import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { FolderOpen, X } from 'lucide-react'
import { getPlatform, dirName } from '@editor/platform'
import { useProjectStore } from '@editor/store/projectStore'
import { useTimelineStore } from '@editor/store/timelineStore'
import { getActiveScene } from '@editor/activeScene'
import {
  type ExportBounds,
  type ExportView,
  clampExportZoom,
  fitExportView,
  viewOffset,
  withViewOffset
} from '@render/exportCamera'
import { buildFramePlan, exportAnimationVideo, formatSeconds, sanitizeFileName } from '@editor/services/videoExport'
import { t } from '@i18n'
import { useDialogDrag } from './dialogDrag'
import VideoExportPreview from './VideoExportPreview'

export interface VideoExportDialogProps {
  onClose: () => void
  onStatus?: (text: string) => void
}

/** 尺寸预设：横屏 / 方形 / 竖屏各给常用档 */
const SIZE_PRESETS: Array<{ w: number; h: number; label: string }> = [
  { w: 1920, h: 1080, label: '1920×1080' },
  { w: 1280, h: 720, label: '1280×720' },
  { w: 1080, h: 1080, label: '1080×1080' },
  { w: 1080, h: 1920, label: '1080×1920' },
  { w: 720, h: 1280, label: '720×1280' }
]

const SETTINGS_KEY = 'hao2d:video-export'

interface SavedSettings {
  width: number
  height: number
  background: string
  outDir: string
}

function loadSettings(): Partial<SavedSettings> {
  if (typeof localStorage === 'undefined') return {}
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Partial<SavedSettings>
  } catch {
    return {}
  }
}

/** H.264 要求偶数：奇数向上取整到偶数；下限 16px（避免输入框清空时导出一个 2px 的怪东西） */
function evenify(value: number): number {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n) || n < 16) return 16
  return n % 2 === 0 ? n : n + 1
}

/**
 * 导出视频面板。
 *
 * 导出完成后**不关闭**：换一个动画、改个尺寸就能接着导下一个（同名文件自动加序号）。
 * 预览与成片走同一条渲染链路（`scene.captureFrame`），所见即所得。
 */
export default function VideoExportDialog({ onClose, onStatus }: VideoExportDialogProps) {
  const doc = useProjectStore((s) => s.document)
  const projectName = useProjectStore((s) => s.projectName)
  const projectPath = useProjectStore((s) => s.projectPath)
  const currentAnimation = useTimelineStore((s) => s.currentAnimation)
  const time = useTimelineStore((s) => s.time)
  const { panelStyle, handleProps } = useDialogDrag()

  const saved = useMemo(loadSettings, [])
  const [animationName, setAnimationName] = useState(currentAnimation ?? doc.animations[0]?.name ?? '')
  const [width, setWidth] = useState(saved.width ?? 1920)
  const [height, setHeight] = useState(saved.height ?? 1080)
  const [background, setBackground] = useState(saved.background ?? '#1A1A1C')
  const [outDir, setOutDir] = useState(saved.outDir ?? (projectPath ? dirName(projectPath) : ''))
  const [view, setView] = useState<ExportView>({ zoom: 100, centerX: 0, centerY: 0 })
  const [bounds, setBounds] = useState<ExportBounds | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [result, setResult] = useState<{ ok: boolean; message: string; path: string } | null>(null)
  const cancelRef = useRef(false)

  const animation = doc.animations.find((item) => item.name === animationName) ?? null
  const fps = doc.frameRate
  const plan = useMemo(() => (animation ? buildFramePlan(animation, fps) : null), [animation, fps])

  // 打开面板先停播：预览要的是「一帧静帧」，播放中取景会一帧帧跳
  useEffect(() => {
    useTimelineStore.getState().setPlaying(false)
  }, [])

  // 换动画才需要重新量整段包围盒（12 帧采样对高模不便宜，别跟着每次改宽高跑）
  useEffect(() => {
    setBounds(getActiveScene()?.measureAnimationBounds() ?? null)
  }, [animationName])

  // 包围盒或画幅变了就重新取景：换尺寸后原来的取景必然偏
  useEffect(() => {
    setView(fitExportView(bounds, evenify(width), evenify(height)))
  }, [bounds, width, height])

  useEffect(() => {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ width, height, background, outDir }))
  }, [width, height, background, outDir])

  const changeAnimation = (name: string): void => {
    setAnimationName(name)
    // 预览 / 成片都渲染「当前动画」：切选择时同步切换时间轴，所见即所得
    if (name) useTimelineStore.getState().setAnimation(name)
  }

  const pickDir = async (): Promise<void> => {
    const picked = await getPlatform().pickFiles({
      directory: true,
      multi: false,
      title: t('选择视频导出目录')
    })
    if (picked[0]) setOutDir(picked[0])
  }

  const startExport = async (): Promise<void> => {
    const scene = getActiveScene()
    if (!scene || !animation) return
    if (!outDir) {
      setResult({ ok: false, message: t('先选择导出目录'), path: '' })
      return
    }
    cancelRef.current = false
    setBusy(true)
    setResult(null)
    setProgress({ done: 0, total: plan?.total ?? 0 })
    const outcome = await exportAnimationVideo(
      scene,
      {
        animation,
        animationName: animation.name,
        projectName: projectName || doc.armatureName,
        width: evenify(width),
        height: evenify(height),
        fps,
        background,
        view,
        outDir
      },
      {
        onProgress: (done, total) => setProgress({ done, total }),
        isCancelled: () => cancelRef.current
      }
    )
    setBusy(false)
    if (outcome.cancelled) {
      setResult({ ok: false, message: t('已取消导出'), path: '' })
      return
    }
    if (outcome.ok) {
      setResult({ ok: true, message: outcome.path, path: outcome.path })
      onStatus?.(t('视频已导出'))
      return
    }
    setResult({ ok: false, message: outcome.reason, path: '' })
  }

  const scene = getActiveScene()
  const offset = viewOffset(view, bounds)
  const fileLabel = `${sanitizeFileName(projectName || doc.armatureName)}_${sanitizeFileName(
    animationName || 'animation'
  )}.mp4`

  return createPortal(
    <div className="fixed inset-0 z-[900] flex items-center justify-center bg-black/55">
      <div
        className="flex h-[520px] w-[840px] flex-col rounded-[6px] border border-line bg-ink-800 shadow-2xl"
        style={panelStyle}
      >
        <div className="flex h-[28px] shrink-0 items-center justify-between border-b border-line px-3" {...handleProps}>
          <span className="hao-panel-title">{t('导出视频')}</span>
          <button
            type="button"
            // 导出中不响应关闭：关掉面板不会停掉编码，只会让进度无处显示
            className={busy ? 'cursor-default text-content-lo/40' : 'cursor-pointer text-content-lo hover:text-content-hi'}
            title={busy ? t('导出中，先取消再关闭') : t('关闭')}
            onClick={() => {
              if (!busy) onClose()
            }}
          >
            <X size={14} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 gap-3 p-3">
          {/* 左：取景预览 */}
          <div className="flex min-h-0 w-[404px] flex-col gap-2">
            <VideoExportPreview
              scene={scene}
              width={evenify(width)}
              height={evenify(height)}
              background={background}
              view={view}
              time={time}
              onViewChange={setView}
            />
            <span className="shrink-0 text-3xs text-content-lo">
              {t('拖动平移 · 滚轮缩放 · {0} × {1} · {2} 帧 · {3} · {4} fps', [
                String(evenify(width)),
                String(evenify(height)),
                String(plan?.total ?? 0),
                formatSeconds(plan?.duration ?? 0),
                String(fps)
              ])}
            </span>
          </div>

          {/* 右：参数 */}
          <div className="flex min-w-0 flex-1 flex-col gap-2 overflow-y-auto pr-1">
            <label className="flex items-center gap-2">
              <span className="hao-label w-[52px] shrink-0">{t('动画')}</span>
              <select
                className="hao-field min-w-0 flex-1"
                value={animationName}
                onChange={(e) => changeAnimation(e.target.value)}
              >
                {doc.animations.length === 0 ? <option value="">{t('（没有动画）')}</option> : null}
                {doc.animations.map((item) => (
                  <option key={item.name} value={item.name}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex items-center gap-2">
              <span className="hao-label w-[52px] shrink-0">{t('背景色')}</span>
              <input
                type="color"
                className="h-[22px] w-[30px] shrink-0 cursor-pointer rounded border border-line bg-ink-900 p-0"
                value={background}
                onChange={(e) => setBackground(e.target.value.toUpperCase())}
              />
              <span className="font-mono text-3xs text-content-mid">{background}</span>
            </label>

            <label className="flex items-center gap-2">
              <span className="hao-label w-[52px] shrink-0">{t('尺寸')}</span>
              <select
                className="hao-field min-w-0 flex-1"
                value={SIZE_PRESETS.some((p) => p.w === width && p.h === height) ? `${width}x${height}` : 'custom'}
                onChange={(e) => {
                  if (e.target.value === 'custom') return
                  const [w, h] = e.target.value.split('x').map(Number)
                  setWidth(w)
                  setHeight(h)
                }}
              >
                {SIZE_PRESETS.map((preset) => (
                  <option key={preset.label} value={`${preset.w}x${preset.h}`}>
                    {preset.label}
                  </option>
                ))}
                <option value="custom">{t('自定义')}</option>
              </select>
            </label>

            <div className="flex items-center gap-1.5 pl-[60px]">
              <input
                className="hao-field w-full font-mono"
                inputMode="numeric"
                value={String(width)}
                title={t('宽（自动对齐到偶数）')}
                onChange={(e) => setWidth(Number(e.target.value.replace(/[^0-9]/g, '')) || 0)}
              />
              <span className="text-3xs text-content-lo">×</span>
              <input
                className="hao-field w-full font-mono"
                inputMode="numeric"
                value={String(height)}
                title={t('高（自动对齐到偶数）')}
                onChange={(e) => setHeight(Number(e.target.value.replace(/[^0-9]/g, '')) || 0)}
              />
            </div>

            <div className="grid grid-cols-2 gap-1.5 pl-[60px]">
              <NumberBox
                label={t('缩放 %')}
                value={Math.round(view.zoom)}
                onCommit={(v) => setView({ ...view, zoom: clampExportZoom(v) })}
              />
              <NumberBox
                label={t('偏移 X')}
                value={Math.round(offset.x * 100) / 100}
                step={0.1}
                onCommit={(v) => setView(withViewOffset(view, bounds, v, offset.y))}
              />
              <NumberBox
                label={t('偏移 Y')}
                value={Math.round(offset.y * 100) / 100}
                step={0.1}
                onCommit={(v) => setView(withViewOffset(view, bounds, offset.x, v))}
              />
              <button
                type="button"
                className="hao-btn h-[22px] px-2 text-3xs"
                onClick={() => setView(fitExportView(bounds, evenify(width), evenify(height)))}
              >
                {t('重置取景')}
              </button>
            </div>

            <div className="flex items-center gap-2">
              <span className="hao-label w-[52px] shrink-0">{t('目录')}</span>
              <span className="min-w-0 flex-1 truncate text-3xs text-content-mid" title={outDir}>
                {outDir || t('（未选择）')}
              </span>
              <button
                type="button"
                className="hao-tool-button h-[20px] w-[22px]"
                title={t('选择目录')}
                onClick={() => void pickDir()}
              >
                <FolderOpen size={12} />
              </button>
            </div>
            <span className="truncate pl-[60px] font-mono text-3xs text-content-lo">{fileLabel}</span>

            <div className="mt-auto flex flex-col gap-1.5">
              {busy ? (
                <>
                  <div className="h-[4px] w-full overflow-hidden rounded bg-ink-600">
                    <div
                      className="h-full bg-accent transition-[width] duration-100"
                      style={{ width: `${progress.total > 0 ? (progress.done / progress.total) * 100 : 0}%` }}
                    />
                  </div>
                  <div className="flex items-center justify-between text-3xs text-content-lo">
                    <span>
                      {t('第 {0} / {1} 帧', [String(progress.done), String(progress.total)])} · {fps} fps
                    </span>
                    <button
                      type="button"
                      className="hao-btn h-[20px] px-2 text-3xs"
                      onClick={() => {
                        cancelRef.current = true
                      }}
                    >
                      {t('取消')}
                    </button>
                  </div>
                </>
              ) : (
                <button
                  type="button"
                  className="hao-btn hao-btn-accent h-[26px] w-full justify-center"
                  disabled={!animation || !outDir || !scene}
                  onClick={() => void startExport()}
                >
                  {t('导出 MP4')}
                </button>
              )}
              {result ? (
                <div className={`flex items-center gap-2 text-3xs ${result.ok ? 'text-ok' : 'text-warn'}`}>
                  <span className="min-w-0 flex-1 truncate" title={result.message}>
                    {result.ok ? t('已导出：{0}', [result.message]) : result.message}
                  </span>
                  {result.ok ? (
                    <button
                      type="button"
                      className="shrink-0 text-content-lo hover:text-content-hi"
                      onClick={() => void getPlatform().revealInFolder(result.path)}
                    >
                      {t('在文件夹中显示')}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}

/** 紧凑数值框：失焦 / 回车提交，避免边打字边改取景 */
function NumberBox({
  label,
  value,
  step = 1,
  onCommit
}: {
  label: string
  value: number
  step?: number
  onCommit: (value: number) => void
}) {
  const [text, setText] = useState(String(value))
  const editing = useRef(false)
  useEffect(() => {
    if (!editing.current) setText(String(value))
  }, [value])
  const commit = (raw: string): void => {
    const parsed = Number(raw)
    onCommit(Number.isFinite(parsed) ? parsed : value)
  }
  return (
    <label className="flex items-center gap-1" title={label}>
      <span className="shrink-0 text-3xs text-content-lo">{label}</span>
      <input
        className="hao-field min-w-0 flex-1 font-mono"
        inputMode="decimal"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onFocus={() => {
          editing.current = true
        }}
        onBlur={(e) => {
          editing.current = false
          commit(e.target.value)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit((e.target as HTMLInputElement).value)
          else if (e.key === 'ArrowUp') commit(String(value + step))
          else if (e.key === 'ArrowDown') commit(String(value - step))
        }}
      />
    </label>
  )
}

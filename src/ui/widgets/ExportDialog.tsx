import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, FolderOpen, Loader2, Package, X } from 'lucide-react'
import { getPlatform } from '@editor/platform'
import { useProjectStore } from '@editor/store/projectStore'
import { listFiles, prepareRuntimeExport, writeHao2dExport, writeRuntimeExport } from '@editor/services/exportService'
import type { RuntimeExportPlan } from '@editor/services/exportService'
import { collectHao2dWarnings } from '@core/codec/hao2dWriter'
import { loadImageElement } from '@render/imageLoader'

/** 两套导出目标：自定义运行时数据 / 给 Unity 的 .hao2d（共用打包与预览） */
export type ExportMode = 'runtime' | 'unity'

export interface ExportDialogProps {
  /** 导出目标：自定义运行时数据 / 给 Unity 的 .hao2d（含图集与材质） */
  mode: ExportMode
  onClose: () => void
  onStatus?: (text: string) => void
}

/** 记住上次选的导出目录，下次打开直接沿用 */
const EXPORT_DIR_KEY = 'hao2d.exportDir'
const MAX_PREVIEW_WIDTH = 660
const MAX_PREVIEW_HEIGHT = 320
const SCALE_PRESETS = [0.25, 0.5, 0.75, 1]
const SIZE_PRESETS = [1024, 2048, 4096]

/** 两种导出模式的标题 */
const MODE_TITLE: Record<ExportMode, string> = {
  runtime: '导出运行时数据',
  unity: '导出 Unity'
}

/**
 * 导出弹窗：选目录 → 调图集缩放 / 单页尺寸 → 实时看图集预览 → 导出。
 *
 * 预览和真正导出的产物出自**同一份** `RuntimeExportPlan`（同样的打包与 UV 重映射），
 * 所以「预览里能装下」＝「导出结果就是这几页」。
 * 两种模式共用这套预览，只是最后写盘的文件清单不同。
 */
export default function ExportDialog({ mode, onClose, onStatus }: ExportDialogProps) {
  const doc = useProjectStore((s) => s.document)
  const skeletons = useProjectStore((s) => s.skeletons)
  const activeSkeleton = useProjectStore((s) => s.activeSkeleton)
  const projectName = useProjectStore((s) => s.projectName)
  const [dir, setDir] = useState(() => {
    if (typeof localStorage === 'undefined') return ''
    return localStorage.getItem(EXPORT_DIR_KEY) ?? ''
  })
  const [scale, setScale] = useState(1)
  const [maxSize, setMaxSize] = useState(2048)
  const [page, setPage] = useState(0)
  const [busy, setBusy] = useState(false)
  /** 勾选要导出的骨架：默认全选（一个项目可以有多个骨架，每个骨架单独出一份资源） */
  const [picked, setPicked] = useState<number[]>(() => skeletons.map((_, index) => index))
  /** 图集范围：默认装**所有骨架**用到的图；也可以只装这次要导出的骨架用到的图 */
  const [atlasScope, setAtlasScope] = useState<'all' | 'selected'>('all')
  const selected = useMemo(
    () => picked.filter((index) => index >= 0 && index < skeletons.length),
    [picked, skeletons]
  )
  const rootRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  /** 预览用的已加载图片（按源图名缓存，切页 / 调参数不用重新解码） */
  const loadedRef = useRef(new Map<string, HTMLImageElement>())

  // 编译 + 打包 + UV 重映射（纯计算，不写盘）：改缩放 / 页尺寸后立刻重算预览
  const plan = useMemo<RuntimeExportPlan>(
    () => prepareRuntimeExport({ scale, maxSize, skeletons: selected, atlasScope }),
    [scale, maxSize, doc, skeletons, selected, atlasScope]
  )
  const pages = plan.atlas.pages
  const current = Math.min(page, Math.max(0, pages.length - 1))

  /**
   * .hao2d 的能力差异提示（变换 / 路径约束在 Unity 侧写不进去等）。
   * 只在这类导出里显示，运行时导出不受影响。
   */
  const warnings = useMemo(
    () =>
      mode === 'unity'
        ? [...new Set(plan.skeletons.flatMap((entry) => collectHao2dWarnings(entry.asset)))]
        : [],
    [mode, plan]
  )

  /** 勾选 / 取消一个骨架（至少留一个：全不勾等于没东西可导） */
  const toggleSkeleton = (index: number): void => {
    setPicked((prev) => {
      if (!prev.includes(index)) return [...prev, index].sort((a, b) => a - b)
      if (prev.length <= 1) {
        onStatus?.('至少要勾选一个骨架')
        return prev
      }
      return prev.filter((item) => item !== index)
    })
  }

  /** Esc 关闭；弹窗内的按键不冒泡出去（否则会触发视口 / 工具的全局快捷键） */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
        return
      }
      if (rootRef.current?.contains(event.target as Node)) event.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  /** 预览绘制：棋盘底 + 当前页的图块（按显示比例缩放） */
  useEffect(() => {
    const canvas = canvasRef.current
    const pageInfo = pages[current]
    const pagePlan = plan.plans[current]
    if (!canvas || !pageInfo || !pagePlan) return

    let cancelled = false
    const fit = Math.min(MAX_PREVIEW_WIDTH / pageInfo.width, MAX_PREVIEW_HEIGHT / pageInfo.height, 1)
    const cssW = Math.max(1, Math.round(pageInfo.width * fit))
    const cssH = Math.max(1, Math.round(pageInfo.height * fit))
    const dpr = Math.min(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1, 2)
    canvas.width = Math.round(cssW * dpr)
    canvas.height = Math.round(cssH * dpr)
    canvas.style.width = `${cssW}px`
    canvas.style.height = `${cssH}px`
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const paint = (): void => {
      if (cancelled) return
      ctx.clearRect(0, 0, cssW, cssH)
      for (const blit of pagePlan.blits) {
        const image = loadedRef.current.get(blit.name)
        if (!image) continue
        ctx.drawImage(image, blit.x * fit, blit.y * fit, blit.width * fit, blit.height * fit)
      }
      // 分块描边：一眼能看出每张碎图落在哪
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)'
      ctx.lineWidth = 1
      for (const blit of pagePlan.blits) {
        ctx.strokeRect(blit.x * fit + 0.5, blit.y * fit + 0.5, Math.max(1, blit.width * fit - 1), Math.max(1, blit.height * fit - 1))
      }
    }
    paint()

    const missing = [...new Set(pagePlan.blits.map((blit) => blit.name))].filter(
      (name) => !loadedRef.current.has(name)
    )
    if (missing.length === 0) return

    const platform = getPlatform()
    void Promise.all(
      missing.map(async (name) => {
        const image = doc.images.find((entry) => entry.name === name)
        if (!image) return
        const url = await platform.imageUrl(image.path)
        if (!url) return
        const element = await loadImageElement(url).catch(() => null)
        if (element) loadedRef.current.set(name, element)
      })
    ).then(() => paint())

    return () => {
      cancelled = true
    }
  }, [plan, current, pages, doc.images])

  const pickDir = async (): Promise<void> => {
    const picked = await getPlatform().pickFiles({
      directory: true,
      multi: false,
      title: '选择导出目录（会在里面新建工程文件夹）'
    })
    const next = picked[0]
    if (!next) return
    setDir(next)
    if (typeof localStorage !== 'undefined') localStorage.setItem(EXPORT_DIR_KEY, next)
  }

  const exportNow = async (): Promise<void> => {
    if (!dir) {
      onStatus?.('请先选择导出目录')
      return
    }
    setBusy(true)
    try {
      const result =
        mode === 'unity'
          ? await writeHao2dExport(dir, plan)
          : await writeRuntimeExport(dir, plan)
      onStatus?.(result.message)
      onClose()
    } finally {
      setBusy(false)
    }
  }

  const totalBlocks = plan.plans.reduce((sum, item) => sum + item.blits.length, 0)
  const pageInfo = pages[current]
  const pagePlan = plan.plans[current]

  return createPortal(
    <div className="fixed inset-0 z-[900] flex items-center justify-center bg-black/55">
      <div
        ref={rootRef}
        className="flex w-[780px] max-w-[94vw] flex-col rounded border border-line bg-ink-800 shadow-2xl shadow-black/60"
      >
        {/* 标题栏 */}
        <div className="flex h-[30px] shrink-0 items-center gap-2 border-b border-line bg-ink-700 px-2.5">
          <Package size={13} className="text-accent" />
          <span className="text-panel font-semibold text-content-hi">{MODE_TITLE[mode]}</span>
          <span className="hao-label ml-1">
            {pages.length > 0 ? `共 ${pages.length} 页 · ${totalBlocks} 张图片` : '没有可导出的图片'}
          </span>
          <button type="button" title="关闭（Esc）" className="hao-tool-button ml-auto" onClick={onClose}>
            <X size={13} />
          </button>
        </div>

        {/* 导出目录 */}
        <div className="flex shrink-0 items-center gap-2 border-b border-line/60 px-2.5 py-2">
          <span className="hao-label w-[54px] shrink-0">导出目录</span>
          <div
            className="hao-field flex min-w-0 flex-1 items-center truncate text-content-mid"
            title={dir || '尚未选择'}
          >
            {dir || '尚未选择（点右侧按钮选一个目录）'}
          </div>
          <button type="button" className="hao-btn shrink-0" onClick={() => void pickDir()}>
            <FolderOpen size={12} /> 选择…
          </button>
        </div>

        {/* 导出骨架：一个项目可以有多个骨架，这里勾选要导出的（默认全选） */}
        <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-line/60 px-2.5 py-2">
          <span className="hao-label w-[54px] shrink-0">导出骨架</span>
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
            {skeletons.map((skeleton, index) => (
              <label
                key={`${skeleton.armatureName}-${index}`}
                className="flex cursor-pointer items-center gap-1 rounded-[4px] border border-line/60 px-1.5 py-[2px] text-3xs text-content-mid hover:bg-ink-700"
                title={`${skeleton.armatureName}（${skeleton.bones.length} 骨骼 / ${skeleton.animations.length} 动画）`}
              >
                <input
                  type="checkbox"
                  className="h-[11px] w-[11px] accent-cyan-400"
                  checked={picked.includes(index)}
                  onChange={() => toggleSkeleton(index)}
                />
                <span className="max-w-[150px] truncate text-content-hi">{skeleton.armatureName}</span>
              </label>
            ))}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              className="hao-btn h-[18px] px-1.5 text-3xs"
              title="勾选全部骨架"
              onClick={() => setPicked(skeletons.map((_, index) => index))}
            >
              全选
            </button>
            <button
              type="button"
              className="hao-btn h-[18px] px-1.5 text-3xs"
              title="只勾选当前编辑的骨架"
              disabled={picked.length === 1 && picked[0] === activeSkeleton}
              onClick={() => setPicked([activeSkeleton])}
            >
              仅当前
            </button>
          </div>
        </div>

        {/* 产物提示：会放进新建的子文件夹 */}
        <div className="shrink-0 border-b border-line/60 px-2.5 py-1.5">
          <span className="hao-label">
            导出时会在所选目录内新建 <span className="text-accent">{plan.stem}/</span> 文件夹（目录与图集名都用项目名
            「<span className="text-accent">{projectName}</span>」），产物都放在里面：
            {mode === 'unity'
              ? `${plan.skeletons.length} 个骨架各自一个 .hao2d / 共用 ${pages.length} 张图集页与 ${pages.length} 个材质（Hao2D/Sprite）`
              : `${listFiles(plan.skeletons.map((entry) => entry.fileName))} / 共用 ${plan.atlasName} / ${pages.length} 张图集页`}
          </span>
        </div>

        {/* 参数区 */}
        <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 px-2.5 py-2">
          <div className="flex items-center gap-2">
            <span className="hao-label shrink-0">图集范围</span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                title="图集里装上项目里所有骨架用到的图（默认）"
                className={['hao-btn h-[18px] px-1.5 text-3xs', atlasScope === 'all' ? 'hao-btn-accent' : ''].join(' ')}
                onClick={() => setAtlasScope('all')}
              >
                所有骨架用到的图
              </button>
              <button
                type="button"
                title="图集里只装这次要导出的骨架用到的图"
                className={[
                  'hao-btn h-[18px] px-1.5 text-3xs',
                  atlasScope === 'selected' ? 'hao-btn-accent' : ''
                ].join(' ')}
                onClick={() => setAtlasScope('selected')}
              >
                只含选中骨架用到的图
              </button>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="hao-label w-[54px] shrink-0">图集缩放</span>
            <input
              type="range"
              min={0.1}
              max={1}
              step={0.05}
              value={scale}
              className="h-[14px] w-[150px] cursor-pointer accent-cyan-400"
              onChange={(event) => setScale(Number(event.target.value))}
            />
            <span className="w-[38px] shrink-0 text-panel text-content-hi">{Math.round(scale * 100)}%</span>
            <div className="flex items-center gap-1">
              {SCALE_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  className={[
                    'hao-btn h-[18px] px-1.5 text-3xs',
                    Math.abs(scale - preset) < 1e-6 ? 'hao-btn-accent' : ''
                  ].join(' ')}
                  onClick={() => setScale(preset)}
                >
                  {Math.round(preset * 100)}%
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="hao-label shrink-0">单页最大</span>
            <div className="flex items-center gap-1">
              {SIZE_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  className={[
                    'hao-btn h-[18px] px-1.5 text-3xs',
                    maxSize === preset ? 'hao-btn-accent' : ''
                  ].join(' ')}
                  onClick={() => setMaxSize(preset)}
                >
                  {preset}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* 图集预览 */}
        <div className="mx-2.5 mb-2 flex min-h-0 flex-col rounded border border-line/60 bg-ink-900/40">
          <div className="flex h-[24px] shrink-0 items-center gap-2 border-b border-line/50 px-2">
            <span className="hao-label">图集预览</span>
            {pageInfo ? (
              <span className="text-3xs text-content-lo">
                第 {current + 1} / {pages.length} 页 · {pageInfo.width}×{pageInfo.height} ·{' '}
                {pagePlan?.blits.length ?? 0} 张图
              </span>
            ) : null}
            {pages.length > 1 ? (
              <div className="ml-auto flex items-center gap-1">
                <button
                  type="button"
                  title="上一页"
                  className="hao-btn h-[18px] w-[18px] justify-center p-0"
                  disabled={current <= 0}
                  onClick={() => setPage(Math.max(0, current - 1))}
                >
                  <ChevronLeft size={12} />
                </button>
                <button
                  type="button"
                  title="下一页"
                  className="hao-btn h-[18px] w-[18px] justify-center p-0"
                  disabled={current >= pages.length - 1}
                  onClick={() => setPage(Math.min(pages.length - 1, current + 1))}
                >
                  <ChevronRight size={12} />
                </button>
              </div>
            ) : null}
          </div>
          <div className="flex min-h-[180px] items-center justify-center p-2">
            {pages.length === 0 ? (
              <span className="text-panel text-content-lo">
                当前工程没有使用任何图片，图集为空（导出后角色以纯色块渲染）
              </span>
            ) : (
              <div className="hao-checkerboard-sm rounded border border-line/70 p-px">
                <canvas ref={canvasRef} className="block" />
              </div>
            )}
          </div>
          {pages.length > 1 ? (
            <div className="flex flex-wrap items-center gap-1 px-2 pb-2">
              {pages.map((item, index) => (
                <button
                  key={item.image}
                  type="button"
                  title={`${item.image}（${item.width}×${item.height}）`}
                  className={[
                    'hao-btn h-[16px] min-w-[16px] justify-center px-1 text-3xs',
                    index === current ? 'hao-btn-accent' : ''
                  ].join(' ')}
                  onClick={() => setPage(index)}
                >
                  {index + 1}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        {/* 警告（打包时放不下的图、以及 .hao2d 与 Unity 运行时的能力差异） */}
        {plan.warnings.length + warnings.length > 0 ? (
          <div className="mx-2.5 mb-2 max-h-[52px] shrink-0 overflow-auto hao-scroll rounded border border-warn/30 bg-warn/10 px-2 py-1">
            {[...plan.warnings, ...warnings].map((warning, index) => (
              <div key={`${index}-${warning}`} className="text-3xs text-warn/90">
                {warning}
              </div>
            ))}
          </div>
        ) : null}

        {/* 底部操作 */}
        <div className="flex shrink-0 items-center gap-2 border-t border-line bg-ink-700/60 px-2.5 py-2">
          <span className="hao-label mr-auto">
            缩放不影响角色大小，只改变纹理分辨率：调小可以把更多碎图塞进更少的页
          </span>
          <button type="button" className="hao-btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            type="button"
            className="hao-btn hao-btn-accent"
            disabled={busy || !dir}
            onClick={() => void exportNow()}
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : null}
            {busy ? '正在导出…' : '导出'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Image as ImageIcon, Trash2, Upload } from 'lucide-react'
import { getPlatform, dirName, baseName } from '@editor/platform'
import { useProjectStore } from '@editor/store/projectStore'
import { stageFilePath } from '@editor/services/projectAssets'
import { PPU } from '@editor/commands/authoringCommands'
import type { EditorDocument, StageImage } from '@core/model/authoring'
import { NumberField, SliderField } from './fields'
import { useDialogDrag } from './dialogDrag'

export interface StageDialogProps {
  onClose: () => void
  onStatus?: (text: string) => void
}

const IMAGE_FILTER = [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]

/**
 * 「舞台」弹窗：给视口铺一张背景参考图（构图 / 姿态参照）。
 *
 * - 图片存到工程目录的 `stage/` 下，随工程走；`editorMeta.stage.file` 只记文件名
 * - 弹窗里能改 位置 / 大小（世界单位，显示按 PPU 换算成像素）/ 透明度
 * - 仅编辑器显示，**不参与任何导出**（运行时编译器根本不读 editorMeta）
 */
export default function StageDialog({ onClose, onStatus = () => undefined }: StageDialogProps) {
  const stage = useProjectStore((s) => s.document.editorMeta.stage)
  const projectPath = useProjectStore((s) => s.projectPath)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  /** 标题栏拖动弹窗（见 dialogDrag） */
  const { panelStyle, handleProps } = useDialogDrag()

  // 预览图 URL 是异步拿到的（hao2d-file:// 协议），按当前文件刷新
  useEffect(() => {
    let cancelled = false
    if (!stage || !projectPath) {
      setPreviewUrl(null)
      return
    }
    void getPlatform()
      .imageUrl(stageFilePath(dirName(projectPath), stage.file))
      .then((url) => {
        if (!cancelled) setPreviewUrl(url)
      })
    return () => {
      cancelled = true
    }
  }, [stage?.file, projectPath])

  /** 改舞台配置：silent = 拖动滑块期间的高频写入（不记历史，事务由 SliderField 管） */
  const setStage = (mutate: (draft: StageImage) => void, label: string, silent = false): void => {
    const store = useProjectStore.getState()
    const apply = (draft: EditorDocument): void => {
      if (draft.editorMeta.stage) mutate(draft.editorMeta.stage)
    }
    if (silent) store.updateSilent(apply)
    else store.update(label, apply)
  }

  const pickImage = async (replace: boolean): Promise<void> => {
    const platform = getPlatform()
    const picked = await platform.pickFiles({ filters: IMAGE_FILTER, multi: false })
    if (picked.length === 0) return
    const path = useProjectStore.getState().projectPath
    if (!path) {
      onStatus('请先保存工程：参考图要存到工程目录的 stage/ 下')
      return
    }
    const src = picked[0]
    const bytes = await platform.readBinary(src)
    if (!bytes.length) {
      onStatus('读不到图片文件')
      return
    }
    const infos = await platform.imageInfo([src])
    const size = infos[0] ?? { width: 0, height: 0 }

    // 文件名去重：同目录同名就加 _2 / _3 ……（避免覆盖已在使用 / 历史里的参考图）
    const origin = baseName(src)
    let fileName = origin
    let counter = 2
    // eslint-disable-next-line no-await-in-loop
    while (await platform.exists(stageFilePath(dirName(path), fileName))) {
      const dot = origin.lastIndexOf('.')
      const base = dot >= 0 ? origin.slice(0, dot) : origin
      const ext = dot >= 0 ? origin.slice(dot) : ''
      fileName = `${base}_${counter}${ext}`
      counter += 1
    }
    const target = stageFilePath(dirName(path), fileName)
    await platform.writeBinary(target, bytes)

    // 换图时删掉旧文件（换名产生的，避免磁盘残留）
    if (replace && stage && stage.file !== fileName) {
      await platform.deleteFile(stageFilePath(dirName(path), stage.file))
    }

    const init: StageImage = {
      file: fileName,
      x: 0,
      y: 0,
      width: size.width ? size.width / PPU : 8,
      height: size.height ? size.height / PPU : 8,
      opacity: 0.5
    }
    useProjectStore.getState().update(replace && stage ? '更换舞台参考图' : '设置舞台参考图', (draft) => {
      draft.editorMeta.stage = init
    })
  }

  const removeImage = async (): Promise<void> => {
    if (!stage) return
    const path = useProjectStore.getState().projectPath
    if (path) await getPlatform().deleteFile(stageFilePath(dirName(path), stage.file))
    useProjectStore.getState().update('删除舞台参考图', (draft) => {
      draft.editorMeta.stage = null
    })
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[900] flex items-center justify-center bg-black/45"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className="w-[380px] overflow-hidden rounded-[10px] border border-white/10 bg-ink-900 text-content-hi shadow-xl shadow-black/40"
        style={panelStyle}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <div className="flex h-[30px] items-center justify-between border-b border-white/10 px-3" {...handleProps}>
          <span className="flex items-center gap-1.5 text-[12px] font-medium">
            <ImageIcon size={14} />
            舞台参考图
          </span>
          <button
            type="button"
            // 标题栏的 `cursor: grab` 会被继承下来，按钮自己声明 pointer 盖掉它
            className="cursor-pointer rounded p-0.5 text-content-lo hover:bg-white/10 hover:text-content-hi"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <div className="flex flex-col gap-3 p-3">
          {stage ? (
            <>
              <div className="flex items-center gap-3">
                {previewUrl ? (
                  <img
                    src={previewUrl}
                    alt="舞台参考图预览"
                    className="h-[60px] w-[60px] rounded border border-white/10 object-contain"
                  />
                ) : (
                  <div className="flex h-[60px] w-[60px] items-center justify-center rounded border border-white/10 bg-white/5 text-content-lo">
                    无预览
                  </div>
                )}
                <div className="flex flex-col gap-1.5">
                  <span className="text-[11px] text-content-mid">文件：{stage.file}</span>
                  <span className="text-[11px] text-content-lo">
                    仅编辑器显示 · 不导出 · 存于工程 stage/ 目录
                  </span>
                </div>
              </div>

              <div className="flex flex-col gap-1.5 rounded border border-white/10 bg-white/[0.03] p-2">
                <span className="text-3xs uppercase tracking-wide text-content-lo">位置（世界坐标，y 向上）</span>
                <div className="flex gap-2">
                  <NumberField
                    label="X"
                    value={stage.x}
                    unitScale={PPU}
                    precision={0}
                    step={PPU}
                    onChange={(v) => setStage((s) => (s.x = v), '调整参考图位置')}
                  />
                  <NumberField
                    label="Y"
                    value={stage.y}
                    unitScale={PPU}
                    precision={0}
                    step={PPU}
                    onChange={(v) => setStage((s) => (s.y = v), '调整参考图位置')}
                  />
                </div>
              </div>

              <div className="flex flex-col gap-1.5 rounded border border-white/10 bg-white/[0.03] p-2">
                <span className="text-3xs uppercase tracking-wide text-content-lo">大小（显示像素）</span>
                <div className="flex gap-2">
                  <NumberField
                    label="宽"
                    value={stage.width}
                    unitScale={PPU}
                    precision={0}
                    step={PPU}
                    min={PPU * 0.5}
                    onChange={(v) => setStage((s) => (s.width = v), '调整参考图大小')}
                  />
                  <NumberField
                    label="高"
                    value={stage.height}
                    unitScale={PPU}
                    precision={0}
                    step={PPU}
                    min={PPU * 0.5}
                    onChange={(v) => setStage((s) => (s.height = v), '调整参考图大小')}
                  />
                </div>
              </div>

              <SliderField
                label="透明度"
                value={stage.opacity}
                min={0}
                max={1}
                step={0.05}
                transaction="调整参考图透明度"
                onChange={(v, silent) => setStage((s) => (s.opacity = v), '调整参考图透明度', silent)}
              />

              <div className="flex justify-between gap-2 pt-1">
                <button
                  type="button"
                  className="hao-btn flex items-center gap-1"
                  onClick={() => void pickImage(true)}
                >
                  <Upload size={13} />
                  更换图片
                </button>
                <button
                  type="button"
                  className="hao-btn flex items-center gap-1 hover:border-danger/50 hover:text-danger"
                  onClick={() => void removeImage()}
                >
                  <Trash2 size={13} />
                  删除图片
                </button>
              </div>
            </>
          ) : (
            <div className="flex flex-col items-center gap-3 py-4">
              <div className="flex h-[72px] w-[72px] items-center justify-center rounded-full bg-white/5 text-content-lo">
                <ImageIcon size={30} />
              </div>
              <span className="text-[12px] text-content-mid">还没有参考图</span>
              <span className="px-6 text-center text-[11px] text-content-lo">
                选一张图铺在视口后面当背景参照（构图 / 姿态），它只显示在编辑器里，导出时不会带上。
              </span>
              <button
                type="button"
                className="hao-btn flex items-center gap-1"
                onClick={() => void pickImage(false)}
              >
                <Upload size={13} />
                选择参考图片…
              </button>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}

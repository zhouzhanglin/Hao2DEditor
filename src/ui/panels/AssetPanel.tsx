import { useRef, useState } from 'react'
import { Layers, Package, Plus } from 'lucide-react'
import { useProjectStore } from '@editor/store/projectStore'
import { useSelectionStore } from '@editor/store/selectionStore'
import { PanelEmpty } from '@ui/widgets/PanelShell'
import { createRegionFromImage } from '@editor/commands/authoringCommands'
import { setDraggingImage, setImageDragData } from '@ui/widgets/dragDrop'
import { ImageHoverPreview, ImageThumb } from './ImageThumb'
import type { AuthoringImage } from '@core/model/authoring'

/** 皮肤与图集面板：切换当前皮肤、查看图片清单（导出时打包为图集） */
export default function AssetPanel() {
  const document = useProjectStore((s) => s.document)
  const update = useProjectStore((s) => s.update)
  const selection = useSelectionStore()
  /** 悬停的图片 + 所在行元素（预览浮层贴在行旁边） */
  const [hovered, setHovered] = useState<{ image: AuthoringImage; row: HTMLElement } | null>(null)
  /** 已选图片（多选）：拖拽时整组一起走，落到视口里一次建多个插槽 */
  const [picked, setPicked] = useState<string[]>([])
  /** Shift 范围选择的锚点（上一次普通点击 / Cmd 点击的行） */
  const anchorRef = useRef<string | null>(null)

  // 图片可能被删除 / 改名，选中列表里失效的名字直接忽略
  const selected = picked.filter((name) => document.images.some((item) => item.name === name))
  const selectedSet = new Set(selected)

  /** 点行：普通点击单选、Cmd/Ctrl 点击增减、Shift 点击按锚点选一段 */
  const pickImage = (name: string, event: React.MouseEvent): void => {
    if (event.metaKey || event.ctrlKey) {
      setPicked(
        selected.includes(name) ? selected.filter((item) => item !== name) : [...selected, name]
      )
      anchorRef.current = name
      return
    }
    if (event.shiftKey && anchorRef.current) {
      const names = document.images.map((item) => item.name)
      const from = names.indexOf(anchorRef.current)
      const to = names.indexOf(name)
      if (from >= 0 && to >= 0) {
        setPicked(names.slice(Math.min(from, to), Math.max(from, to) + 1))
        return
      }
    }
    setPicked([name])
    anchorRef.current = name
  }

  const activeSkin = selection.skin && document.skins.some((s) => s.name === selection.skin) ? selection.skin : ''
  // 新附件的挂载骨骼：优先用当前选中的骨骼，否则退回第一根骨骼
  const bone =
    (selection.kind === 'bone' && selection.bone) || (selection.kind === 'slot' && selection.slot
      ? document.slots.find((slot) => slot.name === selection.slot)?.bone ?? ''
      : '') ||
    document.bones[0]?.name ||
    ''

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-line/60 px-2 py-1.5">
        <h3 className="hao-panel-title mb-1 flex items-center gap-1">
          <Layers size={11} /> 皮肤
        </h3>
        <div className="flex flex-wrap gap-1">
          {document.skins.map((skin) => {
            const active = (skin.name === 'default' && !activeSkin) || skin.name === activeSkin
            const attachments = skin.slots.reduce((sum, slot) => sum + slot.attachments.length, 0)
            return (
              <button
                key={skin.name}
                type="button"
                onClick={() => selection.select({ kind: 'slot', skin: skin.name === 'default' ? '' : skin.name })}
                className={[
                  'h-[20px] rounded border px-1.5 text-3xs transition-colors duration-panel cursor-pointer',
                  active
                    ? 'border-accent/50 bg-accent/15 text-accent'
                    : 'border-line bg-ink-900/60 text-content-mid hover:text-content-hi'
                ].join(' ')}
                title={`${attachments} 个附件`}
              >
                {skin.name}
                <span className="ml-1 text-content-lo">{attachments}</span>
              </button>
            )
          })}
          <button
            type="button"
            className="hao-btn h-[20px] px-1.5 text-3xs"
            onClick={() =>
              update('新建皮肤', (draft) => {
                const name = `skin${draft.skins.length}`
                draft.skins.push({ name, slots: draft.slots.map((slot) => ({ slot: slot.name, attachments: [] })) })
              })
            }
          >
            +
          </button>
        </div>
      </div>

      <div
        className="min-h-0 flex-1 overflow-auto hao-scroll px-2 py-1.5"
        // 点列表空白处取消多选
        onClick={(event) => {
          if (!(event.target as HTMLElement).closest('li')) setPicked([])
        }}
      >
        <h3 className="hao-panel-title mb-1 flex items-center gap-1">
          <Package size={11} /> 图片 / 图集页
          {selected.length > 1 ? (
            <span className="ml-auto font-normal normal-case tracking-normal text-accent">
              已选 {selected.length} 张 · 拖入场景可一起创建
            </span>
          ) : (
            <span className="ml-auto font-normal normal-case tracking-normal text-content-lo/70">
              ⌘/Ctrl 多选
            </span>
          )}
        </h3>
        {document.images.length === 0 ? (
          <PanelEmpty
            title="尚无图片"
            description="通过「导入图片」或直接把碎图拖入窗口，即可作为附件贴图使用；导出时会自动打包成图集。"
          />
        ) : (
          <ul className="flex flex-col gap-1">
            {document.images.map((image) => (
              <li
                key={image.name}
                draggable
                title="拖到视口 = 在落点新建插槽（先多选可以一次拖多张）；拖到层级树的插槽行 = 给该插槽加一个 display"
                className={[
                  'flex cursor-grab items-center gap-1.5 rounded border px-1.5 py-1 active:cursor-grabbing',
                  selectedSet.has(image.name)
                    ? 'border-accent/60 bg-accent/15'
                    : 'border-line/60 bg-ink-900/40 hover:border-accent/40'
                ].join(' ')}
                onClick={(event) => pickImage(image.name, event)}
                onDragStart={(event) => {
                  // 拖的行在多选里 → 整组带走；否则先把选中切到它（拖动即选中）
                  const names =
                    selectedSet.has(image.name) && selectedSet.size > 1 ? selected : [image.name]
                  if (names.length === 1) {
                    setPicked([image.name])
                    anchorRef.current = image.name
                  }
                  setImageDragData(event.dataTransfer, names)
                  setDraggingImage(
                    event.dataTransfer,
                    event.currentTarget.querySelector('img'),
                    names.length
                  )
                  setHovered(null)
                }}
                onMouseEnter={(event) => setHovered({ image, row: event.currentTarget })}
                onMouseLeave={() =>
                  setHovered((current) => (current?.image.name === image.name ? null : current))
                }
              >
                <ImageThumb path={image.path} size={22} />
                <span className="min-w-0 flex-1 truncate">{image.name}</span>
                <span className="shrink-0 font-mono text-3xs text-content-lo">
                  {image.width}×{image.height}
                </span>
                {image.loose ? (
                  <span className="shrink-0 rounded bg-warn/20 px-1 text-3xs text-warn">碎图</span>
                ) : (
                  <span className="shrink-0 rounded bg-ink-600 px-1 text-3xs text-content-lo">图集</span>
                )}
                <button
                  type="button"
                  title={
                    bone
                      ? `在骨骼「${bone}」下新建插槽，并用这张图片作为它的 display（也可以直接把图片拖进场景）`
                      : '先新建一根骨骼，再用图片创建附件'
                  }
                  disabled={!bone}
                  className={[
                    'flex h-[16px] w-[16px] shrink-0 items-center justify-center rounded',
                    bone
                      ? 'text-content-lo hover:bg-accent/15 hover:text-accent cursor-pointer'
                      : 'cursor-not-allowed text-content-lo/40'
                  ].join(' ')}
                  onClick={(event) => {
                    // 别冒泡到行上改了选中（这个按钮只对当前这张生效）
                    event.stopPropagation()
                    if (!bone) return
                    let created: { slot: string; attachment: string } | null = null
                    update('用图片创建附件', (draft) => {
                      created = createRegionFromImage(draft, {
                        image: image.name,
                        bone,
                        width: image.width,
                        height: image.height,
                        // 附件落到当前皮肤，和拖放建插槽保持一致
                        skin: activeSkin
                      })
                    })
                    if (created) {
                      const result: { slot: string; attachment: string } = created
                      selection.selectAttachment(result.slot, result.attachment)
                    }
                  }}
                >
                  <Plus size={11} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* 悬停大图预览：portal 到 body，不会被面板滚动区裁剪。
          每次都从文档里取最新记录（图片可能被改名 / 重新导入，旧引用会指向失效路径） */}
      {hovered && document.images.some((item) => item.name === hovered.image.name) ? (
        <ImageHoverPreview
          image={document.images.find((item) => item.name === hovered.image.name) ?? hovered.image}
          anchor={hovered.row}
        />
      ) : null}
    </div>
  )
}

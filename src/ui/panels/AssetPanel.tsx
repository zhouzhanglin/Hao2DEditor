import { useState } from 'react'
import { Layers, Package, Plus } from 'lucide-react'
import { useProjectStore } from '@editor/store/projectStore'
import { useSelectionStore } from '@editor/store/selectionStore'
import { PanelEmpty } from '@ui/widgets/PanelShell'
import { createRegionFromImage } from '@editor/commands/authoringCommands'
import { setImageDragData } from '@ui/widgets/dragDrop'
import { ImageHoverPreview, ImageThumb } from './ImageThumb'
import type { AuthoringImage } from '@core/model/authoring'

/** 皮肤与图集面板：切换当前皮肤、查看图片清单（导出时打包为图集） */
export default function AssetPanel() {
  const document = useProjectStore((s) => s.document)
  const update = useProjectStore((s) => s.update)
  const selection = useSelectionStore()
  /** 悬停的图片 + 所在行元素（预览浮层贴在行旁边） */
  const [hovered, setHovered] = useState<{ image: AuthoringImage; row: HTMLElement } | null>(null)

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

      <div className="min-h-0 flex-1 overflow-auto hao-scroll px-2 py-1.5">
        <h3 className="hao-panel-title mb-1 flex items-center gap-1">
          <Package size={11} /> 图片 / 图集页
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
                title="拖到视口 = 在落点新建插槽；拖到层级树的插槽行 = 给该插槽加一个 display"
                className="flex cursor-grab items-center gap-1.5 rounded border border-line/60 bg-ink-900/40 px-1.5 py-1 hover:border-accent/40 active:cursor-grabbing"
                onDragStart={(event) => {
                  setImageDragData(event.dataTransfer, image.name)
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
                  onClick={() => {
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

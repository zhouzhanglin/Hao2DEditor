import { useRef, useState } from 'react'
import { ImagePlus, Layers, Loader2, Package, Pencil, Plus, RefreshCw, Scissors, Trash2 } from 'lucide-react'
import { useProjectStore } from '@editor/store/projectStore'
import { useSelectionStore } from '@editor/store/selectionStore'
import { getPlatform } from '@editor/platform'
import { splitAtlasImage } from '@editor/services/atlasSplit'
import { importDroppedPaths } from '@editor/services/projectIo'
import { PanelEmpty } from '@ui/widgets/PanelShell'
import { countImageReferences, createRegionFromImage, renameSkin } from '@editor/commands/authoringCommands'
import { hasExternalFiles, setDraggingImage, setImageDragData } from '@ui/widgets/dragDrop'
import { ImageHoverPreview, ImageThumb } from './ImageThumb'
import ContextMenu from '@ui/widgets/ContextMenu'
import type { ContextMenuItem } from '@ui/widgets/ContextMenu'
import type { AuthoringImage } from '@core/model/authoring'
import { t } from '@i18n'

export interface AssetPanelProps {
  /** 点面板里的「导入」：交给 App 走统一导入命令（带忙碌提示 / 结果反馈） */
  onImport?: () => void
  onStatus?: (text: string) => void
}

/** 皮肤与图集面板：切换当前皮肤、查看图片清单（导出时打包为图集）；导入资源的入口也在这里 */
export default function AssetPanel({ onImport, onStatus }: AssetPanelProps) {
  const document = useProjectStore((s) => s.document)
  const update = useProjectStore((s) => s.update)
  const removeImage = useProjectStore((s) => s.removeImage)
  const replaceImage = useProjectStore((s) => s.replaceImage)
  const selection = useSelectionStore()
  /**
   * 已选图片（多选）：拖拽时整组一起走，落到视口里一次建多个插槽。
   *
   * 存在 `selectionStore` 里而不是本面板的 `useState`：它属于「当前选中」的一部分 ——
   * 点了骨骼 / 插槽 / display 就该跟着清掉（由 `selectionStore` 的 `commit` 统一处理），
   * 留在面板里就会出现「骨骼已选中、图片行还亮着」两处高亮同时存在。
   */
  const picked = selection.pickedImages
  const setPicked = selection.setPickedImages
  /** 从系统拖文件悬停在本面板上（面板范围内的高亮，不是整窗覆盖层） */
  const [fileDragging, setFileDragging] = useState(false)
  /** 悬停的图片 + 所在行元素（预览浮层贴在行旁边） */
  const [hovered, setHovered] = useState<{ image: AuthoringImage; row: HTMLElement } | null>(null)
  /** Shift 范围选择的锚点（上一次普通点击 / Cmd 点击的行） */
  const anchorRef = useRef<string | null>(null)
  /** 右键菜单：位置 + 目标图片名 */
  const [rowMenu, setRowMenu] = useState<{ x: number; y: number; name: string } | null>(null)
  /** 正在拆的图集名（拆图 + 写盘要点时间，按钮上转个圈） */
  const [splitting, setSplitting] = useState<string | null>(null)
  /** 皮肤右键菜单：位置 + 目标皮肤名 */
  const [skinMenu, setSkinMenu] = useState<{ x: number; y: number; name: string } | null>(null)
  /** 正在改名的皮肤（名字 + 输入框草稿）：就地变成输入框，回车确认 / Esc 取消 */
  const [renamingSkin, setRenamingSkin] = useState<{ name: string; draft: string } | null>(null)

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

  /** 拖进本面板的文件：走统一的导入分派（图片 / 图集 / Spine、DragonBones JSON / 工程文件） */
  const importFromFiles = async (files: File[]): Promise<void> => {
    const platform = getPlatform()
    const paths = await Promise.all(files.map((file) => platform.pathForDroppedFile(file)))
    const result = await importDroppedPaths(paths.filter(Boolean))
    if (result.message) onStatus?.(result.message)
  }

  /** 删除图片：被附件引用时先确认，确认后清空引用（纯色）并移除条目 */
  const handleDeleteImage = (name: string): void => {
    const refs = countImageReferences(document, name)
    if (refs > 0) {
      const ok = window.confirm(
        t('图片「{0}」正被 {1} 个附件引用。\n删除后这些附件会丢失贴图、退化为纯色块（附件本身保留）。\n确定删除？', [
          name,
          refs
        ])
      )
      if (!ok) return
    }
    removeImage(name)
    // 读 store 的现值而不是渲染闭包里的 `picked`：删除是右键菜单触发的，用最新值更稳
    setPicked(useSelectionStore.getState().pickedImages.filter((item) => item !== name))
    onStatus?.(
      refs > 0
        ? t('已删除「{0}」（{1} 个附件的贴图已清空）', [name, refs])
        : t('已删除「{0}」', name)
    )
  }

  /** 替换图片：选一张新图，保持原名（附件引用自动跟随），更新来源与尺寸 */
  const handleReplaceImage = async (name: string): Promise<void> => {
    const platform = getPlatform()
    const pickedFiles = await platform.pickFiles({
      title: t('替换图片「{0}」', name),
      filters: [{ name: t('图片'), extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }]
    })
    if (pickedFiles.length === 0) return
    const infos = await platform.imageInfo(pickedFiles.slice(0, 1))
    const info = infos[0]
    if (!info || !info.path) {
      onStatus?.(t('读取「{0}」失败，替换取消', pickedFiles[0] ?? ''))
      return
    }
    replaceImage(name, { path: info.path, width: info.width, height: info.height })
    onStatus?.(t('已用「{0}」替换「{1}」（{2}×{3}）', [info.path, name, info.width, info.height]))
  }

  /** 图集拆碎图：图集里的每块子图各写一张 png，引用它的附件改用碎图，图集条目从工程移除 */
  const handleSplitAtlas = async (name: string): Promise<void> => {
    if (splitting) return
    setSplitting(name)
    try {
      const result = await splitAtlasImage(name)
      onStatus?.(result.message)
    } catch (error) {
      onStatus?.(t('拆分「{0}」失败：{1}', [name, error instanceof Error ? error.message : String(error)]))
    } finally {
      setSplitting(null)
    }
  }

  /** 新建皮肤：名字跳过已占用的（`skin2` 被占了就往后顺延），不制造同名皮肤 */
  const handleAddSkin = (): void => {
    update(t('新建皮肤'), (draft) => {
      const taken = new Set(draft.skins.map((skin) => skin.name))
      let index = draft.skins.length
      while (taken.has(`skin${index}`)) index++
      draft.skins.push({
        name: `skin${index}`,
        slots: draft.slots.map((slot) => ({ slot: slot.name, attachments: [] }))
      })
    })
  }

  /**
   * 皮肤改名：**重名 / 空名直接拒绝**。
   *
   * 在写文档**之前**就拦下来：皮肤名是「变形（FFD）帧的归属」「链接网格的源皮肤」的键，
   * 撞名之后两套皮肤就再也分不清谁是谁；顺带也避免留一条什么都没改的撤销记录。
   */
  const commitSkinRename = (keepEditing = false): void => {
    const pending = renamingSkin
    if (!pending) return
    const to = pending.draft.trim()
    if (!to || to === pending.name) {
      setRenamingSkin(null)
      return
    }
    // 重名时按回车**保持输入框打开**，让用户直接改掉再回车；
    // 失焦进来的则关掉输入框（否则会留下一个没人聚焦、也退不出去的输入框）
    if (document.skins.some((skin) => skin.name === to)) {
      onStatus?.(t('已有同名皮肤：{0}', to))
      if (!keepEditing) setRenamingSkin(null)
      return
    }
    setRenamingSkin(null)
    // 名字 + 变形轨道归属 / 链接网格源皮肤 / 当前皮肤一起改（见 renameSkin）
    update(t('重命名皮肤'), (draft) => {
      renameSkin(draft, pending.name, to)
    })
    // 正被选中的皮肤换到新名字上，否则视口 / 资源面板会立刻退回默认皮肤
    const selectionStore = useSelectionStore.getState()
    if (selectionStore.skin === pending.name) selectionStore.select({ skin: to })
    onStatus?.(t('皮肤已重命名为「{0}」', to))
  }

  /** 删除皮肤：default 不可删；删掉的若是当前皮肤，当前皮肤退回默认（空串） */
  const handleDeleteSkin = (name: string): void => {
    if (name === 'default') {
      onStatus?.(t('不能删除默认皮肤 default'))
      return
    }
    const skin = document.skins.find((item) => item.name === name)
    const attachments = skin?.slots.reduce((sum, slot) => sum + slot.attachments.length, 0) ?? 0
    const confirmed =
      attachments === 0 ||
      window.confirm(
        t('皮肤「{0}」里有 {1} 个附件，删除后这些附件一起消失（引用它们的显示帧 / 链接网格要另行处理）。确定删除？', [
          name,
          attachments
        ])
      )
    if (!confirmed) return
    update(t('删除皮肤'), (draft) => {
      draft.skins = draft.skins.filter((item) => item.name !== name)
      if (draft.editorMeta.activeSkin === name) draft.editorMeta.activeSkin = ''
    })
    const selectionStore = useSelectionStore.getState()
    if (selectionStore.skin === name) selectionStore.select({ skin: '' })
    onStatus?.(t('已删除皮肤「{0}」', name))
  }

  /** 皮肤右键菜单项：默认皮肤两项都禁掉（它是链接网格源皮肤 / 变形归属的基准） */
  const skinMenuItems = (name: string): ContextMenuItem[] => {
    const isDefault = name === 'default'
    return [
      {
        key: 'rename',
        label: t('重命名'),
        icon: <Pencil size={12} />,
        disabled: isDefault,
        hint: isDefault
          ? t('默认皮肤不能重命名 / 删除')
          : t('改名（变形帧与链接网格里的皮肤归属会一起跟随）'),
        onSelect: () => setRenamingSkin({ name, draft: name })
      },
      { key: 'sep', separator: true },
      {
        key: 'delete',
        label: t('删除皮肤'),
        icon: <Trash2 size={12} />,
        danger: true,
        disabled: isDefault,
        hint: isDefault
          ? t('默认皮肤不能重命名 / 删除')
          : t('删除这套皮肤（里面的附件一起消失，可撤销）'),
        onSelect: () => handleDeleteSkin(name)
      }
    ]
  }

  /** 右键菜单项 */
  const imageMenuItems = (name: string): ContextMenuItem[] => [
    {
      key: 'replace',
      label: t('替换图片…'),
      icon: <RefreshCw size={12} />,
      hint: t('选一张新图，保持原名（引用它的附件自动跟随）'),
      onSelect: () => void handleReplaceImage(name)
    },
    { key: 'sep', separator: true },
    {
      key: 'delete',
      label: t('删除图片'),
      icon: <Trash2 size={12} />,
      danger: true,
      hint: t('从工程移除该图片（被引用的附件退化为纯色）'),
      onSelect: () => handleDeleteImage(name)
    }
  ]

  const activeSkin = selection.skin && document.skins.some((s) => s.name === selection.skin) ? selection.skin : ''
  // 新附件的挂载骨骼：优先用当前选中的骨骼，否则退回第一根骨骼
  const bone =
    (selection.kind === 'bone' && selection.bone) || (selection.kind === 'slot' && selection.slot
      ? document.slots.find((slot) => slot.name === selection.slot)?.bone ?? ''
      : '') ||
    document.bones[0]?.name ||
    ''

  return (
    <div
      className={[
        'relative flex h-full flex-col',
        // 系统文件悬停在本面板上时高亮：导入范围就限定在这个面板（没有整窗覆盖层）
        fileDragging ? 'bg-accent/5 outline outline-1 -outline-offset-1 outline-accent/60' : ''
      ].join(' ')}
      onDragOver={(event) => {
        if (!hasExternalFiles(event.dataTransfer)) return
        event.preventDefault()
        event.stopPropagation()
        event.dataTransfer.dropEffect = 'copy'
        if (!fileDragging) setFileDragging(true)
      }}
      onDragLeave={(event) => {
        // 子元素之间移动也会触发 dragleave：真正离开面板才收高亮
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        setFileDragging(false)
      }}
      onDrop={(event) => {
        if (!hasExternalFiles(event.dataTransfer)) return
        event.preventDefault()
        event.stopPropagation()
        setFileDragging(false)
        const files = Array.from(event.dataTransfer.files)
        if (files.length > 0) void importFromFiles(files)
      }}
    >
      {fileDragging ? (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 py-1 text-center text-3xs text-accent">
          {t('松开导入到「资源与皮肤」')}
        </div>
      ) : null}
      <div className="border-b border-line/60 px-2 py-1.5">
        <h3 className="hao-panel-title mb-1 flex items-center gap-1">
          <Layers size={11} /> {t('皮肤')}
        </h3>
        <div className="flex flex-wrap gap-1">
          {document.skins.map((skin) => {
            const active = (skin.name === 'default' && !activeSkin) || skin.name === activeSkin
            const attachments = skin.slots.reduce((sum, slot) => sum + slot.attachments.length, 0)
            // 改名中：这颗 chip 就地变成输入框（回车确认 / Esc 取消 / 失焦确认）
            if (renamingSkin?.name === skin.name) {
              return (
                <input
                  key={skin.name}
                  autoFocus
                  value={renamingSkin.draft}
                  title={t('输入新名字，回车确认 / Esc 取消')}
                  onFocus={(event) => event.currentTarget.select()}
                  onChange={(event) => setRenamingSkin({ name: skin.name, draft: event.target.value })}
                  onBlur={() => commitSkinRename()}
                  onKeyDown={(event) => {
                    // 回车确认；此时若重名，输入框保持打开好继续改（见 commitSkinRename）
                    if (event.key === 'Enter') commitSkinRename(true)
                    else if (event.key === 'Escape') setRenamingSkin(null)
                  }}
                  className="h-[20px] w-[104px] rounded-[4px] border border-accent bg-ink-800 px-1.5 text-3xs text-content-hi outline-none"
                />
              )
            }
            return (
              <button
                key={skin.name}
                type="button"
                onClick={() => {
                  // 走 store 的统一入口：除了选中态，还要把皮肤写进 `editorMeta.activeSkin`，
                  // 下次打开工程才能恢复（只改选中态等于没存，重开就回 default）
                  useProjectStore.getState().setActiveSkin(skin.name)
                  selection.select({ kind: 'slot', skin: skin.name === 'default' ? '' : skin.name })
                }}
                onContextMenu={(event) => {
                  event.preventDefault()
                  setSkinMenu({ x: event.clientX, y: event.clientY, name: skin.name })
                }}
                className={[
                  'h-[20px] rounded border px-1.5 text-3xs transition-colors duration-panel cursor-pointer',
                  active
                    ? 'border-transparent bg-accent-deep text-white'
                    : 'border-line bg-ink-900/60 text-content-mid hover:text-content-hi'
                ].join(' ')}
                title={t('{0}：{1} 个附件（右键重命名 / 删除）', [skin.name, attachments])}
              >
                {skin.name}
                <span className={active ? 'ml-1 text-white/70' : 'ml-1 text-content-lo'}>{attachments}</span>
              </button>
            )
          })}
          <button
            type="button"
            title={t('新建皮肤（每套皮肤一套附件，用于换装 / 换色）')}
            className="hao-btn h-[20px] px-1.5 text-3xs"
            onClick={handleAddSkin}
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
          <Package size={11} /> {t('图片 / 图集页')}
          {selected.length > 1 ? (
            <span className="ml-auto font-normal normal-case tracking-normal text-accent">
              {t('已选 {0} 张 · 拖入场景可一起创建', selected.length)}
            </span>
          ) : (
            <span className="ml-auto font-normal normal-case tracking-normal text-content-lo/70">
              {t('⌘/Ctrl 多选')}
            </span>
          )}
          <button
            type="button"
            title={t('导入图片 / 图集（⌘/Ctrl+I）；也可以把文件 / 文件夹直接拖进这个面板')}
            onClick={() => onImport?.()}
            className="hao-btn flex h-[18px] w-[18px] shrink-0 items-center justify-center p-0"
          >
            <ImagePlus size={11} />
          </button>
        </h3>
        {document.images.length === 0 ? (
          <PanelEmpty
            title={t('尚无图片')}
            description={t('点右上角「导入」选文件，或把图片 / 图集直接拖进这个面板；导入后即可作为附件贴图使用，导出时会自动打包成图集。')}
          />
        ) : (
          <ul className="flex flex-col gap-1">
            {document.images.map((image) => (
              <li
                key={image.name}
                draggable
                title={t('拖到视口 = 在落点新建插槽（先多选可以一次拖多张）；拖到层级树的插槽行 = 给该插槽加一个 display；拖到骨骼行 = 在该骨骼下新建插槽；右键可替换 / 删除')}
                onContextMenu={(event) => {
                  event.preventDefault()
                  setRowMenu({ x: event.clientX, y: event.clientY, name: image.name })
                }}
                className={[
                  // 与层级树 / slot 层级统一：无边框 mac 列表行 + 圆角实心选中块；
                  // 原来的描边卡片是全应用里独一份的行样式，放在一起像两套组件。
                  // 缩略图本身撑高度，内边距仍收着（py-0.5）
                  'group relative mx-1 flex cursor-grab items-center gap-1.5 rounded-[5px] px-1.5 py-0.5 active:cursor-grabbing',
                  selectedSet.has(image.name)
                    ? 'bg-accent-deep text-white'
                    : 'text-content-hi hover:bg-white/[0.07]'
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
                <span className="min-w-0 flex-1 truncate text-2xs">{image.name}</span>
                <span className="shrink-0 font-mono text-3xs text-content-lo">
                  {image.width}×{image.height}
                </span>
                {image.loose ? (
                  <span className="shrink-0 rounded bg-warn/20 px-1 text-3xs text-warn">{t('碎图')}</span>
                ) : (
                  <>
                    <span className="shrink-0 rounded bg-ink-600 px-1 text-3xs text-content-lo">{t('图集')}</span>
                    <button
                      type="button"
                      title={t('拆成碎图：图集里的每块子图各写出一张 png（被旋转存放的会转正），引用它的附件自动改用碎图，图集从工程移除（磁盘上的原 png 保留，可 ⌘/Ctrl+Z 撤销）')}
                      disabled={splitting !== null}
                      className={[
                        'flex h-[16px] w-[16px] shrink-0 items-center justify-center rounded',
                        splitting === image.name
                          ? 'text-accent'
                          : splitting !== null
                            ? 'cursor-not-allowed text-content-lo/40'
                            : 'cursor-pointer text-content-lo hover:bg-accent/15 hover:text-accent'
                      ].join(' ')}
                      onClick={(event) => {
                        // 别冒泡到行上改选中（这个按钮只对当前这张生效）
                        event.stopPropagation()
                        void handleSplitAtlas(image.name)
                      }}
                    >
                      {splitting === image.name ? (
                        <Loader2 size={11} className="animate-spin" />
                      ) : (
                        <Scissors size={11} />
                      )}
                    </button>
                  </>
                )}
                <button
                  type="button"
                  title={
                    bone
                      ? t('在骨骼「{0}」下新建插槽，并用这张图片作为它的 display（也可以直接把图片拖进场景）', bone)
                      : t('先新建一根骨骼，再用图片创建附件')
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
                    update(t('用图片创建附件'), (draft) => {
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

      {skinMenu ? (
        <ContextMenu
          x={skinMenu.x}
          y={skinMenu.y}
          title={t('皮肤「{0}」', skinMenu.name)}
          items={skinMenuItems(skinMenu.name)}
          onClose={() => setSkinMenu(null)}
        />
      ) : null}

      {rowMenu ? (
        <ContextMenu
          x={rowMenu.x}
          y={rowMenu.y}
          title={t('图片「{0}」', rowMenu.name)}
          items={imageMenuItems(rowMenu.name)}
          onClose={() => setRowMenu(null)}
        />
      ) : null}
    </div>
  )
}

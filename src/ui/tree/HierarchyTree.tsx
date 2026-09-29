import { useMemo, useRef, useState } from 'react'
import {
  Activity,
  Bone,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Image as ImageIcon,
  Link2,
  Lock,
  Maximize2,
  Plus,
  Route,
  Target,
  Trash2,
  Unlock
} from 'lucide-react'
import { useProjectStore } from '@editor/store/projectStore'
import { useSelectionStore } from '@editor/store/selectionStore'
import { useModeStore } from '@editor/store/modeStore'
import { createIkConstraint, createPathConstraint, createTransformConstraint } from '@core/model/constraints'
import type { AuthoringBone, AuthoringConstraint, EditorDocument } from '@core/model/authoring'
import { createAuthoringBone, createAuthoringSlot } from '@core/model/authoring'
import { addImageDisplay, createRegionFromImage, deleteAttachment } from '@editor/commands/authoringCommands'
import {
  boneSlotAnchor,
  moveBone,
  moveDisplay,
  moveSlot,
  validateBoneMove,
  validateDisplayMove,
  validateSlotMove
} from '@editor/commands/hierarchyCommands'
import type { MoveAnchor, MoveResult } from '@editor/commands/hierarchyCommands'
import ContextMenu from '@ui/widgets/ContextMenu'
import type { ContextMenuItem } from '@ui/widgets/ContextMenu'
import {
  hasImageDrag,
  hasTreeDrag,
  readImageDrag,
  readTreeDrag,
  setTreeDragData
} from '@ui/widgets/dragDrop'
import type { TreeDragPayload, TreeDropPosition } from '@ui/widgets/dragDrop'

/** 右键菜单的目标：root = 空白处 */
interface MenuTarget {
  kind: 'root' | 'bone' | 'slot' | 'constraint'
  name: string
  /** 挂载 / 驱动骨骼（新建对象会挂到它下面） */
  bone: string
}

interface TreeRowProps {
  depth: number
  label: string
  active: boolean
  icon: React.ReactNode
  meta?: string
  trailing?: React.ReactNode
  expandable?: boolean
  expanded?: boolean
  onToggle?: () => void
  onSelect: () => void
  onDelete?: () => void
  onContextMenu?: (event: React.MouseEvent) => void
  /** 接收资源面板拖来的图片（插槽行用它追加 display） */
  onDropImage?: (imageName: string) => void
  /** 该行归属的插槽名：既用于兜底判定「拖到插槽下面」，也让 display 行归到宿主插槽 */
  dataSlot?: string
  /** 树内拖动：该行本身可拖时给出负载（骨骼 / 插槽 / display） */
  dragPayload?: TreeDragPayload
  /** 接收树内拖动的节点；position 区分「放进这一行」与「排到上/下沿」 */
  onDropNode?: (payload: TreeDragPayload, position: TreeDropPosition) => void
}

/** 指针落在行的哪一段：上沿 / 中间（放进这一层）/ 下沿 */
function dropPositionOf(event: React.DragEvent<HTMLDivElement>): TreeDropPosition {
  const rect = event.currentTarget.getBoundingClientRect()
  const ratio = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0.5
  if (ratio < 0.28) return 'above'
  if (ratio > 0.72) return 'below'
  return 'inside'
}

function TreeRow({
  depth,
  label,
  active,
  icon,
  meta,
  trailing,
  expandable,
  expanded,
  onToggle,
  onSelect,
  onDelete,
  onContextMenu,
  onDropImage,
  dataSlot,
  dragPayload,
  onDropNode
}: TreeRowProps) {
  const [dropActive, setDropActive] = useState(false)
  /** 树内拖动时的高亮：放进行内 or 贴在上/下沿 */
  const [nodeHint, setNodeHint] = useState<TreeDropPosition | null>(null)

  const acceptsDrop = Boolean(onDropImage || onDropNode)

  return (
    <div
      className={[
        'group relative flex h-[22px] items-center gap-1 pr-1 text-panel transition-colors duration-panel cursor-pointer',
        active ? 'bg-accent/12 text-content-hi' : 'text-content-mid hover:bg-ink-700',
        dropActive ? 'ring-1 ring-inset ring-accent/70 bg-accent/10 text-content-hi' : '',
        nodeHint === 'inside' ? 'bg-accent/20 text-content-hi' : '',
        nodeHint === 'above' ? 'shadow-[inset_0_2px_0_0_rgba(34,211,238,0.9)]' : '',
        nodeHint === 'below' ? 'shadow-[inset_0_-2px_0_0_rgba(34,211,238,0.9)]' : '',
        dragPayload ? 'cursor-grab active:cursor-grabbing' : ''
      ].join(' ')}
      style={{ paddingLeft: 4 + depth * 12 }}
      data-slot={dataSlot}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      draggable={dragPayload ? true : undefined}
      onDragStart={
        dragPayload
          ? (event) => {
              setTreeDragData(event.dataTransfer, dragPayload)
              event.stopPropagation()
            }
          : undefined
      }
      onDragEnd={dragPayload ? () => setNodeHint(null) : undefined}
      onDragOver={
        acceptsDrop
          ? (event) => {
              const tree = hasTreeDrag(event.dataTransfer)
              if (!hasImageDrag(event.dataTransfer) && !tree) return
              event.preventDefault()
              event.stopPropagation()
              if (tree) {
                if (!onDropNode) return
                event.dataTransfer.dropEffect = 'move'
                const hint = dropPositionOf(event)
                if (nodeHint !== hint) setNodeHint(hint)
              } else {
                event.dataTransfer.dropEffect = 'copy'
                if (!dropActive) setDropActive(true)
              }
            }
          : undefined
      }
      onDragLeave={
        acceptsDrop
          ? () => {
              setDropActive(false)
              setNodeHint(null)
            }
          : undefined
      }
      onDrop={
        acceptsDrop
          ? (event) => {
              const tree = hasTreeDrag(event.dataTransfer)
              if (!hasImageDrag(event.dataTransfer) && !tree) return
              event.preventDefault()
              event.stopPropagation()
              setDropActive(false)
              setNodeHint(null)
              if (tree) {
                if (!onDropNode) return
                const payload = readTreeDrag(event.dataTransfer)
                if (payload) onDropNode(payload, dropPositionOf(event))
                return
              }
              const imageName = readImageDrag(event.dataTransfer)
              if (imageName) onDropImage?.(imageName)
            }
          : undefined
      }
    >
      {active ? <span className="absolute left-0 top-0 h-full w-[2px] bg-accent" /> : null}
      {expandable ? (
        <button
          type="button"
          className="flex h-[14px] w-[14px] shrink-0 items-center justify-center text-content-lo hover:text-content-hi"
          onClick={(e) => {
            e.stopPropagation()
            onToggle?.()
          }}
        >
          {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </button>
      ) : (
        <span className="w-[14px] shrink-0" />
      )}
      <span className="flex h-[14px] w-[14px] shrink-0 items-center justify-center text-content-lo">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {meta ? <span className="shrink-0 font-mono text-3xs text-content-lo">{meta}</span> : null}
      {trailing}
      {onDelete ? (
        <button
          type="button"
          title="删除"
          className="hidden h-[16px] w-[16px] items-center justify-center rounded text-danger/80 group-hover:flex hover:bg-danger/15"
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
        >
          <Trash2 size={11} />
        </button>
      ) : null}
    </div>
  )
}

const CONSTRAINT_ICON: Record<AuthoringConstraint['type'], React.ReactNode> = {
  ik: <Target size={11} className="text-accent/80" />,
  transform: <Maximize2 size={11} className="text-ok/80" />,
  path: <Route size={11} className="text-warn/80" />,
  // 物理约束仅在导入时保留数据（不参与求解），用弱化图标区分
  physics: <Activity size={11} className="text-content-lo" />
}

const CONSTRAINT_KIND: Record<AuthoringConstraint['type'], string> = {
  ik: 'IK',
  transform: '变换',
  path: '路径',
  physics: '物理'
}

export interface HierarchyTreeProps {
  /** 状态栏提示（Animate 态拒绝改绑定数据时说明原因） */
  onStatus?: (text: string) => void
}

/**
 * 层级树：骨骼、插槽、约束（含 IK）合并为**一棵树**，用图标区分类型。
 *
 * 组织结构：
 * - 根骨骼挂在顶层，子骨骼递归缩进（还原真实父子层级）
 * - 插槽作为其宿主骨骼的子节点（缩进一级），展开后列出它的 display
 * - 约束作为驱动骨骼（`bones[0]`）的子节点，图标按 IK / 变换 / 路径区分
 */
export default function HierarchyTree({ onStatus }: HierarchyTreeProps) {
  const document = useProjectStore((s) => s.document)
  const update = useProjectStore((s) => s.update)
  const selection = useSelectionStore()
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  /** 树列表容器：拖放兜底判定要用它量各行的位置 */
  const listRef = useRef<HTMLDivElement | null>(null)

  const bonesByParent = useMemo(() => groupBones(document.bones), [document.bones])
  // 插槽按 zOrder 倒序排：列表**上面的行画在更前面**（与 Photoshop / Figma 的图层列表一致），
  // 「上移一层」就是视觉上浮起来（zOrder 变大），不会出现列表方向与画面相反的别扭感。
  const slotsByBone = useMemo(() => {
    const grouped = groupByKey(document.slots, (slot) => slot.bone)
    for (const list of grouped.values()) list.sort((left, right) => right.zOrder - left.zOrder)
    return grouped
  }, [document.slots])
  const constraintsByBone = useMemo(
    () => groupByKey(document.constraints, (constraint) => constraint.bones[0] ?? ''),
    [document.constraints]
  )

  const toggle = (name: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  /** display 清单来自当前皮肤（空则 default），与属性面板的取法保持一致 */
  const activeSkin = useMemo(() => {
    const named = selection.skin ? document.skins.find((item) => item.name === selection.skin) : null
    return named ?? document.skins[0] ?? null
  }, [document.skins, selection.skin])

  const displaysOf = (slotName: string): EditorDocument['skins'][number]['slots'][number]['attachments'] =>
    activeSkin?.slots.find((item) => item.slot === slotName)?.attachments ?? []

  /**
   * 切换插槽当前显示的 display：一个插槽可以挂多个，但同时只显示 `slot.attachment` 这一个。
   */
  const selectDisplay = (slotName: string, attachmentName: string): void => {
    update('切换显示的 display', (draft) => {
      const target = draft.slots.find((item) => item.name === slotName)
      if (target) target.attachment = attachmentName
    })
    selection.selectAttachment(slotName, attachmentName)
  }

  /** 插槽 / display 都是绑定数据：Animate 态拒绝修改，避免污染动画基线 */
  const canEditBinding = (): boolean => {
    if (useModeStore.getState().mode === 'pose') return true
    onStatus?.('切到 Pose 状态才能改插槽的 display：插槽 / 附件属于绑定数据')
    return false
  }

  /** 资源面板拖进来的图片：作为新的 display 追加到该插槽，并立即切换显示 */
  const addDisplay = (slotName: string, imageName: string): void => {
    if (!canEditBinding()) return
    const image = document.images.find((item) => item.name === imageName)
    if (!image) return
    let created: { slot: string; attachment: string } | null = null
    update('拖入图片添加 display', (draft) => {
      created = addImageDisplay(draft, {
        image: image.name,
        slot: slotName,
        width: image.width,
        height: image.height,
        skin: selection.skin
      })
    })
    if (created) {
      const result: { slot: string; attachment: string } = created
      selection.selectAttachment(result.slot, result.attachment)
      // 插槽行可能被折叠着，展开宿主骨骼让新 display 可见
      expandBone(boneOfSlot(slotName))
    }
  }

  /**
   * 调整插槽层级（= 绘制顺序）：只重排 zOrder，不动 slots 数组本身。
   * 上层后绘制、会盖住下层；「上移」就是和上面那个换位。要显示在更前面就把 zOrder 调大。
   */
  const nudgeSlotOrder = (slotName: string, direction: 'up' | 'down' | 'top' | 'bottom'): void => {
    const label =
      direction === 'up' ? '上移一层' : direction === 'down' ? '下移一层' : direction === 'top' ? '置顶' : '置底'
    update(`插槽${label}`, (draft) => {
      const ordered = [...draft.slots].sort((left, right) => left.zOrder - right.zOrder)
      const index = ordered.findIndex((item) => item.name === slotName)
      if (index < 0) return
      const [moved] = ordered.splice(index, 1)
      // ordered 是 zOrder 升序（越靠后画得越晚 = 显示在越前面），所以「上移」= 往后挪一位
      const target =
        direction === 'up'
          ? index + 1
          : direction === 'down'
            ? index - 1
            : direction === 'top'
              ? ordered.length
              : 0
      ordered.splice(Math.max(0, Math.min(ordered.length, target)), 0, moved)
      ordered.forEach((item, order) => {
        item.zOrder = order
      })
    })
  }

  /** 树内拖放的统一入口：按「拖的是什么 / 落到哪种行」分派，并挡掉不允许的组合 */
  const handleNodeDrop = (
    payload: TreeDragPayload,
    target: { kind: 'bone' | 'slot' | 'display'; name: string; slot?: string },
    position: TreeDropPosition
  ): void => {
    if (!canEditBinding()) return

    if (payload.kind === 'bone') {
      if (target.kind !== 'bone') {
        onStatus?.('骨骼只能放到骨骼下面（或拖到列表空白处成为根骨骼）')
        return
      }
      const check = validateBoneMove(document, payload.name, target.name)
      if (!check.ok) {
        onStatus?.(check.message)
        return
      }
      let result: MoveResult = check
      update('调整骨骼层级', (draft) => {
        result = moveBone(draft, payload.name, target.name, position)
      })
      if (result.message) onStatus?.(result.message)
      return
    }

    if (payload.kind === 'slot') {
      if (target.kind !== 'bone') {
        onStatus?.('插槽只能放到骨骼下面（不能挂到插槽或 display 之下）')
        return
      }
      const check = validateSlotMove(document, payload.name, target.name)
      if (!check.ok) {
        onStatus?.(check.message)
        return
      }
      let result: MoveResult = check
      update('调整插槽层级', (draft) => {
        const anchor = position === 'inside' ? null : boneSlotAnchor(document, target.name, position)
        result = moveSlot(draft, payload.name, target.name, anchor)
      })
      if (result.message) onStatus?.(result.message)
      return
    }

    // display：只能待在插槽下面；落到 display 行上表示在同一插槽内排序
    if (target.kind === 'slot') {
      runDisplayMove(payload, target.name, null)
      return
    }
    if (target.kind === 'display' && target.slot) {
      const before = position === 'below' ? 'after' : 'before'
      runDisplayMove(payload, target.slot, { name: target.name, side: before })
      return
    }
    onStatus?.('display 只能放到插槽下面')
  }

  /** display 的移动/排序统一走这里：先校验再落历史，落点提示交给命令层的返回消息 */
  const runDisplayMove = (payload: TreeDragPayload, toSlot: string, anchor: MoveAnchor | null): void => {
    if (payload.kind !== 'display') return
    const skinName = activeSkin?.name ?? 'default'
    const check = validateDisplayMove(document, payload.slot, payload.name, toSlot, skinName)
    if (!check.ok) {
      onStatus?.(check.message)
      return
    }
    let result: MoveResult = check
    update('移动 display', (draft) => {
      result = moveDisplay(draft, payload.slot, payload.name, toSlot, anchor, skinName)
    })
    if (result.message) onStatus?.(result.message)
  }

  /** 资源面板拖到骨骼行：在该骨骼下新建插槽，图片作为它的第一个 display */
  const addSlotFromImage = (boneName: string, imageName: string): void => {
    if (!canEditBinding()) return
    const image = document.images.find((item) => item.name === imageName)
    if (!image) return
    let created: { slot: string; attachment: string } | null = null
    update('拖入图片新建插槽', (draft) => {
      created = createRegionFromImage(draft, {
        image: image.name,
        bone: boneName,
        width: image.width,
        height: image.height,
        skin: selection.skin
      })
    })
    if (created) {
      const result: { slot: string; attachment: string } = created
      selection.selectAttachment(result.slot, result.attachment)
      expandBone(boneName)
    }
  }

  /** 展开某根骨骼（新建子对象后自动展开，避免「加了却看不见」） */
  const expandBone = (boneName: string): void => {
    if (!boneName) return
    setCollapsed((prev) => (prev.has(boneName) ? new Set([...prev].filter((name) => name !== boneName)) : prev))
  }

  /** 插槽挂在哪根骨骼上（拖放后展开宿主用） */
  const boneOfSlot = (slotName: string): string =>
    document.slots.find((item) => item.name === slotName)?.bone ?? ''

  /**
   * 拖到「插槽下面」的区域（行与行之间的缝隙、插槽子行的下沿等）时，
   * 按 Y 坐标找鼠标上方最近的那个插槽行，把这次拖拽算到它头上。
   */
  const slotUnderPointer = (clientY: number): string => {
    const list = listRef.current
    if (!list) return ''
    let found = ''
    let top = Number.NEGATIVE_INFINITY
    for (const row of Array.from(list.querySelectorAll<HTMLElement>('[data-slot]'))) {
      const rect = row.getBoundingClientRect()
      if (rect.top <= clientY && rect.top > top) {
        top = rect.top
        found = row.dataset.slot ?? ''
      }
    }
    return found
  }

  /** 当前选中的骨骼（工具栏「+」按钮用它作为挂载目标） */
  const selectedBone = (): string => (selection.kind === 'bone' && selection.bone ? selection.bone : '')

  const addBone = (parent = selectedBone()): void => {
    update('新建骨骼', (draft) => {
      const baseName = parent ? `${parent}_child` : 'bone'
      draft.bones.push(
        createAuthoringBone({
          name: uniqueName(draft.bones.map((b) => b.name), baseName),
          parent,
          length: 0.4
        })
      )
    })
    if (parent) setCollapsed((prev) => (prev.has(parent) ? new Set([...prev].filter((n) => n !== parent)) : prev))
  }

  const addSlot = (bone = selectedBone()): void => {
    update('新建插槽', (draft) => {
      const host = bone || draft.bones[0]?.name || ''
      const name = uniqueName(draft.slots.map((s) => s.name), 'slot')
      draft.slots.push(createAuthoringSlot({ name, bone: host, zOrder: draft.slots.length }))
      draft.skins[0]?.slots.push({ slot: name, attachments: [] })
    })
    if (bone) setCollapsed((prev) => (prev.has(bone) ? new Set([...prev].filter((n) => n !== bone)) : prev))
  }

  const addConstraint = (kind: AuthoringConstraint['type'], bone = selectedBone()): void => {
    update('新建约束', (draft) => {
      const driver = bone || draft.bones[0]?.name || ''
      const name = uniqueName(draft.constraints.map((c) => c.name), kind)
      const base = { name, order: draft.constraints.length, enabled: true, bones: driver ? [driver] : [], target: '' }
      if (kind === 'ik') draft.constraints.push({ ...createIkConstraint(), ...base, type: 'ik' })
      else if (kind === 'transform') {
        draft.constraints.push({ ...createTransformConstraint(), ...base, type: 'transform' })
      } else draft.constraints.push({ ...createPathConstraint(), ...base, type: 'path' })
    })
    if (bone) setCollapsed((prev) => (prev.has(bone) ? new Set([...prev].filter((n) => n !== bone)) : prev))
  }

  /** 右键菜单：记录点击位置与目标对象 */
  const [menu, setMenu] = useState<{ x: number; y: number; target: MenuTarget } | null>(null)

  const openMenu = (event: React.MouseEvent, target: MenuTarget): void => {
    event.preventDefault()
    event.stopPropagation()
    if (target.kind === 'bone') selection.selectBone(target.name)
    else if (target.kind === 'slot') selection.selectSlot(target.name)
    else if (target.kind === 'constraint') selection.selectConstraint(target.name)
    setMenu({ x: event.clientX, y: event.clientY, target })
  }

  const menuItems = (target: MenuTarget): ContextMenuItem[] => {
    const host = target.kind === 'bone' ? target.name : target.bone
    const where = target.kind === 'bone' ? `挂在「${target.name}」下` : host ? `挂在「${host}」下` : '挂在根层'
    const items: ContextMenuItem[] = [
      {
        key: 'bone',
        label: '添加骨骼',
        hint: where,
        icon: <Bone size={12} />,
        onSelect: () => addBone(host)
      },
      {
        key: 'slot',
        label: '添加插槽',
        hint: host ? `挂在骨骼「${host}」上` : '挂到第一根骨骼',
        icon: <Plus size={12} />,
        onSelect: () => addSlot(host)
      },
      { key: 'sep1', label: '', separator: true },
      {
        key: 'ik',
        label: '添加 IK 约束',
        hint: host ? `驱动骨骼：「${host}」` : '未指定驱动骨骼',
        icon: <Target size={12} />,
        onSelect: () => addConstraint('ik', host)
      },
      {
        key: 'transform',
        label: '添加变换约束',
        hint: '继承位移 / 旋转 / 缩放 / 错切',
        icon: <Maximize2 size={12} />,
        onSelect: () => addConstraint('transform', host)
      },
      {
        key: 'path',
        label: '添加路径约束',
        hint: '骨骼沿路径曲线排布',
        icon: <Route size={12} />,
        onSelect: () => addConstraint('path', host)
      }
    ]
    if (target.kind === 'slot') {
      items.push(
        { key: 'sep-order', label: '', separator: true },
        {
          key: 'slot-up',
          label: '上移一层',
          hint: '更晚绘制，会盖住下面的插槽',
          onSelect: () => nudgeSlotOrder(target.name, 'up')
        },
        {
          key: 'slot-down',
          label: '下移一层',
          hint: '更早绘制，被上面的插槽盖住',
          onSelect: () => nudgeSlotOrder(target.name, 'down')
        },
        { key: 'slot-top', label: '置顶', hint: '画在所有插槽之上', onSelect: () => nudgeSlotOrder(target.name, 'top') },
        { key: 'slot-bottom', label: '置底', hint: '画在所有插槽之下', onSelect: () => nudgeSlotOrder(target.name, 'bottom') }
      )
    }
    if (target.kind !== 'root') {
      items.push(
        { key: 'sep2', label: '', separator: true },
        {
          key: 'delete',
          label: `删除「${target.name}」`,
          danger: true,
          disabled: target.kind === 'bone' && document.bones.length <= 1,
          hint: target.kind === 'bone' && document.bones.length <= 1 ? '至少保留一根骨骼' : undefined,
          icon: <Trash2 size={12} />,
          onSelect: () => {
            if (target.kind === 'slot') {
              update('删除插槽', (draft) => {
                draft.slots = draft.slots.filter((s) => s.name !== target.name)
                for (const skin of draft.skins) skin.slots = skin.slots.filter((s) => s.slot !== target.name)
              })
              return
            }
            if (target.kind === 'constraint') {
              removeConstraint(update, target.name)
              return
            }
            update('删除骨骼', (draft) => {
              draft.bones = draft.bones.filter((b) => b.name !== target.name)
              for (const child of draft.bones) if (child.parent === target.name) child.parent = ''
              draft.slots = draft.slots.filter((s) => s.bone !== target.name)
            })
          }
        }
      )
    }
    return items
  }

  const rows: React.ReactNode[] = []

  const pushBone = (bone: AuthoringBone, depth: number): void => {
    const children = bonesByParent.get(bone.name) ?? []
    const slots = slotsByBone.get(bone.name) ?? []
    const constraints = constraintsByBone.get(bone.name) ?? []
    const hasChildren = children.length + slots.length + constraints.length > 0
    const expanded = !collapsed.has(bone.name)

    rows.push(
      <TreeRow
        key={`bone:${bone.name}`}
        dragPayload={{ kind: 'bone', name: bone.name }}
        onDropNode={(payload, position) => handleNodeDrop(payload, { kind: 'bone', name: bone.name }, position)}
        depth={depth}
        label={bone.name}
        active={selection.kind === 'bone' && selection.bone === bone.name}
        icon={<Bone size={11} style={{ color: bone.color }} />}
        meta={bone.length > 0 ? `${(bone.length * 100).toFixed(0)}px` : undefined}
        expandable={hasChildren}
        expanded={expanded}
        onToggle={() => toggle(bone.name)}
        onSelect={() => selection.selectBone(bone.name)}
        // 拖到骨骼行 = 在这根骨骼下新建一个插槽
        onDropImage={(imageName) => addSlotFromImage(bone.name, imageName)}
        onContextMenu={(event) => openMenu(event, { kind: 'bone', name: bone.name, bone: bone.parent })}
        trailing={
          <button
            type="button"
            title={bone.locked ? '解锁' : '锁定'}
            className="flex h-[16px] w-[16px] items-center justify-center rounded text-content-lo hover:bg-ink-600 hover:text-content-hi"
            onClick={(e) => {
              e.stopPropagation()
              update('切换骨骼锁定', (draft) => {
                const target = draft.bones.find((b) => b.name === bone.name)
                if (target) target.locked = !target.locked
              })
            }}
          >
            {bone.locked ? <Lock size={11} /> : <Unlock size={11} />}
          </button>
        }
        onDelete={
          document.bones.length > 1
            ? () =>
                update('删除骨骼', (draft) => {
                  draft.bones = draft.bones.filter((b) => b.name !== bone.name)
                  for (const child of draft.bones) if (child.parent === bone.name) child.parent = ''
                  draft.slots = draft.slots.filter((s) => s.bone !== bone.name)
                })
            : undefined
        }
      />
    )

    if (!expanded) return
    for (const child of children) pushBone(child, depth + 1)
    for (const slot of slots) pushSlot(slot, depth + 1)
    for (const constraint of constraints) rows.push(renderConstraint(constraint, depth + 1))
  }

  /** 插槽下的一个 display（附件）行：点它 = 切到这个 display（同一时刻只显示一个） */
  const renderDisplay = (
    slot: EditorDocument['slots'][number],
    attachment: EditorDocument['skins'][number]['slots'][number]['attachments'][number],
    depth: number
  ): React.ReactNode => {
    const showing = slot.attachment === attachment.name
    return (
      <TreeRow
        key={`display:${slot.name}:${attachment.name}`}
        dragPayload={{ kind: 'display', slot: slot.name, name: attachment.name }}
        onDropNode={(payload, position) =>
          handleNodeDrop(payload, { kind: 'display', name: attachment.name, slot: slot.name }, position)
        }
        depth={depth}
        label={attachment.name}
        active={
          selection.kind === 'attachment' &&
          selection.slot === slot.name &&
          selection.attachment === attachment.name
        }
        icon={
          <ImageIcon
            size={11}
            className={showing ? 'text-accent' : 'text-content-lo/60'}
          />
        }
        meta={showing ? '显示中' : undefined}
        // display 行也算宿主插槽的地盘：拖到插槽下面（含子行）都是「给这个插槽加 display」
        dataSlot={slot.name}
        onDropImage={(imageName) => addDisplay(slot.name, imageName)}
        onSelect={() => selectDisplay(slot.name, attachment.name)}
        onDelete={() =>
          update('删除 display', (draft) => deleteAttachment(draft, slot.name, attachment.name))
        }
      />
    )
  }

  const pushedSlots = new Set<string>()
  const pushSlot = (slot: EditorDocument['slots'][number], depth: number): void => {
    // 同名插槽只渲染一次：异常数据（重名）或热更新残留时也不至于把树撑重复
    if (pushedSlots.has(slot.name)) return
    pushedSlots.add(slot.name)
    const displays = displaysOf(slot.name)
    const expanded = !collapsed.has(`slot:${slot.name}`)
    rows.push(
      <TreeRow
        key={`slot:${slot.name}`}
        dragPayload={{ kind: 'slot', name: slot.name }}
        onDropNode={(payload, position) => handleNodeDrop(payload, { kind: 'slot', name: slot.name }, position)}
        depth={depth}
        label={slot.name}
        active={selection.kind === 'slot' && selection.slot === slot.name}
        icon={
          <span
            className="h-[10px] w-[10px] rounded-sm border border-line"
            style={{ background: toCss(slot.color) }}
          />
        }
        // 行尾显示当前显示的 display 名，不用展开也知道显示的是哪一个
        meta={slot.attachment || (displays.length > 0 ? `${displays.length} 个 display` : undefined)}
        expandable={displays.length > 0}
        expanded={expanded}
        dataSlot={slot.name}
        onToggle={() => toggle(`slot:${slot.name}`)}
        onSelect={() => selection.selectSlot(slot.name)}
        onDropImage={(imageName) => addDisplay(slot.name, imageName)}
        onContextMenu={(event) => openMenu(event, { kind: 'slot', name: slot.name, bone: slot.bone })}
        trailing={
          <button
            type="button"
            title={slot.visible ? '隐藏插槽' : '显示插槽'}
            className="flex h-[16px] w-[16px] items-center justify-center rounded text-content-lo hover:bg-ink-600 hover:text-content-hi"
            onClick={(e) => {
              e.stopPropagation()
              update('切换插槽可见性', (draft) => {
                const target = draft.slots.find((s) => s.name === slot.name)
                if (target) target.visible = !target.visible
              })
            }}
          >
            {slot.visible ? <Eye size={11} /> : <EyeOff size={11} />}
          </button>
        }
        onDelete={() =>
          update('删除插槽', (draft) => {
            draft.slots = draft.slots.filter((s) => s.name !== slot.name)
            for (const skin of draft.skins) skin.slots = skin.slots.filter((s) => s.slot !== slot.name)
          })
        }
      />
    )

    if (!expanded) return
    for (const attachment of displays) rows.push(renderDisplay(slot, attachment, depth + 1))
  }

  const renderConstraint = (constraint: AuthoringConstraint, depth: number): React.ReactNode => (
    <TreeRow
      key={`constraint:${constraint.name}`}
      depth={depth}
      label={constraint.name}
      active={selection.kind === 'constraint' && selection.constraint === constraint.name}
      icon={CONSTRAINT_ICON[constraint.type] ?? <Link2 size={11} />}
      meta={constraint.type === 'ik' ? `${CONSTRAINT_KIND.ik} ${constraint.bones.length}骨` : CONSTRAINT_KIND[constraint.type]}
      onSelect={() => selection.selectConstraint(constraint.name)}
      onContextMenu={(event) =>
        openMenu(event, { kind: 'constraint', name: constraint.name, bone: constraint.bones[0] ?? '' })
      }
      onDelete={() => removeConstraint(update, constraint.name)}
    />
  )

  for (const bone of bonesByParent.get('') ?? []) pushBone(bone, 0)

  // 兜底：骨骼不存在时（异常数据）把插槽 / 约束挂到根层，避免对象彻底消失
  const boneNames = new Set(document.bones.map((b) => b.name))
  for (const slot of document.slots) if (!boneNames.has(slot.bone)) pushSlot(slot, 0)
  for (const constraint of document.constraints) {
    if (!constraint.bones[0] || !boneNames.has(constraint.bones[0])) rows.push(renderConstraint(constraint, 0))
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-[24px] shrink-0 items-center gap-1 border-b border-line/60 bg-ink-800/80 px-1">
        <button type="button" title="新建骨骼（挂在当前选中骨骼下）" className="hao-btn h-[18px] px-1.5 text-3xs" onClick={() => addBone()}>
          <Bone size={11} />
          <span>骨骼</span>
        </button>
        <button type="button" title="新建插槽（挂到当前选中骨骼）" className="hao-btn h-[18px] px-1.5 text-3xs" onClick={() => addSlot()}>
          <Plus size={11} />
          <span>插槽</span>
        </button>
        <button
          type="button"
          title="新建 IK 约束"
          className="hao-btn h-[18px] px-1.5 text-3xs"
          onClick={() => addConstraint('ik')}
        >
          <Target size={11} />
        </button>
        <button
          type="button"
          title="新建变换约束"
          className="hao-btn h-[18px] px-1.5 text-3xs"
          onClick={() => addConstraint('transform')}
        >
          <Maximize2 size={11} />
        </button>
        <button
          type="button"
          title="新建路径约束"
          className="hao-btn h-[18px] px-1.5 text-3xs"
          onClick={() => addConstraint('path')}
        >
          <Route size={11} />
        </button>
        <span className="ml-auto font-mono text-3xs text-content-lo">{rows.length}</span>
      </div>
      <div
        ref={listRef}
        className="min-h-0 flex-1 overflow-auto hao-scroll pb-1"
        title={
          '右键可添加骨骼 / 插槽 / 约束\n' +
          '拖动行来调整层级：骨骼 → 骨骼下（或空白处成为根骨骼）、插槽 → 骨骼下、display → 插槽下\n' +
          '拖动行的上/下沿可以排序；把资源面板的图片拖到插槽行 = 给该插槽加一个 display'
        }
        onContextMenu={(event) => openMenu(event, { kind: 'root', name: '', bone: '' })}
        onDragOver={(event) => {
          const tree = hasTreeDrag(event.dataTransfer)
          if (!hasImageDrag(event.dataTransfer) && !tree) return
          // 行本身没接住时（行间缝隙 / 插槽下方）在这里兜底，同时别冒泡去触发整窗导入覆盖层
          event.preventDefault()
          event.stopPropagation()
          event.dataTransfer.dropEffect = tree ? 'move' : 'copy'
        }}
        onDrop={(event) => {
          const tree = hasTreeDrag(event.dataTransfer)
          if (!hasImageDrag(event.dataTransfer) && !tree) return
          event.preventDefault()
          event.stopPropagation()
          if (tree) {
            // 落到列表空白处：骨骼变根骨骼、插槽挂到第一根骨骼；display 不在这里收
            const payload = readTreeDrag(event.dataTransfer)
            if (!payload) return
            if (payload.kind === 'bone') {
              let result: MoveResult = { ok: false, message: '' }
              update('调整骨骼层级', (draft) => {
                result = moveBone(draft, payload.name, '', 'inside')
              })
              if (result.message) onStatus?.(result.message)
              return
            }
            if (payload.kind === 'slot') {
              const first = document.bones[0]?.name ?? ''
              if (!first) return
              let result: MoveResult = { ok: false, message: '' }
              update('调整插槽层级', (draft) => {
                result = moveSlot(draft, payload.name, first, null)
              })
              if (result.message) onStatus?.(result.message)
              return
            }
            onStatus?.('display 只能放到插槽下面')
            return
          }
          const imageName = readImageDrag(event.dataTransfer)
          const slotName = slotUnderPointer(event.clientY)
          if (imageName && slotName) addDisplay(slotName, imageName)
        }}
      >
        {rows}
      </div>

      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          title={
            menu.target.kind === 'root'
              ? '新建对象'
              : `${menu.target.kind === 'bone' ? '骨骼' : menu.target.kind === 'slot' ? '插槽' : '约束'}「${menu.target.name}」`
          }
          items={menuItems(menu.target)}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  )
}

function removeConstraint(update: (label: string, mutate: (draft: EditorDocument) => void) => void, name: string): void {
  update('删除约束', (draft) => {
    draft.constraints = draft.constraints.filter((c) => c.name !== name)
    for (const animation of draft.animations) {
      animation.constraints = animation.constraints.filter((t) => t.constraint !== name)
    }
  })
}

function groupBones(bones: readonly AuthoringBone[]): Map<string, AuthoringBone[]> {
  const map = new Map<string, AuthoringBone[]>()
  const names = new Set(bones.map((b) => b.name))
  for (const bone of bones) {
    const parent = bone.parent && names.has(bone.parent) ? bone.parent : ''
    const list = map.get(parent) ?? []
    list.push(bone)
    map.set(parent, list)
  }
  return map
}

function groupByKey<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const item of items) {
    const name = key(item)
    const list = map.get(name) ?? []
    list.push(item)
    map.set(name, list)
  }
  return map
}

function uniqueName(existing: readonly string[], base: string): string {
  if (!existing.includes(base)) return base
  let index = 2
  while (existing.includes(`${base}_${index}`)) index++
  return `${base}_${index}`
}

function toCss(hex: string): string {
  const rgb = hex.length === 9 ? hex.slice(0, 7) : hex
  return rgb.startsWith('#') ? rgb : '#ffffff'
}

export type { AuthoringConstraint }

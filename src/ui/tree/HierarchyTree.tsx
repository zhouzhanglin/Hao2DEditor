import { useMemo, useState } from 'react'
import {
  Activity,
  Bone,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
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
import { createIkConstraint, createPathConstraint, createTransformConstraint } from '@core/model/constraints'
import type { AuthoringBone, AuthoringConstraint, EditorDocument } from '@core/model/authoring'
import { createAuthoringBone, createAuthoringSlot } from '@core/model/authoring'
import ContextMenu from '@ui/widgets/ContextMenu'
import type { ContextMenuItem } from '@ui/widgets/ContextMenu'

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
  onContextMenu
}: TreeRowProps) {
  return (
    <div
      className={[
        'group relative flex h-[22px] items-center gap-1 pr-1 text-panel transition-colors duration-panel cursor-pointer',
        active ? 'bg-accent/12 text-content-hi' : 'text-content-mid hover:bg-ink-700'
      ].join(' ')}
      style={{ paddingLeft: 4 + depth * 12 }}
      onClick={onSelect}
      onContextMenu={onContextMenu}
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

/**
 * 层级树：骨骼、插槽、约束（含 IK）合并为**一棵树**，用图标区分类型。
 *
 * 组织结构：
 * - 根骨骼挂在顶层，子骨骼递归缩进（还原真实父子层级）
 * - 插槽作为其宿主骨骼的子节点（缩进一级）
 * - 约束作为驱动骨骼（`bones[0]`）的子节点，图标按 IK / 变换 / 路径区分
 */
export default function HierarchyTree() {
  const document = useProjectStore((s) => s.document)
  const update = useProjectStore((s) => s.update)
  const selection = useSelectionStore()
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())

  const bonesByParent = useMemo(() => groupBones(document.bones), [document.bones])
  const slotsByBone = useMemo(() => groupByKey(document.slots, (slot) => slot.bone), [document.slots])
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
        depth={depth}
        label={bone.name}
        active={selection.kind === 'bone' && selection.bone === bone.name}
        icon={<Bone size={11} style={{ color: bone.color }} />}
        meta={bone.length > 0 ? `${(bone.length * 100).toFixed(0)}px` : undefined}
        expandable={hasChildren}
        expanded={expanded}
        onToggle={() => toggle(bone.name)}
        onSelect={() => selection.selectBone(bone.name)}
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
    for (const slot of slots) rows.push(renderSlot(slot, depth + 1))
    for (const constraint of constraints) rows.push(renderConstraint(constraint, depth + 1))
  }

  const renderSlot = (slot: EditorDocument['slots'][number], depth: number): React.ReactNode => (
    <TreeRow
      key={`slot:${slot.name}`}
      depth={depth}
      label={slot.name}
      active={selection.kind === 'slot' && selection.slot === slot.name}
      icon={
        <span
          className="h-[10px] w-[10px] rounded-sm border border-line"
          style={{ background: toCss(slot.color) }}
        />
      }
      onSelect={() => selection.selectSlot(slot.name)}
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
  for (const slot of document.slots) if (!boneNames.has(slot.bone)) rows.push(renderSlot(slot, 0))
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
        className="min-h-0 flex-1 overflow-auto hao-scroll pb-1"
        title="右键可添加骨骼 / 插槽 / 约束"
        onContextMenu={(event) => openMenu(event, { kind: 'root', name: '', bone: '' })}
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

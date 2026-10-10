import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  Bone,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Grid3x3,
  Image as ImageIcon,
  KeyRound,
  Link2,
  Lock,
  Maximize2,
  Plus,
  Route,
  Search,
  Trash2,
  Unlock,
  X
} from 'lucide-react'
import type { AuthoringAttachmentType } from '@core/model/authoring'
import { useProjectStore } from '@editor/store/projectStore'
import { useSelectionStore } from '@editor/store/selectionStore'
import { useRevealStore } from '@editor/store/revealStore'
import { useModeStore } from '@editor/store/modeStore'
import { useTimelineStore } from '@editor/store/timelineStore'
import { useThrottledPlayheadTime } from '@editor/store/playheadStore'
import { keySlotDisplayNow, keyframeTargetsNow } from '@editor/timeline/actions'
import { CONSTRAINT_CHANNEL_LABEL, CONSTRAINT_CHANNELS, slotDisplayNameAt } from '@editor/timeline/model'
import type { KeyframeTarget } from '@editor/timeline/model'
import { getActiveScene } from '@editor/activeScene'
import { focusNode } from '@editor/focusNode'
import type { FocusTarget } from '@editor/focusNode'
import { createIkConstraint, createPathConstraint, createTransformConstraint } from '@core/model/constraints'
import type { AuthoringBone, AuthoringConstraint, AuthoringImage, EditorDocument } from '@core/model/authoring'
import { createAuthoringBone, createAuthoringSlot } from '@core/model/authoring'
import {
  addImageDisplay,
  createRegionFromImage,
  deleteAttachment,
  deleteSlot,
  toggleSlotDisplay
} from '@editor/commands/authoringCommands'
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
  /**
   * 整行悬浮描述（原生 title，多行用 `\n` 分隔）。
   *
   * 只挂在行容器上：行内按钮自带 title（眼睛 / 锁 / 图标 / 删除），悬浮到按钮上时
   * 浏览器显示的是按钮自己的那句，不会被行描述盖掉。
   */
  title?: string
  active: boolean
  /** 多选里的**次要**选中行（选中集合中非主选中的那几根）：高亮淡一档，一眼认出主选中 */
  secondary?: boolean
  icon: React.ReactNode
  /** 图标可点击：行内快捷操作（display 行 = 切换显示 / 隐藏）。不传则图标只是装饰 */
  onIconClick?: (event: React.MouseEvent<HTMLButtonElement>) => void
  iconTitle?: string
  /** 行首第一列：显示 / 隐藏（插槽的 visible）。不传则该列留空占位，保证各行列对齐 */
  visibleSwitch?: { on: boolean; title: string; onToggle: () => void }
  /** 行首第二列：锁定 / 解锁（骨骼的 locked）。不传则该列留空占位 */
  lockSwitch?: { on: boolean; title: string; onToggle: () => void }
  meta?: string
  trailing?: React.ReactNode
  expandable?: boolean
  expanded?: boolean
  onToggle?: () => void
  /** 行点击；**带事件**是为了识别 Shift / Cmd 多选（骨骼行用），写 `() => …` 也兼容 */
  onSelect: (event: React.MouseEvent) => void
  onDelete?: () => void
  onContextMenu?: (event: React.MouseEvent) => void
  /** 接收资源面板拖来的图片（可多选成组；插槽行用它追加 display） */
  onDropImage?: (imageNames: string[]) => void
  /** 该行归属的插槽名：既用于兜底判定「拖到插槽下面」，也让 display 行归到宿主插槽 */
  dataSlot?: string
  /** 树内拖动：该行本身可拖时给出负载（骨骼 / 插槽 / display） */
  dragPayload?: TreeDragPayload
  /** 接收树内拖动的节点；position 区分「放进这一行」与「排到上/下沿」 */
  onDropNode?: (payload: TreeDragPayload, position: TreeDropPosition) => void
  /**
   * 双击行时聚焦视口的目标。**不传时按 `dragPayload` 推导** —— 骨骼 / 插槽 / display
   * 三种拖动负载的形状与 FocusTarget 完全一致，所以只有约束行需要显式给。
   */
  focusTarget?: FocusTarget
  /** 骨骼行用 `data-bone` 标出名字：定位（滚过来 + 闪一下）靠它查这一行 */
  dataBone?: string
  /** 非 0 时整行闪一下（定位请求；父组件 900ms 后清 0，靠这个开关重启动画） */
  flashKey?: number
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
  title,
  active,
  icon,
  onIconClick,
  iconTitle,
  visibleSwitch,
  lockSwitch,
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
  onDropNode,
  focusTarget,
  dataBone,
  flashKey,
  secondary
}: TreeRowProps) {
  const [dropActive, setDropActive] = useState(false)
  /** 树内拖动时的高亮：放进行内 or 贴在上/下沿 */
  const [nodeHint, setNodeHint] = useState<TreeDropPosition | null>(null)

  const acceptsDrop = Boolean(onDropImage || onDropNode)

  /**
   * 双击聚焦的目标：显式给的优先（约束行），否则直接用拖动负载 ——
   * 骨骼 / 插槽 / display 三种负载的形状与 FocusTarget 相同，不必逐行重复声明。
   */
  const focus: FocusTarget | undefined = focusTarget ?? dragPayload

  return (
    <div
      className={[
        // macOS 列表行：24px 行高；选中是「左右留白的圆角色块」（Finder 的选中不是通栏色块）
        'group relative mx-1 flex h-[22px] items-center gap-1 rounded-[5px] px-1 text-panel transition-colors duration-panel cursor-pointer',
        active
          ? secondary
            ? 'bg-accent-deep/60 text-white'
            : 'bg-accent-deep text-white'
          : 'text-content-hi hover:bg-white/[0.07]',
        dropActive ? 'ring-1 ring-inset ring-accent/70 bg-accent/10 text-content-hi' : '',
        nodeHint === 'inside' ? 'bg-accent/20 text-content-hi' : '',
        nodeHint === 'above' ? 'shadow-[inset_0_2px_0_0_rgba(34,211,238,0.9)]' : '',
        nodeHint === 'below' ? 'shadow-[inset_0_-2px_0_0_rgba(34,211,238,0.9)]' : '',
        // 定位高亮：整行闪一下橙色底（见 .hao-reveal-flash），动画结束后再接管回本行样式
        flashKey ? 'hao-reveal-flash' : '',
        dragPayload ? 'cursor-grab active:cursor-grabbing' : ''
      ].join(' ')}
      title={title}
      data-slot={dataSlot}
      data-bone={dataBone}
      onClick={onSelect}
      onDoubleClick={
        focus
          ? (event) => {
              // 双击行内按钮（展开箭头 / 锁 / 删除）是在操作那个按钮，不聚焦视口
              if ((event.target as HTMLElement).closest('button')) return
              focusNode(useProjectStore.getState().document, focus)
            }
          : undefined
      }
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
              const imageNames = readImageDrag(event.dataTransfer)
              if (imageNames.length > 0) onDropImage?.(imageNames)
            }
          : undefined
      }
    >
      {active ? <span className="absolute left-0 top-0 h-full w-[2px] bg-accent" /> : null}
      {/* 行首两列（固定宽度、不随层级缩进）：显示 / 锁定 */}
      <span className="flex w-[18px] shrink-0 justify-center">
        {visibleSwitch ? (
          <button
            type="button"
            tabIndex={-1}
            title={visibleSwitch.title}
            className={[
              'flex h-[16px] w-[16px] cursor-pointer items-center justify-center rounded hover:bg-ink-600',
              // 显示中 = 常规色；已隐藏 = 警示色（一眼看出这行被关掉了）
              visibleSwitch.on ? 'text-content-mid hover:text-content-hi' : 'text-warn/75 hover:text-warn'
            ].join(' ')}
            onClick={(event) => {
              // 行首开关：拦掉冒泡，别连带选中整行
              event.stopPropagation()
              visibleSwitch.onToggle()
            }}
          >
            {visibleSwitch.on ? <Eye size={11} /> : <EyeOff size={11} />}
          </button>
        ) : null}
      </span>
      <span className="flex w-[18px] shrink-0 justify-center">
        {lockSwitch ? (
          <button
            type="button"
            tabIndex={-1}
            title={lockSwitch.title}
            className={[
              'flex h-[16px] w-[16px] cursor-pointer items-center justify-center rounded hover:bg-ink-600',
              // 已锁 = 琥珀色**实心**锁（最醒目）；未锁 = 很淡的开口锁，悬停该行时才提亮
              lockSwitch.on
                ? 'text-warn hover:text-warn'
                : 'text-content-lo/45 group-hover:text-content-mid'
            ].join(' ')}
            onClick={(event) => {
              event.stopPropagation()
              lockSwitch.onToggle()
            }}
          >
            {lockSwitch.on ? <Lock size={11} fill="currentColor" /> : <Unlock size={11} />}
          </button>
        ) : null}
      </span>
      {/* 内容：层级缩进只作用在这里，两列始终对齐在最左侧 */}
      <div className="flex min-w-0 flex-1 items-center gap-1" style={{ paddingLeft: depth * 12 }}>
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
        {onIconClick ? (
          <button
            type="button"
            tabIndex={-1}
            title={iconTitle}
            className="flex h-[14px] w-[14px] shrink-0 cursor-pointer items-center justify-center rounded text-content-lo hover:bg-ink-600 hover:text-content-mid"
            onClick={(event) => {
              // 图标是行内快捷操作：拦掉冒泡，避免同时触发行点击（选中）
              event.stopPropagation()
              onIconClick(event)
            }}
          >
            {icon}
          </button>
        ) : (
          <span className="flex h-[14px] w-[14px] shrink-0 items-center justify-center text-content-lo">{icon}</span>
        )}
        {/* 定位时整行一起闪（见行 className），文字白不白跟着行走，这里不再单独处理 */}
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
    </div>
  )
}

/** 取骨骼当前世界矩阵（重设父级时保持全局变换用）；场景未就绪时返回 null */
function worldMatrixOfBone(boneName: string): Float32Array | null {
  return getActiveScene()?.worldMatrixOf(boneName) ?? null
}

/**
 * IK 约束图标：**准星**（靶环 + 四向凸点 + 内环 + 中心横杆），与视口叠加层里画的约束手柄同形
 *（`boneOverlay.drawConstraintLinks`）—— 一眼能对上「树里这条约束」和「视口里那个手柄」。
 *
 * 用内联 SVG 而不是 lucide 的 `Target`：后者只有同心圆 + 十字，没有四向凸点与中心横杆，
 * 跟视口里的记号对不上。
 */
function IkConstraintIcon({ size = 13 }: { size?: number }): React.ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="round"
      /* 约束红：与视口叠加层里的约束标记同色（boneOverlay 的 COLOR_CONSTRAINT） */
      className="text-[#e4572e]"
      aria-hidden
    >
      {/* 靶环 */}
      <circle cx="12" cy="12" r="6.8" />
      {/* 四向凸点（上下左右探出环外） */}
      <path d="M12 3.6v2.4M12 20.4v-2.4M3.6 12h2.4M20.4 12h-2.4" />
      {/* 内环：细一圈、淡一点，小尺寸下也不糊成一团 */}
      <circle cx="12" cy="12" r="4.4" strokeWidth={1.3} opacity={0.4} />
      {/* 中心横杆：指向被约束骨骼的求解方向 */}
      <path d="M12 12h6" />
    </svg>
  )
}

const CONSTRAINT_ICON: Record<AuthoringConstraint['type'], React.ReactNode> = {
  ik: <IkConstraintIcon />,
  transform: <Maximize2 size={13} className="text-ok/80" />,
  path: <Route size={13} className="text-warn/80" />,
  // 物理约束仅在导入时保留数据（不参与求解），用弱化图标区分
  physics: <Activity size={13} className="text-content-lo" />
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

/** 网格型附件（含 linkedmesh）：层级树里用网格图标，和贴图区分开 */
function isMeshType(type: AuthoringAttachmentType): boolean {
  return type === 'mesh' || type === 'linkedmesh'
}

/** display 行的类型名（与行内图标同一口径：贴图 / 网格） */
const ATTACHMENT_KIND: Record<AuthoringAttachmentType, string> = {
  region: '贴图',
  mesh: '网格',
  linkedmesh: '网格（链接）',
  boundingbox: '包围盒'
}

type TreeSlot = EditorDocument['slots'][number]
type TreeDisplay = EditorDocument['skins'][number]['slots'][number]['attachments'][number]

/*
 * 行的悬浮描述（原生 title）。
 *
 * 都是纯函数、字符串在组件外拼好：文案只取决于文档数据，跟渲染状态无关；
 * 多行的写法与树容器那句说明一致 —— 一行一个信息点，扫一眼就能读完。
 */
function boneRowTitle(bone: AuthoringBone, counts: { bones: number; slots: number; constraints: number }): string {
  const attached: string[] = []
  if (counts.bones > 0) attached.push(`${counts.bones} 根子骨骼`)
  if (counts.slots > 0) attached.push(`${counts.slots} 个插槽`)
  if (counts.constraints > 0) attached.push(`${counts.constraints} 个约束`)
  const lines = [
    `骨骼「${bone.name}」`,
    `父级：${bone.parent || '（根骨骼）'}`,
    `挂载：${attached.length > 0 ? attached.join(' · ') : '（空）'}`,
    // 与行尾 meta 同一口径（length 是 100 倍刻度，树里一直按 px 显示）；
    // rotation 存的是**局部**值，有父级时写明基准，免得跟视口里看到的世界角度对不上
    `长度 ${(bone.length * 100).toFixed(0)}px · ${
      bone.parent ? `相对父级旋转 ${bone.rotation.toFixed(1)}°` : `旋转 ${bone.rotation.toFixed(1)}°`
    }`
  ]
  if (bone.locked) lines.push('已锁定：视口里点不中它（层级树里照常可操作）')
  return lines.join('\n')
}

function slotRowTitle(slot: TreeSlot, displayCount: number, showing: string): string {
  const lines = [
    `插槽「${slot.name}」`,
    `挂载于：${slot.bone || '根层'}`,
    `绘制层序 ${slot.zOrder}（越小越先绘制）· display ${displayCount} 个`
  ]
  if (!slot.visible) lines.push('已隐藏：视口与导出都不绘制它（点行首眼睛恢复）')
  else if (showing) lines.push(`当前显示：${showing}`)
  else if (displayCount > 0) lines.push('当前一个 display 都不显示（点 display 行的小图标显示它）')
  if (slot.locked) lines.push('已锁定：视口里点不中它（层级树里照常可操作）')
  return lines.join('\n')
}

function displayRowTitle(slot: TreeSlot, display: TreeDisplay, showing: boolean): string {
  const lines = [`display「${display.name}」 · ${ATTACHMENT_KIND[display.type]}`, `宿主插槽：${slot.name}`]
  if (display.image) lines.push(`图片：${display.image}`)
  lines.push(
    showing
      ? '显示中：点前面的小图标可隐藏它（该插槽将不显示任何 display）'
      : '未显示：点前面的小图标切换到它（点文字只选中，不改显示）'
  )
  return lines.join('\n')
}

function constraintRowTitle(constraint: AuthoringConstraint): string {
  const lines = [
    `${CONSTRAINT_KIND[constraint.type]}约束「${constraint.name}」`,
    `骨骼链：${constraint.bones.length > 0 ? constraint.bones.join(' → ') : '（没有骨骼）'}`
  ]
  if (constraint.target) lines.push(`目标：${constraint.target}`)
  if (constraint.type === 'ik') {
    lines.push(`权重 ${constraint.mix.toFixed(2)} · 弯曲方向 ${constraint.bendSign > 0 ? '+1' : '-1'}`)
  }
  if (constraint.type === 'transform') {
    // inherit 没有中文名（工程文件里也是这几个英文枚举），原样显示成「字段：取值」
    lines.push(
      `继承模式：${constraint.inherit}${constraint.relative ? ' · 相对叠加' : ''}${constraint.local ? ' · 取局部变换' : ''}`
    )
  }
  if (constraint.type === 'path') {
    lines.push(`位置 ${constraint.position.toFixed(2)} · 间距 ${constraint.spacing.toFixed(2)}`)
  }
  if (constraint.type === 'physics') lines.push('仅保留数据：不参与求解，导出直通')
  if (!constraint.enabled) lines.push('已停用（enabled = false）')
  return lines.join('\n')
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
  /** 搜索框内容：空 = 不过滤；有值时只显示命中节点 + 其祖先（根骨骼始终保留），并临时全展开 */
  const [query, setQuery] = useState('')
  /** 树列表容器：拖放兜底判定要用它量各行的位置 */
  const listRef = useRef<HTMLDivElement | null>(null)
  /** 检查器里的「定位」请求：滚到那根骨骼并闪一下（见下面两个 effect） */
  const revealTarget = useRevealStore((s) => s.bone)
  const revealNonce = useRevealStore((s) => s.nonce)
  const handledReveal = useRef(0)
  /**
   * 正在闪烁的骨骼行（整行蓝底，见 `.hao-reveal-flash`）。
   *
   * 闪烁靠「加类 → 900ms 后清掉」这个开关重播动画，所以同一根骨骼在闪烁途中被再次
   * 定位时不会从头发一遍 —— 那会儿它本来就还是蓝的，重新滚动到位已经足够。
   */
  const [flash, setFlash] = useState<{ name: string; nonce: number } | null>(null)

  /**
   * 收到定位请求：清掉搜索过滤、展开祖先链，并记下要闪的那一行。
   *
   * 展开与「记下要闪的行」必须同批提交 —— 下一次渲染里那一行才存在，紧接着的滚动
   * effect 才找得到它。同一个序号只处理一次，否则之后每次编辑骨骼都会重放一遍动画。
   */
  useEffect(() => {
    if (revealNonce === 0 || handledReveal.current === revealNonce) return
    handledReveal.current = revealNonce
    // 搜索过滤期间目标多半被筛掉了：定位的语义就是「让我看到它」
    setQuery('')
    const bones = useProjectStore.getState().document.bones
    setCollapsed((prev) => {
      const next = new Set(prev)
      let parent = bones.find((bone) => bone.name === revealTarget)?.parent ?? ''
      while (parent) {
        next.delete(parent)
        parent = bones.find((bone) => bone.name === parent)?.parent ?? ''
      }
      return next
    })
    setFlash({ name: revealTarget, nonce: revealNonce })
  }, [revealTarget, revealNonce])

  /** 行渲染出来之后再滚动（上面那批状态已生效），闪完自动收尾 */
  useEffect(() => {
    if (!flash) return
    const row = listRef.current?.querySelector(`[data-bone="${CSS.escape(flash.name)}"]`)
    row?.scrollIntoView({ block: 'nearest' })
    const timer = window.setTimeout(
      () => setFlash((current) => (current && current.nonce === flash.nonce ? null : current)),
      900
    )
    return () => window.clearTimeout(timer)
  }, [flash])

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

  const mode = useModeStore((s) => s.mode)
  const currentAnimationName = useTimelineStore((s) => s.currentAnimation)
  const activeAnimation = useMemo(
    () => document.animations.find((item) => item.name === currentAnimationName) ?? null,
    [document.animations, currentAnimationName]
  )

  /**
   * 播放头时间走**节流**通道，并且只在「当前动画真的有插槽显示轨」时才跟随：
   * 这个值只用来算「插槽当前显示的附件名」，没有显示轨的动画（绝大多数骨骼动画）
   * 里它根本不会变 —— 那就没必要按秒把整棵树重渲染一遍。
   */
  const showLiveNames =
    mode === 'animate' && (activeAnimation?.slots.some((slot) => slot.displayIndex.length > 0) ?? false)
  const timelineTime = useThrottledPlayheadTime(500, showLiveNames)

  /**
   * 当前显示的 display 名：Animate 态按**关键帧数据**采样（与运行期同一规则），Pose 态 setup 值就是权威。
   * 不能一律看 `slot.attachment` —— 打显示关键帧不改 setup，用 setup 判断会得到
   * 「打完显示帧后再点没反应」的错觉（点击判定与行尾「显示中」标记都用这个函数）。
   */
  const shownDisplayName = (slot: EditorDocument['slots'][number]): string =>
    mode === 'animate' ? slotDisplayNameAt(activeAnimation, slot.name, timelineTime, slot.attachment) : slot.attachment

  const displaysOf = (slotName: string): EditorDocument['skins'][number]['slots'][number]['attachments'] =>
    activeSkin?.slots.find((item) => item.slot === slotName)?.attachments ?? []

  /**
   * 搜索筛选用的 display 键：插槽名 + 附件名（换行分隔，避免名字里带冒号时歧义）。
   *
   * 定义位置有讲究：**必须在下面的搜索 memo 之前** —— 它是 `const`，memo 在渲染早期就执行，
   * 放到后面会撞上 TDZ（第一次命中就整块树抛错）。
   */
  const displayKey = (slotName: string, attachmentName: string): string => `${slotName}\n${attachmentName}`

  /**
   * 点击插槽下的 display：切到它；**再点当前正显示的那一个则隐藏** —— 插槽只有两种状态：
   * 显示某一个 display，或一个都不显示（运行期 displayIndex = -1，是合法的「不显示」）。
   *
   * Pose 态改绑定数据 `slot.attachment`（空串 = 不显示）；Animate 态只写显示关键帧、
   * 不动绑定姿态，与检查器的「显示（关键帧）」下拉是同一语义。
   */
  const selectDisplay = (slotName: string, attachmentName: string): void => {
    const animate = mode === 'animate'
    const slot = document.slots.find((item) => item.name === slotName)
    // 「是否正在显示它」与行尾标记同一数据源（Animate 态看关键帧采样，Pose 态看 setup）
    const showing = slot ? shownDisplayName(slot) === attachmentName : false
    if (animate) {
      onStatus?.(keySlotDisplayNow(slotName, showing ? '' : attachmentName).message)
    } else {
      update(showing ? '隐藏 display' : '切换显示的 display', (draft) => {
        toggleSlotDisplay(draft, slotName, attachmentName)
      })
      onStatus?.(
        showing ? `插槽「${slotName}」不再显示任何 display` : `插槽「${slotName}」显示「${attachmentName}」`
      )
    }
    // 隐藏后仍选中这一行：还能在检查器里编辑它，或再点一次重新显示
    selection.selectAttachment(slotName, attachmentName)
  }

  /** 骨骼 / 插槽 / display / 约束都是绑定数据：Animate 态拒绝增删与改层级，避免污染动画基线 */
  const canEditBinding = (): boolean => {
    if (useModeStore.getState().mode === 'pose') return true
    // 这句话服务于所有入口：拖行改层级、拖图片建插槽 / 加 display、工具栏新建、行尾删除
    onStatus?.('切到 Pose 状态才能改绑定数据（骨骼 / 插槽 / display / 约束）')
    return false
  }

  /**
   * 绑定数据的增删统一包一层：Animate 态点下去得到与拖拽相同的那句提示，
   * 而不是静默写 setup —— 写进去的那一笔会成为动画基线，事后很难解释。
   */
  const poseOnly = (action: () => void): (() => void) => () => {
    if (canEditBinding()) action()
  }

  /** 资源面板拖进来的图片：作为新的 display 追加到该插槽，并立即切换显示 */
  const addDisplay = (slotName: string, imageNames: string[]): void => {
    if (!canEditBinding()) return
    const images = imageNames
      .map((name) => document.images.find((item) => item.name === name))
      .filter((item): item is AuthoringImage => Boolean(item))
    if (images.length === 0) return
    const created: { slot: string; attachment: string }[] = []
    update(
      images.length > 1 ? `拖入 ${images.length} 张图片添加 display` : '拖入图片添加 display',
      (draft) => {
        for (const image of images) {
          const result = addImageDisplay(draft, {
            image: image.name,
            slot: slotName,
            width: image.width,
            height: image.height,
            skin: selection.skin
          })
          if (result) created.push(result)
        }
      }
    )
    // 每个新建的 display 都会成为当前显示项，最后一张显示在最上面
    const last = created[created.length - 1]
    if (!last) return
    selection.selectAttachment(last.slot, last.attachment)
    // 插槽行可能被折叠着，展开宿主骨骼让新 display 可见
    expandBone(boneOfSlot(slotName))
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
        // 传世界矩阵：换父级后保持骨骼的全局位置 / 旋转 / 缩放
        result = moveBone(draft, payload.name, target.name, position, { worldMatrixOf: worldMatrixOfBone })
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
        // 传世界矩阵：换宿主骨骼后保持插槽内容的全局位置 / 旋转 / 缩放
        result = moveSlot(draft, payload.name, target.name, anchor, { worldMatrixOf: worldMatrixOfBone })
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
      // 传世界矩阵：换到别的插槽（宿主骨骼不同）时保持附件的全局位置 / 旋转 / 缩放
      result = moveDisplay(draft, payload.slot, payload.name, toSlot, anchor, skinName, {
        worldMatrixOf: worldMatrixOfBone
      })
    })
    if (result.message) onStatus?.(result.message)
  }

  /** 资源面板拖到骨骼行：在该骨骼下新建插槽，图片作为它的第一个 display */
  const addSlotFromImage = (boneName: string, imageNames: string[]): void => {
    if (!canEditBinding()) return
    const images = imageNames
      .map((name) => document.images.find((item) => item.name === name))
      .filter((item): item is AuthoringImage => Boolean(item))
    if (images.length === 0) return
    const created: { slot: string; attachment: string }[] = []
    update(
      images.length > 1 ? `拖入 ${images.length} 张图片新建插槽` : '拖入图片新建插槽',
      (draft) => {
        for (const image of images) {
          const result = createRegionFromImage(draft, {
            image: image.name,
            bone: boneName,
            width: image.width,
            height: image.height,
            skin: selection.skin
          })
          if (result) created.push(result)
        }
      }
    )
    const first = created[0]
    if (!first) return
    selection.selectAttachment(first.slot, first.attachment)
    expandBone(boneName)
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

  /**
   * 「添加 IK 约束」菜单项的副标题：把**这一次**会配出的受约束骨链显示出来。
   * 多选父→子连续的骨骼时链会一次配好，只选一根时顺带提示链尾可以在检查器里补。
   */
  const ikChainHint = (host: string): string => {
    if (!host) return '未指定驱动骨骼'
    const chain = selection.bones.includes(host) ? chainFromSelection(document, selection.bones, host) : [host]
    return chain.length > 1
      ? `受约束骨链：${chain.join(' → ')}`
      : `驱动骨骼：「${host}」（多选父→子连续的骨骼可一次配好整条链）`
  }

  const addConstraint = (kind: AuthoringConstraint['type'], bone = selectedBone()): void => {
    update('新建约束', (draft) => {
      const driver = bone || draft.bones[0]?.name || ''
      const name = uniqueName(draft.constraints.map((c) => c.name), kind)
      /*
       * IK 真正有用的是「链根 → 链尾」两根以上的骨链，只带右键那一根等于配不出腿 / 手臂。
       * 多选父→子连续的骨骼时一次把整条链配好；只选一根就退回单骨，
       * 链尾之后可以在检查器的「受约束骨骼链」里补。
       */
      const bones =
        kind === 'ik' && driver && selection.bones.includes(driver)
          ? chainFromSelection(draft, selection.bones, driver)
          : driver
            ? [driver]
            : []
      const base = { name, order: draft.constraints.length, enabled: true, bones, target: '' }
      if (kind === 'ik') draft.constraints.push({ ...createIkConstraint(), ...base, type: 'ik' })
      else if (kind === 'transform') {
        draft.constraints.push({ ...createTransformConstraint(), ...base, type: 'transform' })
      } else draft.constraints.push({ ...createPathConstraint(), ...base, type: 'path' })
    })
    if (bone) setCollapsed((prev) => (prev.has(bone) ? new Set([...prev].filter((n) => n !== bone)) : prev))
  }

  /** 右键菜单：记录点击位置与目标对象 */
  const [menu, setMenu] = useState<{ x: number; y: number; target: MenuTarget } | null>(null)
  /** display 行自己的右键菜单（Animate 态：从当前时间开始显示它） */
  const [displayMenu, setDisplayMenu] = useState<{
    x: number
    y: number
    slot: string
    attachment: string
  } | null>(null)

  const openMenu = (event: React.MouseEvent, target: MenuTarget): void => {
    event.preventDefault()
    event.stopPropagation()
    // Animate 态根层没有关键帧操作：不开空菜单（比弹一个空框更清楚）
    if (useModeStore.getState().mode === 'animate' && target.kind === 'root') return
    if (target.kind === 'bone') {
      if (selection.bones.length > 1 && selection.bones.includes(target.name)) {
        /*
         * 已多选时保持整组选中：右键就是「对选中的这组骨骼做什么」，
         * 新建 IK 正是拿这组骨骼当受约束骨链用（见 addConstraint）。
         * 只把右键那一根挪到组末 —— 组末是主选中（检查器显示它）。
         */
        selection.selectBones([...selection.bones.filter((name) => name !== target.name), target.name])
      } else {
        selection.selectBone(target.name)
      }
    } else if (target.kind === 'slot') selection.selectSlot(target.name)
    else if (target.kind === 'constraint') selection.selectConstraint(target.name)
    setMenu({ x: event.clientX, y: event.clientY, target })
  }

  /** 一条「打关键帧」菜单项：点击即在当前时间点写入对应的通道帧 */
  const keyframeItem = (
    key: string,
    label: string,
    hint: string,
    targets: KeyframeTarget[]
  ): ContextMenuItem => {
    // 一个动画都没有时直接置灰并说明原因：否则点了只会闪一行状态栏，像是「没反应」
    const noAnimation = document.animations.length === 0
    return {
      key,
      label,
      hint: noAnimation ? '工程里还没有动画：先在时间轴点「+ 动画」' : hint,
      icon: <KeyRound size={12} />,
      disabled: noAnimation,
      onSelect: () => {
        const result = keyframeTargetsNow(targets, hint)
        onStatus?.(result.message)
      }
    }
  }

  /**
   * 「删除」菜单项：骨骼 / 插槽 / 约束共用一份（约束行的整条菜单就是它，见下面两处）。
   *
   * 删除改的同样是绑定数据，所以 Animate 态一律拒绝；但菜单在 Animate 态仍留着它 ——
   * 直接隐藏会让人以为「删不掉」，点了给一句「切回 Pose」反而更清楚。
   */
  const deleteItem = (target: MenuTarget): ContextMenuItem => ({
    key: 'delete',
    label: `删除「${target.name}」`,
    danger: true,
    disabled: target.kind === 'bone' && document.bones.length <= 1,
    hint: target.kind === 'bone' && document.bones.length <= 1 ? '至少保留一根骨骼' : undefined,
    icon: <Trash2 size={12} />,
    onSelect: poseOnly(() => {
      if (target.kind === 'slot') {
        update('删除插槽', (draft) => {
          deleteSlot(draft, target.name)
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
    })
  })

  /**
   * Animate 态的菜单：只给「打关键帧」。
   * 加骨骼 / 插槽 / 约束、删除这些改的是 setup（绑定）数据，动画状态里动它们会污染动画基线。
   * 约束行同样给打关键帧（IK 的混合是可做动画的），删除放在最后（见下面的分支）。
   */
  const keyframeMenuItems = (target: MenuTarget): ContextMenuItem[] => {
    if (target.kind === 'bone') {
      const bone = target.name
      const channel = (name: string): KeyframeTarget[] => [
        { kind: 'bone', target: bone, attachment: '', channel: name }
      ]
      return [
        keyframeItem('k-translate', '位置关键帧', `${bone} · 位置`, channel('translate')),
        keyframeItem('k-rotate', '旋转关键帧', `${bone} · 旋转`, channel('rotate')),
        keyframeItem('k-scale', '缩放关键帧', `${bone} · 缩放`, channel('scale')),
        keyframeItem('k-shear', '斜切关键帧', `${bone} · 斜切`, channel('shear')),
        { key: 'sep-k', label: '', separator: true },
        keyframeItem('k-all', '全部通道关键帧', bone, [
          ...channel('rotate'),
          ...channel('translate'),
          ...channel('scale'),
          ...channel('shear')
        ])
      ]
    }
    if (target.kind === 'slot') {
      const slot = target.name
      const channel = (name: string): KeyframeTarget[] => [
        { kind: 'slot', target: slot, attachment: '', channel: name }
      ]
      return [
        keyframeItem('k-display', '显示关键帧', `${slot} · 显示`, channel('display')),
        keyframeItem('k-color', '颜色关键帧', `${slot} · 颜色`, channel('color')),
        keyframeItem('k-visible', '可见性关键帧', `${slot} · 可见性`, channel('visible')),
        { key: 'sep-k', label: '', separator: true },
        keyframeItem('k-all', '全部通道关键帧', slot, [
          ...channel('display'),
          ...channel('color'),
          ...channel('visible')
        ])
      ]
    }
    if (target.kind === 'constraint') {
      /*
       * 约束：Animate 态给「打关键帧」，参数之外的操作（添加骨骼 / 插槽）对约束行没有意义。
       * IK 的混合（mix）本来就是可做动画的（时间轴有它的轨道、`.hao2d` 也导出 iks 段），
       * 这里不给入口的话权重动画就只能手改工程文件。物理约束没有可做动画的参数（只保留数据、
       * 不参与求解），菜单仍只留「删除」。
       */
      const name = target.name
      const constraint = document.constraints.find((item) => item.name === name)
      const channels = constraint ? CONSTRAINT_CHANNELS[constraint.type] ?? [] : []
      if (channels.length === 0) return [deleteItem(target)]
      const labelOf = (channel: string): string => CONSTRAINT_CHANNEL_LABEL[channel] ?? channel
      const keyAll: KeyframeTarget[] = [{ kind: 'constraint', target: name, attachment: '' }]
      const keyOne = (channel: string): KeyframeTarget[] => [
        { kind: 'constraint', target: name, attachment: '', channel }
      ]
      const items: ContextMenuItem[] =
        channels.length === 1
          ? [keyframeItem('k-constraint-0', `${labelOf(channels[0])}关键帧`, `${name} · ${labelOf(channels[0])}`, keyAll)]
          : [
              keyframeItem('k-constraint-all', '全部参数关键帧', `${name} · 全部参数`, keyAll),
              { key: 'sep-kc', label: '', separator: true },
              ...channels.map((channel) =>
                keyframeItem(`k-constraint-${channel}`, `${labelOf(channel)}关键帧`, `${name} · ${labelOf(channel)}`, keyOne(channel))
              )
            ]
      items.push({ key: 'sep-kc2', label: '', separator: true }, deleteItem(target))
      return items
    }
    return []
  }

  const menuItems = (target: MenuTarget): ContextMenuItem[] => {
    // Animate 态：菜单换成打关键帧（绑定类操作属于 setup，见上面的说明）
    if (useModeStore.getState().mode === 'animate') return keyframeMenuItems(target)
    // 约束行：整条菜单只有「删除」（参数在检查器里改，「添加骨骼 / 插槽」对它也没有意义）
    if (target.kind === 'constraint') return [deleteItem(target)]
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
      // 约束驱动的是骨骼，挂在插槽下没有意义，只在骨骼行 / 根层提供
      ...(target.kind === 'bone' || target.kind === 'root'
        ? [
            { key: 'sep1', label: '', separator: true },
            {
              key: 'ik',
              label: '添加 IK 约束',
              // 多选父→子连续的骨骼时，链会一次配好；只选一根就提示怎么配出两骨 IK
              hint: ikChainHint(host),
              icon: <IkConstraintIcon size={12} />,
              onSelect: () => addConstraint('ik', host)
            },
            {
              key: 'transform',
              label: '添加变换约束',
              hint: '继承位移 / 旋转 / 缩放 / 斜切',
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
        : [])
    ]
    if (target.kind !== 'root') {
      items.push({ key: 'sep2', label: '', separator: true }, deleteItem(target))
    }
    return items
  }

  /**
   * 搜索筛选：保留「名字命中」的节点，以及它们的**祖先**（层级路径不能断）。
   *
   * **根骨骼始终保留**，哪怕自己没命中 —— 筛选后树顶仍有锚点，不会只剩几根孤立的子节点
   * 让人看不出它们属于哪套骨架。搜索期间忽略折叠状态（强制展开），清空后原折叠状态照旧。
   *
   * 返回 null 表示当前没在搜索，渲染逻辑照常。
   */
  const filter = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return null
    const hit = (text: string): boolean => text.toLowerCase().includes(q)
    const bones = new Set<string>()
    const slots = new Set<string>()
    const displays = new Set<string>()
    const constraints = new Set<string>()
    /** 深度优先：返回「这棵子树里有没有命中」，命中的节点记进对应集合 */
    const visit = (bone: AuthoringBone): boolean => {
      let found = hit(bone.name)
      for (const constraint of constraintsByBone.get(bone.name) ?? []) {
        if (!hit(constraint.name)) continue
        constraints.add(constraint.name)
        found = true
      }
      for (const slot of slotsByBone.get(bone.name) ?? []) {
        let slotHit = hit(slot.name)
        for (const attachment of displaysOf(slot.name)) {
          if (!hit(attachment.name)) continue
          displays.add(displayKey(slot.name, attachment.name))
          slotHit = true
        }
        if (slotHit) {
          slots.add(slot.name)
          found = true
        }
      }
      for (const child of bonesByParent.get(bone.name) ?? []) if (visit(child)) found = true
      if (found) bones.add(bone.name)
      return found
    }
    for (const root of bonesByParent.get('') ?? []) {
      visit(root)
      bones.add(root.name)
    }
    return { bones, slots, displays, constraints }
  }, [query, bonesByParent, slotsByBone, constraintsByBone, document])

  const rows: React.ReactNode[] = []

  const pushBone = (bone: AuthoringBone, depth: number): void => {
    // 搜索时：整棵被筛掉的子树直接跳过
    if (filter && !filter.bones.has(bone.name)) return
    const children = bonesByParent.get(bone.name) ?? []
    const slots = slotsByBone.get(bone.name) ?? []
    const constraints = constraintsByBone.get(bone.name) ?? []
    const hasChildren = children.length + slots.length + constraints.length > 0
    // 搜索期间强制展开：命中的节点多半藏在折叠的分支里；清空搜索后原折叠状态照旧
    const expanded = filter ? true : !collapsed.has(bone.name)

    rows.push(
      <TreeRow
        key={`bone:${bone.name}`}
        dataBone={bone.name}
        flashKey={flash?.name === bone.name ? flash.nonce : 0}
        dragPayload={{ kind: 'bone', name: bone.name }}
        onDropNode={(payload, position) => handleNodeDrop(payload, { kind: 'bone', name: bone.name }, position)}
        depth={depth}
        label={bone.name}
        title={boneRowTitle(bone, { bones: children.length, slots: slots.length, constraints: constraints.length })}
        active={selection.kind === 'bone' && selection.bones.includes(bone.name)}
        secondary={selection.kind === 'bone' && selection.bone !== bone.name}
        icon={<Bone size={11} style={{ color: bone.color }} />}
        meta={bone.length > 0 ? `${(bone.length * 100).toFixed(0)}px` : undefined}
        expandable={hasChildren}
        expanded={expanded}
        onToggle={() => toggle(bone.name)}
        // Shift / Cmd / Ctrl 点击 = 加选 / 减选（多选后可一起旋转 / 移动 / 缩放）
        onSelect={(event) =>
          event.shiftKey || event.metaKey || event.ctrlKey
            ? selection.toggleBone(bone.name)
            : selection.selectBone(bone.name)
        }
        // 拖到骨骼行 = 在这根骨骼下新建一个插槽
        onDropImage={(imageNames) => addSlotFromImage(bone.name, imageNames)}
        onContextMenu={(event) => openMenu(event, { kind: 'bone', name: bone.name, bone: bone.parent })}
        // 锁定列（行首第二列）：骨骼可锁 / 解锁
        lockSwitch={{
          on: bone.locked,
          title: bone.locked ? '解锁' : '锁定',
          onToggle: () =>
            update('切换骨骼锁定', (draft) => {
              const target = draft.bones.find((b) => b.name === bone.name)
              if (target) target.locked = !target.locked
            })
        }}
        onDelete={
          document.bones.length > 1
            ? poseOnly(() =>
                update('删除骨骼', (draft) => {
                  draft.bones = draft.bones.filter((b) => b.name !== bone.name)
                  for (const child of draft.bones) if (child.parent === bone.name) child.parent = ''
                  draft.slots = draft.slots.filter((s) => s.bone !== bone.name)
                })
              )
            : undefined
        }
      />
    )

    if (!expanded) return
    for (const child of children) pushBone(child, depth + 1)
    for (const slot of slots) pushSlot(slot, depth + 1)
    for (const constraint of constraints) rows.push(renderConstraint(constraint, depth + 1))
  }

  /**
   * 插槽下的一个 display（附件）行。
   *
   * 点**前面的小图标** = 切换显示：默认切到它，再点当前正显示的那个则隐藏（一个都不显示）；
   * 点文字只选中这一行，不改显示状态。
   */
  const renderDisplay = (
    slot: EditorDocument['slots'][number],
    attachment: EditorDocument['skins'][number]['slots'][number]['attachments'][number],
    depth: number
  ): React.ReactNode => {
    // 搜索时：没命中的 display 不渲染
    if (filter && !filter.displays.has(displayKey(slot.name, attachment.name))) return null
    // 「显示中」标记与点击判定同一数据源：Animate 态按当前时间点的关键帧数据判断
    const showing = shownDisplayName(slot) === attachment.name
    return (
      <TreeRow
        key={`display:${slot.name}:${attachment.name}`}
        dragPayload={{ kind: 'display', slot: slot.name, name: attachment.name }}
        onDropNode={(payload, position) =>
          handleNodeDrop(payload, { kind: 'display', name: attachment.name, slot: slot.name }, position)
        }
        depth={depth}
        label={attachment.name}
        title={displayRowTitle(slot, attachment, showing)}
        active={
          selection.kind === 'attachment' &&
          selection.slot === slot.name &&
          selection.attachment === attachment.name
        }
        icon={
          // 网格型附件用网格图标，和贴图（图片）一眼区分开
          isMeshType(attachment.type) ? (
            <Grid3x3 size={11} className={showing ? 'text-accent' : 'text-content-lo/60'} />
          ) : (
            <ImageIcon size={11} className={showing ? 'text-accent' : 'text-content-lo/60'} />
          )
        }
        meta={showing ? (isMeshType(attachment.type) ? '显示中 · 网格' : '显示中') : isMeshType(attachment.type) ? '网格' : undefined}
        // display 行也算宿主插槽的地盘：拖到插槽下面（含子行）都是「给这个插槽加 display」
        dataSlot={slot.name}
        onDropImage={(imageNames) => addDisplay(slot.name, imageNames)}
        // 点**前面的小图标** = 切换显示 / 隐藏（图标就是这个开关），点文字只选中不改显示
        onIconClick={() => selectDisplay(slot.name, attachment.name)}
        iconTitle={showing ? '点击隐藏（该插槽不显示任何 display）' : '点击显示它'}
        onSelect={() => selection.selectAttachment(slot.name, attachment.name)}
        // Animate 态：右键 display = 从当前时间点开始显示它（打显示关键帧）
        onContextMenu={(event) => {
          if (useModeStore.getState().mode !== 'animate') return
          event.preventDefault()
          event.stopPropagation()
          setDisplayMenu({
            x: event.clientX,
            y: event.clientY,
            slot: slot.name,
            attachment: attachment.name
          })
        }}
        onDelete={poseOnly(() =>
          update('删除 display', (draft) => deleteAttachment(draft, slot.name, attachment.name))
        )}
      />
    )
  }

  const pushedSlots = new Set<string>()
  const pushSlot = (slot: EditorDocument['slots'][number], depth: number): void => {
    // 搜索时：没命中的插槽（及其 display）不渲染
    if (filter && !filter.slots.has(slot.name)) return
    // 同名插槽只渲染一次：异常数据（重名）或热更新残留时也不至于把树撑重复
    if (pushedSlots.has(slot.name)) return
    pushedSlots.add(slot.name)
    const displays = displaysOf(slot.name)
    const expanded = filter ? true : !collapsed.has(`slot:${slot.name}`)
    // 行尾 meta 与悬浮描述共用同一次采样（Animate 态按关键帧、Pose 态看 setup）
    const showing = shownDisplayName(slot)
    rows.push(
      <TreeRow
        key={`slot:${slot.name}`}
        dragPayload={{ kind: 'slot', name: slot.name }}
        onDropNode={(payload, position) => handleNodeDrop(payload, { kind: 'slot', name: slot.name }, position)}
        depth={depth}
        label={slot.name}
        title={slotRowTitle(slot, displays.length, showing)}
        active={selection.kind === 'slot' && selection.slot === slot.name}
        icon={
          <span
            className="h-[10px] w-[10px] rounded-sm border border-line"
            style={{ background: toCss(slot.color) }}
          />
        }
        // 行尾显示当前显示的 display 名，不用展开也知道显示的是哪一个。
        // Animate 态按关键帧采样（与 display 行的「显示中」标记同一数据源），不能直接看 setup
        meta={showing || (displays.length > 0 ? `${displays.length} 个 display` : undefined)}
        expandable={displays.length > 0}
        expanded={expanded}
        dataSlot={slot.name}
        onToggle={() => toggle(`slot:${slot.name}`)}
        onSelect={() => selection.selectSlot(slot.name)}
        onDropImage={(imageNames) => addDisplay(slot.name, imageNames)}
        onContextMenu={(event) => openMenu(event, { kind: 'slot', name: slot.name, bone: slot.bone })}
        // 显示列（行首第一列）：插槽可显示 / 隐藏
        visibleSwitch={{
          on: slot.visible,
          title: slot.visible ? '隐藏插槽' : '显示插槽',
          onToggle: () =>
            update('切换插槽可见性', (draft) => {
              const target = draft.slots.find((s) => s.name === slot.name)
              if (target) target.visible = !target.visible
            })
        }}
        // 锁定列（行首第二列）：与骨骼一致 —— 锁上后视口里点不中它，层级树里照常可操作
        lockSwitch={{
          on: slot.locked,
          title: slot.locked ? '解锁（视口中可再次选中）' : '锁定（视口中不可选中）',
          onToggle: () =>
            update('切换插槽锁定', (draft) => {
              const target = draft.slots.find((s) => s.name === slot.name)
              if (target) target.locked = !target.locked
            })
        }}
        onDelete={poseOnly(() =>
          update('删除插槽', (draft) => {
            deleteSlot(draft, slot.name)
          })
        )}
      />
    )

    if (!expanded) return
    for (const attachment of displays) rows.push(renderDisplay(slot, attachment, depth + 1))
  }

  const renderConstraint = (constraint: AuthoringConstraint, depth: number): React.ReactNode =>
    // 搜索时：没命中的约束不渲染
    filter && !filter.constraints.has(constraint.name) ? null : (
    <TreeRow
      key={`constraint:${constraint.name}`}
      depth={depth}
      label={constraint.name}
      title={constraintRowTitle(constraint)}
      active={selection.kind === 'constraint' && selection.constraint === constraint.name}
      // 约束没有拖动负载，双击聚焦的目标只能显式给（骨骼 / 插槽 / display 都由负载推导）
      focusTarget={{ kind: 'constraint', name: constraint.name }}
      icon={CONSTRAINT_ICON[constraint.type] ?? <Link2 size={11} />}
      meta={constraint.type === 'ik' ? `${CONSTRAINT_KIND.ik} ${constraint.bones.length}骨` : CONSTRAINT_KIND[constraint.type]}
      onSelect={() => selection.selectConstraint(constraint.name)}
      onContextMenu={(event) =>
        openMenu(event, { kind: 'constraint', name: constraint.name, bone: constraint.bones[0] ?? '' })
      }
      onDelete={poseOnly(() => removeConstraint(update, constraint.name))}
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
        <button type="button" title="新建骨骼（挂在当前选中骨骼下；未选中时建在根层）" className="hao-btn h-[18px] px-1.5 text-3xs" onClick={poseOnly(() => addBone())}>
          <Bone size={11} />
          <span>骨骼</span>
        </button>
        <button type="button" title="新建插槽（挂到当前选中骨骼；未选中时挂到第一根骨骼）" className="hao-btn h-[18px] px-1.5 text-3xs" onClick={poseOnly(() => addSlot())}>
          <Plus size={11} />
          <span>插槽</span>
        </button>
        <button
          type="button"
          title="新建 IK 约束"
          className="hao-btn h-[18px] px-1.5 text-3xs"
          onClick={poseOnly(() => addConstraint('ik'))}
        >
          <IkConstraintIcon size={14} />
        </button>
        <button
          type="button"
          title="新建变换约束"
          className="hao-btn h-[18px] px-1.5 text-3xs"
          onClick={poseOnly(() => addConstraint('transform'))}
        >
          <Maximize2 size={14} />
        </button>
        <button
          type="button"
          title="新建路径约束"
          className="hao-btn h-[18px] px-1.5 text-3xs"
          onClick={poseOnly(() => addConstraint('path'))}
        >
          <Route size={14} />
        </button>
        <span className="ml-auto font-mono text-3xs text-content-lo">{rows.length}</span>
      </div>
      {/* 搜索：按名字筛选树（骨骼 / 插槽 / display / 约束），根骨骼始终保留 —— 见上面的 filter */}
      <div className="relative shrink-0 border-b border-line/60 bg-ink-800/60 px-1 py-1">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            // Esc 清空：与检查器里的输入框一致，打错了不用先全选再删
            if (event.key === 'Escape') setQuery('')
          }}
          placeholder="搜索骨骼 / 插槽 / 约束…"
          className="hao-field h-[22px] w-full pr-6 text-panel"
        />
        {query ? (
          <button
            type="button"
            title="清空搜索"
            onClick={() => setQuery('')}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-content-lo hover:text-content-hi"
          >
            <X size={12} />
          </button>
        ) : (
          <Search
            size={12}
            className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-content-lo"
          />
        )}
      </div>
      <div
        ref={listRef}
        className="min-h-0 flex-1 overflow-auto hao-scroll pb-1"
        title={
          '右键骨骼行 / 空白处：添加骨骼、插槽、约束（约束挂在驱动骨骼下）\n' +
          '拖动行调整层级：骨骼 → 骨骼下（拖到空白处成为根骨骼）、插槽 → 骨骼下（拖到空白处挂到第一根骨骼）、display → 插槽下\n' +
          '拖到行的上 / 下沿 = 排到那一行的前 / 后（骨骼会一起换到它所在的父级下）\n' +
          '资源面板的图片：拖到插槽行（含它下面的 display 行）= 给该插槽加一个 display；拖到骨骼行 = 在该骨骼下新建插槽\n' +
          '改绑定数据（拖动行 / 拖图片 / 新建 / 删除）只在 Pose 态可用'
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
                result = moveBone(draft, payload.name, '', 'inside', { worldMatrixOf: worldMatrixOfBone })
              })
              if (result.message) onStatus?.(result.message)
              return
            }
            if (payload.kind === 'slot') {
              const first = document.bones[0]?.name ?? ''
              if (!first) return
              let result: MoveResult = { ok: false, message: '' }
              update('调整插槽层级', (draft) => {
                result = moveSlot(draft, payload.name, first, null, { worldMatrixOf: worldMatrixOfBone })
              })
              if (result.message) onStatus?.(result.message)
              return
            }
            onStatus?.('display 只能放到插槽下面')
            return
          }
          const imageNames = readImageDrag(event.dataTransfer)
          const slotName = slotUnderPointer(event.clientY)
          if (imageNames.length > 0 && slotName) addDisplay(slotName, imageNames)
        }}
      >
        {rows}
      </div>

      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          title={
            useModeStore.getState().mode === 'animate'
              ? `${menu.target.kind === 'bone' ? '骨骼' : menu.target.kind === 'slot' ? '插槽' : '约束'}「${menu.target.name}」· 打关键帧${
                  // 置灰项的 hover 提示看不到，把原因写在标题里
                  document.animations.length === 0 ? '（工程里还没有动画：先在时间轴点「+ 动画」）' : ''
                }`
              : menu.target.kind === 'root'
                ? '新建对象'
                : `${menu.target.kind === 'bone' ? '骨骼' : menu.target.kind === 'slot' ? '插槽' : '约束'}「${menu.target.name}」`
          }
          items={menuItems(menu.target)}
          onClose={() => setMenu(null)}
        />
      ) : null}

      {displayMenu ? (
        <ContextMenu
          x={displayMenu.x}
          y={displayMenu.y}
          title={`「${displayMenu.slot}」· display「${displayMenu.attachment}」`}
          items={[
            {
              key: 'display-key',
              label: '显示关键帧（从这里开始显示）',
              hint: `在当前时间切到「${displayMenu.attachment}」`,
              icon: <KeyRound size={12} />,
              onSelect: () => {
                const result = keySlotDisplayNow(displayMenu.slot, displayMenu.attachment)
                onStatus?.(result.message)
              }
            },
            {
              key: 'display-hide-key',
              label: '隐藏关键帧（从这里开始不显示）',
              hint: '在当前时间把该插槽切成「不显示」',
              icon: <EyeOff size={12} />,
              onSelect: () => {
                const result = keySlotDisplayNow(displayMenu.slot, '')
                onStatus?.(result.message)
              }
            }
          ]}
          onClose={() => setDisplayMenu(null)}
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

/**
 * 从当前多选里整理出受约束骨骼链（IK 用）。
 *
 * 只接受「父 → 子」连续的几根骨骼 —— 乱七八糟的多选（选了两条腿）拿去当链只会配出错的 IK。
 * 选反了（链尾在前）也接受，翻转后同样连续就用翻转的结果：IK 的链根必须排在前面。
 * 都不满足时退回 `fallback` 单骨。
 */
function chainFromSelection(doc: EditorDocument, names: readonly string[], fallback: string): string[] {
  const picked = names.filter(Boolean)
  const isChain = (list: readonly string[]): boolean =>
    list.length >= 2 &&
    list.every((name, index) => {
      if (index === 0) return doc.bones.some((bone) => bone.name === name)
      const bone = doc.bones.find((item) => item.name === name)
      return !!bone && bone.parent === list[index - 1]
    })
  if (isChain(picked)) return [...picked]
  const reversed = [...picked].reverse()
  if (isChain(reversed)) return reversed
  return fallback ? [fallback] : []
}

function toCss(hex: string): string {
  const rgb = hex.length === 9 ? hex.slice(0, 7) : hex
  return rgb.startsWith('#') ? rgb : '#ffffff'
}

export type { AuthoringConstraint }

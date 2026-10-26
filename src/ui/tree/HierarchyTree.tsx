import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  Bone,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Eye,
  EyeOff,
  Grid3x3,
  Image as ImageIcon,
  KeyRound,
  Link2,
  PersonStanding,
  Lock,
  Maximize2,
  Pentagon,
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
import { useTreeUiStore } from '@editor/store/treeUiStore'
import { keySlotDisplayNow, keyframeTargetsNow } from '@editor/timeline/actions'
import { CONSTRAINT_CHANNEL_LABEL, CONSTRAINT_CHANNELS, slotDisplayNameAt } from '@editor/timeline/model'
import type { KeyframeTarget } from '@editor/timeline/model'
import { getActiveScene } from '@editor/activeScene'
import { focusNode } from '@editor/focusNode'
import type { FocusTarget } from '@editor/focusNode'
import { createIkConstraint, createPathConstraint, createTransformConstraint } from '@core/model/constraints'
import type { AuthoringBone, AuthoringConstraint, AuthoringImage, EditorDocument } from '@core/model/authoring'
import { createAuthoringBone, createAuthoringSlot, rootBoneName } from '@core/model/authoring'
import {
  addArmatureDisplay,
  addImageDisplay,
  createRegionFromImage,
  deleteAttachment,
  deleteBone,
  deleteSlot,
  toggleSlotDisplay
} from '@editor/commands/authoringCommands'
import { checkNestDrop } from '@core/nesting/nest'
import {
  boneSlotAnchor,
  moveBone,
  moveDisplay,
  moveSlot,
  moveSlotToBottom,
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
import { unitsToPx } from '@ui/widgets/fields'
import { t } from '@i18n'

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
  /** display 行用 `data-attachment` 标出附件名：选中附件时按「插槽 + 附件」定位到这一行 */
  dataAttachment?: string
  /** 非 0 时整行闪一下（定位请求；父组件 900ms 后清 0，靠这个开关重启动画） */
  flashKey?: number
}

/**
 * 当前正在树内拖动的负载。
 * HTML5 dragover 阶段拿不到 dataTransfer 的自定义数据，只能靠这个变量判断
 * 「拖的是插槽，落在另一条插槽行上」——这种场景按 50/50 分成上下两半，
 * 让整行 22px 都能用来排序，而不是只有上下各 6px 的边缘。
 */
let activeTreeDrag: TreeDragPayload | null = null

/**
 * 树内拖动是否能落到这一行。
 * - 骨骼只能落到骨骼行（骨骼和插槽是两套独立顺序，骨骼不能插到插槽行之间）
 * - 插槽可以落到骨骼行（换宿主）或插槽行（调绘制顺序）
 * - display 只能落到插槽 / display 行
 * 不兼容时返回 false，让 dragover 显示禁止光标，而不是给一条假的插入线。
 */
function canDropTreePayload(
  payload: TreeDragPayload | null,
  targetKind: 'bone' | 'slot' | 'display' | 'other'
): boolean {
  if (!payload) return true
  if (payload.kind === 'bone') return targetKind === 'bone'
  if (payload.kind === 'slot') return targetKind === 'bone' || targetKind === 'slot'
  // 嵌套骨架只能落到插槽行（骨架列表拖出来 = 新建一个 armature display）
  if (payload.kind === 'armature') return targetKind === 'slot'
  return targetKind === 'slot' || targetKind === 'display'
}

/** 指针落在行的哪一段：上沿 / 中间（放进这一层）/ 下沿 */
function dropPositionOf(
  event: React.DragEvent<HTMLDivElement>,
  targetKind: 'bone' | 'slot' | 'display' | 'other'
): TreeDropPosition {
  const rect = event.currentTarget.getBoundingClientRect()
  const ratio = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0.5
  // 骨架拖进插槽只有「放进插槽」一种语义：不需要上/下沿排序
  if (activeTreeDrag?.kind === 'armature') return 'inside'
  if (targetKind === 'slot' && activeTreeDrag?.kind === 'slot') {
    return ratio < 0.5 ? 'above' : 'below'
  }
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
  dataAttachment,
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
  /** 拖了一个不能放到这一行的东西（骨骼 → 插槽行等）：给红色提示，别画插入线 */
  const [blocked, setBlocked] = useState(false)

  const acceptsDrop = Boolean(onDropImage || onDropNode)
  /** 这一行是什么类型的落点：决定插槽拖动时用 50/50 还是 28/72 的上下沿判定 */
  const targetKind: 'bone' | 'slot' | 'display' | 'other' = dataAttachment
    ? 'display'
    : dataSlot
      ? 'slot'
      : dataBone
        ? 'bone'
        : 'other'

  /**
   * 双击聚焦的目标：显式给的优先（约束行），否则直接用拖动负载 ——
   * 骨骼 / 插槽 / display 三种负载的形状与 FocusTarget 相同，不必逐行重复声明。
   */
  // 骨架负载（从骨架栏拖出来的那种）不是可聚焦节点，只用于拖放
  const focus: FocusTarget | undefined =
    focusTarget ?? (dragPayload && dragPayload.kind !== 'armature' ? dragPayload : undefined)

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
        blocked ? 'ring-1 ring-inset ring-danger/70 bg-danger/10' : '',
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
      data-attachment={dataAttachment}
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
              activeTreeDrag = dragPayload
              setTreeDragData(event.dataTransfer, dragPayload)
              event.stopPropagation()
            }
          : undefined
      }
      onDragEnd={
        dragPayload
          ? () => {
              activeTreeDrag = null
              setNodeHint(null)
              setBlocked(false)
            }
          : undefined
      }
      onDragOver={
        acceptsDrop
          ? (event) => {
              // 某些 Chromium/Electron 组合在 dragover 后段会读不到自定义 MIME，
              // 用 dragstart 记下的 activeTreeDrag 兜底，避免拖到一半突然变成「不可放置」
              const tree = hasTreeDrag(event.dataTransfer) || activeTreeDrag !== null
              const image = hasImageDrag(event.dataTransfer)
              if (!image && !tree) return
              if (tree) {
                if (!onDropNode) return
                if (!canDropTreePayload(activeTreeDrag, targetKind)) {
                  // 骨骼拖到插槽行 / 插槽拖到 display 行等：不给插入线，显示禁止光标 + 红框
                  // 必须 stopPropagation：否则会冒泡到列表空白处，被当成「拖到最下面」处理
                  event.stopPropagation()
                  event.dataTransfer.dropEffect = 'none'
                  if (!blocked) setBlocked(true)
                  if (nodeHint) setNodeHint(null)
                  return
                }
                event.preventDefault()
                event.stopPropagation()
                event.dataTransfer.dropEffect = 'move'
                const hint = dropPositionOf(event, targetKind)
                if (nodeHint !== hint) setNodeHint(hint)
                return
              }
              event.preventDefault()
              event.stopPropagation()
              event.dataTransfer.dropEffect = 'copy'
              if (!dropActive) setDropActive(true)
            }
          : undefined
      }
      onDragLeave={
        acceptsDrop
          ? () => {
              setDropActive(false)
              setNodeHint(null)
              setBlocked(false)
            }
          : undefined
      }
      onDrop={
        acceptsDrop
          ? (event) => {
              const tree = hasTreeDrag(event.dataTransfer) || activeTreeDrag !== null
              if (!hasImageDrag(event.dataTransfer) && !tree) return
              event.preventDefault()
              event.stopPropagation()
              setDropActive(false)
              setNodeHint(null)
              setBlocked(false)
              if (tree) {
                if (!onDropNode) return
                const position = dropPositionOf(event, targetKind)
                const payload = readTreeDrag(event.dataTransfer) ?? activeTreeDrag
                activeTreeDrag = null
                if (payload) onDropNode(payload, position)
                return
              }
              const imageNames = readImageDrag(event.dataTransfer)
              if (imageNames.length > 0) onDropImage?.(imageNames)
            }
          : undefined
      }
    >
      {active ? <span className="absolute left-0 top-0 h-full w-[2px] bg-accent" /> : null}
      {/* 行首两列（固定宽度、不随层级缩进）：显示 / 锁定。
          两列贴在一起（中间只留 2px）—— 与「slot 层级」面板的行首图标密度一致：
          原来各占 18px + 列间 gap-1，两个图标之间空出 11px，看着发虚 */}
      <span className="flex shrink-0 items-center gap-0.5">
        <span className="flex w-[14px] justify-center">
          {visibleSwitch ? (
            <button
              type="button"
              tabIndex={-1}
              title={visibleSwitch.title}
              className={[
                'flex h-[14px] w-[14px] cursor-pointer items-center justify-center rounded hover:bg-ink-600',
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
        <span className="flex w-[14px] justify-center">
          {lockSwitch ? (
            <button
              type="button"
              tabIndex={-1}
              title={lockSwitch.title}
              className={[
                'flex h-[14px] w-[14px] cursor-pointer items-center justify-center rounded hover:bg-ink-600',
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
            title={t('删除')}
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

/** 骨骼末端的世界坐标（原点沿骨骼 x 轴前进 length）：新建 IK 节点骨要摆在链尾末端 */
function boneTipWorld(boneName: string, length: number): { x: number; y: number } | null {
  const matrix = worldMatrixOfBone(boneName)
  if (!matrix || matrix.length < 14) return null
  // mat4 列主序：第 0 列是骨骼 x 轴方向，平移在 [12] / [13]
  return { x: matrix[0] * length + matrix[12], y: matrix[1] * length + matrix[13] }
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

/**
 * 插槽图标：**◉**（圆环 + 中心实心点）。骨骼行用骨形图标，插槽用圆点一眼区分开；
 * 行首图标会带上插槽自己的颜色（见插槽行的 `icon`），与视口里插槽手柄同色。
 */
function SlotIcon({ size = 12, color }: { size?: number; color?: string }): React.ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="1 1 20 20"
      fill="none"
      stroke="currentColor"
      style={color ? { color } : undefined}
    >
      <circle cx="12" cy="12" r="7.4" strokeWidth={2.8} />
      <circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none" />
    </svg>
  )
}

/**
 * 根骨骼图标：**✛**（四臂端点带凸点的十字）。层级根骨骼 root 与普通骨骼同是骨骼，
 * 但它不能拖动 / 删除，是整棵树的根 —— 用一个不一样的记号让它一眼能认出来。
 */
function RootBoneIcon({ size = 11, style }: { size?: number; style?: React.CSSProperties }): React.ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.6}
      strokeLinecap="round"
      style={style}
    >
      <path d="M12 7v10M7 12h10" />
      <circle cx="12" cy="3.4" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="12" cy="20.6" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="3.4" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="20.6" cy="12" r="1.5" fill="currentColor" stroke="none" />
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

/** 约束类型的短名（IK 保持原文，其余走词典）；文案随语言切换，故是函数 */
function constraintKind(type: AuthoringConstraint['type']): string {
  return t({ ik: 'IK', transform: '变换', path: '路径', physics: '物理' }[type])
}

/** 右键目标的中文名（骨骼 / 插槽 / 约束），用在菜单标题里；root 没有名字 */
function targetKind(kind: MenuTarget['kind']): string {
  if (kind === 'bone') return t('骨骼')
  if (kind === 'slot') return t('插槽')
  return t('约束')
}

/**
 * 约束的「宿主」骨骼：合并显示后，IK / 变换 / 路径约束不再单独占一行，而是寄在
 * 宿主行的徽标 + 属性面板的内嵌分组里；物理约束与宿主缺失的约束仍单独成行。
 *
 * - IK：宿主 = 目标骨 —— 「目标骨就是 IK 节点」（DragonBones 的 bone.ik 心智）
 * - 变换 / 路径：宿主 = 第一根被驱动骨（约束跟着被驱动的骨骼走；目标骨常被多条约束共享，
 *   挂目标上会让一根骨的面板里堆出一摞约束）
 */
function constraintHost(constraint: AuthoringConstraint): string {
  if (constraint.type === 'ik') return constraint.target
  return constraint.bones[0] ?? ''
}

export interface HierarchyTreeProps {
  /** 状态栏提示（Animate 态拒绝改绑定数据时说明原因） */
  onStatus?: (text: string) => void
}

/** 网格型附件（含 linkedmesh）：层级树里用网格图标，和贴图区分开 */
function isMeshType(type: AuthoringAttachmentType): boolean {
  return type === 'mesh' || type === 'linkedmesh'
}

/** display 行的类型名（与行内图标同一口径：贴图 / 网格）；文案随语言切换，故是函数 */
function attachmentKind(type: AuthoringAttachmentType): string {
  return t(
    { region: '贴图', mesh: '网格', linkedmesh: '网格（链接）', boundingbox: '包围盒', clipping: '遮罩', armature: '骨架' }[type]
  )
}

type TreeSlot = EditorDocument['slots'][number]
type TreeDisplay = EditorDocument['skins'][number]['slots'][number]['attachments'][number]

/*
 * 行的悬浮描述（原生 title）。
 *
 * 都是纯函数、字符串在组件外拼好：文案只取决于文档数据，跟渲染状态无关；
 * 多行的写法与树容器那句说明一致 —— 一行一个信息点，扫一眼就能读完。
 */
function boneRowTitle(
  bone: AuthoringBone,
  counts: { bones: number; slots: number; constraints: number },
  hosted: readonly AuthoringConstraint[] = []
): string {
  const attached: string[] = []
  if (counts.bones > 0) attached.push(t('{0} 根子骨骼', counts.bones))
  if (counts.slots > 0) attached.push(t('{0} 个插槽', counts.slots))
  if (counts.constraints > 0) attached.push(t('{0} 个约束', counts.constraints))
  const lines = [
    t('骨骼「{0}」', bone.name),
    t('父级：{0}', bone.parent || t('（根骨骼）')),
    t('挂载：{0}', attached.length > 0 ? attached.join(' · ') : t('（空）')),
    // 与行尾 meta 同一口径（length 存世界单位，树里按 px 显示，换算走 unitsToPx）；
    // rotation 存的是**局部**值，有父级时写明基准，免得跟视口里看到的世界角度对不上
    t('长度 {0}px · {1}', [
      unitsToPx(bone.length).toFixed(0),
      bone.parent
        ? t('相对父级旋转 {0}°', bone.rotation.toFixed(1))
        : t('旋转 {0}°', bone.rotation.toFixed(1))
    ])
  ]
  // 寄宿的约束（IK = 目标骨，变换 / 路径 = 第一根被驱动骨）：树里不再单独成行，靠徽标 + 这里说明
  for (const constraint of hosted) {
    lines.push(
      t('{0}约束「{1}」寄宿在本骨骼 · 骨链 {2} · 参数在属性面板', [
        constraintKind(constraint.type),
        constraint.name,
        constraint.bones.length > 0 ? constraint.bones.join(' → ') : t('（未设置）')
      ])
    )
  }
  if (bone.locked) lines.push(t('已锁定：视口里点不中它（层级树里照常可操作）'))
  return lines.join('\n')
}

function slotRowTitle(slot: TreeSlot, displayCount: number, showing: string): string {
  const lines = [
    t('插槽「{0}」', slot.name),
    t('挂载于：{0}', slot.bone || t('根层')),
    t('绘制层序 {0}（越小越先绘制）· display {1} 个', [slot.zOrder, displayCount])
  ]
  if (!slot.visible) lines.push(t('已隐藏：视口与导出都不绘制它（点行首眼睛恢复）'))
  else if (showing) lines.push(t('当前显示：{0}', showing))
  else if (displayCount > 0) lines.push(t('当前一个 display 都不显示（点 display 行的小图标显示它）'))
  if (slot.locked) lines.push(t('已锁定：视口里点不中它（层级树里照常可操作）'))
  return lines.join('\n')
}

function displayRowTitle(slot: TreeSlot, display: TreeDisplay, showing: boolean): string {
  const lines = [
    t('display「{0}」 · {1}', [display.name, attachmentKind(display.type)]),
    t('宿主插槽：{0}', slot.name)
  ]
  if (display.image) lines.push(t('图片：{0}', display.image))
  lines.push(
    showing
      ? t('显示中：点前面的小图标可隐藏它（该插槽将不显示任何 display）')
      : t('未显示：点前面的小图标切换到它（点文字只选中，不改显示）')
  )
  return lines.join('\n')
}

function constraintRowTitle(constraint: AuthoringConstraint): string {
  const lines = [
    t('{0}约束「{1}」', [constraintKind(constraint.type), constraint.name]),
    t('骨骼链：{0}', constraint.bones.length > 0 ? constraint.bones.join(' → ') : t('（没有骨骼）'))
  ]
  if (constraint.target) lines.push(t('目标：{0}', constraint.target))
  if (constraint.type === 'ik') {
    lines.push(
      t('权重 {0} · 弯曲方向 {1}', [
        constraint.mix.toFixed(2),
        constraint.bendSign > 0 ? '+1' : '-1'
      ])
    )
  }
  if (constraint.type === 'transform') {
    // inherit 没有中文名（工程文件里也是这几个英文枚举），原样显示成「字段：取值」
    lines.push(
      t('继承模式：{0}{1}{2}', [
        constraint.inherit,
        constraint.relative ? t(' · 相对叠加') : '',
        constraint.local ? t(' · 取局部变换') : ''
      ])
    )
  }
  if (constraint.type === 'path') {
    lines.push(t('位置 {0} · 间距 {1}', [constraint.position.toFixed(2), constraint.spacing.toFixed(2)]))
  }
  if (constraint.type === 'physics') lines.push(t('仅保留数据：不参与求解，导出直通'))
  if (!constraint.enabled) lines.push(t('已停用（enabled = false）'))
  return lines.join('\n')
}

/**
 * 层级树：骨骼、插槽、约束（含 IK）合并为**一棵树**，用图标区分类型。
 *
 * 组织结构：
 * - 根骨骼挂在顶层，子骨骼递归缩进（还原真实父子层级）
 * - 插槽作为其宿主骨骼的子节点（缩进一级），展开后列出它的 display
 * - IK / 变换 / 路径约束**不单独成行**：寄宿在宿主骨骼行上（行尾徽标，见 `constraintHost`），
 *   参数在该骨骼的属性面板里编辑；物理约束与宿主缺失的约束仍作为独立行挂在 `bones[0]` 下
 */
export default function HierarchyTree({ onStatus }: HierarchyTreeProps) {
  const document = useProjectStore((s) => s.document)
  const update = useProjectStore((s) => s.update)
  const selection = useSelectionStore()
  /**
   * 层级根骨骼名：整棵树的根，其他骨骼 / 插槽都挂在它之下。
   * 「未选中 / 落到空白处」的挂载目标、根骨骼的移动与删除保护都用它。
   */
  const rootName = rootBoneName(document.bones)
  // 折叠状态提升到 store（见 treeUiStore）：复制 / 直接复制生成新节点时要把源节点的折叠
  // 状态照搬到新节点，而粘贴逻辑在 editor 层，需要共享这块 UI 状态。
  const collapsed = useTreeUiStore((s) => s.collapsed)
  const setCollapsed = useTreeUiStore((s) => s.setCollapsed)
  /** 树里是否列出 display 行（工具栏最右侧的眼睛切换）；纯显示开关，不动数据 */
  const showDisplays = useTreeUiStore((s) => s.showDisplays)
  const setShowDisplays = useTreeUiStore((s) => s.setShowDisplays)
  /** 搜索框内容：空 = 不过滤；有值时只显示命中节点 + 其祖先（根骨骼始终保留），并临时全展开 */
  const [query, setQuery] = useState('')
  /** 树列表容器：拖放兜底判定要用它量各行的位置 */
  const listRef = useRef<HTMLDivElement | null>(null)
  /** 拖插槽到列表下方空白处时，在最底部画一条插入线，提示「放到最底层」 */
  const [bottomHint, setBottomHint] = useState(false)
  /** 检查器里的「定位」请求：滚到那根骨骼并闪一下（见下面两个 effect） */
  const revealTarget = useRevealStore((s) => s.bone)
  const revealNonce = useRevealStore((s) => s.nonce)
  const handledReveal = useRef(0)
  /**
   * 正在闪烁的行（整行蓝底，见 `.hao-reveal-flash`）。三个来源：
   * - 检查器的「定位」请求（force：无论可见与否都滚过来 + 闪）
   * - **树外选中**（视口 / 时间轴 / 插槽面板…）：行不在可见区域时滚过去并闪一下；
   *   行本来就可见则什么都不做 —— 树内点击同样走这里，零噪音
   */
  const [flash, setFlash] = useState<{
    kind: 'bone' | 'slot' | 'display'
    name: string
    /** display 行还要配对插槽（不同插槽可能有同名附件） */
    slot?: string
    nonce: number
    force?: boolean
  } | null>(null)
  const flashNonceRef = useRef(0)

  /** 在已渲染的行里找闪烁目标（attribute 选择器与行的 data-* 一一对应） */
  const findFlashRow = (target: NonNullable<typeof flash>): Element | null => {
    const list = listRef.current
    if (!list) return null
    if (target.kind === 'bone') return list.querySelector(`[data-bone="${CSS.escape(target.name)}"]`)
    if (target.kind === 'slot') return list.querySelector(`[data-slot="${CSS.escape(target.name)}"]`)
    return list.querySelector(
      `[data-slot="${CSS.escape(target.slot ?? '')}"][data-attachment="${CSS.escape(target.name)}"]`
    )
  }

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
    setFlash({ kind: 'bone', name: revealTarget, nonce: revealNonce, force: true })
  }, [revealTarget, revealNonce])

  /**
   * 树外选中（视口点击 / 时间轴轨道 / 插槽面板 / 检查器联动）跟随：
   * 对应行**不在可见区域**时展开祖先、滚过去并亮一下；已在可见区域就什么都不做 ——
   * 树内点击走同一个 effect，不能每点一下都闪。
   */
  useEffect(() => {
    let kind:
      | { kind: 'bone'; name: string }
      | { kind: 'slot'; name: string }
      | { kind: 'display'; name: string; slot: string }
      | null =
      selection.kind === 'bone' && selection.bone
        ? { kind: 'bone', name: selection.bone }
        : selection.kind === 'slot' && selection.slot
          ? { kind: 'slot', name: selection.slot }
          : selection.kind === 'attachment' && selection.slot && selection.attachment
            ? { kind: 'display', name: selection.attachment, slot: selection.slot }
            : null
    // 约束没有自己的行：寄宿在宿主骨上（IK = 目标骨，变换 / 路径 = 第一根驱动骨，物理 = 驱动骨）
    if (!kind && selection.kind === 'constraint' && selection.constraint) {
      const constraint = document.constraints.find((item) => item.name === selection.constraint)
      const host = constraint ? constraintHost(constraint) : ''
      if (host) kind = { kind: 'bone', name: host }
    }
    if (!kind) return

    // 行已渲染且完全在可见区域内 → 不滚动也不闪（点树里的行就是这种情况）
    const row = findFlashRow({ kind: kind.kind, name: kind.name, slot: 'slot' in kind ? kind.slot : undefined, nonce: 0 })
    if (row) {
      const list = listRef.current
      const listRect = list?.getBoundingClientRect()
      const rowRect = row.getBoundingClientRect()
      if (listRect && rowRect.top >= listRect.top - 1 && rowRect.bottom <= listRect.bottom + 1) return
    }

    // 展开祖先链（骨骼父链 / 插槽宿主 / display 的宿主插槽），再交给滚动 effect 滚过去
    const bones = useProjectStore.getState().document.bones
    const slots = useProjectStore.getState().document.slots
    const hostBone =
      kind.kind === 'bone'
        ? kind.name
        : kind.kind === 'slot'
          ? (slots.find((item) => item.name === kind.name)?.bone ?? '')
          : (slots.find((item) => item.name === kind.slot)?.bone ?? '')
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (kind.kind === 'display' && kind.slot) next.delete(`slot:${kind.slot}`)
      let parent = bones.find((bone) => bone.name === hostBone)?.parent ?? ''
      while (parent) {
        next.delete(parent)
        parent = bones.find((bone) => bone.name === parent)?.parent ?? ''
      }
      return next
    })
    flashNonceRef.current += 1
    setFlash({ ...kind, nonce: flashNonceRef.current })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection.kind, selection.bone, selection.slot, selection.attachment, selection.constraint])

  /** 行渲染出来之后再滚动（上面那批状态已生效），闪完自动收尾 */
  useEffect(() => {
    if (!flash) return
    findFlashRow(flash)?.scrollIntoView({ block: 'nearest' })
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

  /**
   * 工具栏「全部折叠 / 全部展开」：一个按钮两种状态。
   * - 只要还有折叠着的节点（`collapsed` 非空）→ 全部展开（清空集合）
   * - 全都展开时 → 一次折起所有骨骼与插槽（没有子节点的行也放进去，反正不显示箭头）
   * 搜索期间树是强制展开的（见 `expanded`），这时按钮点了看不出变化，属于既有约定。
   */
  const toggleCollapseAll = (): void => {
    setCollapsed((prev) => {
      if (prev.size > 0) return new Set<string>()
      const all = new Set<string>()
      for (const bone of document.bones) all.add(bone.name)
      for (const slot of document.slots) all.add(`slot:${slot.name}`)
      return all
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
      update(showing ? t('隐藏 display') : t('切换显示的 display'), (draft) => {
        toggleSlotDisplay(draft, slotName, attachmentName)
      })
      onStatus?.(
        showing
          ? t('插槽「{0}」不再显示任何 display', slotName)
          : t('插槽「{0}」显示「{1}」', [slotName, attachmentName])
      )
    }
    // 隐藏后仍选中这一行：还能在检查器里编辑它，或再点一次重新显示
    selection.selectAttachment(slotName, attachmentName)
  }

  /** 骨骼 / 插槽 / display / 约束都是绑定数据：Animate 态拒绝增删与改层级，避免污染动画基线 */
  const canEditBinding = (): boolean => {
    if (useModeStore.getState().mode === 'pose') return true
    // 这句话服务于所有入口：拖行改层级、拖图片建插槽 / 加 display、工具栏新建、行尾删除
    onStatus?.(t('切到 Pose 状态才能改绑定数据（骨骼 / 插槽 / display / 约束）'))
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
      images.length > 1
        ? t('拖入 {0} 张图片添加 display', images.length)
        : t('拖入图片添加 display'),
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

    /*
     * 从顶部骨架栏拖来的骨架 → 落到插槽行 = 新建一个「嵌套骨架」display。
     *
     * 三道闸：自引用 / 环 / 层数超限（`checkNestDrop` 一次给出可读原因）。
     * 当前骨架本身在骨架栏里是 `draggable=false`，这里再兜一次底 —— 命令 / AI 接口
     * 也可能带着「拖自己」的请求进来。
     */
    if (payload.kind === 'armature') {
      if (target.kind !== 'slot') {
        onStatus?.(t('骨架只能拖到插槽上（对着插槽行中间松手）'))
        return
      }
      const parent = document.armatureName
      if (parent === payload.name) {
        onStatus?.(t('不能把骨架拖到它自己的层级里'))
        return
      }
      const reason = checkNestDrop(useProjectStore.getState().skeletons, parent, payload.name)
      if (reason) {
        onStatus?.(t(reason))
        return
      }
      const created: Array<{ slot: string; attachment: string }> = []
      update(t('嵌套骨架「{0}」', payload.name), (draft) => {
        const result = addArmatureDisplay(draft, {
          slot: target.name,
          armature: payload.name,
          skin: selection.skin
        })
        if (result) created.push(result)
      })
      const last = created[created.length - 1]
      if (!last) return
      selection.selectAttachment(last.slot, last.attachment)
      expandBone(boneOfSlot(target.name))
      return
    }

    if (payload.kind === 'bone') {
      if (target.kind !== 'bone') {
        onStatus?.(t('骨骼只能放到骨骼下面（拖到列表空白处 = 挂到根骨骼下）'))
        return
      }
      const check = validateBoneMove(document, payload.name, target.name)
      if (!check.ok) {
        onStatus?.(check.message)
        return
      }
      let result: MoveResult = check
      update(t('调整骨骼层级'), (draft) => {
        // 传世界矩阵：换父级后保持骨骼的全局位置 / 旋转 / 缩放
        result = moveBone(draft, payload.name, target.name, position, { worldMatrixOf: worldMatrixOfBone })
      })
      if (result.message) onStatus?.(result.message)
      return
    }

    if (payload.kind === 'slot') {
      /*
       * 插槽拖到另一条插槽行的上/下沿 = 按绘制顺序插到它前/后。
       * 这也是层级树里最常用的「三个 slot 换个位置」：直接拖到目标插槽行上即可，
       * 不必先找宿主骨骼、再猜要落在骨骼插槽列表的头部还是尾部。
       * 中间区域按「插到目标之后」处理，整行 22px 都是有效落点，避免上下沿 6px 太小。
       */
      if (target.kind === 'slot') {
        if (payload.name === target.name) {
          onStatus?.(t('插槽「{0}」已经在这个位置', payload.name))
          return
        }
        const targetSlot = document.slots.find((item) => item.name === target.name)
        if (!targetSlot) {
          onStatus?.(t('找不到插槽「{0}」', target.name))
          return
        }
        // 目标在「根层」时沿用源插槽的宿主骨骼：这里只调绘制顺序，不要因为目标没挂骨骼就失败
        const sourceSlot = document.slots.find((item) => item.name === payload.name)
        const hostBone = targetSlot.bone || sourceSlot?.bone || ''
        const check = validateSlotMove(document, payload.name, hostBone)
        if (!check.ok) {
          onStatus?.(check.message)
          return
        }
        let result: MoveResult = check
        update(t('调整插槽层级'), (draft) => {
          /*
           * 列表是「上面的行更靠前（zOrder 更大）」，而 moveSlot 的 ordered 是 zOrder 升序（先画 → 后画）：
           * 落在目标**上方** = 比目标更晚绘制 = 插到目标之后；落在下方则相反。
           */
          const side = position === 'above' ? 'after' : 'before'
          // 传世界矩阵：万一跨骨骼，保持插槽内容的全局位置 / 旋转 / 缩放
          result = moveSlot(draft, payload.name, hostBone, { name: target.name, side }, {
            worldMatrixOf: worldMatrixOfBone
          })
        })
        onStatus?.(
          result.ok
            ? t('插槽「{0}」已移到「{1}」{2}', [
                payload.name,
                target.name,
                position === 'above' ? t('上方') : t('下方')
              ])
            : result.message
        )
        return
      }

      if (target.kind !== 'bone') {
        onStatus?.(t('插槽只能放到骨骼或另一条插槽旁边'))
        return
      }
      const check = validateSlotMove(document, payload.name, target.name)
      if (!check.ok) {
        onStatus?.(check.message)
        return
      }
      let result: MoveResult = check
      update(t('调整插槽层级'), (draft) => {
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
    onStatus?.(t('display 只能放到插槽下面'))
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
    update(t('移动 display'), (draft) => {
      // 传世界矩阵：换到别的插槽（宿主骨骼不同）时保持附件的全局位置 / 旋转 / 缩放
      result = moveDisplay(draft, payload.slot, payload.name, toSlot, anchor, skinName, {
        worldMatrixOf: worldMatrixOfBone
      })
    })
    if (result.message) onStatus?.(result.message)
  }

  /**
   * 资源面板拖图片进层级窗口：在 `boneName` 下新建插槽，图片作为它的第一个 display。
   * 两个入口共用：拖到**骨骼行** = 那根骨骼；拖到列表**空白处** = 层级根骨骼 root。
   */
  const addSlotFromImage = (boneName: string, imageNames: string[]): void => {
    if (!canEditBinding()) return
    const images = imageNames
      .map((name) => document.images.find((item) => item.name === name))
      .filter((item): item is AuthoringImage => Boolean(item))
    if (images.length === 0) return
    const created: { slot: string; attachment: string }[] = []
    update(
      images.length > 1
        ? t('拖入 {0} 张图片新建插槽', images.length)
        : t('拖入图片新建插槽'),
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
    if (!first) {
      onStatus?.(t('无法用「{0}」新建插槽', images[0].name))
      return
    }
    selection.selectAttachment(first.slot, first.attachment)
    expandBone(boneName)
    // 报出宿主骨骼：空白处落点挂到 root，不提示的话很难看出这一笔挂到了哪里
    onStatus?.(
      created.length === 1
        ? t('已新建插槽「{0}」挂到骨骼「{1}」下（图片「{2}」是它的 display）', [
            first.slot,
            boneName,
            images[0].name
          ])
        : t('已新建 {0} 个插槽挂到骨骼「{1}」下（{2}）', [
            created.length,
            boneName,
            created.map((item) => item.slot).join(t('、'))
          ])
    )
  }

  /** 展开某根骨骼（新建子对象后自动展开，避免「加了却看不见」） */
  const expandBone = (boneName: string): void => {
    if (!boneName) return
    setCollapsed((prev) => (prev.has(boneName) ? new Set([...prev].filter((name) => name !== boneName)) : prev))
  }

  /** 插槽挂在哪根骨骼上（拖放后展开宿主用） */
  const boneOfSlot = (slotName: string): string =>
    document.slots.find((item) => item.name === slotName)?.bone ?? ''

  /** 当前选中的骨骼（工具栏「+」按钮用它作为挂载目标） */
  const selectedBone = (): string => (selection.kind === 'bone' && selection.bone ? selection.bone : '')

  const addBone = (parent = selectedBone()): void => {
    // 未选中（含从空白处右键）时挂到层级根骨骼 root 下：其他骨骼都必须待在它之下
    const host = parent || rootName
    update(t('新建骨骼'), (draft) => {
      const baseName = parent ? `${parent}_child` : 'bone'
      draft.bones.push(
        createAuthoringBone({
          name: uniqueName(draft.bones.map((b) => b.name), baseName),
          parent: host,
          length: 0.4
        })
      )
    })
    if (host) setCollapsed((prev) => (prev.has(host) ? new Set([...prev].filter((n) => n !== host)) : prev))
  }

  const addSlot = (bone = selectedBone()): void => {
    update(t('新建插槽'), (draft) => {
      // 宿主兜底到层级根骨骼：插槽必须挂在骨骼上，挂在 root 下总能看见内容
      const host = bone || rootBoneName(draft.bones)
      const name = uniqueName(draft.slots.map((s) => s.name), 'slot')
      draft.slots.push(createAuthoringSlot({ name, bone: host, zOrder: draft.slots.length }))
      draft.skins[0]?.slots.push({ slot: name, attachments: [] })
    })
    if (bone) setCollapsed((prev) => (prev.has(bone) ? new Set([...prev].filter((n) => n !== bone)) : prev))
  }

  /**
   * 「添加 IK 约束」菜单项的副标题：**新建一根 IK 节点骨**当目标（挂在层级根骨骼 root 下、
   * 摆在链尾末端，spineboy 的 front-ankle-ik 就是这么长的），而不是征用现有骨骼 —— 目标骨要能独立拖动 /
   * 打帧，拿链上的骨骼当目标会让 IK 拉着自己跑。链取当前多选（父→子连续），没多选就驱动右键那根。
   */
  const ikCreateHint = (host: string): string => {
    const chain =
      selection.bones.length >= 2
        ? chainFromSelection(document, selection.bones, host)
        : host
          ? [host]
          : []
    if (chain.length === 0) return t('未指定驱动骨骼：先选中骨骼再点')
    return t('新建 IK 节点骨驱动：{0}（节点骨挂在 root 下，可拖动 / 可打帧）', chain.join(' → '))
  }

  const addConstraint = (kind: AuthoringConstraint['type'], bone = selectedBone()): void => {
    /*
     * IK 的链在进 draft 前先定好：取当前多选（父→子连续，右键骨会被 openMenu 追加进组，
     * 右键链尾的子骨骼正好把链延长）；没多选就驱动右键的那一根 —— 单骨 IK 立刻可用
     * （链尾指向目标），两骨以上的链走解析解。
     */
    const chain =
      kind !== 'ik'
        ? []
        : selection.bones.length >= 2
          ? chainFromSelection(document, selection.bones, bone || document.bones[0]?.name || '')
          : bone
            ? [bone]
            : []
    const tail = chain[chain.length - 1] ?? ''
    // 节点骨摆在链尾**末端**（原点 + 骨长沿骨骼方向）；场景没就绪时退回原点，之后手动拖
    const tailBone = document.bones.find((item) => item.name === tail)
    const tip = tail ? boneTipWorld(tail, tailBone?.length ?? 0) : null
    // 名字在进 draft 前定好：创建完要选中新节点（名字与约束名是两个命名空间，互不冲突）
    const nodeName = uniqueName(document.bones.map((item) => item.name), tail ? `${tail}_ik` : 'ik')
    update(t('新建约束'), (draft) => {
      const name = uniqueName(draft.constraints.map((c) => c.name), kind)
      const base = { name, order: draft.constraints.length, enabled: true, bones: [] as string[], target: '' }
      if (kind === 'ik') {
        // IK 节点骨：挂在层级根骨骼 root 下、零长度（就是个把手）、约束红 —— 与视口里 IK 手柄同色
        draft.bones.push(
          createAuthoringBone({
            name: nodeName,
            parent: rootBoneName(draft.bones),
            localPosition: tip ?? { x: 0, y: 0 },
            length: 0,
            color: '#e4572e'
          })
        )
        draft.constraints.push({ ...createIkConstraint(), ...base, type: 'ik', target: nodeName, bones: chain })
      } else {
        // 变换 / 路径的宿主是第一根被驱动骨：点中的骨骼进骨链，目标（来源骨 / 路径骨）在面板里选
        const host = bone || draft.bones[0]?.name || ''
        const bones = host ? [host] : []
        if (kind === 'transform') {
          draft.constraints.push({ ...createTransformConstraint(), ...base, type: 'transform', bones })
        } else draft.constraints.push({ ...createPathConstraint(), ...base, type: 'path', bones })
      }
    })
    if (kind === 'ik') {
      // 选中新节点：属性面板立刻显示它（行首 IK 图标 + 内嵌 IK 分组），直接接着补参数
      selection.selectBone(nodeName)
      return
    }
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
      if (selection.bones.length > 1) {
        /*
         * 已多选时保持整组选中：右键就是「对选中的这组骨骼做什么」。
         * 新建 IK 拿这组骨骼当受约束骨链 —— 右键那一根不在组里时**追加**进组：
         * 右键链尾的子骨骼正好把链延长（父→子连续就能配成链）；配不成链时
         * addConstraint 会退回只驱动右键那一根。
         */
        selection.selectBones(
          selection.bones.includes(target.name)
            ? [...selection.bones.filter((name) => name !== target.name), target.name]
            : [...selection.bones, target.name]
        )
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
      hint: noAnimation ? t('工程里还没有动画：先在时间轴点「+ 动画」') : hint,
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
  const deleteItem = (target: MenuTarget): ContextMenuItem => {
    // 层级根骨骼不给删：它一没，其他节点就失去共同的祖先（整棵子树会跟着一起消失）
    const isRoot = target.kind === 'bone' && target.name === rootName
    const lastBone = target.kind === 'bone' && document.bones.length <= 1
    return {
      key: 'delete',
      label: t('删除「{0}」', target.name),
      danger: true,
      disabled: isRoot || lastBone,
      hint: isRoot
        ? t('「{0}」是层级根骨骼，不能删除', rootName)
        : lastBone
          ? t('至少保留一根骨骼')
          : undefined,
      icon: <Trash2 size={12} />,
      onSelect: poseOnly(() => {
        if (target.kind === 'slot') {
          update(t('删除插槽'), (draft) => {
            deleteSlot(draft, target.name)
          })
          return
        }
        if (target.kind === 'constraint') {
          removeConstraint(update, target.name)
          return
        }
        update(t('删除骨骼'), (draft) => {
          deleteBone(draft, target.name)
        })
      })
    }
  }

  /**
   * 约束的关键帧菜单项（Animate 态）。独立约束行（物理 / 宿主缺失）的整条菜单与
   * 骨骼行里「寄宿约束」的追加段共用：`withDelete` 为真时末尾带分隔线 + 删除。
   */
  const constraintKeyframeItems = (name: string, withDelete: boolean): ContextMenuItem[] => {
    const constraint = document.constraints.find((item) => item.name === name)
    const channels = constraint ? CONSTRAINT_CHANNELS[constraint.type] ?? [] : []
    const deleteEntry = deleteItem({ kind: 'constraint', name, bone: constraint?.bones[0] ?? '' })
    if (channels.length === 0) return withDelete ? [deleteEntry] : []
    const labelOf = (channel: string): string => t(CONSTRAINT_CHANNEL_LABEL[channel] ?? channel)
    const keyAll: KeyframeTarget[] = [{ kind: 'constraint', target: name, attachment: '' }]
    const keyOne = (channel: string): KeyframeTarget[] => [
      { kind: 'constraint', target: name, attachment: '', channel }
    ]
    const items: ContextMenuItem[] =
      channels.length === 1
        ? [
            keyframeItem(
              'k-constraint-0',
              t('{0}关键帧', labelOf(channels[0])),
              `${name} · ${labelOf(channels[0])}`,
              keyAll
            )
          ]
        : [
            keyframeItem('k-constraint-all', t('全部参数关键帧'), `${name} · ${t('全部参数')}`, keyAll),
            { key: 'sep-kc', label: '', separator: true },
            ...channels.map((channel) =>
              keyframeItem(
                `k-constraint-${channel}`,
                t('{0}关键帧', labelOf(channel)),
                `${name} · ${labelOf(channel)}`,
                keyOne(channel)
              )
            )
          ]
    if (withDelete) items.push({ key: 'sep-kc2', label: '', separator: true }, deleteEntry)
    return items
  }

  /**
   * Animate 态的菜单：只给「打关键帧」。
   * 加骨骼 / 插槽 / 约束、删除这些改的是 setup（绑定）数据，动画状态里动它们会污染动画基线。
   * 骨骼行顺带给寄宿约束（IK 权重等）的打帧入口 —— 合并显示后约束不再有独立行；删除放最后。
   */
  const keyframeMenuItems = (target: MenuTarget): ContextMenuItem[] => {
    if (target.kind === 'bone') {
      const bone = target.name
      const channel = (name: string): KeyframeTarget[] => [
        { kind: 'bone', target: bone, attachment: '', channel: name }
      ]
      const items: ContextMenuItem[] = [
        keyframeItem('k-translate', t('位置关键帧'), `${bone} · ${t('位置')}`, channel('translate')),
        keyframeItem('k-rotate', t('旋转关键帧'), `${bone} · ${t('旋转')}`, channel('rotate')),
        keyframeItem('k-scale', t('缩放关键帧'), `${bone} · ${t('缩放')}`, channel('scale')),
        keyframeItem('k-shear', t('斜切关键帧'), `${bone} · ${t('斜切')}`, channel('shear')),
        { key: 'sep-k', label: '', separator: true },
        keyframeItem('k-all', t('全部通道关键帧'), bone, [
          ...channel('rotate'),
          ...channel('translate'),
          ...channel('scale'),
          ...channel('shear')
        ])
      ]
      // 寄宿在本骨骼上的约束（IK 权重等）就地给打帧入口 —— 合并显示后约束不再有独立行
      const hosted = document.constraints.filter(
        (constraint) => constraint.type !== 'physics' && constraintHost(constraint) === bone
      )
      for (const constraint of hosted) {
        const constraintItems = constraintKeyframeItems(constraint.name, false)
        if (constraintItems.length > 0) {
          items.push({ key: `sep-hc-${constraint.name}`, label: '', separator: true }, ...constraintItems)
        }
      }
      return items
    }
    if (target.kind === 'slot') {
      const slot = target.name
      const channel = (name: string): KeyframeTarget[] => [
        { kind: 'slot', target: slot, attachment: '', channel: name }
      ]
      return [
        keyframeItem('k-display', t('显示关键帧'), `${slot} · ${t('显示')}`, channel('display')),
        keyframeItem('k-color', t('颜色关键帧'), `${slot} · ${t('颜色')}`, channel('color')),
        keyframeItem('k-visible', t('可见性关键帧'), `${slot} · ${t('可见性')}`, channel('visible')),
        { key: 'sep-k', label: '', separator: true },
        keyframeItem('k-all', t('全部通道关键帧'), slot, [
          ...channel('display'),
          ...channel('color'),
          ...channel('visible')
        ])
      ]
    }
    if (target.kind === 'constraint') {
      /*
       * 约束行（现在只剩物理 / 宿主缺失的约束）：Animate 态给「打关键帧」，
       * 参数之外的操作（添加骨骼 / 插槽）对约束行没有意义。
       * IK 的混合（mix）本来就是可做动画的（时间轴有它的轨道、`.hao2d` 也导出 iks 段），
       * 这里不给入口的话权重动画就只能手改工程文件。物理约束没有可做动画的参数（只保留数据、
       * 不参与求解），菜单仍只留「删除」。
       */
      return constraintKeyframeItems(target.name, true)
    }
    return []
  }

  const menuItems = (target: MenuTarget): ContextMenuItem[] => {
    // Animate 态：菜单换成打关键帧（绑定类操作属于 setup，见上面的说明）
    if (useModeStore.getState().mode === 'animate') return keyframeMenuItems(target)
    // 约束行：整条菜单只有「删除」（参数在检查器里改，「添加骨骼 / 插槽」对它也没有意义）
    if (target.kind === 'constraint') return [deleteItem(target)]
    const host = target.kind === 'bone' ? target.name : target.bone
    const where =
      target.kind === 'bone'
        ? t('挂在「{0}」下', target.name)
        : host
          ? t('挂在「{0}」下', host)
          : rootName
            ? t('挂在根骨骼「{0}」下', rootName)
            : t('挂在根骨骼下')
    const items: ContextMenuItem[] = [
      {
        key: 'bone',
        label: t('添加骨骼'),
        hint: where,
        icon: <Bone size={12} />,
        onSelect: () => addBone(host)
      },
      {
        key: 'slot',
        label: t('添加插槽'),
        hint: host ? t('挂在骨骼「{0}」上', host) : t('挂到第一根骨骼'),
        icon: <Plus size={12} />,
        onSelect: () => addSlot(host)
      },
      // 约束驱动的是骨骼，挂在插槽下没有意义，只在骨骼行 / 根层提供
      ...(target.kind === 'bone' || target.kind === 'root'
        ? [
            { key: 'sep1', label: '', separator: true },
            {
              key: 'ik',
              label: t('添加 IK 约束'),
              // 新建一根 IK 节点骨当目标；多选链根→链尾后再点，链会一次配好
              hint: ikCreateHint(host),
              icon: <IkConstraintIcon size={12} />,
              onSelect: () => addConstraint('ik', host)
            },
            {
              key: 'transform',
              label: t('添加变换约束'),
              hint: t('继承位移 / 旋转 / 缩放 / 斜切'),
              icon: <Maximize2 size={12} />,
              onSelect: () => addConstraint('transform', host)
            },
            {
              key: 'path',
              label: t('添加路径约束'),
              hint: t('骨骼沿路径曲线排布'),
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
      // 宿主命中：IK / 变换 / 路径约束不再单独成行，约束名搜到时要点亮寄它那行（目标骨 / 驱动骨）
      for (const constraint of document.constraints) {
        if (constraint.type === 'physics') continue
        if (constraintHost(constraint) === bone.name && hit(constraint.name)) found = true
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

  /**
   * 可见骨骼的扁平顺序（与行的渲染顺序一致：DFS、搜索筛掉的子树不进列表、
   * 折叠的分支不进列表）。Shift 点选 = 从锚点到点中行做**范围**选中
   * （Finder / 资源管理器的列表习惯），没有这个顺序就算不出「之间」有哪些行。
   */
  const visibleBoneOrder = useMemo(() => {
    const names: string[] = []
    const walk = (bone: AuthoringBone): void => {
      if (filter && !filter.bones.has(bone.name)) return
      names.push(bone.name)
      if (!filter && collapsed.has(bone.name)) return
      for (const child of bonesByParent.get(bone.name) ?? []) walk(child)
    }
    for (const root of bonesByParent.get('') ?? []) walk(root)
    return names
  }, [filter, collapsed, bonesByParent])

  /** Shift 范围点选的锚点：最近一次不带 Shift 点中的骨骼行 */
  const [anchorBone, setAnchorBone] = useState('')

  const rows: React.ReactNode[] = []

  const pushBone = (bone: AuthoringBone, depth: number): void => {
    // 搜索时：整棵被筛掉的子树直接跳过
    if (filter && !filter.bones.has(bone.name)) return
    const children = bonesByParent.get(bone.name) ?? []
    const slots = slotsByBone.get(bone.name) ?? []
    // 只有物理约束（与宿主缺失的约束，见根层兜底）还单独成行；其余寄宿在本行的徽标 + 属性面板里
    const constraintRows = (constraintsByBone.get(bone.name) ?? []).filter(
      (constraint) => constraint.type === 'physics'
    )
    const hosted = document.constraints.filter(
      (constraint) => constraint.type !== 'physics' && constraintHost(constraint) === bone.name
    )
    const hasChildren = children.length + slots.length + constraintRows.length > 0
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
        title={boneRowTitle(bone, { bones: children.length, slots: slots.length, constraints: constraintRows.length }, hosted)}
        // 宿主骨骼的行首图标直接用约束图标（不再画骨骼图标）：一眼认出「这行是个 IK / 变换 / 路径节点」；
        // 寄宿多条约束时取第一条，其余在悬浮描述与属性面板里
        icon={
          hosted.length > 0 ? (
            <span
              title={hosted
                .map((c) => t('{0}约束「{1}」', [constraintKind(c.type), c.name]))
                .join('\n')}
            >
              {CONSTRAINT_ICON[hosted[0].type]}
            </span>
          ) : bone.name === rootName ? (
            <RootBoneIcon size={11} style={{ color: bone.color }} />
          ) : (
            <Bone size={11} style={{ color: bone.color }} />
          )
        }
        active={selection.kind === 'bone' && selection.bones.includes(bone.name)}
        secondary={selection.kind === 'bone' && selection.bone !== bone.name}
        meta={bone.length > 0 ? `${unitsToPx(bone.length).toFixed(0)}px` : undefined}
        expandable={hasChildren}
        expanded={expanded}
        onToggle={() => toggle(bone.name)}
        // Shift 点击 = 从锚点到点中行做范围选中（bone_8 → bone_10 会带上中间的 bone_9）；
        // Cmd/Ctrl 点击 = 加选 / 减选（多选后可一起旋转 / 移动 / 缩放）；普通点击 = 单选并重设锚点
        onSelect={(event) => {
          if (event.shiftKey) {
            const anchor = anchorBone || selection.bone || visibleBoneOrder[0] || bone.name
            const from = visibleBoneOrder.indexOf(anchor)
            const to = visibleBoneOrder.indexOf(bone.name)
            if (from < 0 || to < 0) {
              selection.toggleBone(bone.name)
              return
            }
            const [start, end] = from <= to ? [from, to] : [to, from]
            // 主选中 = 点中的那根（放组末，检查器显示它）；锚点不动，可继续 Shift 扩选
            selection.selectBones([
              ...visibleBoneOrder.slice(start, end + 1).filter((name) => name !== bone.name),
              bone.name
            ])
            return
          }
          setAnchorBone(bone.name)
          if (event.metaKey || event.ctrlKey) selection.toggleBone(bone.name)
          else selection.selectBone(bone.name)
        }}
        // 拖到骨骼行 = 在这根骨骼下新建一个插槽
        onDropImage={(imageNames) => addSlotFromImage(bone.name, imageNames)}
        onContextMenu={(event) => openMenu(event, { kind: 'bone', name: bone.name, bone: bone.parent })}
        // 锁定列（行首第二列）：骨骼可锁 / 解锁
        lockSwitch={{
          on: bone.locked,
          title: bone.locked ? t('解锁') : t('锁定'),
          onToggle: () =>
            update(t('切换骨骼锁定'), (draft) => {
              const target = draft.bones.find((b) => b.name === bone.name)
              if (target) target.locked = !target.locked
            })
        }}
        // 层级根骨骼不显示删除按钮（同右键菜单：root 不能删）
        onDelete={
          document.bones.length > 1 && bone.name !== rootName
            ? poseOnly(() =>
                update(t('删除骨骼'), (draft) => {
                  deleteBone(draft, bone.name)
                })
              )
            : undefined
        }
      />
    )

    if (!expanded) return
    for (const child of children) pushBone(child, depth + 1)
    for (const slot of slots) pushSlot(slot, depth + 1)
    for (const constraint of constraintRows) rows.push(renderConstraint(constraint, depth + 1))
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
          // 嵌套骨架用人形图标（一眼区别于骨骼行的骨头图标），遮罩用虚线多边形，网格用网格，贴图用图片
          attachment.type === 'armature' ? (
            // 人形图标本身细节少、笔画细，用满 14px 的图标列 + 加粗描边才看得清
            <PersonStanding
              size={15}
              strokeWidth={2.6}
              className={showing ? 'text-accent' : 'text-content-lo/60'}
            />
          ) : attachment.type === 'clipping' ? (
            <Pentagon size={11} className={showing ? 'text-accent' : 'text-content-lo/60'} />
          ) : isMeshType(attachment.type) ? (
            <Grid3x3 size={11} className={showing ? 'text-accent' : 'text-content-lo/60'} />
          ) : (
            <ImageIcon size={11} className={showing ? 'text-accent' : 'text-content-lo/60'} />
          )
        }
        meta={
          attachment.type === 'armature'
            ? showing
              ? t('显示中 · 骨架 {0}', attachment.subArmature || '?')
              : t('骨架 {0}', attachment.subArmature || '?')
            : attachment.type === 'clipping'
              ? showing
                ? t('显示中 · 遮罩')
                : t('遮罩')
              : showing
                ? isMeshType(attachment.type)
                  ? t('显示中 · 网格')
                  : t('显示中')
                : isMeshType(attachment.type)
                  ? t('网格')
                  : undefined
        }
        // display 行也算宿主插槽的地盘：拖到插槽下面（含子行）都是「给这个插槽加 display」
        dataSlot={slot.name}
        // 选中附件（视口 / 检查器）时按「插槽 + 附件」定位到这一行（同名附件可能出现在多个插槽）
        dataAttachment={attachment.name}
        flashKey={
          flash?.kind === 'display' && flash.name === attachment.name && flash.slot === slot.name ? flash.nonce : 0
        }
        onDropImage={(imageNames) => addDisplay(slot.name, imageNames)}
        // 点**前面的小图标** = 切换显示 / 隐藏（图标就是这个开关），点文字只选中不改显示
        onIconClick={() => selectDisplay(slot.name, attachment.name)}
        iconTitle={showing ? t('点击隐藏（该插槽不显示任何 display）') : t('点击显示它')}
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
          update(t('删除 display'), (draft) => deleteAttachment(draft, slot.name, attachment.name))
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
        flashKey={flash?.kind === 'slot' && flash.name === slot.name ? flash.nonce : 0}
        active={selection.kind === 'slot' && selection.slot === slot.name}
        icon={<SlotIcon color={toCss(slot.color)} />}
        // 行尾显示当前显示的 display 名，不用展开也知道显示的是哪一个。
        // Animate 态按关键帧采样（与 display 行的「显示中」标记同一数据源），不能直接看 setup
        meta={showing || (displays.length > 0 ? t('{0} 个 display', displays.length) : undefined)}
        // 关掉 display 行时没有子行可展开，箭头一并收掉（行尾的「N 个 display」仍留着看数量）
        expandable={showDisplays && displays.length > 0}
        expanded={expanded}
        dataSlot={slot.name}
        onToggle={() => toggle(`slot:${slot.name}`)}
        onSelect={() => selection.selectSlot(slot.name)}
        onDropImage={(imageNames) => addDisplay(slot.name, imageNames)}
        onContextMenu={(event) => openMenu(event, { kind: 'slot', name: slot.name, bone: slot.bone })}
        // 显示列（行首第一列）：插槽可显示 / 隐藏
        visibleSwitch={{
          on: slot.visible,
          title: slot.visible ? t('隐藏插槽') : t('显示插槽'),
          onToggle: () =>
            update(t('切换插槽可见性'), (draft) => {
              const target = draft.slots.find((s) => s.name === slot.name)
              if (target) target.visible = !target.visible
            })
        }}
        // 锁定列（行首第二列）：与骨骼一致 —— 锁上后视口里点不中它，层级树里照常可操作
        lockSwitch={{
          on: slot.locked,
          title: slot.locked ? t('解锁（视口中可再次选中）') : t('锁定（视口中不可选中）'),
          onToggle: () =>
            update(t('切换插槽锁定'), (draft) => {
              const target = draft.slots.find((s) => s.name === slot.name)
              if (target) target.locked = !target.locked
            })
        }}
        onDelete={poseOnly(() =>
          update(t('删除插槽'), (draft) => {
            deleteSlot(draft, slot.name)
          })
        )}
      />
    )

    // 工具栏「显示 / 隐藏 display」关掉时：插槽行照旧（行尾还写着当前显示的是哪一个），只是不列子行
    if (!expanded || !showDisplays) return
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
      meta={
        constraint.type === 'ik'
          ? t('IK {0} 骨', constraint.bones.length)
          : constraintKind(constraint.type)
      }
      onSelect={() => selection.selectConstraint(constraint.name)}
      onContextMenu={(event) =>
        openMenu(event, { kind: 'constraint', name: constraint.name, bone: constraint.bones[0] ?? '' })
      }
      onDelete={poseOnly(() => removeConstraint(update, constraint.name))}
    />
  )

  for (const bone of bonesByParent.get('') ?? []) pushBone(bone, 0)

  // 兜底：宿主不存在（目标 / 驱动骨骼被删或还没设）的约束挂到根层，避免对象彻底消失。
  // 有宿主的 IK / 变换 / 路径约束寄在宿主行上（徽标），这里只收留无处安放的
  const boneNames = new Set(document.bones.map((b) => b.name))
  for (const slot of document.slots) if (!boneNames.has(slot.bone)) pushSlot(slot, 0)
  for (const constraint of document.constraints) {
    const host = constraintHost(constraint)
    if (host && boneNames.has(host)) continue
    rows.push(renderConstraint(constraint, 0))
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-[24px] shrink-0 items-center gap-1 border-b border-line/60 bg-ink-800/80 px-1">
        <button type="button" title={t('新建骨骼（挂在当前选中骨骼下；未选中时挂在根骨骼 root 下）')} className="hao-btn h-[18px] px-1.5 text-3xs" onClick={poseOnly(() => addBone())}>
          <Bone size={11} />
          <span>{t('骨骼')}</span>
        </button>
        <button type="button"           title={t('新建插槽（挂到当前选中骨骼；未选中时挂到第一根骨骼）')} className="hao-btn h-[18px] px-1.5 text-3xs" onClick={poseOnly(() => addSlot())}>
          <SlotIcon size={11} />
          <span>{t('插槽')}</span>
        </button>
        <button
          type="button"
          title={t('新建 IK 约束（自动新建一根 IK 节点骨挂在根骨骼 root 下、摆在链尾末端；先多选链根 → 链尾再点，可一次配好骨链）')}
          className="hao-btn h-[18px] px-1.5 text-3xs"
          onClick={poseOnly(() => addConstraint('ik'))}
        >
          <IkConstraintIcon size={14} />
        </button>
        <button
          type="button"
          title={t('新建变换约束')}
          className="hao-btn h-[18px] px-1.5 text-3xs"
          onClick={poseOnly(() => addConstraint('transform'))}
        >
          <Maximize2 size={14} />
        </button>
        <button
          type="button"
          title={t('新建路径约束')}
          className="hao-btn h-[18px] px-1.5 text-3xs"
          onClick={poseOnly(() => addConstraint('path'))}
        >
          <Route size={14} />
        </button>
        {/* 右侧两个显示开关（`ml-auto` 靠右，与左边的「新建」按钮分开）：
            全部折叠 / 全部展开，以及树里 display 行的显隐 */}
        <button
          type="button"
          tabIndex={-1}
          title={
            collapsed.size > 0
              ? t('全部展开（骨骼 / 插槽 / display）')
              : t('全部折叠（只留顶层骨骼，再点一次全部展开）')
          }
          className="hao-btn ml-auto h-[18px] px-1.5 text-3xs"
          onClick={toggleCollapseAll}
        >
          {collapsed.size > 0 ? <ChevronsUpDown size={13} /> : <ChevronsDownUp size={13} />}
        </button>
        <button
          type="button"
          tabIndex={-1}
          title={showDisplays ? t('隐藏 display 行（树里只留骨骼 / 插槽）') : t('显示 display 行')}
          className={[
            'hao-btn h-[18px] px-1.5 text-3xs',
            // 关掉时压暗：一眼看出树是被这个开关过滤过的，而不是工程里没有附件
            showDisplays ? '' : 'text-content-lo'
          ].join(' ')}
          onClick={() => setShowDisplays(!showDisplays)}
        >
          {showDisplays ? <Eye size={13} /> : <EyeOff size={13} />}
        </button>
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
          placeholder={t('搜索骨骼 / 插槽 / 约束…')}
          className="hao-field h-[22px] w-full pr-6 text-panel"
        />
        {query ? (
          <button
            type="button"
            title={t('清空搜索')}
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
        onContextMenu={(event) => openMenu(event, { kind: 'root', name: '', bone: '' })}
        onDragOverCapture={(event) => {
          // 用 capture：行自己会 stopPropagation，冒泡阶段收不到「正在哪一行上」
          setBottomHint(activeTreeDrag?.kind === 'slot' && event.target === event.currentTarget)
        }}
        onDragOver={(event) => {
          const tree = hasTreeDrag(event.dataTransfer) || activeTreeDrag !== null
          if (!hasImageDrag(event.dataTransfer) && !tree) return
          // 行本身没接住时（列表空白处）在这里兜底，同时别冒泡去触发整窗导入覆盖层
          event.preventDefault()
          event.stopPropagation()
          event.dataTransfer.dropEffect = tree ? 'move' : 'copy'
        }}
        onDragLeave={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          if (
            event.clientX >= rect.left &&
            event.clientX <= rect.right &&
            event.clientY >= rect.top &&
            event.clientY <= rect.bottom
          ) {
            return
          }
          setBottomHint(false)
        }}
        onDragEnd={() => setBottomHint(false)}
        onDrop={(event) => {
          const tree = hasTreeDrag(event.dataTransfer) || activeTreeDrag !== null
          if (!hasImageDrag(event.dataTransfer) && !tree) return
          event.preventDefault()
          event.stopPropagation()
          setBottomHint(false)
          if (tree) {
            if (!canEditBinding()) return
            // 落到列表空白处：骨骼 / 插槽都挂到层级根骨骼 root 下；display 不在这里收
            const payload = readTreeDrag(event.dataTransfer) ?? activeTreeDrag
            activeTreeDrag = null
            if (!payload) return
            if (payload.kind === 'bone') {
              let result: MoveResult = { ok: false, message: '' }
              let movedToEnd = false
              update(t('调整骨骼层级'), (draft) => {
                result = moveBone(draft, payload.name, '', 'inside', { worldMatrixOf: worldMatrixOfBone })
                if (!result.ok) return
                /*
                 * 拖到空白处 = 挂到根骨骼下并排到骨骼列表末尾。
                 * moveBone 的 blank 分支只改 parent、不动数组顺序，所以这里补一次「移到末尾」，
                 * 让「拖到最下面」至少有一个可见结果（插槽始终渲染在骨骼之后，骨骼不可能排到插槽下面）。
                 */
                const root = rootBoneName(draft.bones)
                const bone = draft.bones.find((item) => item.name === payload.name)
                if (!root || !bone || bone.parent !== root) return
                const from = draft.bones.indexOf(bone)
                if (from < 0 || from === draft.bones.length - 1) return
                draft.bones.splice(from, 1)
                draft.bones.push(bone)
                movedToEnd = true
              })
              onStatus?.(
                result.ok
                  ? movedToEnd
                    ? t('骨骼「{0}」已挂到根骨骼「{1}」下，并排到骨骼列表末尾（骨骼顺序不影响插槽绘制顺序）', [
                        payload.name,
                        rootBoneName(document.bones) || 'root'
                      ])
                    : t('骨骼「{0}」已经在骨骼列表末尾；骨骼不能排到插槽行之间（插槽绘制顺序请拖 slot 行）', [
                        payload.name
                      ])
                  : result.message
              )
              return
            }
            if (payload.kind === 'slot') {
              const root = rootBoneName(document.bones)
              if (!root) return
              let result: MoveResult = { ok: false, message: '' }
              let landedBottom = false
              update(t('调整插槽层级'), (draft) => {
                /*
                 * 空白处是列表**最下面**：对应绘制顺序的最底层（zOrder 最小）。
                 * 注意不能 append 到末尾 —— zOrder 升序是「先画 → 后画」，
                 * 层级列表是降序（上面的行更靠前），所以底部要插到升序数组的最前面。
                 */
                result = moveSlotToBottom(draft, payload.name, { worldMatrixOf: worldMatrixOfBone })
                landedBottom = result.ok
              })
              onStatus?.(
                result.ok
                  ? landedBottom
                    ? t('插槽「{0}」已移到最底层（root 下）', payload.name)
                    : result.message
                  : result.message
              )
              return
            }
            onStatus?.(t('display 只能放到插槽下面'))
            return
          }
          /*
           * 图片落到列表**空白处**：到这里说明落点不在骨骼行 / 插槽行 / display 行上
           * （那三种行自己接了 dragover + drop，事件不会冒泡下来），算「拖到层级窗口的空白处」，
           * 在层级根骨骼 root 下新建插槽 —— 与「拖到骨骼行 = 在该骨骼下新建插槽」
           * 「拖到插槽行 / display 行 = 给该插槽加一个 display」组成完整的三条规则。
           */
          const imageNames = readImageDrag(event.dataTransfer)
          if (imageNames.length === 0) return
          if (!rootName) {
            onStatus?.(t('场景里还没有骨骼：先用工具栏的「骨骼」新建一根骨骼，再把图片拖进来'))
            return
          }
          addSlotFromImage(rootName, imageNames)
        }}
      >
        {rows}
        {bottomHint ? (
          <div className="pointer-events-none mx-1 mt-1 h-[2px] bg-accent" title={t('放到最底层')} />
        ) : null}
      </div>

      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          title={
            useModeStore.getState().mode === 'animate'
              ? t('{0}「{1}」· 打关键帧{2}', [
                  targetKind(menu.target.kind),
                  menu.target.name,
                  // 置灰项的 hover 提示看不到，把原因写在标题里
                  document.animations.length === 0 ? t('（工程里还没有动画：先在时间轴点「+ 动画」）') : ''
                ])
              : menu.target.kind === 'root'
                ? t('新建对象')
                : t('{0}「{1}」', [targetKind(menu.target.kind), menu.target.name])
          }
          items={menuItems(menu.target)}
          onClose={() => setMenu(null)}
        />
      ) : null}

      {displayMenu ? (
        <ContextMenu
          x={displayMenu.x}
          y={displayMenu.y}
          title={t('「{0}」· display「{1}」', [displayMenu.slot, displayMenu.attachment])}
          items={[
            {
              key: 'display-key',
              label: t('显示关键帧（从这里开始显示）'),
              hint: t('在当前时间切到「{0}」', displayMenu.attachment),
              icon: <KeyRound size={12} />,
              onSelect: () => {
                const result = keySlotDisplayNow(displayMenu.slot, displayMenu.attachment)
                onStatus?.(result.message)
              }
            },
            {
              key: 'display-hide-key',
              label: t('隐藏关键帧（从这里开始不显示）'),
              hint: t('在当前时间把该插槽切成「不显示」'),
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
  update(t('删除约束'), (draft) => {
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

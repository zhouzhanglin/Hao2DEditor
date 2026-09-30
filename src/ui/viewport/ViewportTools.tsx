import {
  Bone,
  Grid3x3,
  MousePointer2,
  Move,
  MoveDiagonal2,
  RotateCw,
  Scaling,
  Spline
} from 'lucide-react'
import { GIZMO_ORDER, useToolStore } from '@editor/store/toolStore'
import { useModeStore } from '@editor/store/modeStore'
import type { EditorTool, GizmoMode } from '@editor/store/toolStore'

/**
 * 视口左上角（Pose / Animate 下方）的工具面板，分两组：
 *
 * - **编辑工具**：选择 / 绑骨骼 / 插槽 / 权重刷 / 顶点 / 约束
 *   （顶点工具的快捷键与名字随模式变化：Pose = 网格工具 M，Animate = FFD 顶点工具 D）
 * - **变换工具**：移动 / 旋转 / 缩放 / 斜切（W / E / R / T）——决定骨骼小坐标轴的行为
 *
 * 两组语义不同：编辑工具决定「鼠标在视口里做什么」，变换工具决定「选中骨骼怎么动」，
 * 所以中间加一条分隔线，激活态也用不同色系（编辑=强调青色、变换=轴色）。
 * 这里是编辑工具的唯一入口（顶部工具条不再放一份）。
 */
const EDIT_TOOLS: Array<{
  id: EditorTool
  label: string
  key: string
  icon: typeof MousePointer2
  hint?: string
}> = [
  { id: 'select', label: '选择工具', key: 'V', icon: MousePointer2, hint: '选中并变换骨骼 / 插槽 / 附件' },
  {
    id: 'bone',
    label: '画骨骼工具',
    key: 'B',
    icon: Bone,
    hint: '在视口拖拽画骨骼：起点落在骨骼上会吸附并以它为父，接着拖就能连成骨骼链（仅 Pose 态）'
  },
  { id: 'weight', label: '权重刷工具', key: 'G', icon: Spline },
  {
    id: 'ffd',
    label: '顶点工具',
    key: 'D',
    icon: Grid3x3,
    hint: '拖顶点：Pose 改绑定网格，Animate 写 FFD 帧；网格内双击可插入顶点'
  }
]

/**
 * 顶点工具的外观**随模式切换**：同一个工具，Pose 态自称「网格工具(M)」、
 * Animate 态自称「FFD 顶点工具(D)」—— 用户按场景找名字，实现却只有一份。
 */
const VERTEX_TOOL_VIEWS: Record<'pose' | 'animate', { label: string; key: string; icon: typeof Grid3x3; hint: string }> = {
  pose: {
    label: '网格工具',
    key: 'M',
    icon: Grid3x3,
    hint: '编辑网格顶点 / 三角面；网格内双击可插入顶点'
  },
  animate: {
    label: 'FFD 顶点工具',
    key: 'D',
    icon: Grid3x3,
    hint: '拖顶点写当前时间点的 FFD 帧；网格内双击可插入顶点'
  }
}

type EditToolItem = {
  id: EditorTool
  label: string
  key: string
  icon: typeof MousePointer2
  hint?: string
}

function withVertexToolView(item: EditToolItem, mode: 'pose' | 'animate'): EditToolItem {
  if (item.id !== 'ffd') return item
  const view = VERTEX_TOOL_VIEWS[mode]
  return { ...item, label: view.label, key: view.key, icon: view.icon, hint: view.hint }
}

const GIZMO_ICONS: Record<GizmoMode, typeof Move> = {
  move: Move,
  rotate: RotateCw,
  scale: Scaling,
  shear: MoveDiagonal2
}

const GIZMO_TONE: Record<GizmoMode, string> = {
  move: 'text-[#f87171] border-[#ef4444]/60 bg-[#ef4444]/15',
  rotate: 'text-[#60a5fa] border-[#60a5fa]/60 bg-[#60a5fa]/15',
  scale: 'text-[#22c55e] border-[#22c55e]/60 bg-[#22c55e]/15',
  shear: 'text-[#c084fc] border-[#c084fc]/60 bg-[#c084fc]/15'
}

export interface ViewportToolsProps {
  onStatus?: (text: string) => void
}

export default function ViewportTools({ onStatus = () => undefined }: ViewportToolsProps) {
  const mode = useModeStore((s) => s.mode)
  const tool = useToolStore((s) => s.tool)
  const setTool = useToolStore((s) => s.setTool)
  const gizmo = useToolStore((s) => s.gizmo)
  const setGizmo = useToolStore((s) => s.setGizmo)
  /**
   * Animate 状态隐藏绑定期工具（绑骨骼 / 权重刷——它们改的是绑定姿态），
   * 但 **顶点工具要保留**：动画态拖顶点写的是 deform 关键帧，是正当的动画编辑操作。
   */
  const editTools =
    mode === 'animate' ? EDIT_TOOLS.filter((item) => item.id === 'select' || item.id === 'ffd') : EDIT_TOOLS

  const buttonClass =
    'flex h-[28px] w-[28px] items-center justify-center rounded-md border transition-all duration-panel cursor-pointer'

  return (
    <div className="pointer-events-auto absolute left-3 top-[58px] z-20 flex flex-col gap-0.5 rounded-lg border border-line bg-ink-900/85 p-1 shadow-lg shadow-black/40 backdrop-blur-sm">
      {editTools.map((rawItem) => {
        // 顶点工具按当前模式换名字：Pose = 网格工具(M)，Animate = FFD 顶点工具(D)
        const { id, label, key, hint, icon: Icon } = withVertexToolView(rawItem, mode)
        const active = tool === id
        return (
          <button
            key={id}
            type="button"
            title={hint ? `${label}（${key}）\n${hint}` : `${label}（${key}）`}
            onClick={() => {
              setTool(id)
              onStatus(`工具：${label}`)
            }}
            className={[
              buttonClass,
              active
                ? 'border-accent/60 bg-accent/15 text-accent'
                : 'border-transparent text-content-lo hover:bg-ink-700 hover:text-content-mid'
            ].join(' ')}
          >
            <Icon size={15} />
          </button>
        )
      })}

      <div className="mx-1 my-0.5 h-px bg-line" />

      {GIZMO_ORDER.map(({ mode, key, label, hint }) => {
        const Icon = GIZMO_ICONS[mode]
        const active = gizmo === mode
        return (
          <button
            key={mode}
            type="button"
            title={`${label}（${key}）\n${hint}`}
            onClick={() => {
              const painting = tool !== 'select' && tool !== 'bone'
              setGizmo(mode)
              onStatus(
                painting ? `骨骼工具：${label} · 已退出绘制工具，鼠标现在用于${label}骨骼` : `骨骼工具：${label}`
              )
            }}
            className={[
              buttonClass,
              active ? GIZMO_TONE[mode] : 'border-transparent text-content-lo hover:bg-ink-700 hover:text-content-mid'
            ].join(' ')}
          >
            <Icon size={15} />
          </button>
        )
      })}
    </div>
  )
}

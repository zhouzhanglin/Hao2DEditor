import { Bone, Boxes, MousePointer2, Move, MoveDiagonal2, RotateCw, Scaling, Spline } from 'lucide-react'
import { GIZMO_ORDER, useToolStore } from '@editor/store/toolStore'
import { useModeStore } from '@editor/store/modeStore'
import type { EditorTool, GizmoMode } from '@editor/store/toolStore'

/**
 * 视口左上角（Pose / Animate 下方）的工具面板，分两组：
 *
 * - **编辑工具**：选择 / 绑骨骼 / 权重刷 / FFD 顶点（V / B / G / D）
 * - **变换工具**：移动 / 旋转 / 缩放 / 斜切（Q / W / E / R）——决定骨骼小坐标轴的行为
 *
 * 两组语义不同：编辑工具决定「鼠标在视口里做什么」，变换工具决定「选中骨骼怎么动」，
 * 所以中间加一条分隔线，激活态也用不同色系（编辑=强调青色、变换=轴色）。
 */
const EDIT_TOOLS: Array<{ id: EditorTool; label: string; key: string; icon: typeof MousePointer2 }> = [
  { id: 'select', label: '选择工具', key: 'V', icon: MousePointer2 },
  { id: 'bone', label: '绑骨骼工具', key: 'B', icon: Bone },
  { id: 'weight', label: '权重刷工具', key: 'G', icon: Spline },
  { id: 'ffd', label: 'FFD 顶点工具', key: 'D', icon: Boxes }
]

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
   * 但 **FFD 顶点要保留**：动画态拖顶点写的是 deform 关键帧，是正当的动画编辑操作。
   */
  const editTools =
    mode === 'animate' ? EDIT_TOOLS.filter((item) => item.id === 'select' || item.id === 'ffd') : EDIT_TOOLS

  const buttonClass =
    'flex h-[28px] w-[28px] items-center justify-center rounded-md border transition-all duration-panel cursor-pointer'

  return (
    <div className="pointer-events-auto absolute left-3 top-[58px] z-20 flex flex-col gap-0.5 rounded-lg border border-line bg-ink-900/85 p-1 shadow-lg shadow-black/40 backdrop-blur-sm">
      {editTools.map(({ id, label, key, icon: Icon }) => {
        const active = tool === id
        return (
          <button
            key={id}
            type="button"
            title={`${label}（${key}）`}
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

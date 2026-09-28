import { Bone, Clapperboard } from 'lucide-react'
import type { EditorMode } from '@editor/store/modeStore'

export interface ModeSwitchProps {
  mode: EditorMode
  onChange: (mode: EditorMode) => void
}

const ITEMS: Array<{ mode: EditorMode; label: string; hint: string; icon: typeof Bone }> = [
  { mode: 'pose', label: 'Pose', hint: '绑定状态：编辑 setup 姿态、网格与权重（Tab 切换）', icon: Bone },
  { mode: 'animate', label: 'Animate', hint: '动画编辑状态：时间轴与关键帧（Tab 切换）', icon: Clapperboard }
]

/**
 * 视口左上角的 Pose / Animate 二段式开关。
 * 放在视口内而不是菜单栏，是因为它决定「当前编辑的是绑定姿态还是动画」，
 * 属于视口上下文，切换频率高且需要足够大的点击区域。
 */
export default function ModeSwitch({ mode, onChange }: ModeSwitchProps) {
  return (
    <div className="pointer-events-auto absolute left-3 top-3 z-20 flex items-center gap-1 rounded-lg border border-line bg-ink-900/85 p-1 shadow-lg shadow-black/40 backdrop-blur-sm">
      {ITEMS.map(({ mode: item, label, hint, icon: Icon }) => {
        const active = mode === item
        return (
          <button
            key={item}
            type="button"
            title={hint}
            onClick={() => onChange(item)}
            className={[
              'flex h-[34px] min-w-[112px] items-center justify-center gap-2 rounded-md px-3 text-xs font-semibold uppercase tracking-[0.08em] transition-all duration-panel cursor-pointer',
              active
                ? 'bg-gradient-to-b from-accent/30 to-accent-deep/10 text-accent shadow-[0_0_14px_-2px_rgba(34,211,238,0.75)]'
                : 'text-content-lo hover:bg-ink-700 hover:text-content-mid'
            ].join(' ')}
          >
            <Icon size={16} />
            <span>{label}</span>
          </button>
        )
      })}
    </div>
  )
}

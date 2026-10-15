import { Bone, Clapperboard } from 'lucide-react'
import type { EditorMode } from '@editor/store/modeStore'
import { t } from '@i18n'

export interface ModeSwitchProps {
  mode: EditorMode
  onChange: (mode: EditorMode) => void
}

/** 两段式开关的文案随语言切换，故做成函数 */
function items(): Array<{ mode: EditorMode; label: string; hint: string; icon: typeof Bone }> {
  return [
    { mode: 'pose', label: t('准备'), hint: t('绑定状态：编辑 setup 姿态、网格与权重（Tab 切换）'), icon: Bone },
    { mode: 'animate', label: t('动画'), hint: t('动画编辑状态：时间轴与关键帧（Tab 切换）'), icon: Clapperboard }
  ]
}

/**
 * 视口左上角的 Pose / Animate 二段式开关。
 * 放在视口内而不是菜单栏，是因为它决定「当前编辑的是绑定姿态还是动画」，
 * 属于视口上下文，切换频率高且需要足够大的点击区域。
 */
export default function ModeSwitch({ mode, onChange }: ModeSwitchProps) {
  return (
    <div className="pointer-events-auto absolute left-3 top-3 z-20 flex items-center gap-0.5 rounded-[7px] border border-white/10 bg-ink-900/70 p-0.5 shadow-lg shadow-black/30 backdrop-blur-md">
      {items().map(({ mode: item, label, hint, icon: Icon }) => {
        const active = mode === item
        return (
          <button
            key={item}
            type="button"
            title={hint}
            onClick={() => onChange(item)}
            className={[
              // macOS 分段控件：轨道是半透明圆角底，选中段是实心蓝 + 白字（不是渐变 + 光晕）
              'flex h-[30px] min-w-[104px] items-center justify-center gap-2 rounded-[5px] px-3 text-panel font-medium transition-colors duration-panel cursor-pointer',
              active
                ? 'bg-accent-deep text-white'
                : 'text-content-mid hover:bg-white/[0.08] hover:text-content-hi'
            ].join(' ')}
          >
            <Icon size={15} />
            <span>{label}</span>
          </button>
        )
      })}
    </div>
  )
}

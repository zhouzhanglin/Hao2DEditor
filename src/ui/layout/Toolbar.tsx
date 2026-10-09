import { Crosshair } from 'lucide-react'
import type { OverlayState } from '@editor/store/toolStore'

export interface ToolbarProps {
  zoom: number
  overlay: OverlayState
  onToggleOverlay: (key: keyof OverlayState) => void
  onFitViewport: () => void
}

/**
 * 叠加层开关。**没有「网格」**：全局网格层会让整个角色铺满线框，
 * 现在改成「谁被选中才画谁」（选择 / Pose 工具按选中项自动显示，见 Scene.focusMeshSlot）。
 */
const OVERLAYS: Array<{ key: keyof OverlayState; label: string }> = [
  { key: 'bones', label: '骨骼' },
  { key: 'weight', label: '权重' },
  { key: 'ffd', label: 'FFD' },
  { key: 'constraints', label: '约束' }
]

/**
 * 工具条：叠加层开关 + 缩放信息（播放控制统一在时间轴上）。
 *
 * 编辑工具的切换放在视口左侧的面板里（ViewportTools），不再在这里重复一份。
 */
export default function Toolbar(props: ToolbarProps) {
  const { zoom, overlay } = props

  return (
    <div className="flex h-[34px] items-center gap-2 border-b border-line bg-ink-700 px-2">
      <div className="flex items-center gap-0.5">
        {OVERLAYS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => props.onToggleOverlay(key)}
            className={[
              'h-[22px] rounded-[5px] px-2 text-2xs transition-colors duration-panel cursor-pointer',
              overlay[key] ? 'bg-accent-deep text-white' : 'text-content-mid hover:bg-ink-600 hover:text-content-hi'
            ].join(' ')}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex flex-1 justify-end items-center gap-2 text-3xs text-content-lo">
        <span className="font-mono">{zoom.toFixed(0)}%</span>
        <button type="button" title="适配视野 (F)" onClick={props.onFitViewport} className="hao-tool-button">
          <Crosshair size={14} />
        </button>
      </div>
    </div>
  )
}

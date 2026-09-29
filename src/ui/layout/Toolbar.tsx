import { Crosshair } from 'lucide-react'

export interface ToolbarProps {
  zoom: number
  overlay: { bones: boolean; mesh: boolean; weight: boolean; ffd: boolean; constraints: boolean }
  onToggleOverlay: (key: keyof ToolbarProps['overlay']) => void
  onFitViewport: () => void
}

const OVERLAYS: Array<{ key: keyof ToolbarProps['overlay']; label: string }> = [
  { key: 'bones', label: '骨骼' },
  { key: 'mesh', label: '网格' },
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
              'h-[22px] rounded px-1.5 text-3xs uppercase tracking-[0.06em] transition-colors duration-panel cursor-pointer',
              overlay[key]
                ? 'bg-accent/15 text-accent ring-1 ring-accent/30'
                : 'text-content-lo hover:bg-ink-600 hover:text-content-mid'
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

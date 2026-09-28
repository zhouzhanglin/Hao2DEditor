import {
  Boxes,
  Crosshair,
  Grid3x3,
  Layers,
  Link2,
  MousePointer2,
  Move3d,
  Spline
} from 'lucide-react'
import type { EditorMode } from '@editor/store/modeStore'

export type EditorTool =
  | 'select'
  | 'bone'
  | 'slot'
  | 'mesh'
  | 'weight'
  | 'ffd'
  | 'constraint'

export interface ToolbarProps {
  mode: EditorMode
  tool: EditorTool
  zoom: number
  overlay: { bones: boolean; mesh: boolean; weight: boolean; ffd: boolean; constraints: boolean }
  onToolChange: (tool: EditorTool) => void
  onToggleOverlay: (key: keyof ToolbarProps['overlay']) => void
  onFitViewport: () => void
}

const TOOLS: Array<{ id: EditorTool; label: string; icon: typeof MousePointer2 }> = [
  { id: 'select', label: '选择 / 变换 (Q)', icon: MousePointer2 },
  { id: 'bone', label: '骨骼 (B)', icon: Move3d },
  { id: 'slot', label: '插槽 (S)', icon: Layers },
  { id: 'mesh', label: '网格 (M)', icon: Grid3x3 },
  { id: 'weight', label: '权重刷 (W)', icon: Spline },
  { id: 'ffd', label: 'FFD 变形 (D)', icon: Boxes },
  { id: 'constraint', label: '约束 (C)', icon: Link2 }
]

const OVERLAYS: Array<{ key: keyof ToolbarProps['overlay']; label: string }> = [
  { key: 'bones', label: '骨骼' },
  { key: 'mesh', label: '网格' },
  { key: 'weight', label: '权重' },
  { key: 'ffd', label: 'FFD' },
  { key: 'constraints', label: '约束' }
]

/** 工具条：工具切换 + 叠加层开关 + 缩放信息（播放控制统一在时间轴上）。 */
export default function Toolbar(props: ToolbarProps) {
  const { tool, zoom, overlay } = props

  return (
    <div className="flex h-[34px] items-center gap-2 border-b border-line bg-ink-700 px-2">
      <div className="flex items-center gap-0.5 rounded border border-line/70 bg-ink-900/40 p-[2px]">
        {TOOLS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            title={label}
            onClick={() => props.onToolChange(id)}
            className={['hao-tool-button', tool === id ? 'hao-tool-button-active' : ''].join(' ')}
          >
            <Icon size={14} />
          </button>
        ))}
      </div>

      <div className="mx-1 h-[18px] w-px bg-line" />

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

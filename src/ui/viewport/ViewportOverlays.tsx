import { Crosshair } from 'lucide-react'
import type { OverlayState } from '@editor/store/toolStore'

export interface ViewportOverlaysProps {
  zoom: number
  overlay: OverlayState
  onToggleOverlay: (key: keyof OverlayState) => void
  onFitViewport: () => void
}

/**
 * 叠加层开关。**只剩与「在编辑谁」无关的两项**：骨架与约束手柄 —— 任何工具下看的都是同一件事。
 *
 * 「网格 / FFD / 权重」都已移除：它们分别跟着选中项、顶点工具、权重刷工具自动显示，
 * 手动开全局版只会把整个角色铺满线条与顶点，还得记着关回去。
 */
const OVERLAYS: Array<{ key: keyof OverlayState; label: string; hint: string }> = [
  { key: 'bones', label: '骨骼', hint: '显示 / 隐藏骨骼骨架' },
  { key: 'constraints', label: '约束', hint: '显示 / 隐藏约束手柄（IK / 路径）' }
]

/**
 * 视口**右上角**的浮动面板：叠加层开关（骨骼 / 约束）+ 缩放读数与「适配视野」。
 *
 * 与左上角的 Pose / Animate 开关（ModeSwitch）同一种外观与尺寸：它们都是视口上下文的
 * 高频操作，贴着画布浮着比占用菜单栏下面一整行更省地方，视线也不用离开画面。
 *
 * 缩放与「适配视野」原来在那一行里，跟着搬过来（那一行已整体移除）。
 */
export default function ViewportOverlays(props: ViewportOverlaysProps) {
  const { zoom, overlay } = props

  return (
    <div className="pointer-events-auto absolute right-3 top-3 z-20 flex items-center gap-0.5 rounded-[7px] border border-white/10 bg-ink-900/70 p-0.5 shadow-lg shadow-black/30 backdrop-blur-md">
      {OVERLAYS.map(({ key, label, hint }) => (
        <button
          key={key}
          type="button"
          title={hint}
          onClick={() => props.onToggleOverlay(key)}
          className={[
            // 与 ModeSwitch 同一套：轨道是半透明圆角底，打开的那段是实心蓝 + 白字
            'h-[30px] min-w-[52px] rounded-[5px] px-3 text-panel font-medium transition-colors duration-panel cursor-pointer',
            overlay[key]
              ? 'bg-accent-deep text-white'
              : 'text-content-mid hover:bg-white/[0.08] hover:text-content-hi'
          ].join(' ')}
        >
          {label}
        </button>
      ))}
      <span className="px-1.5 font-mono text-3xs text-content-lo">{zoom.toFixed(0)}%</span>
      <button
        type="button"
        title="适配视野 (F)"
        onClick={props.onFitViewport}
        className="hao-tool-button h-[30px] w-[28px]"
      >
        <Crosshair size={15} />
      </button>
    </div>
  )
}

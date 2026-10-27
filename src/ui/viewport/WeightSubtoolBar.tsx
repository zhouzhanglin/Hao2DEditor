import { ArrowUpDown, Brush, SquareDashedMousePointer } from 'lucide-react'
import { getActiveScene } from '@editor/activeScene'
import { useModeStore } from '@editor/store/modeStore'
import type { WeightSubtool } from '@editor/store/toolStore'
import { useToolStore, weightSubtools } from '@editor/store/toolStore'
import { t } from '@i18n'

/**
 * 权重刷的**子工具图标条**：贴在视口左下角，与网格工具的子工具条同一位置。
 *
 * 三个子工具（图标顺序与 `weightSubtools` 一一对应）：
 * - **刷权重**（默认）：左键拖动刷；有选中顶点时只刷这些顶点；
 * - **框选顶点**：左键拖动拉出矩形选中顶点（Shift 追加），松手才结算，全程不写权重；
 * - **直接拖动**：选中顶点后按住上下拖，改它们在这根骨骼上的权重（光标给上下箭头，不画刷子圈）。
 *
 * 为什么用工具条而不是修饰键：权重刷下 Alt / Shift / Ctrl 已经分别是「减少 / 覆盖 / 平滑」，
 * 再挤一个「框选」必然互相打架；而同一个左键拖动也不能既框选又刷 —— 只能二选一。
 *
 * 与 `MeshSubtoolBar`（网格工具 + Pose 态）互斥：当前工具只有一个，两条不会同时出现。
 */
const SUBTOOL_ICONS: Record<WeightSubtool, typeof Brush> = {
  paint: Brush,
  box: SquareDashedMousePointer,
  direct: ArrowUpDown
}

export default function WeightSubtoolBar({ onStatus }: { onStatus: (message: string) => void }) {
  const tool = useToolStore((state) => state.tool)
  const subtool = useToolStore((state) => state.weightSubtool)
  const setWeightSubtool = useToolStore((state) => state.setWeightSubtool)
  const mode = useModeStore((state) => state.mode)

  // 只在「权重刷 + Pose 态」出现：Animate 态权重刷本来就被拦下（见 authoringTools 的模式判断）
  if (tool !== 'weight' || mode !== 'pose') return null

  return (
    <div
      className="pointer-events-auto absolute bottom-3 left-3 z-20 flex items-center gap-0.5 rounded-[8px] border border-white/10 bg-ink-900/70 p-1 shadow-lg shadow-black/30 backdrop-blur-md"
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
    >
      {weightSubtools().map((item) => {
        const Icon = SUBTOOL_ICONS[item.id]
        const active = item.id === subtool
        return (
          <button
            key={item.id}
            type="button"
            title={t('{0}\n{1}', [item.label, item.hint])}
            aria-label={item.label}
            aria-pressed={active}
            onClick={() => {
              setWeightSubtool(item.id)
              /*
               * 刷子半径圈只在「刷权重」下有意义：切走立刻收掉，不然它会原地留到下一次鼠标移动
               *（框选 / 直接拖动下那个圈会被误读成「点下去是在刷」）。
               */
              if (item.id !== 'paint') getActiveScene()?.setViewState({ brushRing: null })
              onStatus(t('权重刷：{0}', item.label))
            }}
            className={[
              'flex h-[28px] w-[28px] cursor-pointer items-center justify-center rounded-[6px] border transition-colors duration-panel',
              active
                ? 'border-accent/60 bg-accent/15 text-accent'
                : 'border-transparent text-content-mid hover:bg-white/[0.07] hover:text-content-hi'
            ].join(' ')}
          >
            <Icon size={16} />
          </button>
        )
      })}
    </div>
  )
}

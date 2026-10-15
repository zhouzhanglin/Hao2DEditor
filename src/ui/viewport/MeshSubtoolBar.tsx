import { Fragment, useState } from 'react'
import type { ReactNode } from 'react'
import { Lasso, Network, SquarePen, SquarePlus, SquareX } from 'lucide-react'
import { getActiveScene } from '@editor/activeScene'
import { useModeStore } from '@editor/store/modeStore'
import type { MeshSubtool } from '@editor/store/toolStore'
import { boundaryRedrawWarning, meshSubtools, useToolStore } from '@editor/store/toolStore'
import type { BoundaryRedrawLoss } from '@editor/tools/authoringTools'
import { boundaryRedrawLoss, closeMeshBoundaryOn } from '@editor/tools/authoringTools'
import ConfirmDialog from '@ui/widgets/ConfirmDialog'
import { t } from '@i18n'

/**
 * 网格工具（Pose 态的「网格工具 M」）的**子工具图标条**：贴在视口左下角。
 *
 * 五个子工具（图标顺序与 `MESH_SUBTOOLS` 一一对应）：
 * - 编辑顶点：默认语义，拖动顶点改几何
 * - 添加顶点 / 删除顶点：点一下改一个顶点
 * - 自己绘制边界 / 自定义布线：改网格拓扑
 *
 * 只有「编辑顶点」是默认状态，另外四个都是临时的：在视口里按右键、或再点一次同一个图标，
 * 都会回到「编辑顶点」（右键处理在 ViewportCanvas）。例外是「自己绘制边界」——最后一个点
 * 接回起点就算画完，它自己会退出（见 authoringTools 的 boundaryPointerDown）。
 *
 * 「自己绘制边界」也是唯一**进去之前先弹确认**的：它是整块重画，会连着旧顶点、绑定权重与
 * FFD 关键帧一起丢掉（见 `BOUNDARY_REDRAW_WARNING`）；取消就留在原来的子工具上，什么都不动。
 *
 * 「自己绘制边界」期间视口会换一副样子：**旧网格的线框、顶点、选中轮廓全部藏起来**，只留
 * 图片的 region 框（虚框）与正在画的轮廓 —— 用户据此知道笔尖该落在框里（落点也会被夹进框）。
 * 退出该状态（闭合 / 右键 / 切走子工具）即自动恢复。见 Scene.drawOverlays 的 boundaryDraw。
 */

/**
 * 图标刻意按**动作形状**挑，不按「同类曲线」凑：
 *
 * 前三个是一眼能连起来的方框系列（笔 / 加 / 叉），后两个换成完全不同的两族形状 ——
 * 套索（手绘一圈轮廓）与节点网络（几个点被连线串起来）。原先的 Spline / Route 都是
 * 「曲线 + 圆点」，彼此就是一个模子，还各自撞了别的功能：`Route` 是层级树里**路径约束**的图标，
 * `Share2`（曲线共享图）是菜单栏**导出**的图标 —— 都在这套图标里回避掉。
 */
const SUBTOOL_ICONS: Record<MeshSubtool, typeof SquarePen> = {
  edit: SquarePen,
  add: SquarePlus,
  remove: SquareX,
  boundary: Lasso,
  rewire: Network
}

/** 鼠标指针中心那个小徽标：一眼看出当前是「加点 / 删点 / 画边界 / 连线」 */
const CURSOR_BADGES: Partial<Record<MeshSubtool, string>> = {
  add: '+',
  remove: '×',
  boundary: '✎',
  rewire: '⌁'
}

/**
 * 各子工具的鼠标指针：内联 SVG（箭头 + 彩色徽标），热点在箭头尖上。
 * 「编辑顶点」返回空串 —— 它就是默认光标，不需要特殊标记。
 */
export function meshSubtoolCursor(subtool: MeshSubtool): string {
  const badge = CURSOR_BADGES[subtool]
  if (!badge) return ''
  const color = subtool === 'remove' ? '#f87171' : subtool === 'rewire' ? '#fbbf24' : '#38bdf8'
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26">' +
    '<path d="M2 1.5 L2 17 L6.2 13.2 L9 19.6 L11.8 18.3 L9.2 12.2 L14.6 12.2 Z" fill="#0f172a" stroke="#f8fafc" stroke-width="1.2"/>' +
    `<circle cx="19" cy="19" r="6.4" fill="${color}"/>` +
    `<text x="19" y="22.4" font-size="10" font-family="sans-serif" text-anchor="middle" fill="#0b1220">${badge}</text>` +
    '</svg>'
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 2 1, crosshair`
}

/**
 * 确认弹窗里的明细：把「这次到底会丢多少」写出来（数字来自 `boundaryRedrawLoss`，
 * 与重建时真正清掉的东西对应）。
 */
function lossDetails(loss: BoundaryRedrawLoss): ReactNode {
  const parts = [t('{0} 个网格点', loss.vertices)]
  if (loss.bones > 0) parts.push(t('{0} 根骨骼的绑定权重', loss.bones))
  if (loss.ffdFrames > 0) parts.push(t('{0} 个 FFD 关键帧（{1} 个动画）', [loss.ffdFrames, loss.ffdAnims]))
  return (
    <>
      <span>
        {t('对象：')}
        <span className="text-content-mid">{loss.slot}</span> /{' '}
        <span className="text-content-mid">{loss.attachment}</span>
      </span>
      <span>
        {t('本次将丢弃：')}
        <span className="text-content-mid">{parts.join(t('、'))}</span>
      </span>
    </>
  )
}

export default function MeshSubtoolBar({ onStatus }: { onStatus: (message: string) => void }) {
  const tool = useToolStore((state) => state.tool)
  const meshSubtool = useToolStore((state) => state.meshSubtool)
  const setMeshSubtool = useToolStore((state) => state.setMeshSubtool)
  const mode = useModeStore((state) => state.mode)
  /** 待确认的「重绘边界」明细：非空 = 确认弹窗开着（点确定才真的切过去） */
  const [pendingLoss, setPendingLoss] = useState<BoundaryRedrawLoss | null>(null)

  // 只属于「网格工具 + Pose 态」：Animate 态拖顶点写的是 FFD 关键帧，跟这套拓扑工具不是一回事
  if (tool !== 'ffd' || mode !== 'pose') return null

  /** 真正切到某个子工具（确认框点「确定」后也走这里） */
  const enter = (clicked: MeshSubtool, next: MeshSubtool): void => {
    const scene = getActiveScene()
    if (scene) {
      // 画边界画到一半又点了别的子工具：回「编辑顶点」按规则收尾闭合，换别的子工具就当放弃
      const drawing = scene.state.pendingMeshPath
      if (drawing && clicked === 'boundary' && next === 'edit') closeMeshBoundaryOn(scene, onStatus)
      else scene.setViewState({ pendingMeshPath: null, hoveredVertex: -1 })
    }
    setMeshSubtool(next)
    const item = meshSubtools().find((entry) => entry.id === next)
    onStatus(
      next === 'edit'
        ? t('网格工具：{0}', item?.label ?? t('编辑顶点'))
        : t('网格工具：{0}（右键回到「编辑顶点」）', item?.label ?? '')
    )
  }

  const pick = (subtool: MeshSubtool): void => {
    // 再点一次当前项 = 退出（等价右键），省得非要回视口按一下右键
    const next: MeshSubtool = subtool === meshSubtool && subtool !== 'edit' ? 'edit' : subtool
    /*
     * 进「自己绘制边界」= 把旧网格整块换成画出来的那一圈：顶点、绑定权重、FFD 关键帧
     * 都要丢（见 rebuildMeshBoundary），所以先确认再进去；取消就留在原来的子工具上，什么都不动。
     * 两种情况不用问：退出（next === 'edit'）；以及**选中项没东西可丢**（没选中网格 / 空网格）——
     * 弹一次「要不要删掉没有的东西」纯属打扰，判定见 boundaryRedrawLoss。
     */
    if (next === 'boundary') {
      const loss = boundaryRedrawLoss()
      if (loss) {
        setPendingLoss(loss)
        return
      }
    }
    enter(subtool, next)
  }

  return (
    <>
      <div
        className="pointer-events-auto absolute bottom-3 left-3 z-20 flex items-center gap-0.5 rounded-[8px] border border-white/10 bg-ink-900/70 p-1 shadow-lg shadow-black/30 backdrop-blur-md"
        onPointerDown={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.stopPropagation()}
      >
        {meshSubtools().map((item) => {
          const Icon = SUBTOOL_ICONS[item.id]
          const active = item.id === meshSubtool
          return (
            <Fragment key={item.id}>
              {item.divider ? <span className="mx-0.5 h-4 w-px bg-line" /> : null}
              <button
                type="button"
                title={t('{0}\n{1}', [item.label, item.hint])}
                aria-label={item.label}
                aria-pressed={active}
                onClick={() => pick(item.id)}
                className={[
                  'flex h-[28px] w-[28px] cursor-pointer items-center justify-center rounded-[6px] border transition-colors duration-panel',
                  active
                    ? 'border-accent/60 bg-accent/15 text-accent'
                    : 'border-transparent text-content-mid hover:bg-white/[0.07] hover:text-content-hi'
                ].join(' ')}
              >
                <Icon size={16} />
              </button>
            </Fragment>
          )
        })}
      </div>

      {pendingLoss ? (
        <ConfirmDialog
          title={t('重绘网格边线')}
          icon={Lasso}
          danger
          message={boundaryRedrawWarning()}
          details={lossDetails(pendingLoss)}
          hint={t('这一步可以用 Ctrl+Z 整步撤销')}
          confirmLabel={t('重绘')}
          onConfirm={() => {
            setPendingLoss(null)
            enter('boundary', 'boundary')
          }}
          onClose={() => setPendingLoss(null)}
        />
      ) : null}
    </>
  )
}

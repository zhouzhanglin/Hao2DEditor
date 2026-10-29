import { Easing } from '@core/model/animation'
import { useProjectStore } from '@editor/store/projectStore'
import { useTimelineStore } from '@editor/store/timelineStore'
import { findKeyframe, setKeyEasing } from '@editor/timeline/model'
import CurveEditor from '@ui/timeline/CurveEditor'
import { t } from '@i18n'

/**
 * 关键帧缓动曲线：**浮动在视口右下角**（原来占左栏一整块，Animate 态时把层级树的
 * 可用高度吃掉一大半，而它只在挑缓动时才用得上）。
 *
 * 两件事都由这里定：
 * - 没选中关键帧 → 整块不渲染（没有可改的缓动，浮层没有存在的意义）；
 * - 不画标题栏 / 关闭按钮：拖控制点或点预设即写入，切到别处自然消失。
 *
 * 定位用 `absolute`：外层视口容器是 `relative`（见 App 的 center 分栏），
 * 右下角与左下角的工具条、正下方中点的取值条都不冲突。
 */
export default function CurvePanel() {
  const document = useProjectStore((s) => s.document)
  const update = useProjectStore((s) => s.update)
  const animationName = useTimelineStore((s) => s.currentAnimation)
  const selectedKeys = useTimelineStore((s) => s.selectedKeys)

  if (selectedKeys.length === 0) return null

  const animation = document.animations.find((item) => item.name === animationName) ?? null
  const single = selectedKeys.length === 1 ? selectedKeys[0] : null
  const frame = single && animation ? findKeyframe(animation, single) : null

  return (
    <div className="animate-fade-in absolute bottom-2 right-2 z-20 w-[176px] rounded-[6px] border border-line bg-ink-800/95 p-1.5 shadow-2xl shadow-black/50 backdrop-blur-sm">
      <CurveEditor
        selectedKeys={selectedKeys}
        easing={frame?.easing ?? Easing.Linear}
        curve={frame?.curve ?? null}
        showTitle={false}
        onChange={(easing, curve) => {
          update(t('修改缓动'), (draft) => {
            setKeyEasing(draft, animation?.name ?? null, selectedKeys, easing, curve)
          })
        }}
      />
    </div>
  )
}

import { Easing } from '@core/model/animation'
import { useProjectStore } from '@editor/store/projectStore'
import { useTimelineStore } from '@editor/store/timelineStore'
import { findKeyframe, setKeyEasing } from '@editor/timeline/model'
import CurveEditor from '@ui/timeline/CurveEditor'

/**
 * 关键帧曲线面板：Animate 态占左栏第三块（原「资源与皮肤」的位置）。
 *
 * 曲线编辑器原先挤在时间轴底部工具条里，横向只有一百来像素；挪到左栏后有完整一列可用，
 * 缓动预设、控制点、c1/c2 数值都放得下。拖控制点 / 点预设即写入选中关键帧的缓动
 * （多选时作用于全部选中帧）。
 */
export default function CurvePanel() {
  const document = useProjectStore((s) => s.document)
  const update = useProjectStore((s) => s.update)
  const animationName = useTimelineStore((s) => s.currentAnimation)
  const selectedKeys = useTimelineStore((s) => s.selectedKeys)

  const animation = document.animations.find((item) => item.name === animationName) ?? null
  const single = selectedKeys.length === 1 ? selectedKeys[0] : null
  const frame = single && animation ? findKeyframe(animation, single) : null

  return (
    <div className="flex h-full w-full flex-col gap-1.5 overflow-y-auto overflow-x-hidden p-2">
      <CurveEditor
        selectedKeys={selectedKeys}
        easing={frame?.easing ?? Easing.Linear}
        curve={frame?.curve ?? null}
        showTitle={false}
        onChange={(easing, curve) => {
          update('修改缓动', (draft) => {
            setKeyEasing(draft, animation?.name ?? null, selectedKeys, easing, curve)
          })
        }}
      />
      <p className="text-3xs text-content-lo">
        选中关键帧后拖控制点，或点预设按钮；多选时预设作用于全部选中帧。
      </p>
    </div>
  )
}

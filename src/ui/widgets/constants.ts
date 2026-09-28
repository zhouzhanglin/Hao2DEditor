import { BlendMode } from '@core/model/types'
import type { ConstraintType } from '@core/model/constraints'

export const BLEND_OPTIONS = [
  { value: String(BlendMode.Normal), label: 'Normal' },
  { value: String(BlendMode.Additive), label: 'Additive' },
  { value: String(BlendMode.Multiply), label: 'Multiply' },
  { value: String(BlendMode.Screen), label: 'Screen' },
  { value: String(BlendMode.Erase), label: 'Erase（视口降级）' },
  { value: String(BlendMode.Mask), label: 'Mask（视口降级）' },
  { value: String(BlendMode.Below), label: 'Below（视口降级）' },
  { value: String(BlendMode.None), label: 'None（视口降级）' }
]

export const CONSTRAINT_LABEL: Record<ConstraintType, string> = {
  ik: 'IK',
  transform: '变换',
  path: '路径',
  physics: '物理'
}

export const EASING_OPTIONS = [
  { value: '0', label: '线性' },
  { value: '1', label: '阶跃' },
  { value: '2', label: '贝塞尔' }
]

/** 时间轴轨道的显示名与分组 */
export const TRACK_GROUPS = ['骨骼变换', '插槽颜色', '附件切换', 'FFD 变形', '约束', '事件'] as const

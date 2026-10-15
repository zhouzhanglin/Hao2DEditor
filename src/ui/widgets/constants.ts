import { BlendMode } from '@core/model/types'
import type { ConstraintType } from '@core/model/constraints'
import { t } from '@i18n'

/**
 * 选项表 / 标签表一律做成**函数**而不是模块级常量：
 * 常量会在模块导入时就把 `t()` 的结果固化下来，切语言时不会跟着变。
 */

export function blendOptions(): Array<{ value: string; label: string }> {
  return [
    { value: String(BlendMode.Normal), label: 'Normal' },
    { value: String(BlendMode.Additive), label: 'Additive' },
    { value: String(BlendMode.Multiply), label: 'Multiply' },
    { value: String(BlendMode.Screen), label: 'Screen' },
    { value: String(BlendMode.Erase), label: t('Erase（视口降级）') },
    { value: String(BlendMode.Mask), label: t('Mask（视口降级）') },
    { value: String(BlendMode.Below), label: t('Below（视口降级）') },
    { value: String(BlendMode.None), label: t('None（视口降级）') }
  ]
}

const CONSTRAINT_LABEL_KEY: Record<ConstraintType, string> = {
  ik: 'IK',
  transform: '变换',
  path: '路径',
  physics: '物理'
}

/** 约束类型的中文短名（IK 保持原文，其余走词典） */
export function constraintLabel(type: ConstraintType): string {
  return t(CONSTRAINT_LABEL_KEY[type])
}

export function easingOptions(): Array<{ value: string; label: string }> {
  return [
    { value: '0', label: t('线性') },
    { value: '1', label: t('阶跃') },
    { value: '2', label: t('贝塞尔') }
  ]
}

/** 时间轴轨道的显示名与分组 */
export function trackGroups(): string[] {
  return [t('骨骼变换'), t('插槽颜色'), t('附件切换'), t('FFD 变形'), t('约束'), t('事件')]
}

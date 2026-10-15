/**
 * 骨骼叠加层的样式（「全局设置 → 骨骼样式」里可调，落盘 localStorage，跨工程保留）。
 *
 * 这些字段的**默认值就是加设置之前项目里用的那一档**：没动过设置时，视口里的骨骼
 * 与原来一模一样。放开之后每一项都只影响叠加层的外观，不写进工程文件、不进运行期 ——
 * 导出的角色数据不受它影响。
 */
export interface BoneOverlayStyle {
  /** 骨骼本体半宽：占骨骼长度的百分比（半宽 = length × 该值；原来写死 5%） */
  widthPercent: number
  /** 骨骼原点圆圈半径（屏幕像素；原来写死 6，拾取容差跟着它走，见 scene.pickBoneHandleAt） */
  jointRadius: number
  /** 骨骼本体默认填充色 `#RRGGBB`（原来 #CCD2D8） */
  fillColor: string
  /** 骨骼本体默认填充透明度（原来 0.55） */
  fillAlpha: number
  /** 描边色 `#RRGGBB`：骨骼本体轮廓与原点圆圈都用它（原来与填充同色 #CCD2D8） */
  strokeColor: string
  /** 描边透明度（原来 0.9） */
  strokeAlpha: number
  /** 选中后的颜色：本体填充 / 描边 / 原点圈一起换成它（原来 #4FE3F7） */
  selectedColor: string
}

export const DEFAULT_BONE_STYLE: BoneOverlayStyle = {
  widthPercent: 3,
  jointRadius: 6,
  fillColor: '#c4c4c4',
  fillAlpha: 1,
  strokeColor: '#CCD2D8',
  strokeAlpha: 0.9,
  selectedColor: '#4FE3F7'
}

/** `#RRGGBB` → pixi 的颜色数值；解析不了（坏设置 / 手改 localStorage）退回白色 */
export function boneStyleColor(hex: string): number {
  const text = hex.trim().replace(/^#/, '')
  if (!/^[0-9a-fA-F]{6}$/.test(text)) return 0xffffff
  return parseInt(text, 16)
}

/**
 * 校验 / 规整 `#RRGGBB`：坏值退回 `fallback`。
 * 写设置的那一端（settingsStore / 设置弹窗）都过它，绘制端拿到的就一定是合法色。
 */
export function normalizeBoneHex(hex: string, fallback: string): string {
  const text = hex.trim().replace(/^#/, '')
  return /^[0-9a-fA-F]{6}$/.test(text) ? `#${text.toUpperCase()}` : fallback
}

/** 透明度夹到 0..1：设置面板拖到边界外、旧数据缺字段时都不该画出负 alpha */
export function boneStyleAlpha(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(1, Math.max(0, value))
}

import { Graphics } from 'pixi.js'
import type { Skeleton } from '@core/model/skeleton'
import type { Constraint } from '@core/model/constraints'
import { BONE_ORIGIN_RADIUS, attachmentGizmoFrame, gizmoGeometry, unshearedWorldRot } from '@render/picking'
import type { GizmoGeometry } from '@render/picking'
import { circlePolygon, DOT_SEGMENTS } from './shapes'

export interface BoneOverlayOptions {
  /** 1 世界单位对应的屏幕像素的倒数（= 1 / zoom），用于保持描边视觉宽度恒定 */
  unitsPerPixel: number
  /** 选中的骨骼（索引集合）：多选时这几根**全部**按选中样式画 */
  selectedBones: ReadonlySet<number>
  hoveredBone: number
  /** 是否绘制骨骼本体（关掉「骨骼」开关但「约束」仍开着时传 false：只留约束手柄，不画骨架） */
  showBones: boolean
  showConstraints: boolean
  showSlots: boolean
  /**
   * 当前选中网格**绑定的骨骼**：索引 → 颜色（取自「权重骨骼列表」的配色，见 weightPalette）。
   * 这几根按各自的颜色画（未选中 / 未悬停时），于是「面板里哪一行」「视口里哪根骨骼」
   * 「顶点饼图里的哪一瓣」用的是同一个色，一眼对得上。
   */
  weightBoneColors?: ReadonlyMap<number, number>
  /** 需要画成空心的骨骼名（来自编辑期模型的 hollow 选项，默认全是实心） */
  hollowBones?: ReadonlySet<string>
  /** 拖拽新建骨骼时的预览（世界坐标两点） */
  pendingBone?: { x1: number; y1: number; x2: number; y2: number } | null
  /** 选中的附件操作器（Pose 态）：中心 = 附件 position，轴 = 附件旋转叠加宿主骨骼 */
  attachmentGizmo?: { boneIndex: number; position: { x: number; y: number }; rotation: number } | null
}

// 覆盖层配色统一取 macOS 系统色（暗色版），与主题令牌同源。
// 骨骼样式与 **Spine 编辑器**一致：本体浅灰半透明、关节处白圈；
// 选中骨骼整根（本体 + 关节圈）换成青色高亮；旋转工具时原点外再套一个红圈。
const COLOR_BONE = 0xccd2d8
const COLOR_JOINT = 0xf2f5f8
/** 选中骨骼的高亮色（青）：本体与关节圈一起换成它，一眼锁定选中的是哪根 */
const COLOR_SELECTED = 0x4fe3f7
/** 旋转工具的圆环（红）：与 Spine 的旋转圈同义 —— 选中骨骼切到旋转时出现 */
const COLOR_ROTATE_RING = 0xff453a
/** 约束（连线 + 准星手柄）的红：与层级树里 IK 图标的颜色一致（HierarchyTree 的 IkConstraintIcon） */
const COLOR_CONSTRAINT = 0xe4572e
/** 目标骨被选中时准星提亮成白色：骨骼层关掉时这是「选中了它」的唯一视口反馈 */
const COLOR_CONSTRAINT_SELECTED = 0xffffff
const COLOR_LINK = 0x8e8e93

/** 小坐标轴：X 轴红、Y 轴绿、中心蓝（macOS 系统色） */
const COLOR_AXIS_X = 0xff453a
const COLOR_AXIS_Y = 0x30d158
const COLOR_AXIS_CENTER = 0x0a84ff
/** 斜切包围盒（紫） */
const COLOR_SHEAR_BOX = 0xbf5af2
/** 拖拽新建骨骼的虚线预览 */
const COLOR_PENDING = 0xbf5af2

/** 小坐标轴的模式（与 editor/store/toolStore 的 GizmoMode 一致，避免循环依赖这里重复声明） */
export type GizmoDrawMode = 'move' | 'rotate' | 'scale' | 'shear'

function squarePath(x: number, y: number, r: number): number[] {
  return [x - r, y - r, x + r, y - r, x + r, y + r, x - r, y + r]
}

/**
 * 骨骼变换小坐标轴（gizmo）：中心 + 局部 X / Y 轴，按模式换外观。
 *
 * - move：箭头（X 红 / Y 绿）+ 中心方块（拖中心 = 两轴一起动）
 * - rotate：圆环（拖环或中心都是旋转）
 * - scale：轴末端方块（改长度 / 粗细）+ 中心方块（等比）
 *
 * 斜切不走小坐标轴，改画**包围盒**（见 `drawShearBox`）：在框的边上拖动即可斜切。
 * 尺寸都用 `unitsPerPixel` 换算，保证屏幕上大小恒定。
 */
export function drawBoneGizmo(
  stroke: Graphics,
  fill: Graphics,
  skeleton: Skeleton,
  index: number,
  mode: GizmoDrawMode,
  unitsPerPixel: number
): void {
  const w = unitsPerPixel
  const geometry = gizmoGeometry(skeleton, index, w * GIZMO_AXIS_LENGTH)
  if (!geometry) return
  drawGizmoFrame(stroke, fill, geometry, mode, w)
}

/**
 * gizmo 通用绘制（骨骼与附件操作器共用）：中心圆 + 轴，按模式换外观。
 * 骨骼用蓝色中心，附件用橙色中心（`centerColor`）区分。
 */
export function drawGizmoFrame(
  stroke: Graphics,
  fill: Graphics,
  frame: GizmoGeometry,
  mode: GizmoDrawMode,
  unitsPerPixel: number,
  centerColor = COLOR_AXIS_CENTER
): void {
  const w = unitsPerPixel
  const { ox, oy, tx, ty, sx, sy } = frame
  const handle = w * GIZMO_HANDLE_SIZE

  stroke
    .poly(circlePolygon(ox, oy, w * GIZMO_CENTER_RADIUS))
    .stroke({ width: w * 1.6, color: centerColor, alpha: 0.95 })
  fill
    .poly(circlePolygon(ox, oy, w * GIZMO_CENTER_RADIUS * 0.6))
    .fill({ color: centerColor, alpha: 0.9 })

  if (mode === 'rotate') {
    const r = w * GIZMO_RING_RADIUS
    // 旋转环用**红色**（与 Spine 的旋转圈同义：红圈 = 正在旋转），中心点仍用 centerColor
    // 自己画多边形：Pixi 的 circle 会按世界半径退化成多边形（放大后尤其明显）
    stroke.poly(circlePolygon(ox, oy, r)).stroke({ width: w * 2.4, color: COLOR_ROTATE_RING, alpha: 0.9 })
    // 四个刻度，强调「这是一个旋转环」
    for (const angle of [0, Math.PI / 2, Math.PI, (Math.PI * 3) / 2]) {
      const cx = ox + Math.cos(angle) * r
      const cy = oy + Math.sin(angle) * r
      stroke
        .moveTo(ox + Math.cos(angle) * (r - w * 4), oy + Math.sin(angle) * (r - w * 4))
        .lineTo(ox + Math.cos(angle) * (r + w * 4), oy + Math.sin(angle) * (r + w * 4))
        .stroke({ width: w * 1.4, color: COLOR_ROTATE_RING, alpha: 0.75 })
    }
    return
  }

  const drawAxis = (ex: number, ey: number, color: number): void => {
    stroke.moveTo(ox, oy).lineTo(ex, ey).stroke({ width: w * 2, color, alpha: 1 })
    if (mode === 'move') {
      // 箭头：沿轴方向的三角形
      const angle = Math.atan2(ey - oy, ex - ox)
      const head = handle * 1.5
      fill
        .poly([
          ex,
          ey,
          ex - Math.cos(angle - 0.4) * head,
          ey - Math.sin(angle - 0.4) * head,
          ex - Math.cos(angle + 0.4) * head,
          ey - Math.sin(angle + 0.4) * head
        ])
        .fill({ color, alpha: 0.95 })
      return
    }
    // scale：实心方块
    fill.poly(squarePath(ex, ey, handle)).fill({ color, alpha: 0.5 })
    stroke.poly(squarePath(ex, ey, handle)).stroke({ width: w * 1.6, color, alpha: 1 })
  }

  drawAxis(tx, ty, COLOR_AXIS_X)
  drawAxis(sx, sy, COLOR_AXIS_Y)
}

/**
 * 附件操作器：与骨骼 gizmo 同一套外观，中心用**橙色**区分（骨骼是蓝色）。
 * 中心 = 附件 position 的世界位置，轴 = 附件自身旋转叠加骨骼朝向。
 */
export function drawAttachmentGizmo(
  stroke: Graphics,
  fill: Graphics,
  frame: GizmoGeometry,
  mode: GizmoDrawMode,
  unitsPerPixel: number
): void {
  drawGizmoFrame(stroke, fill, frame, mode, unitsPerPixel, 0xfbbf24)
}

/**
 * 斜切包围盒：把选中骨骼（及其附件）框起来，鼠标落在边上拖动即可斜切。
 * 四角顺序：左上 → 右上 → 右下 → 左下。
 */
export function drawShearBox(
  stroke: Graphics,
  fill: Graphics,
  corners: ReadonlyArray<{ x: number; y: number }>,
  unitsPerPixel: number
): void {
  if (corners.length < 4) return
  const w = unitsPerPixel
  const path = corners.flatMap((point) => [point.x, point.y])
  fill.poly(path).fill({ color: COLOR_SHEAR_BOX, alpha: 0.1 })
  stroke.poly(path).stroke({ width: w * 1.8, color: COLOR_SHEAR_BOX, alpha: 0.95 })
  // 四角加小方块，让"这是一个可拖的框"更明确
  for (const point of corners) {
    const r = w * 3.5
    const box = [point.x - r, point.y - r, point.x + r, point.y - r, point.x + r, point.y + r, point.x - r, point.y + r]
    fill.poly(box).fill({ color: COLOR_SHEAR_BOX, alpha: 0.85 })
    stroke.poly(box).stroke({ width: w * 1.2, color: COLOR_SHEAR_BOX, alpha: 1 })
  }
}

/** 选中 display 的轮廓色：与附件操作器同族（琥珀），一眼看出「这是附件」 */
const COLOR_DISPLAY_OUTLINE = 0xfbbf24

/** 轮廓样式：默认是「已选中」外观（亮线），悬停预览传更弱的一档 */
export interface DisplayOutlineStyle {
  color?: number
  strokeAlpha?: number
  /** 描边宽度（屏幕像素） */
  width?: number
}

/** 一条轮廓路径（世界坐标）：Region 传闭合矩形四角，Mesh 传一条边界边（两个点） */
export type DisplayOutlinePath = ReadonlyArray<{ x: number; y: number }>

/**
 * display 的轮廓：沿对象**真实形状**描线，**不填色**。
 *
 * 为什么要有这个：附件操作器（十字轴）只指示**轴心**，轴心常常落在对象外面
 * （比如贴图相对骨骼偏移很远），所以光看操作器分不清到底选中了哪一个；
 * 沿形状描一圈才是一眼可辨的反馈。
 *
 * 为什么只描线不填色：填色会盖住贴图本身的颜色与细节，比对（尤其是调位置 /
 * 看 UV 是否正确）时反而碍事；线框只按边界提示范围。
 *
 * 多条路径用 `moveTo / lineTo` 拼成**一次** stroke：网格的边界是几十条短线段，
 * 逐条 `poly().stroke()` 会为每条边生成一份几何，白白多出几十次绘制调用。
 */
export function drawDisplayOutline(
  stroke: Graphics,
  paths: ReadonlyArray<DisplayOutlinePath>,
  unitsPerPixel: number,
  style: DisplayOutlineStyle = {}
): void {
  let drawn = 0
  for (const path of paths) {
    if (path.length < 2) continue
    stroke.moveTo(path[0].x, path[0].y)
    for (let i = 1; i < path.length; i++) stroke.lineTo(path[i].x, path[i].y)
    // 只在三点以上闭合：两点的线段闭合是空操作，但会多一次 closePath
    if (path.length > 2) stroke.closePath()
    drawn++
  }
  if (drawn === 0) return
  const w = unitsPerPixel
  stroke.stroke({
    width: w * (style.width ?? 1.6),
    color: style.color ?? COLOR_DISPLAY_OUTLINE,
    alpha: style.strokeAlpha ?? 0.95
  })
}

/** 斜切包围盒边缘的拾取容差（px） */
export const SHEAR_EDGE_TOLERANCE = 8

/** 小坐标轴在屏幕上的尺寸（px） */
export const GIZMO_AXIS_LENGTH = 62
export const GIZMO_HANDLE_SIZE = 6
export const GIZMO_CENTER_RADIUS = 8
export const GIZMO_RING_RADIUS = 46

/**
 * 洋葱皮幽灵骨骼的配色：**前一帧暖珊瑚、后一帧冷蓝**。
 * 一暖一冷是各家的通行约定，一眼看出「从哪来（前一帧）、到哪去（后一帧）」；
 * 早先两帧同色，两个幽灵叠在一起根本分不清哪个是哪个。
 */
export const GHOST_PREV_COLOR = 0xff8a6a
export const GHOST_NEXT_COLOR = 0x5cc8ff

/**
 * 洋葱皮：用**另一时刻**的世界矩阵画一套幽灵骨骼作参考（不重渲染网格，开销可忽略）。
 *
 * 形状与本体骨骼同一套语言（见 drawBoneOverlay）：**细长的风筝 + 关节小圈**，
 * 但只描边、不填充、尺寸更瘦 —— 幽灵是背景参照，不能和当前姿态抢眼。
 *
 * 早先画的是「父骨原点 → 子骨原点」的等宽直线：根骨骼（父 = 自己）退化成零长度
 * **根本画不出来**，整体又是一团同色乱线，读不出每根骨骼的朝向与长度，所以显得糙。
 */
export function drawGhostBones(
  g: Graphics,
  matrices: Float32Array,
  lengths: readonly number[],
  unitsPerPixel: number,
  color: number,
  alpha: number
): void {
  const w = unitsPerPixel
  // 骨骼体与关节圈分两批描边：同一批内的所有路径合并成一次绘制调用
  for (let i = 0; i < lengths.length; i++) {
    const o = i * 16
    const sx = matrices[o]
    const sy = matrices[o + 1]
    const scale = Math.hypot(sx, sy)
    if (scale < 1e-6) continue
    const reach = lengths[i] * scale
    if (reach < 1e-4) continue
    const x = matrices[o + 12]
    const y = matrices[o + 13]
    // 幽灵只作参照，方向直接取矩阵 x 轴（不必像本体那样剔除剪切）
    const dx = sx / scale
    const dy = sy / scale
    const px = -dy
    const py = dx
    // 比本体更瘦（本体半宽 5% 长度）：细一点不抢戏，但足够看出朝向
    const shoulder = reach * 0.12
    const halfW = Math.min(Math.max(reach * 0.035, w * 1.1), reach * 0.24)
    g.poly(
      [
        x,
        y, // 顶点（骨骼原点）
        x + dx * shoulder + px * halfW,
        y + dy * shoulder + py * halfW, // 左肩
        x + dx * reach,
        y + dy * reach, // 末端尖端
        x + dx * shoulder - px * halfW,
        y + dy * shoulder - py * halfW // 右肩
      ],
      true
    )
  }
  g.stroke({ width: w * 1.3, color, alpha })

  // 关节小圈：比本体（半径 6px）小一档，只提示「关节在这儿」，不喧宾夺主
  const joint = w * 3.6
  for (let i = 0; i < lengths.length; i++) {
    const o = i * 16
    // 小圈用 DOT_SEGMENTS：半径只有 3.6px，48 段看不出差别，纯属白白多算顶点
    g.poly(circlePolygon(matrices[o + 12], matrices[o + 13], joint, DOT_SEGMENTS), true)
  }
  g.stroke({ width: w * 1.1, color, alpha: alpha * 0.7 })
}

/**
 * 骨骼绘制 + 关节 + 约束目标连线（画在世界容器里，y 轴向上）。
 *
 * 骨骼体是 Spine 风格的**风筝形四边形**：原点收成顶点 → 沿骨骼方向张开到两个肩点 →
 * 再收成末端尖端；骨骼原点（关节处）画一个空心圆圈。
 * 每个骨骼可以选实心（默认，半透明填充 + 描边）或空心（只描边），
 * 空心标记来自编辑期模型的 `hollow`（按骨骼名匹配，运行时模型不带该字段）。
 *
 * 描边与填充必须用**两个 Graphics**：pixi v8 中 stroke() 之后的路径仍会被后续
 * fill() 填充，混用会画出一整块覆盖角色的色斑。
 */
/**
 * 绘制骨骼体、原点圈与**末端缩放手柄**（仅选中骨骼绘制手柄，避免画面噪点）。
 */
export function drawBoneOverlay(
  strokes: Graphics,
  fills: Graphics,
  skeleton: Skeleton,
  constraints: readonly Constraint[],
  options: BoneOverlayOptions
): void {
  strokes.clear()
  fills.clear()
  const g = strokes
  const w = options.unitsPerPixel
  const boneCount = skeleton.boneCount

  // 骨骼体（四边形）+ 原点圈：「骨骼」开关关掉时整段跳过（约束手柄与骨骼是两个独立开关）
  for (let i = 0; options.showBones && i < boneCount; i++) {
    const o = i * 16
    const x = skeleton.world[o + 12]
    const y = skeleton.world[o + 13]
    const length = skeleton.asset.bones[i].length
    const isSelected = options.selectedBones.has(i)
    const isHovered = i === options.hoveredBone
    /*
     * Spine 风格的状态色：普通 = 浅灰（绑定了权重的骨骼仍用「权重骨骼列表」的色，
     * 与面板 / 饼图对上）；选中 = 整根换成青色高亮；悬停只压实透明度。
     */
    const weightColor = options.weightBoneColors?.get(i)
    const isWeight = weightColor !== undefined
    const color = isSelected ? COLOR_SELECTED : (weightColor ?? COLOR_BONE)

    /*
     * 骨骼方向按**不含剪切的旋转角**画（长度乘世界缩放）：剪切只作用于蒙皮 / 附件，
     * 骨骼本体不跟着歪。否则斜切工具下骨骼会随 shearX 摆动，与旋转的观感完全混淆 ——
     * 「斜切」的反馈要看剪切包围盒与附件的形变，动骨骼本体的只能是旋转工具。
     */
    const worldScale = Math.hypot(skeleton.world[o], skeleton.world[o + 1])
    const boneAngle = (unshearedWorldRot(skeleton, i) * Math.PI) / 180
    const dx = Math.cos(boneAngle) * length * worldScale
    const dy = Math.sin(boneAngle) * length * worldScale
    const norm = Math.hypot(dx, dy)

    if (length >= 1e-4 && norm >= 1e-6) {
      const tx = x + dx
      const ty = y + dy
      const dirX = dx / norm
      const dirY = dy / norm
      const px = -dirY
      const py = dirX
      // Spine 风格风筝形：原点收成顶点 → 沿骨骼方向张开到两个肩点 → 收成末端尖端
      const shoulder = length * 0.09
      const halfW = Math.min(Math.max(length * 0.05, w * 2.2), length * 0.4)
      const sx = x + dirX * shoulder
      const sy = y + dirY * shoulder
      const quad = [
        x,
        y, // 顶点（骨骼原点，正对关节圈）
        sx + px * halfW,
        sy + py * halfW, // 左肩
        tx,
        ty, // 末端尖端
        sx - px * halfW,
        sy - py * halfW // 右肩
      ]
      const hollow = options.hollowBones?.has(skeleton.asset.bones[i].name) ?? false
      // 选中接近实心（0.95）、悬停次之（0.75）、普通 0.55 —— 三个档位只看透明度就知道谁被选中
      if (!hollow) fills.poly(quad).fill({ color, alpha: isSelected ? 0.95 : isHovered ? 0.75 : 0.55 })
      // 描边与填充同色：普通骨骼浅灰描边，选中整根青色（Spine 的选中高亮观感）
      strokes.poly(quad).stroke({
        width: w * (isSelected ? 2.2 : isWeight ? 1.5 : 1.2),
        color,
        alpha: hollow || isSelected || isHovered ? 1 : 0.9
      })

    }

    // 原点（骨骼头）画一个圈：空心白环（Spine 风格），选中换成青色并画粗一点。
    // 半径与拾取用的 BONE_ORIGIN_RADIUS 一致（拖这个圈 = 移动骨骼）
    const r = (isSelected ? BONE_ORIGIN_RADIUS + 1.5 : BONE_ORIGIN_RADIUS - 0.5) * w
    strokes
      .poly(circlePolygon(x, y, r))
      .stroke({
        width: w * (isSelected ? 2.2 : 1.8),
        color: isSelected ? COLOR_SELECTED : (weightColor ?? COLOR_JOINT),
        alpha: isSelected || isHovered ? 1 : 0.9
      })
  }

  if (options.showSlots) {
    for (let i = 0; i < skeleton.slotCount; i++) {
      const slot = skeleton.asset.slots[i]
      if (slot.boneIndex < 0) continue
      const o = slot.boneIndex * 16
      const x = skeleton.world[o + 12]
      const y = skeleton.world[o + 13]
      const r = w * 2
      g.moveTo(x - r, y).lineTo(x + r, y)
      g.moveTo(x, y - r).lineTo(x, y + r)
      g.stroke({ width: w * 1, color: COLOR_LINK, alpha: 0.6 })
    }
  }

  if (options.showConstraints) drawConstraintLinks(g, skeleton, constraints, w, options.selectedBones)
  drawPendingBone(strokes, fills, options.pendingBone, w)
}

/**
 * 拖拽新建骨骼的预览：起点圆圈 + 虚线骨骼 + 末端圆点。
 * 松开鼠标后由上层按同样的两点生成真实骨骼，所以预览与结果是同一条线。
 */
function drawPendingBone(
  strokes: Graphics,
  fills: Graphics,
  pending: BoneOverlayOptions['pendingBone'],
  w: number
): void {
  if (!pending) return
  const { x1, y1, x2, y2 } = pending
  const length = Math.hypot(x2 - x1, y2 - y1)
  if (length > 1e-4) {
    const dash = w * 7
    const gap = w * 5
    const dx = (x2 - x1) / length
    const dy = (y2 - y1) / length
    for (let distance = 0; distance < length; distance += dash + gap) {
      const segment = Math.min(dash, length - distance)
      strokes.moveTo(x1 + dx * distance, y1 + dy * distance)
      strokes.lineTo(x1 + dx * (distance + segment), y1 + dy * (distance + segment))
    }
    strokes.stroke({ width: w * 2, color: COLOR_PENDING, alpha: 0.95 })
  }
  strokes.circle(x1, y1, w * 5).stroke({ width: w * 2, color: COLOR_PENDING, alpha: 0.95 })
  fills.circle(x2, y2, w * 5).fill({ color: COLOR_PENDING, alpha: 0.35 })
  strokes.circle(x2, y2, w * 5).stroke({ width: w * 2, color: COLOR_PENDING, alpha: 0.95 })
}

/**
 * 约束手柄连线（红色）：
 * - IK：**顺着骨骼链**走（根骨原点 → 各关节 → 末端尖端），再从尖端拉到目标点
 * - 变换 / 路径：多根骨骼共同受某个目标影响，保持「每根 → 目标」的扇形连线
 *
 * 目标骨骼缺失、约束停用、以及不参与求解的 physics 都不画。
 */
function drawConstraintLinks(
  g: Graphics,
  skeleton: Skeleton,
  constraints: readonly Constraint[],
  w: number,
  selectedBones: ReadonlySet<number>
): void {
  for (const constraint of constraints) {
    if (!constraint.enabled || constraint.type === 'physics') continue
    if (constraint.targetBoneIndex < 0 || constraint.targetBoneIndex >= skeleton.boneCount) continue
    const targetX = skeleton.boneWorldX(constraint.targetBoneIndex)
    const targetY = skeleton.boneWorldY(constraint.targetBoneIndex)

    if (constraint.type === 'ik') {
      /*
       * 中间几段与骨骼本体重合（一眼看出「这几根归这条 IK 管」、链的顺序是根 → 末端），
       * 最后一段「尖端 → 目标」才是 IK 真正要消除的差距。
       *
       * 早先是「链上每根骨骼的原点都连到目标点」：两骨 IK 会画成一个三角扇形，
       * 既不像骨骼，也看不出链的顺序（目标离链尾远时尤其别扭）。
       */
      let last = -1
      for (const bone of constraint.boneIndices) {
        if (bone < 0 || bone >= skeleton.boneCount) continue
        const x = skeleton.boneWorldX(bone)
        const y = skeleton.boneWorldY(bone)
        if (last < 0) g.moveTo(x, y)
        else g.lineTo(x, y)
        last = bone
      }
      if (last >= 0) {
        /*
         * 末端 = 原点沿骨骼 x 轴走一个 length —— 方向按**不含剪切的旋转角**算
         *（与骨骼本体绘制 / 拾取同一口径）：剪切不该让骨骼末端偏离画出来的骨骼
         */
        const o = last * 16
        const length = skeleton.asset.bones[last].length
        const scale = Math.hypot(skeleton.world[o], skeleton.world[o + 1])
        const angle = (unshearedWorldRot(skeleton, last) * Math.PI) / 180
        const tipX = skeleton.world[o + 12] + Math.cos(angle) * length * scale
        const tipY = skeleton.world[o + 13] + Math.sin(angle) * length * scale
        g.lineTo(tipX, tipY).lineTo(targetX, targetY)
        g.stroke({ width: w * 1.2, color: COLOR_CONSTRAINT, alpha: 0.7 })
      }
    } else {
      for (const bone of constraint.boneIndices) {
        if (bone < 0 || bone >= skeleton.boneCount) continue
        g.moveTo(skeleton.boneWorldX(bone), skeleton.boneWorldY(bone)).lineTo(targetX, targetY)
        g.stroke({ width: w * 1.2, color: COLOR_CONSTRAINT, alpha: 0.7 })
      }
    }

    /*
     * IK 目标点画成**准星**：靶环 + 四向凸点 + 内环 + 中心横杆 ——
     * 与层级树里的 IK 图标同形（HierarchyTree 的 IkConstraintIcon），
     * 「树里这条约束」和「视口里这个手柄」一眼能对上。
     * 原来只是一横一竖的十字，混在骨骼手柄里区分度太低。
     *
     * 目标骨被选中时准星提亮成白色：骨骼层关掉时骨骼高亮看不见，
     * 白准星就是「选中了它」的唯一视口反馈
     */
    const markerColor = selectedBones.has(constraint.targetBoneIndex) ? COLOR_CONSTRAINT_SELECTED : COLOR_CONSTRAINT
    const ring = w * 8
    const nubIn = ring + w * 0.7
    const nubOut = ring + w * 4.2
    g.poly(circlePolygon(targetX, targetY, ring))
    g.moveTo(targetX, targetY - nubOut).lineTo(targetX, targetY - nubIn)
    g.moveTo(targetX, targetY + nubIn).lineTo(targetX, targetY + nubOut)
    g.moveTo(targetX - nubOut, targetY).lineTo(targetX - nubIn, targetY)
    g.moveTo(targetX + nubIn, targetY).lineTo(targetX + nubOut, targetY)
    g.moveTo(targetX, targetY).lineTo(targetX + ring * 0.82, targetY)
    g.stroke({ width: w * 2.4, color: markerColor, alpha: 0.95, cap: 'round', join: 'round' })
    // 内环：细一圈、淡一点
    g.poly(circlePolygon(targetX, targetY, ring * 0.58))
    g.stroke({ width: w * 1.1, color: markerColor, alpha: 0.45 })
  }
}

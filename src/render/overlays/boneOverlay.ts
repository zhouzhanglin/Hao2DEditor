import { Graphics } from 'pixi.js'
import type { Skeleton } from '@core/model/skeleton'
import type { Constraint } from '@core/model/constraints'
import { BONE_ORIGIN_RADIUS, attachmentGizmoFrame, gizmoGeometry } from '@render/picking'
import type { GizmoGeometry } from '@render/picking'
import { circlePolygon } from './shapes'

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
// 骨骼的**填充与关节圈**始终用自己的颜色（见 drawBoneOverlay 里的 strength），
// 这样「列表里哪一行」和「视口里哪根」永远同色；只有**选中时的描边**换成黑色，用来强调。
const COLOR_BONE = 0xe0a45c
const COLOR_JOINT = 0xffd60a
const COLOR_ROOT = 0xbf5af2
/** 选中骨骼的描边色（黑色硬描边，跟骨骼自己的颜色形成对比） */
const COLOR_SELECTED = 0x000000
const COLOR_CONSTRAINT = 0x40c8e0
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
    // 自己画多边形：Pixi 的 circle 会按世界半径退化成多边形（放大后尤其明显）
    stroke.poly(circlePolygon(ox, oy, r)).stroke({ width: w * 2.4, color: centerColor, alpha: 0.85 })
    // 四个刻度，强调「这是一个旋转环」
    for (const angle of [0, Math.PI / 2, Math.PI, (Math.PI * 3) / 2]) {
      const cx = ox + Math.cos(angle) * r
      const cy = oy + Math.sin(angle) * r
      stroke
        .moveTo(ox + Math.cos(angle) * (r - w * 4), oy + Math.sin(angle) * (r - w * 4))
        .lineTo(ox + Math.cos(angle) * (r + w * 4), oy + Math.sin(angle) * (r + w * 4))
        .stroke({ width: w * 1.4, color: centerColor, alpha: 0.7 })
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
 * 洋葱皮：用**另一时刻**的世界矩阵画一套暗色骨骼作为参考。
 * 只画骨骼线段（不重渲染网格），足以判断前后帧的姿态差异，开销可以忽略。
 */
export function drawGhostBones(
  g: Graphics,
  boneCount: number,
  parentIndices: readonly number[],
  matrices: Float32Array,
  unitsPerPixel: number,
  alpha: number
): void {
  for (let i = 0; i < boneCount; i++) {
    const offset = i * 16
    const x = matrices[offset + 12]
    const y = matrices[offset + 13]
    const parent = parentIndices[i]
    const px = parent >= 0 ? matrices[parent * 16 + 12] : x
    const py = parent >= 0 ? matrices[parent * 16 + 13] : y
    g.moveTo(px, py).lineTo(x, y)
  }
  g.stroke({ width: unitsPerPixel * 1.6, color: 0x8B5CF6, alpha })
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
    const isRoot = skeleton.asset.bones[i].parentIndex < 0
    /*
     * 强调 = **只改透明度与线宽，不改颜色**：骨骼永远用自己的颜色
     *（绑定了权重的骨骼用「权重骨骼列表」里的色，其余用默认橙），选中就压实到不透明。
     * 以前选中 / 悬停会把整根换成蓝 / 青，颜色一换就看不出「这根是列表里的哪个颜色」。
     */
    const strength = isSelected ? 2 : isHovered ? 1 : 0
    const weightColor = options.weightBoneColors?.get(i)
    const isWeight = weightColor !== undefined
    const color = weightColor ?? COLOR_BONE

    const dx = skeleton.world[o] * length
    const dy = skeleton.world[o + 1] * length
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
      // 选中接近实心（0.9）、悬停次之（0.6）、普通 0.4 —— 三个档位只看透明度就知道谁被选中
      if (!hollow) fills.poly(quad).fill({ color, alpha: strength === 2 ? 0.9 : strength === 1 ? 0.6 : 0.4 })
      /*
       * 选中：描边换成**黑色并加粗**（2.6 倍像素宽），本体颜色留在填充里。
       *
       * 原来选中只是「加粗一点点 + 透明度压实」，在浅色素材 / 一堆骨骼挨在一起时几乎看不出来；
       * 黑描边跟骨骼自己的颜色（橙 / 权重色）形成硬对比，多选时也能一眼数清选了几根。
       */
      strokes.poly(quad).stroke({
        width: w * (isSelected ? 2.6 : isWeight ? 1.5 : 1.2),
        color: isSelected ? COLOR_SELECTED : color,
        alpha: hollow || strength > 0 ? 1 : 0.9
      })

    }

    // 原点（骨骼头）画一个圈：空心环，颜色不变（根骨骼紫 / 绑定骨骼用列表色 / 其余黄），
    // 选中只是画得更粗、更实。半径与拾取用的 BONE_ORIGIN_RADIUS 一致（拖这个圈 = 移动骨骼）
    const r = (isSelected ? BONE_ORIGIN_RADIUS + 1.5 : BONE_ORIGIN_RADIUS - 0.5) * w
    strokes
      .poly(circlePolygon(x, y, r))
      .stroke({
        width: w * (isSelected ? 2.0 : 1.8),
        color: isRoot ? COLOR_ROOT : (weightColor ?? COLOR_JOINT),
        alpha: isRoot || strength > 0 ? 1 : 0.9
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

  if (options.showConstraints) drawConstraintLinks(g, skeleton, constraints, w)
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

function drawConstraintLinks(
  g: Graphics,
  skeleton: Skeleton,
  constraints: readonly Constraint[],
  w: number
): void {
  for (const constraint of constraints) {
    if (!constraint.enabled || constraint.type === 'physics') continue
    if (constraint.targetBoneIndex < 0) continue
    const targetX = skeleton.boneWorldX(constraint.targetBoneIndex)
    const targetY = skeleton.boneWorldY(constraint.targetBoneIndex)

    for (const bone of constraint.boneIndices) {
      if (bone < 0 || bone >= skeleton.boneCount) continue
      const x = skeleton.boneWorldX(bone)
      const y = skeleton.boneWorldY(bone)
      g.moveTo(x, y).lineTo(targetX, targetY)
      g.stroke({ width: w * 1.2, color: COLOR_CONSTRAINT, alpha: 0.7 })
    }

    const size = w * 5
    g.moveTo(targetX - size, targetY).lineTo(targetX + size, targetY)
    g.moveTo(targetX, targetY - size).lineTo(targetX, targetY + size)
    g.stroke({ width: w * 1.2, color: COLOR_CONSTRAINT, alpha: 0.85 })
  }
}

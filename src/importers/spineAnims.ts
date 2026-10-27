import { Easing, emptyBoneAnim, emptyConstraintAnim, emptyDeformAnim, emptyIkAnim, emptySlotAnim } from '@core/model/animation'
import { t } from '@i18n'
import type {
  AnimData,
  BoneAnim,
  ConstraintAnim,
  DeformAnim,
  DeformKeyframe,
  DrawOrderKeyframe,
  EventKeyframe,
  IkAnim,
  SlotAnim
} from '@core/model/animation'
import type { BoneData } from '@core/model/types'
import type { Constraint } from '@core/model/constraints'
import type { AtlasRegion, PageSizes } from './uv'
import { parseHexColor, pxToUnit } from './uv'
import type { SpineAnimationJson } from './spineTypes'

/** 网格附件的绑定顶点（deform 换算与长度对齐用）：key = `slot\u0000attachment` */
export interface SpineDeformBase {
  /** 绑定顶点（世界单位，每顶点 x,y）；加权网格为等长的零占位 */
  vertices: Float32Array
  weighted: boolean
}

export interface SpineAnimContext {
  boneIndex: Map<string, number>
  slotIndex: Map<string, number>
  /** 新序骨骼（动画增量需要叠加 setup 值） */
  bones: readonly BoneData[]
  constraints: readonly Constraint[]
  /** 每个插槽的「附件名 → 默认皮肤下的下标」 */
  attIndexBySlot: Map<string, Map<string, number>>
  regions: Map<string, AtlasRegion>
  pageSizes: PageSizes
  /** 网格顶点基线：key = `slot\u0000attachment` */
  deformBase: ReadonlyMap<string, SpineDeformBase>
  /**
   * 贝塞尔 `curve` 的坐标系：`true` = 绝对值（spine ≥ 4.2 的「(时间, 值) 控制点」），
   * `false` = 归一化 0..1 控制点（≤ 4.1），`null` = 版本未知（回退数值启发式）。
   */
  absoluteCurve: boolean | null
  /** 工程帧率：附件切换要按帧对齐（骨骼轨道是 30fps 烘焙量化的，见附件轨道的处理） */
  fps: number
  warnings: string[]
}

/**
 * Spine 动画 → AnimData。
 *
 * 关键点（与参考库一致）：
 * - 骨骼轨道的 rotate/translate/scale 是**相对 setup 的增量**，这里叠加成绝对值后写入
 * - `attachment` 轨道固定 Stepped，同时产出附件名（换皮肤后按名解析才正确）
 * - `deform` 的层级既可能是 3.x 的「插槽层」，也可能是 4.x 的「皮肤层」
 * - easing：curve 数组 ≥4 → Bezier；数字 → Bezier[c,0,1,1]；"stepped" → Stepped；其余 Linear
 */
export function importSpineAnimations(
  name: string,
  animation: SpineAnimationJson,
  ctx: SpineAnimContext
): AnimData {
  const bones: BoneAnim[] = []
  const slots: SlotAnim[] = []
  const deforms: DeformAnim[] = []
  const drawOrder: DrawOrderKeyframe[] = []
  const events: EventKeyframe[] = []
  const iks: IkAnim[] = []
  const constraintTracks: ConstraintAnim[] = []
  let duration = 0

  for (const [boneName, timeline] of Object.entries(animation.bones ?? {})) {
    const index = ctx.boneIndex.get(boneName)
    if (index === undefined) {
      ctx.warnings.push(t('动画「{0}」的骨骼轨道「{1}」不存在，已忽略', [name, boneName]))
      continue
    }
    const bone = ctx.bones[index]
    if (!bone) continue
    const track: BoneAnim = emptyBoneAnim(index)

    // 旋转：Spine 的帧值是「相对 setup 的增量」，与 setup 同向（顺时针为正）→ 相加。
    // 字段名按版本兼容：3.x/4.1 是 `angle`，**4.2 起统一改成 `value`** ——
    // 只读一个的话，另一代的资源旋转会被全部读成 0。
    const rotateKeys = timeline.rotate ?? []
    for (let i = 0; i < rotateKeys.length; i++) {
      const key = rotateKeys[i]
      const next = rotateKeys[i + 1]
      const raw = numberOr(key.angle ?? key.value, 0)
      const nraw = next ? numberOr(next.angle ?? next.value, 0) : raw
      // 缓动的归一化必须用**曲线所在的原始值空间**（角度 / 像素 / 倍数），
      // 不能换成叠加过 setup、除过 PPU 的最终值 —— 控制点是同一空间的绝对坐标
      const e = curveOfChannel(key.curve, 0, timeOf(key), next ? timeOf(next) : timeOf(key), raw, nraw, ctx.absoluteCurve)
      track.rotate.push({ time: timeOf(key), value: bone.rotation + raw, ...e })
      duration = Math.max(duration, timeOf(key))
    }
    // 位移：增量叠加到 setup 位置
    const trKeys = timeline.translate ?? []
    for (let i = 0; i < trKeys.length; i++) {
      const key = trKeys[i]
      const next = trKeys[i + 1]
      const rawX = numberOr(key.x, 0)
      const nrawX = next ? numberOr(next.x, 0) : rawX
      // 多通道 curve 里 x / y 各占一组，而模型每帧只存一个 easing —— 用 x 通道（编辑器默认两通道一致）
      const e = curveOfChannel(key.curve, 0, timeOf(key), next ? timeOf(next) : timeOf(key), rawX, nrawX, ctx.absoluteCurve)
      track.translate.push({
        time: timeOf(key),
        value: {
          x: bone.localPosition.x + pxToUnit(rawX),
          y: bone.localPosition.y + pxToUnit(numberOr(key.y, 0))
        },
        ...e
      })
      duration = Math.max(duration, timeOf(key))
    }
    // 缩放：倍数叠加到 setup 缩放
    const scKeys = timeline.scale ?? []
    for (let i = 0; i < scKeys.length; i++) {
      const key = scKeys[i]
      const next = scKeys[i + 1]
      const rawX = numberOr(key.x, 1)
      const nrawX = next ? numberOr(next.x, 1) : rawX
      const e = curveOfChannel(key.curve, 0, timeOf(key), next ? timeOf(next) : timeOf(key), rawX, nrawX, ctx.absoluteCurve)
      track.scale.push({
        time: timeOf(key),
        value: { x: bone.localScale.x * rawX, y: bone.localScale.y * numberOr(key.y, 1) },
        ...e
      })
      duration = Math.max(duration, timeOf(key))
    }
    const shKeys = timeline.shear ?? []
    for (let i = 0; i < shKeys.length; i++) {
      const key = shKeys[i]
      const next = shKeys[i + 1]
      const rawX = numberOr(key.x, 0)
      const nrawX = next ? numberOr(next.x, 0) : rawX
      const e = curveOfChannel(key.curve, 0, timeOf(key), next ? timeOf(next) : timeOf(key), rawX, nrawX, ctx.absoluteCurve)
      // 与参考库一致：shear 帧**原样保留**（不叠加 setup）
      // —— 参考的注释明确写着「setup 里没有 shear，且运行期不采样它，原样保留」
      track.shear.push({
        time: timeOf(key),
        value: { x: rawX, y: numberOr(key.y, 0) },
        ...e
      })
      duration = Math.max(duration, timeOf(key))
    }

    if (
      track.rotate.length > 0 ||
      track.translate.length > 0 ||
      track.scale.length > 0 ||
      track.shear.length > 0
    ) {
      bones.push(track)
    }
  }

  for (const [slotName, timeline] of Object.entries(animation.slots ?? {})) {
    const slotIndex = ctx.slotIndex.get(slotName)
    if (slotIndex === undefined) {
      ctx.warnings.push(t('动画「{0}」的插槽轨道「{1}」不存在，已忽略', [name, slotName]))
      continue
    }
    const track: SlotAnim = emptySlotAnim(slotIndex)
    const attIndex = ctx.attIndexBySlot.get(slotName)

    // 槽位颜色通道：3.x 是 `color`，4.x 改名成 `rgba`
    for (const key of timeline.rgba ?? timeline.color ?? []) {
      track.color.push({
        time: timeOf(key),
        value: parseHexColor(typeof key.color === 'string' ? key.color : undefined),
        easing: Easing.Linear,
        curve: null
      })
      duration = Math.max(duration, timeOf(key))
    }

    for (const key of timeline.attachment ?? []) {
      const attachment = typeof key.name === 'string' ? key.name : ''
      const index = attachment ? (attIndex?.get(attachment) ?? -1) : -1
      const time = attachmentKeyTime(timeOf(key), ctx.fps)
      track.displayIndex.push({ time, value: index, easing: Easing.Stepped, curve: null })
      track.displayAttachment.push(attachment)
      duration = Math.max(duration, time)
    }

    if (track.color.length > 0 || track.displayIndex.length > 0) slots.push(track)
  }

  collectDeforms(animation, ctx, deforms, (time) => {
    duration = Math.max(duration, time)
  })

  for (const key of animation.drawOrder ?? []) {
    const offsets = Array.isArray(key.offsets) ? (key.offsets as Array<Record<string, unknown>>) : []
    drawOrder.push({ time: timeOf(key), order: expandDrawOrder(offsets, ctx.slotIndex) })
    duration = Math.max(duration, timeOf(key))
  }

  for (const key of animation.events ?? []) {
    events.push({
      time: timeOf(key),
      name: typeof key.name === 'string' ? key.name : '',
      stringParam: typeof key.string === 'string' ? key.string : '',
      intParam: Math.round(numberOr(key.int, 0)),
      floatParam: numberOr(key.float, 0)
    })
    duration = Math.max(duration, timeOf(key))
  }

  // ik 轨道（参考库风格，ikIndex 指向 IK 约束列表）
  const ikConstraintIndices = ctx.constraints
    .map((constraint, i) => ({ constraint, i }))
    .filter((entry) => entry.constraint.type === 'ik')
    .map((entry) => entry.i)

  for (const [ikName, keys] of Object.entries(animation.ik ?? {})) {
    const constraintIndex = ctx.constraints.findIndex((c) => c.name === ikName && c.type === 'ik')
    if (constraintIndex < 0) {
      ctx.warnings.push(t('动画「{0}」的 IK 轨道「{1}」不存在，已忽略', [name, ikName]))
      continue
    }
    const ikOrder = ikConstraintIndices.indexOf(constraintIndex)
    const track = emptyIkAnim(ikOrder)
    for (const key of keys) {
      track.mix.push({
        time: timeOf(key),
        value: numberOr(key.mix, 1),
        easing: Easing.Linear,
        curve: null
      })
      duration = Math.max(duration, timeOf(key))
    }
    iks.push(track)

    // 同时产出编辑器的完整约束轨道（mix）
    const full = emptyConstraintAnim(constraintIndex)
    full.mix = track.mix
    constraintTracks.push(full)
  }

  for (const [constraintName, keys] of Object.entries(animation.transform ?? {})) {
    const index = ctx.constraints.findIndex((c) => c.name === constraintName && c.type === 'transform')
    if (index < 0) continue
    const track = emptyConstraintAnim(index)
    for (const key of keys) {
      track.mixRotate.push(floatKey(key, 'mixRotate', 1))
      track.mixX.push(floatKey(key, 'mixX', 1))
      track.mixY.push(floatKey(key, 'mixY', 1))
      track.mixScaleX.push(floatKey(key, 'mixScaleX', 1))
      track.mixScaleY.push(floatKey(key, 'mixScaleY', 1))
      track.mixShearY.push(floatKey(key, 'mixShearY', 1))
      track.offsetRotate.push(floatKey(key, 'rotate', 0))
      track.offsetX.push(floatKey(key, 'x', 0, true))
      track.offsetY.push(floatKey(key, 'y', 0, true))
      duration = Math.max(duration, timeOf(key))
    }
    constraintTracks.push(track)
  }

  for (const [constraintName, keys] of Object.entries(animation.path ?? {})) {
    const index = ctx.constraints.findIndex((c) => c.name === constraintName && c.type === 'path')
    if (index < 0) continue
    const track = emptyConstraintAnim(index)
    for (const key of keys) {
      track.position.push(floatKey(key, 'position', 0))
      track.spacing.push(floatKey(key, 'spacing', 0))
      track.rotateMix.push(floatKey(key, 'rotateMix', 1))
      track.translateMix.push(floatKey(key, 'translateMix', 1))
      duration = Math.max(duration, timeOf(key))
    }
    constraintTracks.push(track)
  }

  return {
    name,
    duration: duration > 0 ? duration : 1,
    bones,
    slots,
    deforms,
    drawOrder,
    events,
    iks,
    constraints: constraintTracks
  }
}

function floatKey(
  key: Record<string, unknown>,
  field: string,
  fallback: number,
  scaled = false
): { time: number; value: number; easing: Easing; curve: number[] | null } {
  const raw = numberOr(key[field], fallback)
  return {
    time: timeOf(key),
    value: scaled ? pxToUnit(raw) : raw,
    easing: Easing.Linear,
    curve: null
  }
}

/**
 * deform 层级判定：第一层键能在插槽表找到 → 3.x 插槽层；否则是 4.x 皮肤层（只取第一个皮肤）。
 * 4.2 起官方把 deform 挪进了 `attachments.<skin>.<slot>.<attachment>.deform`，
 * 由 `collectAttachmentDeforms` 单独处理。
 */
function collectDeforms(
  animation: SpineAnimationJson,
  ctx: SpineAnimContext,
  out: DeformAnim[],
  onTime: (time: number) => void
): void {
  const deform = animation.deform
  collectAttachmentDeforms(animation, ctx, out, onTime)
  if (!deform) return

  const keys = Object.keys(deform)
  if (keys.length === 0) return
  const isSlotLayer = ctx.slotIndex.has(keys[0])
  const layer = (
    isSlotLayer ? deform : (deform[keys[0]] ?? {})
  ) as unknown as Record<string, Record<string, Array<Record<string, unknown>>>>

  for (const [slotName, attachments] of Object.entries(layer)) {
    for (const [attachmentName, frames] of Object.entries(attachments)) {
      if (!Array.isArray(frames)) continue
      pushDeformTrack(slotName, attachmentName, frames as Array<Record<string, unknown>>, ctx, out, onTime)
    }
  }
}

/** 4.2+：`attachments.<skin>.<slot>.<attachment>.deform`（官方 4.3 运行库唯一认的位置） */
function collectAttachmentDeforms(
  animation: SpineAnimationJson,
  ctx: SpineAnimContext,
  out: DeformAnim[],
  onTime: (time: number) => void
): void {
  const skins = animation.attachments
  if (!skins) return
  for (const slots of Object.values(skins)) {
    if (!slots || typeof slots !== 'object') continue
    for (const [slotName, attachments] of Object.entries(slots)) {
      if (!attachments || typeof attachments !== 'object') continue
      for (const [attachmentName, timeline] of Object.entries(attachments)) {
        const frames = (timeline as { deform?: unknown } | null)?.deform
        if (!Array.isArray(frames)) continue
        pushDeformTrack(slotName, attachmentName, frames as Array<Record<string, unknown>>, ctx, out, onTime)
      }
    }
  }
}

function pushDeformTrack(
  slotName: string,
  attachmentName: string,
  frames: Array<Record<string, unknown>>,
  ctx: SpineAnimContext,
  out: DeformAnim[],
  onTime: (time: number) => void
): void {
  const slotIndex = ctx.slotIndex.get(slotName)
  if (slotIndex === undefined) return
  const track = emptyDeformAnim(slotIndex, attachmentName)
  const base = ctx.deformBase.get(`${slotName}\u0000${attachmentName}`)
  // 数组长度对齐到附件绑定顶点数（参考库用 `deformLength = 附件顶点数 × 2`）
  let need = base ? base.vertices.length : 0
  for (const frame of frames) {
    const offset = numberOr(frame.offset, 0)
    const vertices = Array.isArray(frame.vertices) ? (frame.vertices as number[]) : []
    need = Math.max(need, Math.round(offset) + vertices.length)
    onTime(numberOr(frame.time, 0))
  }
  for (const frame of frames) {
    const offset = Math.max(0, Math.round(numberOr(frame.offset, 0)))
    const vertices = Array.isArray(frame.vertices) ? (frame.vertices as number[]) : []
    const offsets = new Array<number>(need).fill(0)
    for (let i = 0; i < vertices.length; i++) {
      const at = offset + i
      // Spine 的 deform 帧 `vertices` **本身就是「相对绑定顶点的偏移」**：
      // 官方 SkeletonJson 读取时是 `deform[i] = 该偏移[i] + 绑定顶点[i]`（非加权网格）
      // 才凑出绝对坐标。我们运行期同样是「绑定顶点 + 偏移」（见 meshBuilder），
      // 所以这里**原样使用**。
      //
      // 早先误以为 json 存的是绝对坐标、又减了一次绑定顶点 → 偏移变成
      // 「偏移 − 绑定坐标」，FFD 彻底错乱（表现：deform 作用的部件变形诡异，
      // 看起来像缩放/斜切出问题 —— 如 spineunitygirl 的手指与脚）。
      offsets[at] = pxToUnit(vertices[i])
    }
    const key: DeformKeyframe = {
      time: numberOr(frame.time, 0),
      offsets,
      vertexOffset: 0,
      easing: Easing.Linear,
      curve: null
    }
    track.frames.push(key)
  }
  if (track.frames.length > 0) out.push(track)
}

type SpineCurveKeyframeMap = Record<string, Array<Record<string, unknown>>>

/**
 * drawOrder 的 offsets 展开成完整顺序：
 * 依次把插槽从原位置取出，插入到 `原下标 + offset` 处（夹取到合法范围）。
 */
function expandDrawOrder(
  offsets: Array<Record<string, unknown>>,
  slotIndex: Map<string, number>
): number[] {
  const order = [...slotIndex.values()].sort((a, b) => a - b)
  const nameOf = new Map<number, string>()
  for (const [name, index] of slotIndex) nameOf.set(index, name)

  for (const entry of offsets) {
    const slotName = typeof entry.slot === 'string' ? entry.slot : ''
    const index = slotIndex.get(slotName)
    if (index === undefined) continue
    const from = order.indexOf(index)
    if (from < 0) continue
    order.splice(from, 1)
    const offset = Math.round(numberOr(entry.offset, 0))
    const target = Math.max(0, Math.min(order.length, from + offset))
    order.splice(target, 0, index)
  }
  void nameOf
  return order
}

/**
 * 帧缓动：把 Spine 的 `curve` 归一化成 0..1 的 cubic-bezier 控制点。
 *
 * 每通道 4 个数，多通道轨道（translate / scale / shear）按 x / y 依次排列成 8 个数
 * （见官方 `ReadCurve`：`const i = value << 2`，再按通道逐个 `setBezier`）。
 *
 * 两个时代的坐标系不同，**只能靠版本区分**（`SpineAnimContext.absoluteCurve`）：
 * - ≤ 4.1：`[cx1, cy1, cx2, cy2]` 是**归一化 0..1 控制点**，可直接交给求值器；
 * - ≥ 4.2：是 **(时间, 值) 空间的绝对坐标**，必须按「本帧 → 下一帧」的区间归一化。
 *   贝塞尔对仿射变换不变，所以归一化后的形状与官方完全等价。
 *
 * 数值启发式（四个分量是否都落在宽松的过冲窗口内）**仍会误判**：scale 通道的值本来就在 1 附近，
 * 绝对控制点很容易整组落进 [0,1]（正例见 spineboy-pro 的 `idle-turn/front-fist.scale`）。
 * 所以只在版本缺失（`null`）时才回退到它。
 *
 * `channel` 选第几组（0 = x / rotate，1 = y）。`curve` 为 `"stepped"` 时阶跃，
 * 缺省 / 非数组为线性。
 */
function curveOfChannel(
  curve: unknown,
  channel: number,
  time1: number,
  time2: number,
  value1: number,
  value2: number,
  absolute: boolean | null
): { easing: Easing; curve: number[] | null } {
  if (curve === 'stepped') return { easing: Easing.Stepped, curve: null }
  if (!Array.isArray(curve)) return { easing: Easing.Linear, curve: null }
  const base = channel * 4
  if (curve.length < base + 4) {
    // 单通道轨道只给 4 个数：第二通道复用第一组
    if (channel > 0 && curve.length >= 4) return curveOfChannel(curve, 0, time1, time2, value1, value2, absolute)
    return { easing: Easing.Linear, curve: null }
  }
  const c1t = numberOr(curve[base], 0)
  const c1v = numberOr(curve[base + 1], 0)
  const c2t = numberOr(curve[base + 2], 0)
  const c2v = numberOr(curve[base + 3], 0)
  const dt = time2 - time1
  if (Math.abs(dt) < 1e-9) return { easing: Easing.Linear, curve: null }

  /*
   * 「像不像归一化控制点」：`cx` 是两帧之间的时间百分比，`cy` 是两帧取值差的百分比 —— 官方允许
   * **过冲 / 回弹**（3.3 的 Dragon 实测 1.06 / 1.33 / 1.43）。这里必须给过冲留余量，
   * 别用 [0,1] 硬卡：卡死后这些曲线会被误判成绝对坐标，缓动被压成「几乎不动 → 末尾突跳」。
   * 出现 10 / 20 这类通道单位的值时才判定为绝对坐标。
   */
  const inRange = (value: number): boolean => value >= -1 && value <= 2
  const looksNormalized = inRange(c1t) && inRange(c1v) && inRange(c2t) && inRange(c2v)
  // 版本明确时以版本为准；歧义（版本缺失）时才看数值
  const treatAsNormalized = absolute === true ? false : absolute === false ? true : looksNormalized
  if (treatAsNormalized && looksNormalized) {
    return { easing: Easing.Bezier, curve: [c1t, c1v, c2t, c2v] }
  }
  const dv = value2 - value1
  const flat = Math.abs(dv) < 1e-9
  return {
    easing: Easing.Bezier,
    curve: [(c1t - time1) / dt, flat ? 0 : (c1v - value1) / dv, (c2t - time1) / dt, flat ? 1 : (c2v - value1) / dv]
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * 关键帧时间（秒）。Spine 的**第一帧通常省略 `time` 字段**（等价于 0，见参考库
 * `GetFloat(keyMap, "time", 0)`），直接读会得到 undefined —— 时间轴上第一帧就
 * 不在 0 处（排序/插值也跟着错）。
 */
function timeOf(key: { time?: number }): number {
  return numberOr(key.time, 0)
}

/**
 * 附件（`displayIndex`）关键帧的时间换算：**float32 落位 + 对齐到帧**。
 *
 * ① float32：官方运行库把关键帧时间存进 `Float32Array`，`"time": 1.1` 实际是
 *    `1.1000000238`；判定是 `time < frames[0]`，所以「正好停在第 33 帧」
 *    （`33/30 = 1.1`，双精度）时官方认为这个键还没到。
 * ② 对齐到帧：骨骼轨道是 30fps 烘焙的 —— 关键帧只在「帧时间 ≥ 关键帧时间」的那一帧生效。
 *    附件切换必须落在**同一帧**，否则会在一帧之内先行切换：连续播放、或关掉
 *    「关键帧吸附到帧」慢慢拖时间轴时，能明显看到 flare 贴图先在旧位置闪一下，
 *    下一帧才跟骨骼一起飞出去（portal 第 33→34 帧）。
 *
 * 容差 1e-9 帧：只吃掉 `0.2 * 30 = 6.000000000000001` 这类倍精度噪声，
 * **必须远小于** float32 造成的帧内偏移（最小约 1e-7 帧），否则会把
 * 本该落到下一帧的切换又拉回本帧。
 */
function attachmentKeyTime(time: number, fps: number): number {
  if (!(fps > 0)) return Math.fround(time)
  return Math.ceil(Math.fround(time) * fps - 1e-9) / fps
}

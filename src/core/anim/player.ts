import { clamp01, lerpAngle } from '../math/utils'
import { lastKeyframeTime } from '../model/animation'
import type { AnimData, ConstraintAnim, EventKeyframe, FloatKeyframe, SlotAnim } from '../model/animation'
import { curvePercent, sampleAngle, sampleColor, sampleDeformIndex, sampleDrawOrderIndex, sampleInt, sampleNumber, sampleVec2 } from './interpolation'
import { findAttachmentIndex } from '../model/asset'
import type { RuntimeAsset } from '../model/asset'
import type { Skeleton } from '../model/skeleton'
import type { Constraint } from '../model/constraints'
import { createConstraintStates, resetConstraintStates, solveConstraints } from '../constraints/solver'
import type { ConstraintState } from '../constraints/solver'

/** 采样目标缓冲（A/B 两份用于交叉淡化） */
export interface PoseBuffer {
  pos: Float32Array
  rot: Float32Array
  scale: Float32Array
  shear: Float32Array
  color: Float32Array
  displayIndex: Int32Array
  visible: Uint8Array
  drawOrder: Int32Array
}

function createPoseBuffer(asset: RuntimeAsset): PoseBuffer {
  const b = asset.bones.length
  const s = asset.slots.length
  return {
    pos: new Float32Array(b * 2),
    rot: new Float32Array(b),
    scale: new Float32Array(b * 2),
    shear: new Float32Array(b * 2),
    color: new Float32Array(s * 4),
    displayIndex: new Int32Array(s),
    visible: new Uint8Array(s),
    drawOrder: new Int32Array(s)
  }
}

/**
 * 时间线采样 / 交叉淡化 / 事件（纯数据，与参考库 AnimationPlayer 行为一致）。
 *
 * 采样顺序：骨骼变换 → 插槽（颜色 / 显示下标 / 可见性）→ 绘制顺序 → FFD →
 * 事件 → FK → 约束求解。CrossFade 为两条动画的绝对 pose 线性混合，
 * 离散量按 k < 0.5 硬切，FFD 不参与混合。
 */
export class AnimationPlayer {
  readonly asset: RuntimeAsset
  readonly skeleton: Skeleton
  readonly constraints: Constraint[]
  /** 与 asset.constraints 一一对齐的可变状态 */
  private readonly states: ConstraintState[]
  /** 实际参与求解的约束（`runtimeIK` 为假 = 动画已烘焙，运行期一个约束都不能再解） */
  private readonly activeConstraints: Constraint[]
  private readonly activeStates: ConstraintState[]
  /** asset.constraints 里 IK 约束的下标（供参考库风格的 iks 轨道使用） */
  private readonly ikIndices: number[]

  private readonly bufA: PoseBuffer
  private readonly bufB: PoseBuffer
  private readonly deformBuffers = new Map<string, number[]>()
  /** 每个动画对象算好的播放长度（见 durationOf），asset 不可变所以按对象缓存安全 */
  private readonly durationCache = new WeakMap<AnimData, number>()

  private cur: AnimData | null = null
  private prev: AnimData | null = null
  private timeValue = 0
  /**
   * **不随循环回卷**的绝对时间（秒）：`time` 在 loop 时会回到 0，这个不会。
   *
   * 嵌套骨架的循环播放需要它：子骨架的循环周期往往和父动画不同（父 4 秒、子 1 秒），
   * 用 `time` 算子时间的话，父动画每次 loop 都会把子骨架拉回 0 帧 ——
   * 看起来就像「子骨架根本没在循环，只是跟着父动画重头播」。
   */
  private elapsedValue = 0
  private lastTime = 0
  private fadeDuration = 0
  private fadeElapsed = 0
  private fading = false
  private loopFlag = true
  private pausedFlag = false

  completed = false
  onEvent: ((event: EventKeyframe) => void) | null = null
  onComplete: ((name: string) => void) | null = null

  constructor(asset: RuntimeAsset, skeleton: Skeleton) {
    this.asset = asset
    this.skeleton = skeleton
    this.constraints = asset.constraints
    this.states = createConstraintStates(this.constraints)
    this.bufA = createPoseBuffer(asset)
    this.bufB = createPoseBuffer(asset)

    this.ikIndices = []
    this.activeConstraints = []
    this.activeStates = []
    for (let i = 0; i < this.constraints.length; i++) {
      const constraint = this.constraints[i]
      if (constraint.type === 'ik') this.ikIndices.push(i)
      /*
       * `runtimeIK === false` 的含义是「变形结果已经烘焙进骨骼轨道」（导入的 Spine 资源），
       * 那么**所有**约束都不能再解：轨道里的局部值本身就是约束解出来的，
       * 再解一遍等于翻倍。之前只跳过 IK，所以变换约束一旦导入（如 mix-and-match 的
       * `hair-side-front-control`、`head-control`）就会把头发 / 帽子 / 裙子推飞。
       */
      if (!asset.runtimeIK) continue
      this.activeConstraints.push(constraint)
      this.activeStates.push(this.states[i])
    }
  }

  // ---------------- 播放控制 ----------------

  play(name: string, loop = true): boolean {
    const index = this.indexOf(name)
    if (index < 0) return false
    this.cur = this.asset.animations[index]
    this.prev = null
    this.fading = false
    this.fadeDuration = 0
    this.fadeElapsed = 0
    this.loopFlag = loop
    this.pausedFlag = false
    this.completed = false
    this.timeValue = 0
    this.elapsedValue = 0
    this.lastTime = 0
    this.step(0)
    return true
  }

  /** 与当前动画交叉淡化；duration 为淡入时长（秒） */
  crossFade(name: string, duration: number, loop?: boolean): boolean {
    const index = this.indexOf(name)
    if (index < 0) return false
    const next = this.asset.animations[index]
    if (!this.cur || duration <= 0) return this.play(name, loop ?? this.loopFlag)

    this.prev = this.cur
    this.cur = next
    this.fadeDuration = duration
    this.fadeElapsed = 0
    this.fading = true
    if (loop !== undefined) this.loopFlag = loop
    this.pausedFlag = false
    this.completed = false
    this.timeValue = 0
    this.elapsedValue = 0
    this.lastTime = 0
    this.step(0)
    return true
  }

  stop(): void {
    this.cur = null
    this.prev = null
    this.fading = false
    this.pausedFlag = false
    this.completed = false
    this.timeValue = 0
    this.elapsedValue = 0
    this.lastTime = 0
    this.skeleton.setToSetupPose()
    this.solveCurrentConstraints(null, 0)
  }

  seek(seconds: number): void {
    const anim = this.cur
    // 绝对时钟跟手：拖播放头时子骨架按当前父时间确定性地定位（不是累加，不会漂移）
    this.elapsedValue = seconds
    if (!anim) {
      this.timeValue = 0
      this.lastTime = 0
      return
    }
    const dur = this.durationOf(anim)
    let next = seconds
    if (this.loopFlag) {
      // 正好落在时长上时停在末尾，不取模成 0：否则「时间轴在末尾、画面却是开头」，
      // 此时拖动骨骼写下的关键帧会落在画面之外，看起来像「拖不动」
      next = Math.abs(seconds - dur) < 1e-6 ? dur : ((next % dur) + dur) % dur
    } else next = Math.max(0, Math.min(dur, next))
    this.timeValue = next
    this.lastTime = next
    this.fading = false
    this.prev = null
    this.completed = !this.loopFlag && next >= dur
    this.step(0)
  }

  /** 定格到某动画的指定进度并暂停 */
  setToPose(name: string, normalizedTime: number): boolean {
    const index = this.indexOf(name)
    if (index < 0) return false
    this.cur = this.asset.animations[index]
    this.prev = null
    this.fading = false
    this.completed = false
    this.pausedFlag = true
    this.seek(clamp01(normalizedTime) * this.durationOf(this.cur))
    return true
  }

  update(dt: number): void {
    if (this.pausedFlag) return
    this.step(dt)
  }

  /** 立即按当前状态重建一帧（编辑器改数据后调用） */
  refresh(): void {
    this.step(0)
  }

  // ---------------- 属性 ----------------

  get time(): number {
    return this.timeValue
  }

  /**
   * 绝对播放时间（秒，**不回卷**）：循环时持续累加，`seek` 时跟到目标时间。
   * 子骨架「无限次播放」用它算时钟，才不会在父动画 loop 时被拉回 0。
   */
  get elapsed(): number {
    return this.elapsedValue
  }

  /**
   * 只把绝对时钟挪到指定值（不动当前姿态）。
   *
   * 给「临时 seek 再回来」的场景用：洋葱皮会 seek 到前后帧再 seek 回来，
   * 若顺手把绝对时钟也拉回去，子骨架的循环相位每帧都会被重置一次。
   */
  restoreElapsed(seconds: number): void {
    this.elapsedValue = seconds
  }

  set time(value: number) {
    this.seek(value)
  }

  get normalizedTime(): number {
    const anim = this.cur
    if (!anim) return 0
    return clamp01(this.timeValue / this.durationOf(anim))
  }

  set normalizedTime(value: number) {
    const anim = this.cur
    this.seek(clamp01(value) * (anim ? this.durationOf(anim) : 1))
  }

  get duration(): number {
    return this.cur ? this.durationOf(this.cur) : 0
  }

  get currentAnimation(): string | null {
    return this.cur ? this.cur.name : null
  }

  get currentAnimData(): AnimData | null {
    return this.cur
  }

  get loop(): boolean {
    return this.loopFlag
  }

  set loop(value: boolean) {
    this.loopFlag = value
  }

  get paused(): boolean {
    return this.pausedFlag
  }

  set paused(value: boolean) {
    this.pausedFlag = value
  }

  get isPlaying(): boolean {
    return this.cur !== null && !this.pausedFlag
  }

  get isFading(): boolean {
    return this.fading
  }

  /**
   * 与 `asset.constraints` 对齐的**当前**约束状态（下标越界返回 null）。
   *
   * 给编辑器打关键帧用：画面上正在生效的 mix / 偏移就是这里存的值（动画轨道驱动过的也一样），
   * 读它打帧才是所见即所得。返回副本，调用方改不到运行期状态。
   */
  constraintStateAt(index: number): ConstraintState | null {
    const state = this.states[index]
    return state ? { ...state } : null
  }

  // ---------------- 采样核心 ----------------

  private indexOf(name: string): number {
    return this.asset.animations.findIndex((a) => a.name === name)
  }

  /**
   * 播放长度：按**最后一个关键帧**计算（秒）。
   *
   * 非循环时播到最后一帧停下；循环时到最后一帧后回到第一帧。
   * 数据里的 duration 只在「完全没有关键帧」时兜底，避免播到尾部的空白区。
   *
   * 每帧都会调用，按动画对象缓存（asset 不可变，数据变化时是重建出的新对象，
   * 旧缓存由 WeakMap 自动回收）。
   */
  private durationOf(anim: AnimData): number {
    const cached = this.durationCache.get(anim)
    if (cached !== undefined) return cached
    const last = lastKeyframeTime(anim)
    const value = last > 0 ? last : anim.duration > 0 ? anim.duration : 1
    this.durationCache.set(anim, value)
    return value
  }

  private step(dt: number): void {
    const anim = this.cur
    if (!anim) {
      this.skeleton.updateFk(0)
      this.solveCurrentConstraints(null, 0)
      return
    }

    const dur = this.durationOf(anim)
    this.timeValue += dt
    this.elapsedValue += dt
    if (this.fading && this.fadeDuration > 0) this.fadeElapsed += dt

    let reachedEnd = false
    if (this.timeValue > dur) {
      if (this.loopFlag) this.timeValue %= dur
      else {
        this.timeValue = dur
        reachedEnd = true
      }
    }
    if (!this.loopFlag && this.timeValue >= dur && this.lastTime < dur) reachedEnd = true

    if (this.fading && this.prev) {
      this.resetPose(this.bufA)
      this.setupTo(this.bufA)
      this.sampleInto(this.bufA, this.prev, this.lastTime)
      this.resetPose(this.bufB)
      this.setupTo(this.bufB)
      this.sampleInto(this.bufB, anim, this.timeValue)
      const k = this.fadeDuration > 0 ? clamp01(this.fadeElapsed / this.fadeDuration) : 1
      this.blendInto(this.bufA, this.bufB, k)
      if (k >= 1) {
        this.fading = false
        this.prev = null
      }
    } else {
      this.resetPose(this.bufB)
      this.setupTo(this.bufB)
      this.sampleInto(this.bufB, anim, this.timeValue)
      this.applyPose(this.bufB)
    }

    this.applyDeform(anim, this.timeValue)
    this.fireEvents(anim, this.lastTime, this.timeValue)
    this.lastTime = this.timeValue
    this.skeleton.applyDisplayOverrides()
    this.skeleton.updateFk(0)
    this.solveCurrentConstraints(anim, this.timeValue)

    if (reachedEnd && !this.completed) {
      this.completed = true
      this.onComplete?.(anim.name)
    }
  }

  private resetPose(buf: PoseBuffer): void {
    buf.pos.fill(0)
    buf.rot.fill(0)
    buf.scale.fill(1)
    buf.shear.fill(0)
    buf.color.fill(1)
    buf.displayIndex.fill(0)
    buf.visible.fill(1)
    for (let i = 0; i < buf.drawOrder.length; i++) buf.drawOrder[i] = i
  }

  private setupTo(buf: PoseBuffer): void {
    const bones = this.asset.bones
    for (let i = 0; i < bones.length; i++) {
      const bone = bones[i]
      buf.pos[i * 2] = bone.localPosition.x
      buf.pos[i * 2 + 1] = bone.localPosition.y
      buf.rot[i] = bone.rotation
      buf.scale[i * 2] = bone.localScale.x
      buf.scale[i * 2 + 1] = bone.localScale.y
      buf.shear[i * 2] = bone.localShear.x
      buf.shear[i * 2 + 1] = bone.localShear.y
    }
    const slots = this.asset.slots
    for (let i = 0; i < slots.length; i++) {
      const color = slots[i].color
      buf.color[i * 4] = color.r
      buf.color[i * 4 + 1] = color.g
      buf.color[i * 4 + 2] = color.b
      buf.color[i * 4 + 3] = color.a
      buf.displayIndex[i] = this.skeleton.setupDisplayIndex[i]
      buf.visible[i] = this.skeleton.setupVisibleAt(i) ? 1 : 0
    }
  }

  private sampleInto(buf: PoseBuffer, anim: AnimData, time: number): void {
    const boneCount = this.skeleton.boneCount
    for (const track of anim.bones) {
      const b = track.boneIndex
      if (b < 0 || b >= boneCount) continue
      sampleVec2(track.translate, time, buf.pos, b * 2)
      const rot = sampleAngle(track.rotate, time)
      if (rot !== null) buf.rot[b] = rot
      sampleVec2(track.scale, time, buf.scale, b * 2)
      sampleVec2(track.shear, time, buf.shear, b * 2)
    }

    const slotCount = this.skeleton.slotCount
    for (const track of anim.slots) {
      const s = track.slotIndex
      if (s < 0 || s >= slotCount) continue
      const color = { r: 0, g: 0, b: 0, a: 0 }
      if (sampleColor(track.color, time, color)) {
        buf.color[s * 4] = color.r
        buf.color[s * 4 + 1] = color.g
        buf.color[s * 4 + 2] = color.b
        buf.color[s * 4 + 3] = color.a
      }
      const display = sampleInt(track.displayIndex, time)
      if (display) buf.displayIndex[s] = this.resolveDisplay(s, track, display.value, display.index)
      const visible = sampleInt(track.visible, time)
      if (visible) buf.visible[s] = visible.value > 0 ? 1 : 0
    }

    const orderIndex = sampleDrawOrderIndex(anim.drawOrder, time)
    if (orderIndex >= 0) {
      const order = anim.drawOrder[orderIndex].order
      const count = Math.min(order.length, buf.drawOrder.length)
      for (let i = 0; i < count; i++) buf.drawOrder[i] = order[i]
      // 兜底：顺序帧不完整（老工程文件 / 手改数据）时，把没出现的槽按下标补到末尾。
      // 不补的话尾部会保留上一次的顺序，同一插槽被画两次、别的插槽整个不画。
      if (count < buf.drawOrder.length) {
        const used = new Set<number>()
        for (let i = 0; i < count; i++) used.add(buf.drawOrder[i])
        let write = count
        for (let slot = 0; slot < buf.drawOrder.length && write < buf.drawOrder.length; slot++) {
          if (!used.has(slot)) buf.drawOrder[write++] = slot
        }
      }
    }
  }

  /** 附件时间线：先用附件名在当前合并皮肤里解析，名字缺失/查不到才回退烘焙下标 */
  private resolveDisplay(slotIndex: number, track: SlotAnim, bakedIndex: number, keyIndex: number): number {
    const name = track.displayAttachment[keyIndex] ?? ''
    if (name) {
      const map = this.skeleton.slotAttIndex[slotIndex]
      // 动画里的附件轨道用裸名（`head`），而换装皮肤的附件名带前缀（`goblin/head`）
      const byName = map ? findAttachmentIndex(map, name) : undefined
      if (byName !== undefined) return byName
    }
    return bakedIndex
  }

  private applyPose(buf: PoseBuffer): void {
    const sk = this.skeleton
    sk.localPos.set(buf.pos)
    sk.localRot.set(buf.rot)
    sk.localScale.set(buf.scale)
    sk.localShear.set(buf.shear)
    for (let i = 0; i < sk.slotCount; i++) {
      sk.slotColors[i].r = buf.color[i * 4]
      sk.slotColors[i].g = buf.color[i * 4 + 1]
      sk.slotColors[i].b = buf.color[i * 4 + 2]
      sk.slotColors[i].a = buf.color[i * 4 + 3]
      sk.slotDisplayIndex[i] = buf.displayIndex[i]
      sk.slotVisible[i] = buf.visible[i]
      sk.drawOrder[i] = buf.drawOrder[i]
    }
  }

  /**
   * 交叉淡化：position / scale / color 线性插值，rotation / shear 走最短弧，
   * 离散量（显示下标 / 可见性 / 绘制顺序）按 k < 0.5 硬切。
   */
  private blendInto(a: PoseBuffer, b: PoseBuffer, k: number): void {
    const sk = this.skeleton
    for (let i = 0; i < sk.boneCount; i++) {
      sk.localPos[i * 2] = a.pos[i * 2] + (b.pos[i * 2] - a.pos[i * 2]) * k
      sk.localPos[i * 2 + 1] = a.pos[i * 2 + 1] + (b.pos[i * 2 + 1] - a.pos[i * 2 + 1]) * k
      sk.localScale[i * 2] = a.scale[i * 2] + (b.scale[i * 2] - a.scale[i * 2]) * k
      sk.localScale[i * 2 + 1] = a.scale[i * 2 + 1] + (b.scale[i * 2 + 1] - a.scale[i * 2 + 1]) * k
      sk.localRot[i] = lerpAngle(a.rot[i], b.rot[i], k)
      sk.localShear[i * 2] = lerpAngle(a.shear[i * 2], b.shear[i * 2], k)
      sk.localShear[i * 2 + 1] = lerpAngle(a.shear[i * 2 + 1], b.shear[i * 2 + 1], k)
    }
    const discrete = k < 0.5 ? a : b
    for (let i = 0; i < sk.slotCount; i++) {
      const c = sk.slotColors[i]
      c.r = a.color[i * 4] + (b.color[i * 4] - a.color[i * 4]) * k
      c.g = a.color[i * 4 + 1] + (b.color[i * 4 + 1] - a.color[i * 4 + 1]) * k
      c.b = a.color[i * 4 + 2] + (b.color[i * 4 + 2] - a.color[i * 4 + 2]) * k
      c.a = a.color[i * 4 + 3] + (b.color[i * 4 + 3] - a.color[i * 4 + 3]) * k
      sk.slotDisplayIndex[i] = discrete.displayIndex[i]
      sk.slotVisible[i] = discrete.visible[i]
      sk.drawOrder[i] = discrete.drawOrder[i]
    }
  }

  // ---------------- FFD ----------------

  private applyDeform(anim: AnimData, time: number): void {
    const sk = this.skeleton
    for (let si = 0; si < sk.slotCount; si++) {
      sk.deformOffsets[si] = null
      sk.deformOffsetBase[si] = -1
    }

    for (const track of anim.deforms) {
      const slot = track.slotIndex
      if (slot < 0 || slot >= sk.slotCount) continue
      if (track.attachmentName) {
        const map = sk.slotAttIndex[slot]
        const want = map ? map.get(track.attachmentName) : undefined
        if (want !== undefined && want !== sk.slotDisplayIndex[slot]) continue
      }

      const k = sampleDeformIndex(track.frames, time)
      if (k < 0) continue
      const a = track.frames[k]
      const need = Math.max(0, a.vertexOffset * 2 + a.offsets.length)
      if (need === 0) continue

      const key = `${slot}:${track.attachmentName}`
      const buffer = this.deformBuffer(key, need)
      for (let i = 0; i < need; i++) buffer[i] = a.offsets[i] ?? 0

      const b = track.frames[k + 1]
      if (b) {
        const span = b.time - a.time
        const t = curvePercent(a.easing, a.curve, span <= 0 ? 1 : (time - a.time) / span)
        for (let i = 0; i < need; i++) {
          const target = b.offsets[i] ?? 0
          buffer[i] += (target - buffer[i]) * t
        }
      }
      sk.deformOffsets[slot] = buffer
      sk.deformOffsetBase[slot] = a.vertexOffset
    }
  }

  /** 缓冲长度严格等于 need：多出的顶点下标越界即视为 0，不会被上一帧残留污染 */
  private deformBuffer(key: string, need: number): number[] {
    let buffer = this.deformBuffers.get(key)
    if (!buffer) {
      buffer = new Array<number>(need).fill(0)
      this.deformBuffers.set(key, buffer)
      return buffer
    }
    buffer.length = need
    for (let i = 0; i < need; i++) buffer[i] = 0
    return buffer
  }

  // ---------------- 事件 ----------------

  private fireEvents(anim: AnimData, last: number, cur: number): void {
    if (anim.events.length === 0) return
    const looped = cur < last
    for (const event of anim.events) {
      const hit = looped ? event.time > last || event.time <= cur : event.time > last && event.time <= cur
      if (hit) this.onEvent?.(event)
    }
  }

  // ---------------- 约束 ----------------

  private solveCurrentConstraints(anim: AnimData | null, time: number): void {
    if (this.activeConstraints.length === 0) return
    resetConstraintStates(this.constraints, this.states)

    if (anim) {
      for (const track of anim.constraints) {
        const state = this.states[track.constraintIndex]
        if (!state) continue
        this.applyConstraintTrack(track, time, state)
      }
      // 兼容参考库风格的 iks 轨道（ikIndex 指向 IK 约束列表）
      for (const ik of anim.iks) {
        const index = this.ikIndices[ik.ikIndex]
        if (index === undefined) continue
        const value = sampleNumber(ik.mix, time)
        if (value !== null) this.states[index].mix = value
      }
    }

    solveConstraints(this.skeleton, this.activeConstraints, this.activeStates)
  }

  private applyConstraintTrack(track: ConstraintAnim, time: number, state: ConstraintState): void {
    const assign = (keys: FloatKeyframe[], set: (v: number) => void): void => {
      if (keys.length === 0) return
      const value = sampleNumber(keys, time)
      if (value !== null) set(value)
    }
    assign(track.mix, (v) => (state.mix = v))
    assign(track.mixRotate, (v) => (state.mixRotate = v))
    assign(track.mixX, (v) => (state.mixX = v))
    assign(track.mixY, (v) => (state.mixY = v))
    assign(track.mixScaleX, (v) => (state.mixScaleX = v))
    assign(track.mixScaleY, (v) => (state.mixScaleY = v))
    assign(track.mixShearY, (v) => (state.mixShearY = v))
    assign(track.offsetRotate, (v) => (state.offsetRotate = v))
    assign(track.offsetX, (v) => (state.offsetX = v))
    assign(track.offsetY, (v) => (state.offsetY = v))
    assign(track.offsetScaleX, (v) => (state.offsetScaleX = v))
    assign(track.offsetScaleY, (v) => (state.offsetScaleY = v))
    assign(track.offsetShearY, (v) => (state.offsetShearY = v))
    assign(track.position, (v) => (state.position = v))
    assign(track.spacing, (v) => (state.spacing = v))
    assign(track.rotateMix, (v) => (state.rotateMix = v))
    assign(track.translateMix, (v) => (state.translateMix = v))
  }
}

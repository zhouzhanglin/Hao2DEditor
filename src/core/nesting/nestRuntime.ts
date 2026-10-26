import { AnimationPlayer } from '../anim/player'
import { mulInto, trsInto } from '../math/matrix'
import { buildRuntimeMaps } from '../model/asset'
import type { RuntimeAsset, RuntimeMaps } from '../model/asset'
import { Skeleton } from '../model/skeleton'
import type { AttachmentData, RGBA } from '../model/types'
import { AttachmentType, WHITE } from '../model/types'
import { childClock, sampleSubArmature } from './nest'

/** 子骨架来源：编译产物 + 该骨架当前使用的皮肤（由编辑器侧缓存提供） */
export interface NestSource {
  asset: RuntimeAsset
  skinName: string
}

export type NestResolver = (armatureName: string) => NestSource | null

/** 与 `MeshBuildResult.nestAnchors` 对齐的锚点（这里只关心 layer） */
export interface NestAnchorLike {
  slotIndex: number
  attachmentName: string
  layer: number
}

/** 一个「正在显示」的嵌套骨架实例（每帧更新，字段原地复用，避免 GC） */
export interface NestInstance {
  /** `slotIndex|displayIndex`（同一插槽换 display 时是不同实例） */
  key: string
  slotIndex: number
  displayIndex: number
  attachmentName: string
  armatureName: string
  asset: RuntimeAsset
  skeleton: Skeleton
  player: AnimationPlayer
  /** 父骨骼世界矩阵 × 附件 TRS（列主序 16），供子视图设置变换 */
  matrix: Float32Array
  /** 子骨架最终染色 = 父插槽色 × 附件色（视图再乘全局 tint） */
  tint: RGBA
  /** 当前生效的子动画参数（已按阶跃采样合并 setup 默认值） */
  animation: string
  playTimes: number
  offset: number
  speed: number
  /** 子动画当前时间（秒） */
  childTime: number
  /** 插到父视图的第几个分组之后 */
  layer: number
  visible: boolean
}

const MAT = new Float32Array(16)

/**
 * 嵌套骨架运行期。
 *
 * 职责边界：只管「子骨架的 asset / Skeleton / AnimationPlayer」与矩阵合成，
 * **不碰 pixi** —— 渲染由 `SkeletonView` + `Scene` 负责，这样预览运行库
 * （`main/preview`）与编辑器可以是同一套驱动逻辑。
 *
 * 时间驱动是**确定性**的：每帧按父播放器当前时间算出子动画时间再 `seek`，
 * 不用 `update(dt)` 累加，所以暂停 / 拖动播放头 / 反复横跳都不会漂移。
 */
export class NestRuntime {
  private readonly resolver: NestResolver
  private readonly skinName: string
  /** 父骨架的皮肤解析结果（asset 变化时重建） */
  private parentAsset: RuntimeAsset | null = null
  private parentMaps: RuntimeMaps | null = null
  private readonly cache = new Map<string, NestInstance>()
  private active: NestInstance[] = []
  private missingNames: string[] = []

  constructor(resolver: NestResolver, skinName = '') {
    this.resolver = resolver
    this.skinName = skinName
  }

  /** 当前正在显示的实例（上一帧 `update` 的结果，只读） */
  get instances(): readonly NestInstance[] {
    return this.active
  }

  /**
   * 给某个子骨架实例创建它自己的嵌套层（A 挂 B、B 挂 C 时用）。
   * 复用同一个 resolver，保证多层嵌套解析规则一致。
   */
  createChildRuntime(skinName = this.skinName): NestRuntime {
    return new NestRuntime(this.resolver, skinName)
  }

  /** 工程里找不到的被引用骨架名（按帧去重；UI / 导出据此提示） */
  get missing(): readonly string[] {
    return this.missingNames
  }

  /**
   * 按父骨架当前姿态刷新子骨架。
   *
   * @param anchors `MeshBuilder` 给出的嵌套锚点（决定子视图插在第几层）；缺省时按 0 层处理
   */
  update(
    asset: RuntimeAsset,
    skeleton: Skeleton,
    player: AnimationPlayer,
    anchors?: readonly NestAnchorLike[],
    /** 网格工具的插槽隔离：>= 0 时只保留该插槽上的嵌套（与 MeshBuilder 同一口径） */
    isolateSlot = -1
  ): readonly NestInstance[] {
    if (this.parentAsset !== asset) {
      this.parentAsset = asset
      this.parentMaps = buildRuntimeMaps(asset, this.skinName)
    }
    const maps = this.parentMaps
    if (!maps) return this.active

    const layerOf = new Map<string, number>()
    if (anchors) {
      for (const anchor of anchors) {
        const key = `${anchor.slotIndex}|${anchor.attachmentName}`
        if (!layerOf.has(key)) layerOf.set(key, anchor.layer)
      }
    }

    const missing = new Set<string>()
    const next: NestInstance[] = []
    const anim = player.currentAnimData
    const parentTime = player.time

    for (let slotIndex = 0; slotIndex < asset.slots.length; slotIndex++) {
      if (isolateSlot >= 0 && slotIndex !== isolateSlot) continue
      const skinIndex = maps.skinOfSlot[slotIndex]
      if (skinIndex < 0) continue
      const attachments = maps.skinArr[skinIndex].attachments
      const displayIndex = skeleton.slotDisplayIndex[slotIndex]
      if (displayIndex < 0 || displayIndex >= attachments.length) continue
      const override = maps.resolved[slotIndex]?.[displayIndex]
      const attachment = override ?? attachments[displayIndex]
      if (!attachment || attachment.type !== AttachmentType.Armature) continue

      const key = `${slotIndex}|${displayIndex}`
      const name = attachment.name
      const armatureName = attachment.subArmature
      // 引用缺失（空名 / 工程里没有这个骨架）：不渲染，交给 UI 用 `missing` 提示
      if (!armatureName) continue
      const source = this.resolver(armatureName)
      if (!source) {
        missing.add(armatureName)
        continue
      }

      const instance = this.ensure(key, slotIndex, displayIndex, attachment, source)
      instance.visible = skeleton.slotVisible[slotIndex] === 1

      const track = anim?.slots.find((item) => item.slotIndex === slotIndex)?.subArmature
      const sample = sampleSubArmature(track, parentTime)
      const animation = sample ? sample.animation : attachment.subAnimation
      const playTimes = sample ? sample.playTimes : attachment.subPlayTimes
      const offset = sample ? sample.offset : attachment.subOffset
      const speed = sample ? sample.speed : attachment.subSpeed
      const keyTime = sample ? sample.keyTime : 0

      this.drive(instance, animation, playTimes, offset, speed, parentTime, keyTime)

      // 矩阵 = 父骨骼世界矩阵 × 附件 TRS
      const boneIndex = asset.slots[slotIndex].boneIndex
      const boneOffset = Math.max(0, boneIndex) * 16
      trsInto(MAT, attachment.position.x, attachment.position.y, attachment.rotation, attachment.scale.x, attachment.scale.y)
      mulInto(instance.matrix, skeleton.world.subarray(boneOffset, boneOffset + 16), MAT)

      const slotColor = skeleton.slotColors[slotIndex]
      const attColor = attachment.color
      instance.tint.r = slotColor.r * attColor.r
      instance.tint.g = slotColor.g * attColor.g
      instance.tint.b = slotColor.b * attColor.b
      instance.tint.a = slotColor.a * attColor.a

      instance.layer = layerOf.get(`${slotIndex}|${name}`) ?? 0
      next.push(instance)
    }

    // 回收已经不再显示的实例（换 display / 换皮肤 / 删附件）
    const live = new Set(next.map((instance) => instance.key))
    for (const key of [...this.cache.keys()]) if (!live.has(key)) this.cache.delete(key)

    this.missingNames = [...missing]
    this.active = next
    return next
  }

  /** 丢掉全部子实例（父视图重建 / 关闭工程时调用） */
  dispose(): void {
    this.cache.clear()
    this.active = []
    this.parentMaps = null
    this.parentAsset = null
  }

  private ensure(
    key: string,
    slotIndex: number,
    displayIndex: number,
    attachment: AttachmentData,
    source: NestSource
  ): NestInstance {
    const cached = this.cache.get(key)
    if (cached && cached.asset === source.asset && cached.attachmentName === attachment.name) return cached

    const skeleton = new Skeleton(source.asset)
    // 子骨架跟随父骨架当前皮肤（子骨架里没有同名皮肤时退回它自己的默认皮肤）
    skeleton.applyRuntimeMaps(buildRuntimeMaps(source.asset, source.skinName))
    const player = new AnimationPlayer(source.asset, skeleton)

    const instance: NestInstance = {
      key,
      slotIndex,
      displayIndex,
      attachmentName: attachment.name,
      armatureName: source.asset.armatureName,
      asset: source.asset,
      skeleton,
      player,
      matrix: new Float32Array(16),
      tint: { ...WHITE },
      animation: '',
      playTimes: 0,
      offset: 0,
      speed: 1,
      childTime: 0,
      layer: 0,
      visible: true
    }
    this.cache.set(key, instance)
    return instance
  }

  /** 切换子动画（变化时才 play），再按确定性时间定位 */
  private drive(
    instance: NestInstance,
    animation: string,
    playTimes: number,
    offset: number,
    speed: number,
    parentTime: number,
    keyTime: number
  ): void {
    if (instance.animation !== animation) {
      if (animation) {
        const started = instance.player.play(animation, playTimes === 0)
        if (!started) instance.player.stop()
      } else {
        // 空动画名 = 停在 setup 姿态（DB 的 gotoAndStop 语义）
        instance.player.stop()
      }
    } else if (animation) {
      // 循环开关随关键帧变化时同步（不影响当前时间）
      const loop = playTimes === 0
      if (instance.player.loop !== loop) instance.player.loop = loop
    }

    instance.animation = animation
    instance.playTimes = playTimes
    instance.offset = offset
    instance.speed = speed
    instance.childTime = animation
      ? childClock({
          parentTime,
          keyTime,
          offset,
          speed,
          playTimes,
          duration: instance.player.duration
        })
      : 0
    if (animation) instance.player.seek(instance.childTime)
  }
}

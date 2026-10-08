import { solveFk } from '../math/fk'
import type { FkBone } from '../math/fk'
import type { Vec2 } from '../math/matrix'
import { WHITE } from './types'
import type { RGBA } from './types'
import type { RuntimeAsset, RuntimeMaps } from './asset'
import { findAttachmentIndex, findBoneIndex, findSlotIndex } from './asset'

/**
 * 运行期骨架：纯数据 pose 缓冲，无任何渲染依赖。
 * 由 AnimationPlayer 采样填充，UpdateFK 按拓扑序单遍递推世界矩阵，零 GC。
 */
export class Skeleton {
  asset: RuntimeAsset

  readonly localPos: Float32Array
  readonly localRot: Float32Array
  readonly localScale: Float32Array
  readonly localShear: Float32Array

  readonly world: Float32Array
  readonly worldRot: Float32Array
  readonly worldScale: Float32Array

  slotColors: RGBA[]
  slotDisplayIndex: Int32Array
  slotVisible: Uint8Array
  drawOrder: Int32Array

  /** 每插槽 setup 时的显示下标（工作副本，换装只改它） */
  setupDisplayIndex: Int32Array
  /** 当前皮肤解析出的 setup 显示下标（基准，只读） */
  setupDisplayBase: Int32Array
  /** 每插槽的「附件名 → 下标」表（指向当前合并皮肤） */
  slotAttIndex: Array<Map<string, number> | null> = []

  /** FFD：每插槽的当前顶点偏移（满顶点长度或 null） */
  deformOffsets: Array<number[] | null>
  deformOffsetBase: Int32Array

  readonly boneCount: number
  readonly slotCount: number

  private readonly fkBones: FkBone[]
  private attOverrideName: Array<string | null>
  private visOverride: Uint8Array
  private hasVisOverride: Uint8Array
  private displayOverride: Int32Array
  private hasDisplayOverride: Uint8Array

  constructor(asset: RuntimeAsset) {
    this.asset = asset
    this.boneCount = asset.bones.length
    this.slotCount = asset.slots.length

    this.localPos = new Float32Array(this.boneCount * 2)
    this.localRot = new Float32Array(this.boneCount)
    this.localScale = new Float32Array(this.boneCount * 2)
    this.localShear = new Float32Array(this.boneCount * 2)
    this.world = new Float32Array(this.boneCount * 16)
    this.worldRot = new Float32Array(this.boneCount)
    this.worldScale = new Float32Array(this.boneCount * 2)

    this.slotColors = new Array<RGBA>(this.slotCount).fill(WHITE).map(() => ({ ...WHITE }))
    this.slotDisplayIndex = new Int32Array(this.slotCount)
    this.slotVisible = new Uint8Array(this.slotCount)
    this.drawOrder = new Int32Array(this.slotCount)
    this.setupDisplayIndex = new Int32Array(this.slotCount)
    this.setupDisplayBase = new Int32Array(this.slotCount)
    this.deformOffsets = new Array<number[] | null>(this.slotCount).fill(null)
    this.deformOffsetBase = new Int32Array(this.slotCount).fill(-1)

    this.attOverrideName = new Array<string | null>(this.slotCount).fill(null)
    this.visOverride = new Uint8Array(this.slotCount)
    this.hasVisOverride = new Uint8Array(this.slotCount)
    this.displayOverride = new Int32Array(this.slotCount)
    this.hasDisplayOverride = new Uint8Array(this.slotCount)

    this.fkBones = asset.bones.map((bone) => ({
      parentIndex: bone.parentIndex,
      inheritRotation: bone.inheritRotation,
      inheritScale: bone.inheritScale
    }))

    for (let i = 0; i < this.slotCount; i++) this.setupDisplayIndex[i] = asset.slots[i].defaultDisplayIndex
    this.setupDisplayBase.set(this.setupDisplayIndex)
    this.setToSetupPose()
  }

  /**
   * 皮肤切换后同步「按 setup 附件名解析出的下标」与附件名表。
   * 同时把解析结果写进当前显示下标 —— 否则刚构造（或刚换肤）时会停留在
   * SlotData.defaultDisplayIndex（编译产物的初值是 -1，表现为整只角色不渲染）。
   */
  applyRuntimeMaps(maps: RuntimeMaps): void {
    this.setupDisplayBase.set(maps.setupDisplayIndex)
    this.slotAttIndex = maps.slotAttIndex
    for (let i = 0; i < this.slotCount; i++) {
      const override = this.attOverrideName[i]
      if (override) {
        const map = this.slotAttIndex[i]
        const byName = map ? map.get(override) : undefined
        this.setupDisplayIndex[i] = byName !== undefined ? byName : maps.setupDisplayIndex[i]
      } else {
        this.setupDisplayIndex[i] = maps.setupDisplayIndex[i]
      }
      if (!this.hasDisplayOverride[i]) this.slotDisplayIndex[i] = this.setupDisplayIndex[i]
      if (!this.hasVisOverride[i]) this.slotVisible[i] = 1
    }
  }

  setToSetupPose(): void {
    const bones = this.asset.bones
    for (let i = 0; i < this.boneCount; i++) {
      const bone = bones[i]
      this.localPos[i * 2] = bone.localPosition.x
      this.localPos[i * 2 + 1] = bone.localPosition.y
      this.localRot[i] = bone.rotation
      this.localScale[i * 2] = bone.localScale.x
      this.localScale[i * 2 + 1] = bone.localScale.y
      this.localShear[i * 2] = bone.localShear.x
      this.localShear[i * 2 + 1] = bone.localShear.y
    }
    const slots = this.asset.slots
    for (let i = 0; i < this.slotCount; i++) {
      const color = slots[i].color
      this.slotColors[i].r = color.r
      this.slotColors[i].g = color.g
      this.slotColors[i].b = color.b
      this.slotColors[i].a = color.a
      this.slotDisplayIndex[i] = this.setupDisplayIndex[i]
      this.slotVisible[i] = this.setupVisibleAt(i) ? 1 : 0
      this.deformOffsets[i] = null
      this.deformOffsetBase[i] = -1
      this.drawOrder[i] = i
    }
    this.updateFk(0)
  }

  setupVisibleAt(slotIndex: number): boolean {
    return this.hasVisOverride[slotIndex] ? this.visOverride[slotIndex] === 1 : true
  }

  /** 全量 FK */
  updateFk(startBone = 0): void {
    solveFk(
      this.fkBones,
      this.localPos,
      this.localRot,
      this.localScale,
      this.localShear,
      this.world,
      this.worldRot,
      this.worldScale,
      startBone
    )
  }

  /** 增量 FK：只重算 [startBone, 末尾)（拓扑序保证等价） */
  updateFkFrom(startBone: number): void {
    this.updateFk(startBone)
  }

  boneWorldX(boneIndex: number): number {
    return this.world[boneIndex * 16 + 12]
  }

  boneWorldY(boneIndex: number): number {
    return this.world[boneIndex * 16 + 13]
  }

  boneWorldPosition(boneIndex: number): Vec2 {
    const o = boneIndex * 16
    return { x: this.world[o + 12], y: this.world[o + 13] }
  }

  /** 把角色本地空间坐标变换到世界（此处「世界」= 骨架空间） */
  transformPoint(boneIndex: number, x: number, y: number): Vec2 {
    const o = boneIndex * 16
    const w = this.world
    return {
      x: w[o] * x + w[o + 4] * y + w[o + 12],
      y: w[o + 1] * x + w[o + 5] * y + w[o + 13]
    }
  }

  // ---------------- 插槽运行期覆盖（换装 / 隐藏 / 强制显示下标） ----------------

  findBoneIndex(name: string): number {
    return findBoneIndex(this.asset, name)
  }

  findSlotIndex(name: string): number {
    return findSlotIndex(this.asset, name)
  }

  /**
   * 换装：把某插槽显示的附件换成该插槽下的另一个附件（写在 setup 显示下标上，
   * 因此动画每帧的 SetupTo 不会把它重置掉）。
   */
  setSlotAttachment(slotIndex: number, attachmentName: string): boolean {
    if (slotIndex < 0 || slotIndex >= this.slotCount) return false
    const map = this.slotAttIndex[slotIndex]
    if (!map) return false
    // 兼容换装皮肤的「皮肤名/」前缀（见 findAttachmentIndex）
    const index = findAttachmentIndex(map, attachmentName)
    if (index === undefined) return false
    this.attOverrideName[slotIndex] = attachmentName
    this.setupDisplayIndex[slotIndex] = index
    this.slotDisplayIndex[slotIndex] = index
    return true
  }

  clearSlotAttachmentOverride(slotIndex: number): void {
    if (slotIndex < 0 || slotIndex >= this.slotCount) return
    this.attOverrideName[slotIndex] = null
    this.setupDisplayIndex[slotIndex] = this.setupDisplayBase[slotIndex]
  }

  getSlotAttachmentName(slotIndex: number): string | null {
    return this.attOverrideName[slotIndex] ?? null
  }

  /** 按下标设置显示内容；displayIndex 为 -1 表示不显示任何附件 */
  setSlotDisplayIndex(slotIndex: number, displayIndex: number, force = false): void {
    if (slotIndex < 0 || slotIndex >= this.slotCount) return
    this.setupDisplayIndex[slotIndex] = displayIndex
    if (force) {
      this.hasDisplayOverride[slotIndex] = 1
      this.displayOverride[slotIndex] = displayIndex
    }
  }

  clearSlotDisplayOverride(slotIndex: number): void {
    if (slotIndex < 0 || slotIndex >= this.slotCount) return
    this.hasDisplayOverride[slotIndex] = 0
  }

  getSlotDisplayIndex(slotIndex: number): number {
    if (slotIndex < 0 || slotIndex >= this.slotCount) return -1
    return this.hasDisplayOverride[slotIndex] ? this.displayOverride[slotIndex] : this.slotDisplayIndex[slotIndex]
  }

  hasDisplayOverrideAt(slotIndex: number): boolean {
    return this.hasDisplayOverride[slotIndex] === 1
  }

  /** 把强制显示下标压回当前帧（动画采样之后调用） */
  applyDisplayOverrides(): void {
    for (let i = 0; i < this.slotCount; i++) {
      if (this.hasDisplayOverride[i]) this.slotDisplayIndex[i] = this.displayOverride[i]
    }
  }

  setSlotVisible(slotIndex: number, visible: boolean): void {
    if (slotIndex < 0 || slotIndex >= this.slotCount) return
    this.hasVisOverride[slotIndex] = 1
    this.visOverride[slotIndex] = visible ? 1 : 0
    this.slotVisible[slotIndex] = visible ? 1 : 0
  }

  clearSlotVisibleOverride(slotIndex: number): void {
    if (slotIndex < 0 || slotIndex >= this.slotCount) return
    this.hasVisOverride[slotIndex] = 0
    this.slotVisible[slotIndex] = this.setupVisibleAt(slotIndex) ? 1 : 0
  }

  hasVisibleOverrideAt(slotIndex: number): boolean {
    return this.hasVisOverride[slotIndex] === 1
  }

  /** 手改 deform 后刷新一帧（供编辑器调用） */
  refresh(): void {
    this.updateFk(0)
  }
}

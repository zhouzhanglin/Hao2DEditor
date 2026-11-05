import { buildRuntimeMaps, findAttachmentIndex } from '@core/model/asset'
import type { RuntimeAsset, RuntimeMaps } from '@core/model/asset'
import type { Skeleton } from '@core/model/skeleton'
import type { AnimationPlayer } from '@core/anim/player'
import { AttachmentType } from '@core/model/types'
import type { AttachmentData, RGBA } from '@core/model/types'
import { decomposeTrs } from '@core/math/matrix'
import { NestRuntime } from '@core/nesting/nestRuntime'
import type { MeshBuilder } from '@core/skin/meshBuilder'
import type { MeshBuildResult } from '@core/skin/meshBuilder'

/**
 * 与渲染后端无关的 Hao2D 视图核心：插槽换装 / 显隐 / 显示下标 / 皮肤 / 嵌套子骨架。
 *
 * three 版（`threejsRuntime.ts`）与 pixi 版（`hao2dRuntime.ts`）共用这一份逻辑，
 * 各自只提供一个 `Hao2dRenderAdapter`（创建视图、设局部变换、挂子视图、编绘制顺序）。
 * 这样 `IHao2DView.cs` 的语义（换肤后按名字重放、force 覆盖、嵌套实例复用等）不会两边漂移。
 */

/** 渲染后端视图需要提供的最小能力（ThreeSkeletonView / SkeletonView 都满足） */
export interface Hao2dRenderView {
  readonly result: MeshBuildResult | null
  readonly meshBuilder: MeshBuilder
  setSkin(name: string): void
  setTint(color: RGBA): void
  markDirty(): void
  update(skeleton: Skeleton): void
  destroy(): void
}

/** 渲染适配器：把「与平台无关的视图核心」接到 three / pixi 的容器上 */
export interface Hao2dRenderAdapter<V extends Hao2dRenderView> {
  create(asset: RuntimeAsset, skinName: string): V
  /** 可挂到父容器上的节点（three Group / pixi Container） */
  node(view: V): unknown
  setRootScale(node: unknown, ppu: number): void
  /** 子骨架的局部变换（rotationDeg 是角度，不是弧度） */
  setLocalTransform(node: unknown, x: number, y: number, rotationDeg: number, scaleX: number, scaleY: number): void
  setVisible(node: unknown, visible: boolean): void
  isVisible(node: unknown): boolean
  removeFromParent(node: unknown): void
  /** 嵌套子视图的层序：three 传 view、pixi 传 container，由适配器自己转换 */
  setNestedViews(view: V, layers: readonly NestedChildLayer<V>[]): void
  /** three 需要手动编 renderOrder；pixi 在 update 内部自动排序，可不实现 */
  assignRenderOrder?(view: V, start: number): void
  /** root 销毁时释放后端资源（three 的纹理；pixi 的纹理由舞台统一销毁，可不实现） */
  dispose?(view: V): void
}

export interface NestedChildLayer<V extends Hao2dRenderView> {
  layer: number
  order: number
  view: V
}

/** 子骨架控制器构造参数（由父级的 createChild 工厂补齐 adapter / 纹理等） */
export interface ChildViewInit {
  asset: RuntimeAsset
  skeleton: Skeleton
  player: AnimationPlayer
  maps: RuntimeMaps
  skinName: string
}

export interface ViewCoreOptions<V extends Hao2dRenderView> {
  asset: RuntimeAsset
  skeleton: Skeleton
  player: AnimationPlayer
  maps: RuntimeMaps
  skinName: string
  isRoot: boolean
  ppu: number
  adapter: Hao2dRenderAdapter<V>
  /** 子骨架也用各自平台的子类创建（这样 getNested 返回的对象仍带 group / container） */
  createChild: (init: ChildViewInit) => Hao2dViewCore<V>
  nestedAssets: Map<string, RuntimeAsset>
}

interface NestedEntry<V extends Hao2dRenderView> {
  key: string
  slotIndex: number
  displayIndex: number
  view: V
  controller: Hao2dViewCore<V>
  time: number
}

export class Hao2dViewCore<V extends Hao2dRenderView> {
  readonly asset: RuntimeAsset
  readonly defaultAnimation: string
  readonly defaultSkin: string

  protected readonly skeletonState: Skeleton
  protected readonly playerState: AnimationPlayer
  protected readonly nestedAssets: Map<string, RuntimeAsset>
  protected readonly ppu: number
  protected readonly isRoot: boolean
  protected readonly rootView: V
  protected readonly adapter: Hao2dRenderAdapter<V>
  private readonly createChild: (init: ChildViewInit) => Hao2dViewCore<V>
  private maps: RuntimeMaps
  private nest: NestRuntime
  private readonly children = new Map<string, NestedEntry<V>>()
  private skinName: string
  /** 子骨架被单独 SetSkin 过：父骨架换肤时才重新覆盖 */
  private skinOverride: string | null = null
  private speed = 1
  private playingState = true
  private synced = false
  protected destroyed = false

  constructor(options: ViewCoreOptions<V>) {
    this.asset = options.asset
    this.skeletonState = options.skeleton
    this.playerState = options.player
    this.maps = options.maps
    this.nestedAssets = options.nestedAssets
    this.ppu = options.ppu
    this.isRoot = options.isRoot
    this.skinName = options.skinName
    this.adapter = options.adapter
    this.createChild = options.createChild
    this.defaultAnimation = options.asset.animations[0]?.name ?? ''
    this.defaultSkin = options.skinName
    this.rootView = this.adapter.create(options.asset, options.skinName)
    if (options.isRoot) this.adapter.setRootScale(this.adapter.node(this.rootView), this.ppu)
    this.nest = this.createNest()
  }

  /** 可直接挂到宿主场景的节点（three Group / pixi Container） */
  get mountNode(): unknown {
    return this.adapter.node(this.rootView)
  }

  get skeleton(): Skeleton {
    return this.skeletonState
  }

  get animations(): string[] {
    return this.asset.animations.map((animation) => animation.name)
  }

  get skins(): string[] {
    return this.asset.skins.map((skin) => skin.name)
  }

  get activeSkin(): string {
    return this.skinName
  }

  get slotNames(): string[] {
    return this.asset.slots.map((slot) => slot.name)
  }

  get nestedSlotNames(): string[] {
    const out: string[] = []
    for (let i = 0; i < this.asset.slots.length; i++) {
      const k = this.maps.skinOfSlot[i]
      if (k < 0) continue
      if (this.maps.skinArr[k].attachments.some((item) => item.type === AttachmentType.Armature)) {
        out.push(this.asset.slots[i].name)
      }
    }
    return out
  }

  get nestedCount(): number {
    this.ensureSynced()
    let count = 0
    for (const entry of this.children.values()) if (this.adapter.isVisible(this.adapter.node(entry.view))) count++
    return count
  }

  attachmentNames(slot: string | number): string[] {
    const si = this.slotIndexOf(slot)
    if (si < 0) return []
    const map = this.maps.slotAttIndex[si]
    return map ? [...map.keys()] : []
  }

  get bounds(): { minX: number; minY: number; maxX: number; maxY: number } {
    const b = this.rootView.result?.bounds ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 }
    return {
      minX: b.minX * this.ppu,
      minY: b.minY * this.ppu,
      maxX: b.maxX * this.ppu,
      maxY: b.maxY * this.ppu
    }
  }

  // ---------------- IHao2DView：皮肤 / 换装 / 显隐 / 显示下标 ----------------

  setSkin(skinName: string, fromParent = false): boolean {
    if (this.destroyed) return false
    const name = skinName ?? ''
    // 名字不存在返回 false 并保持当前皮肤（空名 = 只用基底皮肤，恒有效）
    if (name && !this.skins.includes(name)) return false
    this.skinOverride = fromParent ? null : this.isRoot ? null : name
    this.applySkin(name)
    // 父骨架换肤会重新覆盖子骨架皮肤（与 Unity 端 SyncNested 的语义一致）
    for (const entry of this.children.values()) {
      const want = entry.controller.skins.includes(name) ? name : ''
      entry.controller.setSkin(want, true)
    }
    return true
  }

  setSlotAttachment(slot: string | number, attachment: string | number): boolean {
    const si = this.slotIndexOf(slot)
    if (si < 0 || this.destroyed) return false
    let ok = false
    if (typeof attachment === 'string') {
      ok = this.skeletonState.setSlotAttachment(si, attachment)
    } else {
      // 与 Unity 端一致：下标不做上界校验（越界时 MeshBuilder 跳过该插槽），负数才拒绝
      if (!Number.isInteger(attachment) || attachment < 0) return false
      // 按名字写入，换肤后才能按名字重新解析（与 Unity Skeleton.NameOfAttachment 同思路）
      const name = this.attachmentNameAt(si, attachment)
      if (name) ok = this.skeletonState.setSlotAttachment(si, name)
      else {
        this.skeletonState.clearSlotAttachmentOverride(si)
        this.writeDisplay(si, attachment)
        ok = true
      }
    }
    if (ok) this.refreshAfterSlotChange()
    return ok
  }

  setSlotVisible(slot: string | number, visible: boolean): boolean {
    const si = this.slotIndexOf(slot)
    if (si < 0 || this.destroyed) return false
    this.skeletonState.setSlotVisible(si, visible)
    this.refreshAfterSlotChange()
    return true
  }

  setSlotDisplayIndex(slot: string | number, displayIndex: number, force = false): boolean {
    const si = this.slotIndexOf(slot)
    if (si < 0 || this.destroyed || !Number.isInteger(displayIndex)) return false
    // 与 Unity 端一致：只校验插槽下标，displayIndex 越界时该插槽不画而不报错；
    // 同时把「换装覆盖名」同步成这个名字（或 -1 时清空），换肤后才不会串附件
    this.skeletonState.clearSlotAttachmentOverride(si)
    const name = displayIndex >= 0 ? this.attachmentNameAt(si, displayIndex) : ''
    if (name) this.skeletonState.setSlotAttachment(si, name)
    else this.skeletonState.setSlotDisplayIndex(si, displayIndex, false)
    if (force) this.skeletonState.setSlotDisplayIndex(si, displayIndex, true)
    // 立即作用于当前帧（AnimationPlayer 下一帧的 SetupTo 也会读到新的 setup 下标）
    this.writeDisplayDirect(si, displayIndex)
    this.refreshAfterSlotChange()
    return true
  }

  getSlotDisplayIndex(slot: string | number): number {
    return this.skeletonState.getSlotDisplayIndex(this.slotIndexOf(slot))
  }

  findSlotIndex(slotName: string): number {
    return this.skeletonState.findSlotIndex(slotName)
  }

  findAttachmentIndex(slotIndex: number, attachmentName: string): number {
    const map = this.maps.slotAttIndex[slotIndex]
    if (!map || !attachmentName) return -1
    return findAttachmentIndex(map, attachmentName) ?? -1
  }

  getNested(slot: string | number): this | null {
    const si = this.slotIndexOf(slot)
    if (si < 0 || this.destroyed) return null
    this.ensureSynced()
    const attachment = this.attachmentAt(si, this.skeletonState.slotDisplayIndex[si])
    // 没有子骨架 / 该 display 不是 Armature 时返回 null
    if (!attachment || attachment.type !== AttachmentType.Armature) return null
    const displayIndex = this.skeletonState.getSlotDisplayIndex(si)
    for (const entry of this.children.values()) {
      if (
        entry.slotIndex === si &&
        entry.displayIndex === displayIndex &&
        this.adapter.isVisible(this.adapter.node(entry.view))
      ) {
        return entry.controller as this
      }
    }
    return null
  }

  hasNested(slotName: string): boolean {
    return this.getNested(slotName) !== null
  }

  // ---------------- Hao2DViewExtensions 的对等实现 ----------------

  setNestedSlotAttachment(parentSlotName: string, slot: string | number, attachment: string | number): boolean {
    return this.getNested(parentSlotName)?.setSlotAttachment(slot, attachment) ?? false
  }

  setNestedSlotVisible(parentSlotName: string, slot: string | number, visible: boolean): boolean {
    return this.getNested(parentSlotName)?.setSlotVisible(slot, visible) ?? false
  }

  setNestedSlotDisplayIndex(
    parentSlotName: string,
    slot: string | number,
    displayIndex: number,
    force = false
  ): boolean {
    return this.getNested(parentSlotName)?.setSlotDisplayIndex(slot, displayIndex, force) ?? false
  }

  setNestedSkin(parentSlotName: string, skinName: string): boolean {
    return this.getNested(parentSlotName)?.setSkin(skinName) ?? false
  }

  // ---------------- 覆盖清理 ----------------

  clearSlotAttachmentOverride(slot: string | number): boolean {
    const si = this.slotIndexOf(slot)
    if (si < 0 || this.destroyed) return false
    this.skeletonState.clearSlotAttachmentOverride(si)
    this.skeletonState.slotDisplayIndex[si] = this.skeletonState.setupDisplayIndex[si]
    this.refreshAfterSlotChange()
    return true
  }

  clearSlotVisibleOverride(slot: string | number): boolean {
    const si = this.slotIndexOf(slot)
    if (si < 0 || this.destroyed) return false
    this.skeletonState.clearSlotVisibleOverride(si)
    this.refreshAfterSlotChange()
    return true
  }

  clearSlotDisplayOverride(slot: string | number): boolean {
    const si = this.slotIndexOf(slot)
    if (si < 0 || this.destroyed) return false
    const had = this.skeletonState.hasDisplayOverrideAt(si)
    this.skeletonState.clearSlotDisplayOverride(si)
    this.skeletonState.slotDisplayIndex[si] = this.skeletonState.setupDisplayIndex[si]
    this.refreshAfterSlotChange()
    return had
  }

  // ---------------- 播放控制 ----------------

  play(name?: string, loop = true): boolean {
    const target = name ?? this.defaultAnimation
    const ok = target ? this.playerState.play(target, loop) : false
    if (ok) this.playingState = true
    this.rootView.markDirty()
    return ok
  }

  crossFade(name: string, duration = 0.2, loop = true): boolean {
    const ok = this.playerState.crossFade(name, duration, loop)
    if (ok) this.playingState = true
    this.rootView.markDirty()
    return ok
  }

  stop(): void {
    this.playerState.stop()
    this.playingState = false
    this.rootView.markDirty()
  }

  pause(): void {
    this.playingState = false
  }

  resume(): void {
    this.playingState = true
  }

  seek(seconds: number): void {
    this.playerState.seek(seconds)
    this.rootView.markDirty()
  }

  setProgress(normalized: number): void {
    this.playerState.seek(this.playerState.duration * Math.max(0, Math.min(1, normalized)))
    this.rootView.markDirty()
  }

  setLoop(loop: boolean): void {
    this.playerState.loop = loop
  }

  setSpeed(scale: number): void {
    this.speed = scale
  }

  get duration(): number {
    return this.playerState.duration
  }

  get time(): number {
    return this.playerState.time
  }

  get playing(): boolean {
    return this.playingState
  }

  /** 每帧推进：root 自己驱动时间，嵌套子骨架的 pose 由父级 NestRuntime 写入 */
  update(dt: number): void {
    if (this.destroyed) return
    if (this.isRoot && this.playingState) {
      this.playerState.update(dt * this.speed)
      this.rootView.markDirty()
    }
    this.syncTree()
    if (this.isRoot) this.adapter.assignRenderOrder?.(this.rootView, 0)
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    for (const entry of this.children.values()) entry.controller.destroy()
    this.children.clear()
    this.nest.dispose()
    if (this.isRoot) this.adapter.dispose?.(this.rootView)
    this.rootView.destroy()
  }

  // ---------------- 内部 ----------------

  /** setup 姿态先出一次几何：与 spine / pixi 预览页的取景顺序一致 */
  buildSetupPose(): void {
    this.skeletonState.updateFk()
    this.rootView.update(this.skeletonState)
  }

  /** 递归刷新整棵视图树（不含 renderOrder 编号，那个只由 root 做一遍） */
  syncTree(): void {
    if (this.destroyed) return
    this.rootView.update(this.skeletonState)
    this.syncNested()
    this.synced = true
  }

  private ensureSynced(): void {
    if (this.synced || this.destroyed) return
    this.syncNested()
    this.synced = true
  }

  private createNest(): NestRuntime {
    return new NestRuntime((name: string) => {
      const asset = this.nestedAssets.get(name)
      return asset ? { asset, skinName: this.childSkinName(asset) } : null
    }, this.skinName)
  }

  /** 子骨架皮肤：父皮肤在子骨架里存在就沿用，否则用它自己的基底皮肤 */
  private childSkinName(asset: RuntimeAsset): string {
    if (!this.skinName) return ''
    return asset.skins.some((skin) => skin.name === this.skinName) ? this.skinName : ''
  }

  private syncNested(): void {
    const instances = this.nest.update(
      this.asset,
      this.skeletonState,
      this.playerState,
      this.rootView.result?.nestAnchors
    )
    const live = new Set<string>()
    const layers: NestedChildLayer<V>[] = []
    for (const instance of instances) {
      live.add(instance.key)
      let entry = this.children.get(instance.key)
      if (!entry || entry.controller.asset !== instance.asset) {
        if (entry) this.destroyEntry(entry)
        const skin = this.childSkinName(instance.asset)
        const controller = this.createChild({
          asset: instance.asset,
          skeleton: instance.skeleton,
          player: instance.player,
          maps: buildRuntimeMaps(instance.asset, skin),
          skinName: skin
        })
        entry = {
          key: instance.key,
          slotIndex: instance.slotIndex,
          displayIndex: instance.displayIndex,
          view: controller.rootView,
          controller,
          time: Number.NaN
        }
        this.children.set(instance.key, entry)
      }
      entry.slotIndex = instance.slotIndex
      entry.displayIndex = instance.displayIndex

      const parts = decomposeTrs(instance.matrix)
      const childNode = this.adapter.node(entry.view)
      this.adapter.setLocalTransform(
        childNode,
        parts.x,
        parts.y,
        parts.rotation,
        parts.scaleX,
        parts.scaleY
      )
      this.adapter.setVisible(childNode, instance.visible)
      const tint = entry.view.meshBuilder.tint
      const next: RGBA = instance.tint
      if (tint.r !== next.r || tint.g !== next.g || tint.b !== next.b || tint.a !== next.a) {
        entry.view.setTint({ r: next.r, g: next.g, b: next.b, a: next.a })
      }
      if (!(Math.abs(entry.time - instance.childTime) <= 1e-9)) {
        entry.view.markDirty()
        entry.time = instance.childTime
      }
      entry.view.update(instance.skeleton)
      // 子骨架自己也可能挂着别人（A → B → C）：递归同步它的子层
      entry.controller.syncTree()
      layers.push({ layer: instance.layer, order: instance.order, view: entry.view })
    }
    for (const [key, entry] of [...this.children]) {
      if (live.has(key)) continue
      this.destroyEntry(entry)
      this.children.delete(key)
    }
    this.adapter.setNestedViews(this.rootView, layers)
  }

  private destroyEntry(entry: NestedEntry<V>): void {
    this.adapter.removeFromParent(this.adapter.node(entry.view))
    entry.controller.destroy()
  }

  private applySkin(name: string): void {
    this.skinName = name
    this.maps = buildRuntimeMaps(this.asset, name)
    this.skeletonState.applyRuntimeMaps(this.maps)
    // 换肤后按当前时间重采样显示通道（否则 setup 里新增的 display 仍是 -1）
    if (this.isRoot) this.playerState.seek(this.playerState.time)
    this.rootView.setSkin(name)
    this.rootView.markDirty()
    // 皮肤换了，Armature display 可能整组换掉：嵌套实例按新的皮肤重新解析
    this.nest.dispose()
    this.nest = this.createNest()
    for (const entry of this.children.values()) this.destroyEntry(entry)
    this.children.clear()
    this.adapter.setNestedViews(this.rootView, [])
    this.synced = false
    this.refreshAfterSlotChange()
  }

  private refreshAfterSlotChange(): void {
    this.rootView.markDirty()
    this.syncTree()
  }

  private slotIndexOf(slot: string | number): number {
    if (typeof slot === 'number') {
      return Number.isInteger(slot) && slot >= 0 && slot < this.asset.slots.length ? slot : -1
    }
    return this.skeletonState.findSlotIndex(slot)
  }

  private attachmentAt(slotIndex: number, displayIndex: number): AttachmentData | null {
    return this.rootView.meshBuilder.attachmentAt(slotIndex, displayIndex)
  }

  private attachmentNameAt(slotIndex: number, displayIndex: number): string {
    const map = this.maps.slotAttIndex[slotIndex]
    if (!map) return ''
    for (const [name, index] of map) if (index === displayIndex) return name
    return ''
  }

  private writeDisplay(slotIndex: number, displayIndex: number): void {
    this.skeletonState.setupDisplayIndex[slotIndex] = displayIndex
    this.writeDisplayDirect(slotIndex, displayIndex)
  }

  private writeDisplayDirect(slotIndex: number, displayIndex: number): void {
    this.skeletonState.slotDisplayIndex[slotIndex] = displayIndex
  }
}

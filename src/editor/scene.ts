import { Container, Graphics } from 'pixi.js'
import { MAT4_LENGTH, mul, trs } from '@core/math/matrix'
import { Viewport } from '@render/viewport'
import { SkeletonView } from '@render/skeletonView'
import type { TextureStore } from '@render/material'
import { drawBoneOverlay, drawGhostBones } from '@render/overlays/boneOverlay'
import { drawMeshOverlay } from '@render/overlays/meshOverlay'
import { BONE_SIDE_HANDLE_GAP, BONE_TIP_RADIUS, pickBone, pickBoneHandle, pickVertex } from '@render/picking'
import type { BoneHandleHit, BoneHit, VertexHit } from '@render/picking'
import type { MeshBuildResult } from '@core/skin/meshBuilder'
import type { AttachmentData } from '@core/model/types'
import type { EditorDocument } from '@core/model/authoring'
import { animationDuration, buildRuntime, needsRebuild } from './runtime'
import type { RuntimeBundle } from './runtime'
import type { OverlayState } from './store/toolStore'

export interface SceneViewState {
  overlay: OverlayState
  selectedBone: string
  hoveredBone: string
  weightBone: string
  selectedVertices: number[]
  hoveredVertex: number
  playing: boolean
  speed: number
  loop: boolean
  time: number
  /** 洋葱皮：用前后帧的骨骼姿态做参考 */
  onionSkin: boolean
}

export interface EditorSceneOptions {
  /** 承载 pixi canvas 的容器（canvas 由 Viewport 自行创建） */
  host: HTMLElement
  textures: TextureStore
}

/**
 * 编辑器场景：pixi 视口 + 角色视图 + 叠加层 + 运行期 bundle 的唯一入口。
 *
 * React 侧只负责在 store 变化时投喂状态（setDocument / setViewState），
 * 渲染由 rAF 驱动并受脏标记控制，不触发 React 重渲染。
 */
export class EditorScene {
  readonly viewport: Viewport
  readonly textures: TextureStore
  readonly overlay = new Container()

  // 描边与填充必须分开（pixi v8 中 stroke 后的路径仍会被后续 fill 填充）
  private readonly meshStroke = new Graphics()
  private readonly meshFill = new Graphics()
  private readonly boneStroke = new Graphics()
  private readonly boneFill = new Graphics()
  /** 坐标轴：画在棋盘格之上、角色之下 */
  private readonly axes = new Graphics()
  /** 需要画成空心的骨骼名集合（编辑期模型才有 hollow 字段） */
  private hollowBones = new Set<string>()
  private bundle: RuntimeBundle | null = null
  private view: SkeletonView | null = null
  private document: EditorDocument | null = null
  private skinName = ''
  private animationName: string | null = null
  private dirty = true
  private viewState: SceneViewState = {
    overlay: { bones: true, mesh: false, weight: false, ffd: false, constraints: true },
    selectedBone: '',
    hoveredBone: '',
    weightBone: '',
    selectedVertices: [],
    hoveredVertex: -1,
    playing: false,
    speed: 1,
    loop: true,
    time: 0,
    onionSkin: false
  }

  constructor(options: EditorSceneOptions) {
    this.textures = options.textures
    this.viewport = new Viewport(options.host)
    this.overlay.addChild(this.meshFill, this.meshStroke, this.boneFill, this.boneStroke)
    this.viewport.overlayLayer.addChild(this.overlay)
    this.viewport.axisLayer.addChild(this.axes)
  }

  async init(): Promise<void> {
    // 注意：这里不要清空 contentLayer —— 文档同步可能先于 init 完成，
    // 清空会把已经挂上的角色容器一并移除（表现为视口空白）。
    await this.viewport.init()
    if (this.view && this.view.container.parent !== this.viewport.contentLayer) {
      this.viewport.contentLayer.addChild(this.view.container)
    }
  }

  get runtime(): RuntimeBundle | null {
    return this.bundle
  }

  get meshResult(): MeshBuildResult | null {
    return this.view?.result ?? null
  }

  get currentAnimation(): string | null {
    return this.animationName
  }

  setDocument(doc: EditorDocument, skinName: string): void {
    this.document = doc
    // 空心骨骼只存在于编辑期模型：这里按名字收集一份给叠加层使用
    this.hollowBones = new Set(doc.bones.filter((bone) => bone.hollow).map((bone) => bone.name))
    if (needsRebuild(this.bundle, doc, skinName)) {
      const previousAnimation = this.animationName
      const previousTime = this.viewState.time
      this.view?.destroy()
      this.view = null
      this.bundle = buildRuntime(doc, skinName)
      this.skinName = skinName
      this.animationName = previousAnimation && doc.animations.some((a) => a.name === previousAnimation) ? previousAnimation : null
      if (this.animationName) {
        this.bundle.player.play(this.animationName, this.viewState.loop)
        this.bundle.player.time = previousTime
      }
      this.markDirty()
    }
    if (!this.view && this.bundle) {
      this.view = new SkeletonView(this.bundle.asset, this.textures, skinName)
      for (const child of this.viewport.contentLayer.removeChildren()) void child
      this.viewport.contentLayer.addChild(this.view.container)
      this.markDirty()
    }
  }

  setViewState(patch: Partial<SceneViewState>): void {
    const previousSelected = this.viewState.selectedBone
    const previousTime = this.viewState.time
    const wasPlaying = this.viewState.playing
    this.viewState = { ...this.viewState, ...patch }
    if (patch.selectedBone !== undefined || patch.hoveredBone !== undefined) {
      void previousSelected
      this.markDirty()
    }
    if (patch.overlay || patch.selectedVertices || patch.hoveredVertex !== undefined) this.markDirty()

    // 外部改时间（拖时间轴 / 逐帧 / 切关键帧）→ 立即 seek 到播放器并重建一帧。
    // 播放中同样生效，这样「拖时间轴时画面跟着走」和「继续播放」不会互相打架。
    if (patch.time !== undefined && this.bundle && Math.abs(patch.time - previousTime) > 1e-6) {
      this.bundle.player.time = patch.time
      this.markDirty()
    }
    // 从暂停切到播放：把当前时间写回播放器并重建，避免首帧使用过期的采样结果
    if (this.viewState.playing && !wasPlaying && this.bundle) {
      this.bundle.player.time = this.viewState.time
      this.markDirty()
    }
  }

  get state(): SceneViewState {
    return this.viewState
  }

  setSkin(skinName: string): void {
    if (!this.bundle || skinName === this.skinName) return
    this.bundle = buildRuntime(this.bundle.sourceDocument, skinName)
    this.skinName = skinName
    this.view?.setSkin(skinName)
    if (this.animationName) {
      this.bundle.player.play(this.animationName, this.viewState.loop)
      this.bundle.player.time = this.viewState.time
    }
    this.markDirty()
  }

  setAnimation(name: string | null): void {
    this.animationName = name
    if (!this.bundle) return
    if (name) {
      this.bundle.player.play(name, this.viewState.loop)
      this.bundle.player.time = 0
    } else {
      this.bundle.player.stop()
    }
    this.markDirty()
  }

  setTime(time: number): void {
    if (!this.bundle) return
    this.bundle.player.time = time
    this.markDirty()
  }

  get duration(): number {
    return this.document ? animationDuration(this.document, this.animationName) : 1
  }

  markDirty(): void {
    this.dirty = true
  }

  /** 整体染色（与插槽色 / 附件色相乘） */
  setTint(color: { r: number; g: number; b: number; a: number }): void {
    this.view?.setTint(color)
    this.markDirty()
  }

  /** 每帧：推进播放、重建蒙皮、重绘叠加层，必要时渲染 */
  update(dtSeconds: number): void {
    // 兜底：面板尺寸/相机若因任何原因没同步（窗口初始化、面板折叠、HMR 旧实例…），这里每帧纠正
    if (this.viewport.syncFrame()) this.dirty = true
    if (!this.bundle || !this.view || !this.document) {
      this.drawAxes()
      if (this.dirty) {
        this.viewport.render()
        this.dirty = false
      }
      return
    }

    const duration = this.duration
    if (this.animationName && this.viewState.playing) {
      this.bundle.player.loop = this.viewState.loop
      this.bundle.player.update(dtSeconds * this.viewState.speed)
      // 推进结果回写，供时间轴播放头与状态栏显示（外部改时间由 setViewState 处理）
      this.viewState.time = this.bundle.player.time
      if (Math.abs(this.viewState.time - duration) < 1e-6 && !this.viewState.loop) {
        this.viewState.playing = false
      }
      this.view.markDirty()
      this.dirty = true
    } else if (this.animationName && Math.abs(this.bundle.player.time - this.viewState.time) > 1e-6) {
      // 静态编辑时把当前时间写回播放器，保证视口与状态一致
      this.bundle.player.time = this.viewState.time
      this.view.markDirty()
      this.dirty = true
    }

    if (this.view.isDirty) {
      this.view.update(this.bundle.skeleton)
      this.dirty = true
    }

    this.drawAxes()
    this.drawOverlays()
    if (this.dirty) {
      this.viewport.render()
      this.dirty = false
    }
  }

  /** 立即重建一帧（编辑后调用，不等下一帧） */
  refresh(): void {
    this.update(0)
  }

  fit(): void {
    this.viewport.fit(this.meshResult?.bounds ?? null)
    this.markDirty()
    this.viewport.render()
  }

  pickBoneAt(worldX: number, worldY: number): BoneHit | null {
    if (!this.bundle) return null
    return pickBone(this.bundle.skeleton, worldX, worldY, this.viewport.pixelsToWorld(8))
  }

  /**
   * 骨骼手柄拾取（移动 / 缩放 / 旋转三区）。
   * 原点圈与末端手柄是屏幕恒定大小，因此按 zoom 换算成世界半径再判定。
   */
  pickBoneHandleAt(worldX: number, worldY: number): BoneHandleHit | null {
    if (!this.bundle) return null
    return pickBoneHandle(
      this.bundle.skeleton,
      worldX,
      worldY,
      this.viewport.pixelsToWorld(8),
      this.viewport.pixelsToWorld(BONE_TIP_RADIUS),
      this.viewport.pixelsToWorld(BONE_SIDE_HANDLE_GAP),
      this.bundle.boneIndex[this.viewState.selectedBone] ?? -1
    )
  }

  pickVertexAt(worldX: number, worldY: number): VertexHit | null {
    if (!this.bundle) return null
    return pickVertex(this.meshResult, worldX, worldY, this.viewport.pixelsToWorld(9))
  }

  /** 顶点对应的附件（权重显示与拾取共用） */
  attachmentAt(slotIndex: number, displayIndex: number): AttachmentData | null {
    return this.view?.meshBuilder.attachmentAt(slotIndex, displayIndex) ?? null
  }

  /**
   * 某插槽当前附件的世界矩阵（boneWorld × TRS(附件)）。
   * 网格顶点编辑 / FFD 拖拽需要把世界位移换算回附件空间。
   */
  attachmentWorldAt(slotIndex: number): Float32Array | null {
    const bundle = this.bundle
    if (!bundle || slotIndex < 0 || slotIndex >= bundle.asset.slots.length) return null
    const display = bundle.skeleton.slotDisplayIndex[slotIndex]
    const attachment = this.attachmentAt(slotIndex, display)
    if (!attachment) return null
    const boneIndex = bundle.asset.slots[slotIndex].boneIndex
    if (boneIndex < 0) return null
    const boneWorld = bundle.skeleton.world.slice(boneIndex * MAT4_LENGTH, boneIndex * MAT4_LENGTH + MAT4_LENGTH)
    const local = trs(
      attachment.position.x,
      attachment.position.y,
      attachment.rotation,
      attachment.scale.x,
      attachment.scale.y
    )
    return mul(boneWorld, local)
  }

  destroy(): void {
    this.view?.destroy()
    this.view = null
    this.bundle = null
    this.viewport.destroy()
  }

  /**
   * 洋葱皮：临时把播放器 seek 到前后帧取骨骼世界矩阵，再回到当前时间。
   * seek 不触发事件，且同一时间点重采样结果一致，因此不会污染「上一帧事件」的状态。
   */
  private drawOnionSkin(g: Graphics, unitsPerPixel: number): void {
    const bundle = this.bundle
    if (!bundle || !this.animationName) return
    const duration = this.duration
    if (duration <= 0) return
    const player = bundle.player
    const skeleton = bundle.skeleton
    const current = player.time
    const step = Math.max(1 / 120, duration * 0.04)

    const ghosts: Array<{ matrices: Float32Array; alpha: number }> = []
    for (const offset of [-step, step]) {
      let target = current + offset
      if (target < 0) target += duration
      if (target > duration) target -= duration
      player.seek(target)
      ghosts.push({ matrices: skeleton.world.slice(), alpha: 0.22 })
    }
    // 回到原来的时间点，恢复当前姿态
    player.seek(current)

    const parents = bundle.asset.bones.map((bone) => bone.parentIndex)
    for (const ghost of ghosts) {
      drawGhostBones(g, skeleton.boneCount, parents, ghost.matrices, unitsPerPixel, ghost.alpha)
    }
  }

  /**
   * 坐标轴：沿世界 x=0 / y=0 画两条**黑色**细线，铺满当前可见范围。
   * 画在 axisLayer（棋盘格之上、角色之下），因此不会被角色挡住也不会盖住角色。
   */
  private drawAxes(): void {
    const g = this.axes
    g.clear()
    if (!this.viewState.overlay.bones && !this.viewState.overlay.constraints) return
    const viewport = this.viewport
    const topLeft = viewport.screenToWorld(0, 0)
    const bottomRight = viewport.screenToWorld(viewport.width, viewport.height)
    const width = viewport.pixelsToWorld(1)
    // y 轴（世界 x = 0）
    g.moveTo(0, topLeft.y).lineTo(0, bottomRight.y)
    // x 轴（世界 y = 0）
    g.moveTo(topLeft.x, 0).lineTo(bottomRight.x, 0)
    g.stroke({ width, color: 0x000000, alpha: 1 })
  }

  private drawOverlays(): void {
    const bundle = this.bundle
    const state = this.viewState
    const unitPerPixel = this.viewport.pixelsToWorld(1)

    const showBones = (state.overlay.bones || state.overlay.constraints) && bundle !== null
    this.boneStroke.visible = showBones
    this.boneFill.visible = showBones
    if (showBones && bundle && state.onionSkin) this.drawOnionSkin(this.boneStroke, unitPerPixel)
    if (showBones && bundle) {
      drawBoneOverlay(this.boneStroke, this.boneFill, bundle.skeleton, bundle.asset.constraints, {
        unitsPerPixel: unitPerPixel,
        selectedBone: bundle.boneIndex[state.selectedBone] ?? -1,
        hoveredBone: bundle.boneIndex[state.hoveredBone] ?? -1,
        showConstraints: state.overlay.constraints,
        showSlots: false,
        hollowBones: this.hollowBones
      })
    } else {
      this.boneStroke.clear()
      this.boneFill.clear()
    }

    const showMesh = (state.overlay.mesh || state.overlay.weight || state.overlay.ffd) && bundle !== null
    this.meshStroke.visible = showMesh
    this.meshFill.visible = showMesh
    if (!showMesh || !bundle) {
      this.meshStroke.clear()
      this.meshFill.clear()
      return
    }
    const weightBone = state.weightBone ? (bundle.boneIndex[state.weightBone] ?? -1) : -1
    drawMeshOverlay(
      this.meshStroke,
      this.meshFill,
      bundle.skeleton,
      this.meshResult,
      (slotIndex, displayIndex) => this.attachmentAt(slotIndex, displayIndex),
      {
        unitsPerPixel: unitPerPixel,
        showWireframe: state.overlay.mesh || state.overlay.weight,
        showVertices: state.overlay.weight || state.overlay.ffd,
        weightBone: state.overlay.weight ? weightBone : -1,
        selectedVertices: new Set(state.selectedVertices),
        hoveredVertex: state.hoveredVertex
      }
    )
  }
}

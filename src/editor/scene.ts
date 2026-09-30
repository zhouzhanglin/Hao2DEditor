import { Container, Graphics } from 'pixi.js'
import { MAT4_LENGTH, invert, mul, mulPoint, trs } from '@core/math/matrix'
import type { Vec2 } from '@core/math/matrix'
import { Viewport } from '@render/viewport'
import { SkeletonView } from '@render/skeletonView'
import type { TextureStore } from '@render/material'
import {
  GIZMO_AXIS_LENGTH,
  GIZMO_CENTER_RADIUS,
  GIZMO_RING_RADIUS,
  SHEAR_EDGE_TOLERANCE,
  drawAttachmentGizmo,
  drawBoneGizmo,
  drawBoneOverlay,
  drawGhostBones,
  drawShearBox
} from '@render/overlays/boneOverlay'
import type { GizmoDrawMode } from '@render/overlays/boneOverlay'
import { drawMeshOverlay } from '@render/overlays/meshOverlay'
import {
  BONE_ORIGIN_RADIUS,
  attachmentGizmoFrame,
  gizmoGeometry,
  pickAttachmentPixel,
  pickBone,
  pickBoneHandle,
  pickGizmo,
  pickGizmoFrame,
  pickShearEdge,
  pickVertex
} from '@render/picking'
import type { BoneHandleHit, BoneHit, GizmoPart, ShearEdge, VertexHit } from '@render/picking'
import { ImageAlphaCache } from '@render/imageAlpha'

/** 斜切包围盒：局部 AABB + 世界坐标四角（左上 → 右上 → 右下 → 左下） */
export interface ShearBox {
  minX: number
  minY: number
  maxX: number
  maxY: number
  corners: Array<{ x: number; y: number }>
}
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
  /** 骨骼变换小坐标轴的操作模式（移动 / 旋转 / 缩放 / 斜切） */
  gizmo: GizmoDrawMode
  /** 是否绘制骨骼操作器：绘制类工具（权重刷 / FFD / 网格）激活时隐藏，避免出现点不动的假手柄 */
  showGizmo: boolean
  /** 正在拖拽新建骨骼时的预览（世界坐标的两端），松开即生成 */
  pendingBone: { x1: number; y1: number; x2: number; y2: number } | null
  /**
   * 选中的附件操作器（Pose 态）：中心 = 附件 position 的世界位置，
   * 轴 = 附件自身旋转叠加宿主骨骼；null = 不显示（未选附件 / Animate 态 / 绘制工具）。
   */
  selectedAttachment: { boneIndex: number; position: { x: number; y: number }; rotation: number } | null
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
  /** 图片 alpha 缓存：附件像素级拾取用（纹理在 GPU 上读不出来，这里解码一份） */
  readonly imageAlpha = new ImageAlphaCache()
  readonly overlay = new Container()

  // 描边与填充必须分开（pixi v8 中 stroke 后的路径仍会被后续 fill 填充）
  private readonly meshStroke = new Graphics()
  private readonly meshFill = new Graphics()
  private readonly boneStroke = new Graphics()
  private readonly boneFill = new Graphics()
  /** 骨骼变换小坐标轴（描边 / 填充分开，同 pixi v8 的路径规则） */
  private readonly gizmoStroke = new Graphics()
  private readonly gizmoFill = new Graphics()
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
    onionSkin: false,
    gizmo: 'move',
    showGizmo: true,
    pendingBone: null,
    selectedAttachment: null
  }

  constructor(options: EditorSceneOptions) {
    this.textures = options.textures
    this.viewport = new Viewport(options.host)
    this.overlay.addChild(
      this.meshFill,
      this.meshStroke,
      this.boneFill,
      this.boneStroke,
      this.gizmoFill,
      this.gizmoStroke
    )
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
      // 先构建新运行时，成功了再替换：编译中途抛错时保持原样，
      // 否则会留下「视图已销毁、新运行时没建起来」的状态，网格从此不再显示
      const nextBundle = buildRuntime(doc, skinName)
      // 先把旧视图从显示列表摘掉，**再**销毁它。
      //
      // 顺序反了会崩：`view.destroy()` 会释放 GPU buffer，而此时旧视图仍挂在
      // contentLayer 上，pixi 这一帧的渲染指令还引用着那些 buffer —— 渲染时读到
      // null，抛 `Cannot read properties of null (reading 'usage')`，异常冒到
      // requestAnimationFrame 循环外层，整个视口就此定格（改 slot 层级 / 任何
      // 触发重建的编辑都会复现）。
      const previousView = this.view
      if (previousView) {
        this.viewport.contentLayer.removeChild(previousView.container)
        previousView.destroy()
      }
      this.view = null
      this.bundle = nextBundle
      this.skinName = skinName
      this.animationName = previousAnimation && doc.animations.some((a) => a.name === previousAnimation) ? previousAnimation : null
      if (this.animationName) {
        this.bundle.player.play(this.animationName, this.viewState.loop)
        // 时长可能比恢复的时间短（末尾关键帧被删 / 拖动收缩），超出部分会被循环取模，
        // 画面与实际时间就对不上（表现为「拖不动」）。统一收敛到时长内。
        const resumed = Math.max(0, Math.min(previousTime, animationDuration(doc, this.animationName)))
        this.viewState.time = resumed
        this.bundle.player.time = resumed
      }
      this.markDirty()
    }
    if (!this.view && this.bundle) {
      this.view = new SkeletonView(this.bundle.asset, this.textures, skinName)
      // 兜底：清掉可能残留的其它子节点（旧视图已在上面按顺序摘除）
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
      this.invalidateSkin()
    }
    // 从暂停切到播放：把当前时间写回播放器并重建，避免首帧使用过期的采样结果
    if (this.viewState.playing && !wasPlaying && this.bundle) {
      this.bundle.player.time = this.viewState.time
      this.invalidateSkin()
    }
  }

  /**
   * 时间 / 姿态变化后必须连**网格**一起标脏。
   *
   * 蒙皮只在 `view.isDirty` 时重算（见 update）。只标场景脏的话，叠加层里的骨骼会跟着动，
   * 但插槽（图片 / 网格）还是旧姿态 —— 拖时间轴时看起来「骨骼在动、slot 不动」。
   */
  private invalidateSkin(): void {
    this.view?.markDirty()
    this.markDirty()
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
    this.invalidateSkin()
  }

  setTime(time: number): void {
    if (!this.bundle) return
    this.bundle.player.time = time
    this.invalidateSkin()
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

    if (this.animationName && this.viewState.playing) {
      this.bundle.player.loop = this.viewState.loop
      this.bundle.player.update(dtSeconds * this.viewState.speed)
      // 推进结果回写，供时间轴播放头与状态栏显示（外部改时间由 setViewState 处理）
      this.viewState.time = this.bundle.player.time
      // 非循环播完停在最后一帧：完成判定由播放器给出（它按最后一个关键帧算长度，
      // 而不是按可编辑范围 duration —— 后者可能被留得更长）
      if (this.bundle.player.completed && !this.viewState.loop) {
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

  /** 立即重建一帧（编辑后调用，不等下一帧）：连网格一起重建 */
  refresh(): void {
    this.invalidateSkin()
    this.update(0)
  }

  fit(): void {
    this.viewport.fit(this.meshResult?.bounds ?? null)
    this.markDirty()
    this.viewport.render()
  }

  /**
   * 场景首次出现有效内容后，挂载时的自动适配只做一次（ViewportCanvas 的渲染循环检查此标志）。
   * 拖图创建内容前把它置 true，避免刚建好的内容又被自动 fit 拉走视角。
   */
  autoFitDone = false

  /** 场景当前是否有可见内容（拖图时判断要不要把视角对准落点） */
  get hasVisibleContent(): boolean {
    const result = this.meshResult
    if (!result || result.vertexCount === 0) return false
    const b = result.bounds
    return b.maxX - b.minX > 1e-4 && b.maxY - b.minY > 1e-4
  }

  /**
   * 空场景首次拖入图片后的视角适配：把缩放调到内容占视口约四成，
   * 但**以落点为缩放锚点**——落点的屏幕位置保持不变，图片就停在用户松手的地方
   * （之前的实现把落点搬到视口中心，用户会觉得「图片不在松手的位置」）。
   */
  focusOnContent(worldX: number, worldY: number, contentW: number, contentH: number): void {
    const fitZoom = Math.min(
      (this.viewport.width * 0.5) / Math.max(1e-6, contentW),
      (this.viewport.height * 0.5) / Math.max(1e-6, contentH)
    )
    const anchor = this.viewport.worldToScreen(worldX, worldY)
    this.viewport.zoomAt((fitZoom * 0.75) / this.viewport.zoom, anchor.x, anchor.y)
    this.markDirty()
    this.viewport.render()
  }

  pickBoneAt(worldX: number, worldY: number): BoneHit | null {
    if (!this.bundle) return null
    return pickBone(this.bundle.skeleton, worldX, worldY, this.viewport.pixelsToWorld(8))
  }

  /**
   * 骨骼拾取：原点圈（移动）/ 骨骼体（旋转）。
   * 原点圈是屏幕恒定大小，按 zoom 换算成世界半径再判定；缩放走小坐标轴。
   */
  pickBoneHandleAt(worldX: number, worldY: number): BoneHandleHit | null {
    if (!this.bundle) return null
    return pickBoneHandle(
      this.bundle.skeleton,
      worldX,
      worldY,
      this.viewport.pixelsToWorld(8),
      this.viewport.pixelsToWorld(BONE_ORIGIN_RADIUS),
      this.bundle.boneIndex[this.viewState.selectedBone] ?? -1
    )
  }

  /**
   * 骨骼的当前世界矩阵（列主序 16 个数的**拷贝**，setup 姿态）。
   * 层级树里重设父级时用它把世界变换换算到新父的局部空间；骨骼不存在时返回 null。
   */
  worldMatrixOf(boneName: string): Float32Array | null {
    const bundle = this.bundle
    if (!bundle) return null
    const index = bundle.boneIndex[boneName]
    if (index === undefined) return null
    return bundle.skeleton.world.slice(index * 16, index * 16 + 16)
  }

  /**
   * 世界坐标 → 骨骼局部坐标（附件显示空间）。
   * 把图片拖到场景里时，用落点算出附件的 position 就靠这个换算。
   * 用的是骨骼**当前**世界矩阵：Pose 状态下即 setup 姿态。
   */
  worldToBoneLocal(boneName: string, worldX: number, worldY: number): Vec2 | null {
    const bundle = this.bundle
    if (!bundle) return null
    const index = bundle.boneIndex[boneName]
    if (index === undefined) return null
    const inverse = invert(bundle.skeleton.world.subarray(index * 16, index * 16 + 16))
    return mulPoint(inverse, { x: worldX, y: worldY })
  }

  /**
   * 世界坐标 → 附件显示空间。
   * 附件世界矩阵 = 骨骼世界矩阵 · TRS(附件)，网格顶点编辑（插入顶点）要先把鼠标落到这一层。
   */
  worldToAttachmentLocal(
    slotName: string,
    attachmentName: string,
    worldX: number,
    worldY: number
  ): Vec2 | null {
    const bundle = this.bundle
    const doc = this.document
    if (!bundle || !doc) return null
    const slot = doc.slots.find((item) => item.name === slotName)
    if (!slot) return null
    const skin = doc.skins.find((item) => item.name === this.skinName) ?? doc.skins[0]
    const attachment = skin?.slots
      .find((item) => item.slot === slotName)
      ?.attachments.find((item) => item.name === attachmentName)
    const boneIndex = bundle.boneIndex[slot.bone]
    if (!attachment || boneIndex === undefined) return null

    const boneWorld = bundle.skeleton.world.subarray(boneIndex * 16, boneIndex * 16 + 16)
    const attachmentMatrix = trs(
      attachment.position.x,
      attachment.position.y,
      attachment.rotation,
      attachment.scale.x,
      attachment.scale.y
    )
    const world = mul(boneWorld, attachmentMatrix)
    return mulPoint(invert(world), { x: worldX, y: worldY })
  }

  /**
   * 小坐标轴拾取（中心 / X 轴 / Y 轴）。只在选中骨骼上判定——
   * 它是当前对象的操作器，不应该因为鼠标划过别的骨骼就被抢走。
   */
  pickGizmoAt(worldX: number, worldY: number): GizmoPart | null {
    const bundle = this.bundle
    if (!bundle) return null
    const index = bundle.boneIndex[this.viewState.selectedBone] ?? -1
    if (index < 0) return null
    if (this.viewState.gizmo === 'shear') return null
    if (this.viewState.gizmo === 'rotate') {
      // 旋转没有轴向：圆环与中心都算同一个「一起转」
      const geometry = gizmoGeometry(bundle.skeleton, index, this.viewport.pixelsToWorld(GIZMO_AXIS_LENGTH))
      if (!geometry) return null
      const distance = Math.hypot(worldX - geometry.ox, worldY - geometry.oy)
      const ring = this.viewport.pixelsToWorld(GIZMO_RING_RADIUS)
      const tolerance = this.viewport.pixelsToWorld(10)
      if (Math.abs(distance - ring) <= tolerance) return 'center'
      if (distance <= this.viewport.pixelsToWorld(GIZMO_CENTER_RADIUS * 1.6)) return 'center'
      return null
    }
    return pickGizmo(
      bundle.skeleton,
      index,
      worldX,
      worldY,
      this.viewport.pixelsToWorld(GIZMO_AXIS_LENGTH),
      this.viewport.pixelsToWorld(GIZMO_CENTER_RADIUS),
      this.viewport.pixelsToWorld(7)
    )
  }

  pickVertexAt(worldX: number, worldY: number): VertexHit | null {
    if (!this.bundle) return null
    return pickVertex(this.meshResult, worldX, worldY, this.viewport.pixelsToWorld(9))
  }

  /** 附件操作器拾取：旋转环 / 中心 / X-Y 轴（与骨骼 gizmo 同一套判定，尺寸相同） */
  pickAttachmentGizmoAt(worldX: number, worldY: number): GizmoPart | null {
    const state = this.viewState.selectedAttachment
    if (!state || !this.bundle) return null
    if (this.viewState.gizmo === 'shear') return null
    const frame = attachmentGizmoFrame(
      this.bundle.skeleton,
      state.boneIndex,
      state.position,
      state.rotation,
      this.viewport.pixelsToWorld(GIZMO_AXIS_LENGTH)
    )
    if (!frame) return null
    if (this.viewState.gizmo === 'rotate') {
      const distance = Math.hypot(worldX - frame.ox, worldY - frame.oy)
      const ring = this.viewport.pixelsToWorld(GIZMO_RING_RADIUS)
      if (Math.abs(distance - ring) <= this.viewport.pixelsToWorld(10)) return 'center'
      if (distance <= this.viewport.pixelsToWorld(GIZMO_CENTER_RADIUS * 1.6)) return 'center'
      return null
    }
    return pickGizmoFrame(
      frame,
      worldX,
      worldY,
      this.viewport.pixelsToWorld(GIZMO_CENTER_RADIUS),
      this.viewport.pixelsToWorld(7)
    )
  }

  /**
   * 点选附件本体：按**像素**判定（不是矩形区域）—— 落在图片的透明像素上不算命中，
   * 会穿透到它下面的对象；重叠时取视觉上最上层的那个。
   */
  pickAttachmentAt(worldX: number, worldY: number): { slot: string; attachment: string } | null {
    const bundle = this.bundle
    if (!bundle) return null
    const hit = pickAttachmentPixel(this.meshResult, worldX, worldY, {
      // 运行时附件的纹素名 = 图片名（与 alpha 缓存的键一致）
      imageOfSlot: (slotIndex) => {
        const displayIndex = bundle.skeleton.slotDisplayIndex[slotIndex]
        return this.attachmentAt(slotIndex, displayIndex)?.textureName ?? ''
      },
      alphaAt: (image, u, v) => this.imageAlpha.alphaAt(image, u, v)
    })
    if (!hit) return null
    const slot = bundle.asset.slots[hit.slotIndex]
    const displayIndex = bundle.skeleton.slotDisplayIndex[hit.slotIndex]
    const attachment = this.attachmentAt(hit.slotIndex, displayIndex)
    if (!slot || !attachment) return null
    return { slot: slot.name, attachment: attachment.name }
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

  /**
   * 选中骨骼的**斜切包围盒**：把挂在它下面的插槽附件（Mesh 顶点 / Region 尺寸）
   * 换算进骨骼局部空间求 AABB，再变换成世界坐标四角。
   *
   * 之所以在骨骼局部空间求包围盒：shearX / shearY 作用在骨骼的局部轴上，
   * 画的时候再乘骨骼世界矩阵，包围盒就会跟着斜切一起歪 —— 这正是用户要看到的反馈。
   */
  shearBoxAt(): ShearBox | null {
    const bundle = this.bundle
    if (!bundle) return null
    const index = bundle.boneIndex[this.viewState.selectedBone] ?? -1
    if (index < 0) return null
    const local = this.shearBoxLocal(index)
    if (!local) return null
    const world = bundle.skeleton.world.slice(index * MAT4_LENGTH, index * MAT4_LENGTH + MAT4_LENGTH)
    const corner = (x: number, y: number): Vec2 => mulPoint(world, { x, y })
    return {
      minX: local.minX,
      minY: local.minY,
      maxX: local.maxX,
      maxY: local.maxY,
      // 顺序与 pickShearEdge 的约定一致：左上 → 右上 → 右下 → 左下
      corners: [
        corner(local.minX, local.maxY),
        corner(local.maxX, local.maxY),
        corner(local.maxX, local.minY),
        corner(local.minX, local.minY)
      ]
    }
  }

  /** 骨骼局部空间下的包围盒；骨骼没有任何可见附件时退回「骨骼长度」的窄框 */
  private shearBoxLocal(boneIndex: number): { minX: number; minY: number; maxX: number; maxY: number } | null {
    const bundle = this.bundle
    if (!bundle) return null
    let minX = Number.POSITIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    let maxX = Number.NEGATIVE_INFINITY
    let maxY = Number.NEGATIVE_INFINITY

    const expand = (x: number, y: number): void => {
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }

    for (let slotIndex = 0; slotIndex < bundle.asset.slots.length; slotIndex++) {
      if (bundle.asset.slots[slotIndex].boneIndex !== boneIndex) continue
      const display = bundle.skeleton.slotDisplayIndex[slotIndex]
      const attachment = this.attachmentAt(slotIndex, display)
      if (!attachment) continue
      const local = trs(
        attachment.position.x,
        attachment.position.y,
        attachment.rotation,
        attachment.scale.x,
        attachment.scale.y
      )
      const push = (x: number, y: number): void => {
        const p = mulPoint(local, { x, y })
        expand(p.x, p.y)
      }
      const vertices = attachment.vertices
      for (let i = 0; i + 1 < vertices.length; i += 2) push(vertices[i], vertices[i + 1])
      if (attachment.size.x > 0 && attachment.size.y > 0) {
        const hw = attachment.size.x * 0.5
        const hh = attachment.size.y * 0.5
        push(-hw, -hh)
        push(hw, -hh)
        push(hw, hh)
        push(-hw, hh)
      }
    }

    if (Number.isFinite(minX)) return { minX, minY, maxX, maxY }
    // 兜底：光秃秃的骨骼也给一个可拖的框（沿骨骼长度方向）
    const length = Math.max(0.05, bundle.asset.bones[boneIndex]?.length ?? 0.2)
    return { minX: 0, minY: -length * 0.15, maxX: length, maxY: length * 0.15 }
  }

  /** 斜切包围盒的边拾取（世界坐标 + 屏幕像素容差） */
  pickShearEdgeAt(worldX: number, worldY: number): ShearEdge | null {
    const box = this.shearBoxAt()
    if (!box) return null
    return pickShearEdge(box.corners, worldX, worldY, this.viewport.pixelsToWorld(SHEAR_EDGE_TOLERANCE))
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
    // 世界坐标轴属于骨架辅助显示：关掉「骨骼」后一并隐藏，避免只留两条跨界黑线
    if (!this.viewState.overlay.bones) return
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

    // 骨骼本体与约束是**两个独立开关**，但共用同一对绘制层：
    // 「骨骼」关掉、「约束」仍开时这一层还要留着画约束手柄，只是跳过骨骼本体。
    // 曾经用 `bones || constraints` 当作骨骼自身的可见条件，于是关掉「骨骼」后骨架仍在屏幕上。
    const showSkeleton = state.overlay.bones && bundle !== null
    const showConstraints = state.overlay.constraints && bundle !== null
    const showBoneLayer = showSkeleton || showConstraints
    const selectedIndex = bundle ? (bundle.boneIndex[state.selectedBone] ?? -1) : -1
    this.boneStroke.visible = showBoneLayer
    this.boneFill.visible = showBoneLayer
    if (showSkeleton && bundle && state.onionSkin) this.drawOnionSkin(this.boneStroke, unitPerPixel)
    if (showBoneLayer && bundle) {
      drawBoneOverlay(this.boneStroke, this.boneFill, bundle.skeleton, bundle.asset.constraints, {
        unitsPerPixel: unitPerPixel,
        selectedBone: selectedIndex,
        hoveredBone: bundle.boneIndex[state.hoveredBone] ?? -1,
        showBones: showSkeleton,
        showConstraints,
        showSlots: false,
        hollowBones: this.hollowBones,
        // 正在拖拽新建骨骼：把待生成的骨骼画成虚线预览
        pendingBone: state.pendingBone
      })
    } else {
      this.boneStroke.clear()
      this.boneFill.clear()
    }

    // 小坐标轴 / 斜切包围盒 / 附件操作器画在最上层（骨骼、网格之后），保证手柄始终可点可看
    this.gizmoStroke.clear()
    this.gizmoFill.clear()
    const attachmentGizmo = state.selectedAttachment
    const showGizmo =
      showBoneLayer && bundle !== null && state.showGizmo && (selectedIndex >= 0 || attachmentGizmo !== null)
    this.gizmoStroke.visible = showGizmo
    this.gizmoFill.visible = showGizmo
    if (showGizmo && bundle) {
      if (attachmentGizmo) {
        // 附件操作器：斜切不支持附件，其余模式照常（中心橙色区分骨骼）
        if (state.gizmo !== 'shear') {
          const frame = attachmentGizmoFrame(
            bundle.skeleton,
            attachmentGizmo.boneIndex,
            attachmentGizmo.position,
            attachmentGizmo.rotation,
            unitPerPixel * GIZMO_AXIS_LENGTH
          )
          if (frame) {
            drawAttachmentGizmo(this.gizmoStroke, this.gizmoFill, frame, state.gizmo, unitPerPixel)
          }
        }
      } else if (state.gizmo === 'shear') {
        // 斜切不用小坐标轴，改成包围盒：鼠标在边上拖动即可变形
        const box = this.shearBoxAt()
        if (box) drawShearBox(this.gizmoStroke, this.gizmoFill, box.corners, unitPerPixel)
      } else {
        drawBoneGizmo(this.gizmoStroke, this.gizmoFill, bundle.skeleton, selectedIndex, state.gizmo, unitPerPixel)
      }
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

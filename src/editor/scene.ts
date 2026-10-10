import { Container, FillGradient, Graphics } from 'pixi.js'
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
  drawDisplayOutline,
  drawGhostBones,
  drawShearBox
} from '@render/overlays/boneOverlay'
import { circlePolygon } from '@render/overlays/shapes'
import type { GizmoDrawMode } from '@render/overlays/boneOverlay'
import { drawMeshOverlay } from '@render/overlays/meshOverlay'
import { BRUSH_MODE_COLORS, brushModeColorValue, weightBoneColorMap } from '@core/weightPalette'
import { BRUSH_FALLOFF_STOPS } from '@editor/commands/authoringCommands'
import type { BrushMode } from '@editor/commands/authoringCommands'
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
import { AttachmentType, attachmentFrameBox } from '@core/model/types'

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
  /**
   * 网格线框 / 顶点**只画这个插槽**（'' = 不限制）。
   *
   * 选择 / Pose 工具由视口按当前选中项填 —— 这两个工具「选中哪个才画哪个」，
   * 而不是把整个角色的 displayObject 都铺上线框。顶点工具不走这里（它用网格隔离，
   * 连其它附件一起隐藏，为的是不被十几层网格互相遮挡）。
   */
  focusMeshSlot: string
  /** 主选中骨骼（操作器轴心、拾取、检查器都看它） */
  selectedBone: string
  /** 选中的骨骼集合（多选）：叠加层把这批骨骼全部画成选中样式 */
  selectedBones: string[]
  hoveredBone: string
  /**
   * 权重刷工具是否激活：**权重着色（顶点饼图）只在它激活时画**。
   *
   * 顶部「权重」开关已移除（与「网格」「FFD」同一处理）：这件事本身就等价于
   * 「正在用权重刷」，不需要用户再手动同步一个开关。
   */
  weightTool: boolean
  selectedVertices: number[]
  hoveredVertex: number
  /**
   * 权重刷的刷子指示（世界坐标 + 半径 + 模式），null = 不显示。
   *
   * 画成一个圆：**圈有多大，刷一下就有多大**（半径与 paintAt 用的是同一个世界值），
   * 颜色跟着模式变（增加绿 / 减少红 / 覆盖蓝）。
   */
  brushRing: { x: number; y: number; radius: number; mode: BrushMode } | null
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
  /**
   * 选中的 display（插槽名 + 附件名）：叠加层沿对象**真实形状**画一圈轮廓。
   *
   * 与 `selectedAttachment`（操作器）分开，是因为两者可见条件不同：轮廓在任何
   * 模式 / 工具下都要画（动画态也得看得出选的是谁），操作器只在 Pose + 选择工具下。
   * null = 不画轮廓。
   */
  selectedDisplay: { slot: string; attachment: string } | null
  /**
   * 鼠标底下的 display（悬停预览）：画一圈**更弱**的轮廓，点下去之前就知道会选中谁。
   * 只在选择工具下计算（其它工具点下去干的是别的事）；null = 不画。
   */
  hoveredDisplay: { slot: string; attachment: string } | null
  /**
   * 当前选中网格**绑定的骨骼**名（检查器「权重骨骼列表」里的那些）：
   * 叠加层把它们换成高亮色画，一眼看出这个网格跟哪几根骨骼有关。
   * 没选中网格 / 网格没有绑定骨骼时为空数组。
   */
  weightBones: string[]
  /**
   * 网格工具（`ffd`）的隔离目标：**只渲染这个插槽的附件**，其余全部隐藏。
   * 空串 = 不隔离（未选中网格 / 其它工具时显示全部）。
   */
  isolateMeshSlot: string
  /** 隔离插槽上要显示的附件名（空串 = 沿用当前显示项） */
  isolateMeshAttachment: string
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
  /** display 轮廓线（选中 + 悬停共用；只描线不填色，画在骨骼之下、网格之上） */
  private readonly outlineStroke = new Graphics()
  /** 骨骼变换小坐标轴（描边 / 填充分开，同 pixi v8 的路径规则） */
  private readonly gizmoStroke = new Graphics()
  private readonly gizmoFill = new Graphics()
  /** 坐标轴：画在棋盘格之上、角色之下 */
  private readonly axes = new Graphics()
  /** 权重刷的刷子指示（软边圆 + 中心点）：画在最上层，它就是个「跟着鼠标的光标」 */
  private readonly brushRing = new Graphics()
  /** 软边圆用的径向渐变（按模式缓存：颜色与停止点都是固定的，与半径无关） */
  private readonly brushGradients = new Map<BrushMode, FillGradient>()
  /** 需要画成空心的骨骼名集合（编辑期模型才有 hollow 字段） */
  private hollowBones = new Set<string>()
  private bundle: RuntimeBundle | null = null
  private view: SkeletonView | null = null
  private document: EditorDocument | null = null
  private skinName = ''
  private animationName: string | null = null
  private dirty = true
  private viewState: SceneViewState = {
    // 网格 / FFD / 权重显示都不看开关：按选中项、工具与权重刷自动决定
    overlay: { bones: true, constraints: true },
    focusMeshSlot: '',
    isolateMeshSlot: '',
    isolateMeshAttachment: '',
    selectedBone: '',
    selectedBones: [],
    hoveredBone: '',
    weightTool: false,
    selectedVertices: [],
    hoveredVertex: -1,
    brushRing: null,
    playing: false,
    speed: 1,
    loop: true,
    time: 0,
    onionSkin: false,
    gizmo: 'move',
    showGizmo: true,
    pendingBone: null,
    selectedAttachment: null,
    selectedDisplay: null,
    hoveredDisplay: null,
    weightBones: []
  }

  constructor(options: EditorSceneOptions) {
    this.textures = options.textures
    this.viewport = new Viewport(options.host)
    this.overlay.addChild(
      this.meshStroke,
      // 轮廓线压在最下面：骨骼与操作器都盖在它之上，手柄不会被描边挡住
      this.outlineStroke,
      this.boneFill,
      this.boneStroke,
      /*
       * 顶点色点（权重着色 / FFD 手柄）画在骨骼**之上**：加权网格的顶点本来就贴着骨骼走，
       * 压在下面的话黄色关节与绿色高亮骨骼正好盖住色点 —— 实测采样到的是关节色而不是权重色。
       * 仍然压在操作器之下，免得挡住 gizmo 的抓取。
       */
      this.meshFill,
      this.gizmoFill,
      this.gizmoStroke,
      this.brushRing
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

  /**
   * 网格工具的「隔离显示」：**只渲染当前选中的那个网格**，其余附件全部跳过。
   *
   * 复杂角色上十几个网格彼此遮挡，顶点 / 线框 / 贴图叠成一片，看不出在编哪一个；
   * 隔离后画面里只剩目标网格，拖顶点、看权重都干净。未选中、选中的不是网格、
   * 或换到别的工具时自动恢复显示全部。
   *
   * `isolateMeshSlot` 存的是插槽**名**（附件名会随皮肤切换变化，插槽名稳定），
   * 每帧解析一次的开销可以忽略；`setIsolation` 内部做去重，值不变时不会触发重建。
   */
  private applyMeshIsolation(): void {
    const view = this.view
    if (!view) return
    const name = this.viewState.isolateMeshSlot
    let index = -1
    let display = -1
    if (name && this.bundle) {
      const found = this.bundle.asset.slots.findIndex((slot) => slot.name === name)
      if (found >= 0) {
        // 优先用**选中的那个附件**（按名查显示下标）—— 选中不等于它在显示，
        // 不指定的话隔离出来可能还是旧的显示项
        const wanted = this.viewState.isolateMeshAttachment
        const byName = wanted ? view.meshBuilder.attachmentIndexOf(found, wanted) : -1
        const current = byName >= 0 ? byName : this.bundle.skeleton.slotDisplayIndex[found]
        const attachment = this.attachmentAt(found, current)
        if (attachment && attachment.type === AttachmentType.Mesh) {
          index = found
          display = byName
        }
      }
    }
    view.setIsolation(index, display)
  }

  setViewState(patch: Partial<SceneViewState>): void {
    const previousSelected = this.viewState.selectedBone
    const previousSelectedBones = this.viewState.selectedBones.join(',')
    const previousTime = this.viewState.time
    const wasPlaying = this.viewState.playing
    this.viewState = { ...this.viewState, ...patch }
    // 选中集合是数组，每次渲染都是新引用：按内容比，免得无变化也重画一帧
    const selectedBonesChanged =
      patch.selectedBones !== undefined && patch.selectedBones.join(',') !== previousSelectedBones
    if (
      patch.selectedBone !== undefined ||
      selectedBonesChanged ||
      patch.hoveredBone !== undefined ||
      patch.weightBones !== undefined
    ) {
      void previousSelected
      this.markDirty()
    }
    if (patch.overlay || patch.selectedVertices || patch.hoveredVertex !== undefined) this.markDirty()
    // 刷子半径圈跟着鼠标走，每帧都可能变（拖动 / 修饰键切换模式）
    if (patch.brushRing !== undefined) this.markDirty()

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

    // 网格工具的隔离显示：只渲染当前选中的那个网格（值不变时内部直接返回）
    this.applyMeshIsolation()

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

  /**
   * 某插槽**当前显示附件**的世界矩阵（按插槽名取）。
   *
   * 与 `attachmentWorldAt` 的区别只是入参：那个要运行期下标，这个给面板用（面板手上只有名字）。
   * 名字不存在或该插槽此刻不显示附件时返回 null —— 调用方可以退回宿主骨骼。
   */
  attachmentWorldByName(slotName: string): Float32Array | null {
    const bundle = this.bundle
    if (!bundle) return null
    const index = bundle.asset.slots.findIndex((slot) => slot.name === slotName)
    if (index < 0) return null
    return this.attachmentWorldAt(index)
  }

  /**
   * 把某块世界范围摆到视口**中央**（层级树里双击骨骼 / display / 约束时用）。
   *
   * 与 `fit` 的区别：fit 是「世界原点固定在屏幕中心、按内容半径定缩放」；
   * 这里是「目标点居中」—— 双击一个偏在一角的节点，希望它出现在正中间。
   */
  frameContent(worldX: number, worldY: number, contentWidth: number, contentHeight: number, fill = 0.5): void {
    this.viewport.frame(worldX, worldY, contentWidth, contentHeight, fill)
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
    // 只画选中的那一个时，也只让那一个的顶点可抓 —— 否则会拖到看不见（甚至没画出来）的顶点
    return pickVertex(this.meshResult, worldX, worldY, this.viewport.pixelsToWorld(9), this.editingSlotIndex())
  }

  /**
   * `focusMeshSlot` 对应的插槽下标（空串 / 名字不存在时 -1）。
   *
   * 只有**选择 / Pose 工具**会填它 —— 用来把顶点圆点按网格尺寸定大小（见 drawOverlays）。
   */
  private focusSlotIndex(): number {
    return this.slotIndexByName(this.viewState.focusMeshSlot)
  }

  /**
   * **在编辑谁**的插槽下标（-1 = 不限制）。覆盖层「画谁」与顶点拾取「抓谁」共用它，
   * 两处必须一致 —— 否则会拖到根本没画出来的顶点：
   * - 选择 / Pose 工具：选中项（`focusMeshSlot`）；
   * - 顶点工具：选中的附件（`isolateMeshSlot`）—— 即便它是 Region、不会真隔离
   *  （见 applyMeshIsolation），也只画它自己的顶点；否则整个角色的顶点会一起铺出来。
   */
  private editingSlotIndex(): number {
    return this.slotIndexByName(this.viewState.isolateMeshSlot || this.viewState.focusMeshSlot)
  }

  private slotIndexByName(name: string): number {
    if (!name || !this.bundle) return -1
    return this.bundle.asset.slots.findIndex((slot) => slot.name === name)
  }

  /**
   * 把「共享顶点缓冲里的下标」换算成**附件自己的顶点下标**（同时给出它属于哪个插槽 / 附件）。
   *
   * 视口点选返回的是共享缓冲下标（按插槽分组的合并结果），而顶点编辑命令
   * （删顶点 / 权重 / FFD）操作的是附件内部的顶点数组 —— 两者不能混用：
   * 直接拿共享下标去删，要么越界（表现为「删除失败」），要么删到别的附件上。
   */
  vertexRefAt(vertexIndex: number): { slot: string; attachment: string; vertex: number } | null {
    const mesh = this.meshResult
    const bundle = this.bundle
    if (!mesh || !bundle || vertexIndex < 0 || vertexIndex >= mesh.vertexCount) return null
    const slotIndex = mesh.sourceSlot[vertexIndex]
    const slotData = bundle.asset.slots[slotIndex]
    if (!slotData) return null
    const display = bundle.skeleton.slotDisplayIndex[slotIndex]
    const current = this.attachmentAt(slotIndex, display)
    if (!current) return null
    return { slot: slotData.name, attachment: current.name, vertex: mesh.sourceVertex[vertexIndex] }
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
   * display 的轮廓路径（**世界坐标**），给轮廓叠加层用。
   *
   * - **Region**：`size` 的矩形四角。区域顶点按 ±size/2 生成（见 meshBuilder），
   *   所以局部四角是固定的，乘附件世界矩阵即可 —— 矩形跟着附件旋转，不是轴对齐框。
   * - **Mesh**：从**已构建的三角形**里求「边界边」—— 只被一个三角形用到的边就是外轮廓。
   *   坐标取已构建的顶点：加权蒙皮的顶点位置只有那里是对的，附件里的 `vertices`
   *   是绑定空间数据，直接变换会画到别处。
   *
   * **不能按 `hull` 取前 N 个顶点连折线**：自动建网会把 hull 写成顶点总数
   * （见 autoMesh.ts 的 `hull: vertices.length`），那样连线会穿过内部顶点，
   * 在网格内部画出一团交叉线（这正是之前那个皇冠的样子）。
   *
   * 顶点按世界坐标焊接：UV 接缝处常有位置重复的顶点，不合并就会算出假边界。
   * 选中项此刻没显示（displayIndex 被关键帧切走）或数据不全时返回 null（不画）。
   */
  private displayOutlinePaths(
    slotName: string,
    attachmentName: string
  ): Array<Array<{ x: number; y: number }>> | null {
    const bundle = this.bundle
    if (!bundle) return null
    const slotIndex = bundle.asset.slots.findIndex((slot) => slot.name === slotName)
    if (slotIndex < 0) return null
    const displayIndex = bundle.skeleton.slotDisplayIndex[slotIndex]
    const attachment = this.attachmentAt(slotIndex, displayIndex)
    // 选中的那个此刻没显示就别画，免得轮廓圈在别的对象上
    if (!attachment || attachment.name !== attachmentName) return null
    const world = this.attachmentWorldAt(slotIndex)
    if (!world) return null

    if (attachment.vertices.length === 0) {
      /*
       * 画的是**原图框**：被裁剪的图（图集里只存了有像素的那块）按原图尺寸 + 中心位移画，
       * 轮廓 / 变换手柄于是包含被裁掉的空白 —— 与 DragonBones / Spine 编辑器里的显示一致。
       * 渲染不受影响：四边形仍按 `size`（内容）画，空白不会被画出来。
       */
      const box = attachmentFrameBox(attachment)
      const halfWidth = box.size.x * 0.5
      const halfHeight = box.size.y * 0.5
      const corners = [
        { x: box.center.x - halfWidth, y: box.center.y - halfHeight },
        { x: box.center.x + halfWidth, y: box.center.y - halfHeight },
        { x: box.center.x + halfWidth, y: box.center.y + halfHeight },
        { x: box.center.x - halfWidth, y: box.center.y + halfHeight }
      ]
      const rect = corners.map((corner) => ({
        x: world[0] * corner.x + world[4] * corner.y + world[12],
        y: world[1] * corner.x + world[5] * corner.y + world[13]
      }))
      return [rect]
    }

    const result = this.meshResult
    if (!result || result.vertexCount === 0) return null

    // 本插槽的顶点 → 世界坐标 + 焊接 id（同一位置只留一份）
    const weldOfBuilt = new Map<number, number>()
    const weldedAt: Array<{ x: number; y: number }> = []
    const idByKey = new Map<string, number>()
    for (let i = 0; i < result.vertexCount; i++) {
      if (result.sourceSlot[i] !== slotIndex) continue
      const x = result.positions[i * 2]
      const y = result.positions[i * 2 + 1]
      const key = `${Math.round(x * 1000)}:${Math.round(y * 1000)}`
      let id = idByKey.get(key)
      if (id === undefined) {
        id = weldedAt.length
        idByKey.set(key, id)
        weldedAt.push({ x, y })
      }
      weldOfBuilt.set(i, id)
    }
    if (weldedAt.length < 3) return null

    // 统计边：三角形三条边各记一次，最后只出现一次的即边界（内部边被两个三角形共享）
    const edgeCount = new Map<string, number>()
    const edgeEnds = new Map<string, [number, number]>()
    for (const group of result.groups) {
      const indices = group.indices
      for (let i = 0; i + 2 < group.indexCount; i += 3) {
        const a = weldOfBuilt.get(indices[i])
        const b = weldOfBuilt.get(indices[i + 1])
        const c = weldOfBuilt.get(indices[i + 2])
        // 三角形跨插槽（同图集页多附件混排）时跳过：只统计完全属于本插槽的
        if (a === undefined || b === undefined || c === undefined) continue
        const tri: Array<[number, number]> = [
          [a, b],
          [b, c],
          [c, a]
        ]
        for (const [u, v] of tri) {
          const key = u < v ? `${u}-${v}` : `${v}-${u}`
          edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1)
          if (!edgeEnds.has(key)) edgeEnds.set(key, [u, v])
        }
      }
    }

    const paths: Array<Array<{ x: number; y: number }>> = []
    for (const [key, count] of edgeCount) {
      if (count !== 1) continue
      const ends = edgeEnds.get(key)
      if (!ends) continue
      const from = weldedAt[ends[0]]
      const to = weldedAt[ends[1]]
      if (from && to) paths.push([from, to])
    }
    return paths.length > 0 ? paths : null
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
      // 被裁剪的图按**原图**算包围盒（含空白），否则变换框会比图小一圈
      const box = attachmentFrameBox(attachment)
      if (box.size.x > 0 && box.size.y > 0) {
        const hw = box.size.x * 0.5
        const hh = box.size.y * 0.5
        push(box.center.x - hw, box.center.y - hh)
        push(box.center.x + hw, box.center.y - hh)
        push(box.center.x + hw, box.center.y + hh)
        push(box.center.x - hw, box.center.y + hh)
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
   *
   * 坐标轴是**基础参照**，与「骨骼 / 网格 / 约束」这些辅助显示开关**无关，一直显示**：
   * 早先它跟着「骨骼」开关走，导入资源后为了看清角色把骨骼关掉，坐标轴也跟着消失，
   * 看起来就像"xy 不见了"。
   */
  private drawAxes(): void {
    const g = this.axes
    g.clear()
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

  /**
   * 软边圆用的径向渐变（按模式缓存）。
   *
   * 停止点取自落笔的衰减曲线（`BRUSH_FALLOFF_STOPS`：距圆心比例 → 相对强度），强度折算成
   * alpha —— 于是**屏幕上看到的那团明暗就是实际刷出来的强度分布**，改曲线两边一起变。
   * 颜色用 8 位十六进制（`#RRGGBBAA`）把 alpha 编进去：渐变的颜色停止点没有独立的 alpha 字段。
   * 坐标按形状包围盒归一化（0..1），与半径、缩放无关 —— 所以一个模式只建一次就够。
   */
  private brushGradient(mode: BrushMode): FillGradient {
    const cached = this.brushGradients.get(mode)
    if (cached) return cached
    const rgb = BRUSH_MODE_COLORS[mode].slice(1)
    /** 圆心处的不透明度：够看清这团软边，又不遮住底下要刷的图 */
    const maxAlpha = 0.38
    const gradient = new FillGradient({
      type: 'radial',
      center: { x: 0.5, y: 0.5 },
      innerRadius: 0,
      outerRadius: 0.5,
      colorStops: BRUSH_FALLOFF_STOPS.map(([offset, strength]) => {
        const byte = Math.round(Math.max(0, Math.min(1, strength)) * maxAlpha * 255)
        return { offset, color: `#${rgb}${byte.toString(16).padStart(2, '0')}` }
      })
    })
    this.brushGradients.set(mode, gradient)
    return gradient
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
    // 多选高亮：名字 → 索引（已删除的骨骼自动略过），主选中一定在里面
    const selectedBoneIndices = new Set<number>()
    if (bundle) {
      for (const name of state.selectedBones) {
        const index = bundle.boneIndex[name] ?? -1
        if (index >= 0) selectedBoneIndices.add(index)
      }
      if (selectedIndex >= 0) selectedBoneIndices.add(selectedIndex)
    }
    /*
     * 选中网格绑定的骨骼：名字 → 索引（已被删除的骨骼自动略过），并按它在「权重骨骼列表」
     * 里的**位置**取配色（见 weightPalette）。
     *
     * 这份映射**两处共用**：骨骼覆盖层把这几根画成各自的颜色，网格覆盖层的权重饼图用同一组色
     * —— 于是「面板里那一行的色块」「视口里那根骨骼」「顶点饼图里的那一瓣」三者一个色，
     * 不用再靠记忆去对（原来骨骼是一个统一的绿，跟饼图对不上）。
     */
    const weightBoneColors = bundle
      ? weightBoneColorMap(state.weightBones, bundle.boneIndex)
      : new Map<number, number>()
    this.boneStroke.visible = showBoneLayer
    this.boneFill.visible = showBoneLayer
    if (showSkeleton && bundle && state.onionSkin) this.drawOnionSkin(this.boneStroke, unitPerPixel)
    if (showBoneLayer && bundle) {
      drawBoneOverlay(this.boneStroke, this.boneFill, bundle.skeleton, bundle.asset.constraints, {
        unitsPerPixel: unitPerPixel,
        selectedBones: selectedBoneIndices,
        hoveredBone: bundle.boneIndex[state.hoveredBone] ?? -1,
        weightBoneColors,
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

    /*
     * display 轮廓线：选中（亮）与悬停（弱）**共用同一个 Graphics** —— 两条路径可以同时存在，
     * 「选中 A、鼠标悬在 B 上」时两个圈都在，谁是选中的一眼可辨。
     *
     * 只描线不填色：填色会盖住贴图本身的颜色与细节，调位置 / 看 UV 时反而碍事。
     * 轮廓压在最下面（骨骼与操作器都盖在它之上），任何模式 / 工具下都给。
     */
    this.outlineStroke.clear()
    const selectedDisplay = state.selectedDisplay
    const hoveredDisplay = state.hoveredDisplay
    const outlineVisible =
      showBoneLayer && bundle !== null && (selectedDisplay !== null || hoveredDisplay !== null)
    this.outlineStroke.visible = outlineVisible
    if (outlineVisible) {
      if (selectedDisplay) {
        const outline = this.displayOutlinePaths(selectedDisplay.slot, selectedDisplay.attachment)
        if (outline) drawDisplayOutline(this.outlineStroke, outline, unitPerPixel)
      }
      // 悬停预览用同一套形状计算，只是更弱、更细；正悬在已选中那个上就跳过（那圈已经够亮）
      const hoveredIsSelected =
        hoveredDisplay !== null &&
        selectedDisplay !== null &&
        hoveredDisplay.slot === selectedDisplay.slot &&
        hoveredDisplay.attachment === selectedDisplay.attachment
      if (hoveredDisplay && !hoveredIsSelected) {
        const outline = this.displayOutlinePaths(hoveredDisplay.slot, hoveredDisplay.attachment)
        if (outline) {
          drawDisplayOutline(this.outlineStroke, outline, unitPerPixel, { strokeAlpha: 0.5, width: 1.2 })
        }
      }
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

    /*
     * 权重刷的刷子指示：**圈有多大，刷一下就有多大**（半径与 paintAt 用的是同一个世界值），
     * 颜色 = 当前模式（增加绿 / 减少红 / 覆盖蓝，与鼠标光标同源，见 BRUSH_MODE_COLORS）。
     * 画在最上层 —— 它本质是个「跟着鼠标走的光标」。
     */
    const ring = state.brushRing
    this.brushRing.clear()
    this.brushRing.visible = ring !== null
    if (ring) {
      const color = brushModeColorValue(ring.mode)
      /*
       * Photoshop 那样的软边圆：**一整片径向渐变**（中心浓、边缘透明），不做等强线分层。
       * 明暗分布直接取落笔的衰减曲线（见 BRUSH_FALLOFF_STOPS），且按形状包围盒归一化，
       * 所以半径 / 缩放怎么变，这团软边的相对形状都一样。
       * 外沿再描一圈实线当边界 —— 圈外一个顶点都不碰。
       */
      this.brushRing
        .poly(circlePolygon(ring.x, ring.y, ring.radius))
        .fill(this.brushGradient(ring.mode))
        .stroke({ width: unitPerPixel * 1.2, color, alpha: 0.8 })
      // 落点（鼠标精确位置）
      this.brushRing.poly(circlePolygon(ring.x, ring.y, unitPerPixel * 2)).fill({ color, alpha: 0.85 })
    }

    /*
     * 网格层什么时候画、画谁：
     *
     * - **顶点工具（隔离中）**：强制显示 —— 工具本身就在编这个网格，「看不见网格线」说不过去；
     * - **选择 / Pose 工具**：只画**选中的那个插槽**（`focusMeshSlot`，视口按选中项填）。
     *   原来有个全局「网格」开关，一开就是把所有 displayObject 都铺上线框，已移除；
     * - **权重 / FFD 显示层**：照旧全局（那两层的语义是看权重、看 FFD 偏移，不是选谁画谁）。
     */
    const isolating = (this.view?.meshBuilder.isolateSlot ?? -1) >= 0
    const focusSlot = this.focusSlotIndex()
    /*
     * **在编辑谁**：选择 / Pose 工具取选中项，顶点工具取选中的附件（见 editingSlotIndex）。
     *
     * 为什么不能只靠 `isolating`：隔离只对 **Mesh** 成立（见 applyMeshIsolation），Region 走不到
     * 那里 —— 而顶点工具也要能编 Region（转网格前后都要看得到顶点）。原来这份「看得到」是靠顶部
     * 「FFD」开关撑着的，那个开关已移除（与「网格」开关同一处理）：显示跟着工具走，不需要手动开。
     */
    const editingSlot = this.editingSlotIndex()
    const showMesh = (editingSlot >= 0 || isolating) && bundle !== null
    this.meshStroke.visible = showMesh
    this.meshFill.visible = showMesh
    if (!showMesh || !bundle) {
      this.meshStroke.clear()
      this.meshFill.clear()
      return
    }
    /*
     * 顶点圆点的半径（世界单位）：
     * - **顶点工具（隔离中）**：固定 5 屏幕像素 —— 那是可拖的手柄，缩多远都要抓得住；
     * - **选择 / Pose 工具**：按**网格自身尺寸**取固定值（顶点包围盒最长边的 2%），
     *   不为视口缩放做补偿 —— 放大时点跟着网格一起变大，缩小时一起变小。
     *   这两类工具下顶点只是"标出位置"，跟着内容走比固定屏幕尺寸更直观。
     *   2% 是按「适配视口时直径约 10px」定的（与之前的屏幕恒定尺寸观感一致）。
     */
    let vertexRadius = unitPerPixel * 5
    if (!isolating && focusSlot >= 0) {
      /*
       * 基准取**整个角色**的包围盒（不是选中的那个网格）：按网格算的话，切到一个零件网格
       * （比如长矛前端的小块）点时大小会忽然变成针尖。这圈点只是"标出顶点在哪"，
       * 同一屏里大小一致更重要。
       */
      const positions = this.meshResult?.positions
      if (positions) {
        let minX = Number.POSITIVE_INFINITY
        let minY = Number.POSITIVE_INFINITY
        let maxX = Number.NEGATIVE_INFINITY
        let maxY = Number.NEGATIVE_INFINITY
        const count = this.meshResult?.vertexCount ?? 0
        for (let i = 0; i < count; i++) {
          const x = positions[i * 2]
          const y = positions[i * 2 + 1]
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
        const extent = Math.max(maxX - minX, maxY - minY)
        if (extent > 1e-6) {
          /*
           * 世界半径跟着网格走，但**屏幕尺寸夹在 6~14px 之间**：
           * 高倍缩放下纯世界尺寸会失控（实测放大到局部时，点直径涨到好几百像素，整屏都被糊住），
           * 缩得很远时又会小到看不见。夹取之后两头都保得住，中间段仍随缩放变化。
           */
          const zoom = this.viewport.zoom
          const screenRadius = Math.min(3, Math.max(3, extent * 0.02 * zoom))
          vertexRadius = screenRadius / Math.max(1e-6, zoom)
        }
      }
    }
    drawMeshOverlay(
      this.meshStroke,
      this.meshFill,
      bundle.skeleton,
      this.meshResult,
      (slotIndex, displayIndex) => this.attachmentAt(slotIndex, displayIndex),
      {
        unitsPerPixel: unitPerPixel,
        showWireframe: isolating || editingSlot >= 0,
        showVertices: isolating || editingSlot >= 0,
        // 隔离本身就只构建了那一个插槽，不需要再过滤；顶点工具下的 Region 靠它只画选中那一个
        onlySlot: isolating ? -1 : editingSlot,
        vertexRadius,
        // 权重着色（饼图）跟着权重刷工具走：顶部「权重」开关已移除
        showWeights: state.weightTool,
        weightBoneColors,
        selectedVertices: new Set(state.selectedVertices),
        hoveredVertex: state.hoveredVertex
      }
    )
  }
}

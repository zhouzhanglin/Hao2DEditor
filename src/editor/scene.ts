import { Container, FillGradient, Graphics, Sprite, Texture } from 'pixi.js'
import { MAT4_LENGTH, decomposeTrs, invert, mul, mulPoint, trs } from '@core/math/matrix'
import type { Vec2 } from '@core/math/matrix'
import { Viewport } from '@render/viewport'
import { SkeletonView } from '@render/skeletonView'
import type { TextureStore } from '@render/material'
import { destroyTexture } from '@render/material'
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
  drawShearBox,
  GHOST_NEXT_COLOR,
  GHOST_PREV_COLOR
} from '@render/overlays/boneOverlay'
import { DEFAULT_BONE_STYLE } from '@render/overlays/boneStyle'
import type { BoneOverlayStyle } from '@render/overlays/boneStyle'
import { circlePolygon } from '@render/overlays/shapes'
import type { GizmoDrawMode } from '@render/overlays/boneOverlay'
import { drawMeshOverlay } from '@render/overlays/meshOverlay'
import { BRUSH_MODE_COLORS, brushModeColorValue, weightBoneColorMap } from '@core/weightPalette'
import { brushFalloffStops } from '@editor/commands/authoringCommands'
import type { BrushMode } from '@editor/commands/authoringCommands'
import {
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

/**
 * 网格子工具正在画的折线颜色（绘制边界 / 自定义布线）。
 * 取亮青色：与网格线框（灰）、骨骼（黄）、权重（红绿蓝）都不撞色，压在网格上也看得清。
 */
const MESH_PATH_COLOR = 0x38bdf8

/**
 * 「自己绘制边界」时画的那个**图片 region 框**（原图框）的颜色：中性浅灰白，不跟贴图内容抢眼，
 * 也跟网格线框（灰蓝）、正在画的折线（亮青）区分得开。底下垫一圈深色描边，深浅背景上都看得见。
 */
const REGION_FRAME_COLOR = 0xe2e8f0

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
import type { AuthoringAttachment, EditorDocument, StageImage } from '@core/model/authoring'
import { animationDuration, applyPreviewSlotColors, applyValueChanges, buildRuntime, needsRebuild } from './runtime'
import type { RuntimeBundle } from './runtime'
import { useProjectStore } from './store/projectStore'
import type { NestRuntime } from '@core/nesting/nestRuntime'
import type { OverlayState } from './store/toolStore'

export interface SceneViewState {
  overlay: OverlayState
  /** 舞台参考图（背景，仅编辑器用）：null = 没设置；贴图由 ViewportCanvas 异步喂进来 */
  stage: StageImage | null
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
   * 权重刷的刷子指示（世界坐标 + 半径 + 模式 + Feather），null = 不显示。
   *
   * 画成一个圆：**圈有多大，刷一下就有多大**（半径与 paintAt 用的是同一个世界值），
   * 圈内的软边按 Feather 衰减（见 brushFalloffStops），颜色跟着模式变（增加绿 / 减少红 / 覆盖蓝）。
   */
  brushRing: { x: number; y: number; radius: number; mode: BrushMode; feather: number } | null
  /**
   * 网格顶点的**框选矩形**（世界坐标）：顶点工具在空白处左键拖动时显示。
   * null = 没在框选。松手后由工具按它算选中哪些顶点。
   */
  vertexBox: { x0: number; y0: number; x1: number; y1: number } | null
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
   * 权重刷 / 直接拖动的**目标骨骼**名（'' = 没有）。
   *
   * 与 `selectedBone` 分开：选了顶点后 `kind` 变成 `attachment`、`selectedBones` 变空，
   * 但「正在改哪根骨骼的权重」并没有变 —— 这根必须一直画出来，否则用户不知道在给谁调权重。
   */
  weightTargetBone: string
  /**
   * 网格工具（`ffd`）的隔离目标：**只渲染这个插槽的附件**，其余全部隐藏。
   * 空串 = 不隔离（未选中网格 / 其它工具时显示全部）。
   */
  isolateMeshSlot: string
  /** 隔离插槽上要显示的附件名（空串 = 沿用当前显示项） */
  isolateMeshAttachment: string
  /**
   * 网格子工具正在画的折线预览（绘制边界 / 自定义布线），null = 没在画。
   *
   * 点存的是**附件显示空间**坐标（与 `attachment.vertices` 同一坐标系），画的时候才按附件
   * 世界矩阵变换到世界坐标 —— 于是它跟网格顶点永远对齐（摆 POSE、切动画都不会错位）。
   */
  pendingMeshPath: PendingMeshPath | null
  /**
   * 「自己绘制边界」正在给哪个**网格附件**画（Pose 态 + 网格工具 + 该子工具，选中项是网格时才有值）。
   *
   * 有值期间视口会把旧网格的形状整个让开：**不画网格线框、不画顶点、也不画它的选中轮廓**，
   * 改成画图片的 region 框（见 `drawBoundaryFrame`）。理由：重画边界时旧网格的形状与顶点全是
   * 干扰 —— 用户只需要知道「图片范围在哪、笔尖要落在里面」（点子工具的落点也会被夹进这个框）。
   */
  boundaryTarget: { slot: string; attachment: string } | null
  /**
   * 遮罩工具正在画的多边形（世界坐标）：`points` 已落点，`cursor` 是橡皮筋末端。
   * 与 `pendingMeshPath` 分开：遮罩点存世界坐标，提交时才换算到骨骼局部空间。
   */
  pendingMaskPath: {
    slot: string
    target: string
    points: Vec2[]
    cursor: Vec2 | null
    /**
     * 草稿里属于「原多边形」的点数。
     * 在已有遮罩上追加点时，Ctrl+Z 只应撤回本次新增的点，不能把原多边形也吃掉。
     */
    baseCount: number
  } | null
  /** 遮罩工具当前选中的控制点（用于高亮 / Delete 删除）；索引只在该附件内有效 */
  maskPoint: { slot: string; attachment: string; index: number } | null
}

/**
 * 网格子工具（绘制边界 / 自定义布线）正在画的折线：
 * `points` 是已经落下的点，`cursor` 是当前光标位置（画橡皮筋用），都是附件显示空间坐标。
 */
export interface PendingMeshPath {
  slot: string
  attachment: string
  points: Vec2[]
  cursor: Vec2 | null
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
  /** 骨骼叠加层样式（「全局设置 → 骨骼样式」）：拾取容差与绘制共用同一份 */
  private boneStyle: BoneOverlayStyle = { ...DEFAULT_BONE_STYLE }

  // 描边与填充必须分开（pixi v8 中 stroke 后的路径仍会被后续 fill 填充）
  private readonly meshStroke = new Graphics()
  private readonly meshFill = new Graphics()
  private readonly boneStroke = new Graphics()
  private readonly boneFill = new Graphics()
  /**
   * 洋葱皮：前后帧的幽灵骨骼。**必须独立成层** —— 骨骼层每次重绘都会 `clear()`，
   * 幽灵画进 boneStroke 会被紧接着的 drawBoneOverlay 当场擦掉（开了洋葱皮看不到东西）。
   */
  private readonly ghostBones = new Graphics()
  /** display 轮廓线（选中 + 悬停共用；只描线不填色，画在骨骼之下、网格之上） */
  private readonly outlineStroke = new Graphics()
  /** 骨骼变换小坐标轴（描边 / 填充分开，同 pixi v8 的路径规则） */
  private readonly gizmoStroke = new Graphics()
  private readonly gizmoFill = new Graphics()
  /** 坐标轴：画在棋盘格之上、角色之下 */
  private readonly axes = new Graphics()
  /** 权重刷的刷子指示（软边圆 + 中心点）：画在最上层，它就是个「跟着鼠标的光标」 */
  private readonly brushRing = new Graphics()
  /** 顶点框选矩形：与刷子圈同一层（跟着鼠标走的临时指示） */
  private readonly vertexBox = new Graphics()
  /** 「自己绘制边界」时提示范围的图片 region 框（画在折线之下） */
  private readonly regionFrame = new Graphics()
  /** 网格子工具正在画的折线（画边界 / 自定义布线）：同样画在最上层 */
  private readonly meshPath = new Graphics()
  /** 遮罩：半透明填充 / 轮廓 / 控制点（画在角色之上、操作器之下） */
  private readonly maskFill = new Graphics()
  private readonly maskStroke = new Graphics()
  private readonly maskPoints = new Graphics()
  /**
   * 舞台参考图（背景）：挂在 `viewport.stageLayer`（棋盘格之上、坐标轴与角色之下）。
   * 贴图由 ViewportCanvas 异步加载后经 `setStageTexture` 喂进来；配置每帧应用（改弹窗实时生效）。
   */
  private readonly stageSprite = new Sprite()
  /** 软边圆用的径向渐变（按「模式 + Feather」缓存：颜色与停止点固定，与半径无关） */
  private readonly brushGradients = new Map<string, FillGradient>()
  /** 需要画成空心的骨骼名集合（编辑期模型才有 hollow 字段） */
  private hollowBones = new Set<string>()
  private bundle: RuntimeBundle | null = null
  private view: SkeletonView | null = null
  private document: EditorDocument | null = null
  private skinName = ''
  /**
   * 嵌套骨架的子视图。key = 层级路径 + `slotIndex|displayIndex`
   * （A 挂 B、B 挂 C 时 C 的 key 形如 `7|0/2|1`，用 `/` 分层）。
   * 复用规则：同一路径只建一次，结构变化（换 display / 换骨架）才重建。
   */
  private readonly nestedViews = new Map<string, { view: SkeletonView; child: NestRuntime }>()
  /** 子骨架上一帧的动画时间：用于判断要不要重算子网格（避免空闲时每帧重建） */
  private readonly nestedTimes = new Map<string, number>()
  /** 当前整体染色（子视图要自己再乘一遍：它的 MeshBuilder 与父视图不共享 tint） */
  private tint = { r: 1, g: 1, b: 1, a: 1 }
  private animationName: string | null = null
  private dirty = true
  private viewState: SceneViewState = {
    // 网格 / FFD / 权重显示都不看开关：按选中项、工具与权重刷自动决定
    overlay: { bones: true, constraints: true },
    stage: null,
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
    vertexBox: null,
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
    weightBones: [],
    weightTargetBone: '',
    pendingMeshPath: null,
    boundaryTarget: null,
    pendingMaskPath: null,
    maskPoint: null
  }

  constructor(options: EditorSceneOptions) {
    this.textures = options.textures
    this.viewport = new Viewport(options.host)
    this.overlay.addChild(
      this.meshStroke,
      // 轮廓线压在最下面：骨骼与操作器都盖在它之上，手柄不会被描边挡住
      this.outlineStroke,
      // 洋葱皮的幽灵骨骼压在当前骨骼之下：真人骨骼盖住幽灵，对比更清楚
      this.ghostBones,
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
      this.brushRing,
      this.vertexBox,
      this.regionFrame,
      this.meshPath,
      this.maskFill,
      this.maskStroke,
      this.maskPoints
    )
    this.viewport.overlayLayer.addChild(this.overlay)
    this.viewport.axisLayer.addChild(this.axes)
    this.viewport.stageLayer.addChild(this.stageSprite)
  }

  /** 换舞台参考图的贴图（ViewportCanvas 加载完成后调用；null = 清掉） */
  setStageTexture(texture: Texture | null): void {
    const prev = this.stageSprite.texture
    this.stageSprite.texture = texture ?? Texture.EMPTY
    // 旧贴图是我们自己 new 出来的，换掉就没人引用了，销毁掉避免 GPU 资源泄漏
    //（走 `destroyTexture`：舞台图常被渲染过，直接 destroy 会触发 pixi 的 bindGroup 误报）
    if (prev && prev !== Texture.EMPTY && prev !== texture) destroyTexture(prev)
    this.dirty = true
  }

  /**
   * 骨骼叠加层样式（「全局设置 → 骨骼样式」，见 `boneStyle.ts`）。
   * 与视口状态无关、也不进文档：改的只是视口里骨骼的长相，导出数据不受影响。
   */
  setBoneStyle(style: BoneOverlayStyle): void {
    this.boneStyle = { ...DEFAULT_BONE_STYLE, ...style }
    // 叠加层每帧都会重画，这里只保证画面真的刷新出来
    this.markDirty()
  }

  /**
   * 拖动中的颜色预览：`{ 插槽名: '#RRGGBBAA' }`，只改运行期（文档 / 历史 / 面板都不动）。
   *
   * 配合 `previewStore`：拖动期间颜色只写这里，于是不再每帧深拷贝文档、不再重建运行期、
   * 也不会让订阅 `document` 的面板（时间轴 / 层级树 / 检查器…）整棵重渲染 —— 拖动卡顿的主因。
   * 松手时调用方把最终值提交进文档（一条撤销记录）并清空预览；因为提交值与预览值相同，
   * 画面上不会闪一下。
   */
  setPreviewSlotColors(colors: Record<string, string>): void {
    const bundle = this.bundle
    if (!bundle) return
    if (applyPreviewSlotColors(bundle, colors)) this.invalidateSkin()
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
    // 工程内其它骨架：解析 `subArmature` 引用（同时参与重建判定：子骨架改了父骨架要刷新）
    const skeletons = useProjectStore.getState().skeletons
    if (needsRebuild(this.bundle, doc, skinName, skeletons)) {
      const previousAnimation = this.animationName
      const previousTime = this.viewState.time
      // 先构建新运行时，成功了再替换：编译中途抛错时保持原样，
      // 否则会留下「视图已销毁、新运行时没建起来」的状态，网格从此不再显示
      const nextBundle = buildRuntime(doc, skinName, { skeletons })
      // 先把旧视图从显示列表摘掉，**再**销毁它。
      //
      // 顺序反了会崩：`view.destroy()` 会释放 GPU buffer，而此时旧视图仍挂在
      // contentLayer 上，pixi 这一帧的渲染指令还引用着那些 buffer —— 渲染时读到
      // null，抛 `Cannot read properties of null (reading 'usage')`，异常冒到
      // requestAnimationFrame 循环外层，整个视口就此定格（改 slot 层级 / 任何
      // 触发重建的编辑都会复现）。
      const previousView = this.view
      if (previousView) {
        // 子视图归 Scene 管：先销毁（并从父容器里摘掉），再销毁父视图，避免父容器
        // removeChildren 之后子容器变成没人释放的孤儿（GPU buffer 泄漏）
        this.clearNestedViews()
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
      } else {
        /*
         * Pose 态（没选动画）：没有人推进播放器，而**新建出来的运行时不会自己求解约束**
         * —— 不补这一步，新建 / 编辑 IK 约束后视口永远看不到效果（表现为「IK 完全没反应」）。
         * `refresh()` 在没有当前动画时就是「重算 FK + 求解约束」，不会动绑定姿态。
         */
        this.bundle.player.refresh()
      }
      this.markDirty()
    } else {
      // 只改了「值」（目前是插槽颜色）：运行期原地更新，**不重建**。
      // 重建是全量重编译 + 销毁重建视图 + 新建玩家；热更只是几次分量赋值（见 `applyValueChanges`）。
      const bundle = this.bundle
      if (bundle) {
        applyValueChanges(bundle, doc)
        // 引用要跟上：它既是「这份 bundle 编译自哪份文档」，也是下次值比较的基准
        bundle.sourceDocument = doc
        this.invalidateSkin()
      }
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
      patch.weightBones !== undefined ||
      patch.weightTargetBone !== undefined
    ) {
      void previousSelected
      this.markDirty()
    }
    if (patch.overlay || patch.selectedVertices || patch.hoveredVertex !== undefined) this.markDirty()
    // 刷子半径圈跟着鼠标走，每帧都可能变（拖动 / 修饰键切换模式）
    if (patch.brushRing !== undefined) this.markDirty()
    // 顶点框选矩形同理：拖动中每一下都要重画
    if (patch.vertexBox !== undefined) this.markDirty()
    // 网格子工具的折线同理：橡皮筋每动一下就要重画
    if (patch.pendingMeshPath !== undefined) this.markDirty()
    // 进出「自己绘制边界」要换一整帧的显示（藏网格 / 画 region 框）
    if (patch.boundaryTarget !== undefined) this.markDirty()
    // 舞台参考图：位置 / 大小 / 透明度变了要立即重画
    if (patch.stage !== undefined) this.markDirty()

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

  /** 销毁全部子视图（换文档 / 换皮肤 / 关闭工程） */
  private clearNestedViews(): void {
    for (const entry of this.nestedViews.values()) {
      entry.view.container.removeFromParent()
      entry.view.destroy()
    }
    this.nestedViews.clear()
    this.nestedTimes.clear()
    this.view?.setNestedViews([])
  }

  /** 销毁一个子视图（连同它在更下层挂的子视图） */
  private destroyNestedEntry(key: string): void {
    const entry = this.nestedViews.get(key)
    if (!entry) return
    entry.view.container.removeFromParent()
    entry.view.destroy()
    this.nestedViews.delete(key)
    this.nestedTimes.delete(key)
    for (const childKey of [...this.nestedViews.keys()]) {
      if (childKey.startsWith(`${key}/`)) this.destroyNestedEntry(childKey)
    }
  }

  /**
   * 同步嵌套骨架：驱动子播放器（`NestRuntime` 负责采样与确定性 seek）、
   * 复用 / 重建子视图、写变换与染色，再按层号交给父视图排序。
   *
   * 递归：子骨架自己也可能是父骨架（A 挂 B、B 挂 C），每层用各自 `NestRuntime`。
   * 返回「本帧画面有没有变化」，供调用方决定是否重渲染。
   */
  private syncNestedViews(): boolean {
    const bundle = this.bundle
    const view = this.view
    const nest = bundle?.nest
    if (!bundle || !view || !nest) return false

    const live = new Set<string>()
    // 网格工具隔离时子骨架也要跟着「只剩这一个插槽」，否则它会盖住正在编辑的网格
    let changed = this.syncNestedLayer(
      nest,
      bundle.asset,
      bundle.skeleton,
      bundle.player,
      view,
      '',
      live,
      view.meshBuilder.isolateSlot
    )
    for (const key of [...this.nestedViews.keys()]) {
      if (live.has(key)) continue
      this.destroyNestedEntry(key)
      changed = true
    }
    return changed
  }

  /** 一层嵌套（`prefix` 是这层在视图树里的路径前缀，根层为空串） */
  private syncNestedLayer(
    nest: NestRuntime,
    asset: NonNullable<RuntimeBundle['asset']>,
    skeleton: NonNullable<RuntimeBundle['skeleton']>,
    player: NonNullable<RuntimeBundle['player']>,
    host: SkeletonView,
    prefix: string,
    live: Set<string>,
    isolateSlot = -1
  ): boolean {
    const instances = nest.update(asset, skeleton, player, host.result?.nestAnchors, isolateSlot)
    let changed = false
    const layers: Array<{ layer: number; order: number; container: Container }> = []

    for (const instance of instances) {
      const key = prefix ? `${prefix}/${instance.key}` : instance.key
      live.add(key)
      let entry = this.nestedViews.get(key)
      // 引用的骨架被换掉（改指向别的骨架）：asset 不同就只能重建（连带更下层）
      if (entry && entry.view.runtimeAsset !== instance.asset) {
        this.destroyNestedEntry(key)
        entry = undefined
      }
      if (!entry) {
        entry = {
          view: new SkeletonView(instance.asset, this.textures, this.skinName),
          child: nest.createChildRuntime(this.skinName)
        }
        this.nestedViews.set(key, entry)
        this.nestedTimes.set(key, Number.NaN)
        changed = true
      }

      // 容器变换 = 父骨骼世界矩阵 × 附件 TRS（NestRuntime 已算好）
      const parts = decomposeTrs(instance.matrix)
      entry.view.container.position.set(parts.x, parts.y)
      entry.view.container.rotation = (parts.rotation * Math.PI) / 180
      entry.view.container.scale.set(parts.scaleX, parts.scaleY)
      entry.view.container.visible = instance.visible

      // 染色 = 子骨架自身（插槽色 × 附件色）× 视口整体染色；值没变就别标脏
      const tint = entry.view.meshBuilder.tint
      const next = {
        r: instance.tint.r * this.tint.r,
        g: instance.tint.g * this.tint.g,
        b: instance.tint.b * this.tint.b,
        a: instance.tint.a * this.tint.a
      }
      if (tint.r !== next.r || tint.g !== next.g || tint.b !== next.b || tint.a !== next.a) {
        entry.view.setTint(next)
      }

      // 子动画时间变了才重算网格（空闲时子视图保持不脏，零额外开销）
      const last = this.nestedTimes.get(key) ?? Number.NaN
      if (!(Math.abs(last - instance.childTime) <= 1e-9)) {
        entry.view.markDirty()
        this.nestedTimes.set(key, instance.childTime)
      }
      if (entry.view.isDirty) {
        entry.view.update(instance.skeleton)
        changed = true
      }

      // 递归：这个子骨架自己也可能挂着别人的骨架
      if (
        this.syncNestedLayer(
          entry.child,
          instance.asset,
          instance.skeleton,
          instance.player,
          entry.view,
          key,
          live
        )
      ) {
        changed = true
      }

      if (entry.view.container.parent !== host.container) changed = true
      layers.push({ layer: instance.layer, order: instance.order, container: entry.view.container })
    }

    host.setNestedViews(layers)
    return changed
  }

  setSkin(skinName: string): void {
    if (!this.bundle || skinName === this.skinName) return
    // 子视图的皮肤是构造时定的：换肤必须整套重建（否则子骨架还穿旧皮肤）
    this.clearNestedViews()
    this.bundle = buildRuntime(this.bundle.sourceDocument, skinName, {
      skeletons: useProjectStore.getState().skeletons
    })
    this.skinName = skinName
    this.view?.setSkin(skinName)
    if (this.animationName) {
      this.bundle.player.play(this.animationName, this.viewState.loop)
      this.bundle.player.time = this.viewState.time
    } else {
      // 同上：换皮肤也是重建运行时，Pose 态得补一次约束求解
      this.bundle.player.refresh()
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
    this.tint = { ...color }
    this.view?.setTint(color)
    // 子视图的 tint 在每帧同步时再乘上去（它有自己的 MeshBuilder）
    for (const entry of this.nestedViews.values()) entry.view.markDirty()
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

    // 嵌套骨架：子动画时间由父播放器当前时间确定性算出（见 NestRuntime），
    // 因此这里必须**每帧**跑一次，哪怕父视图自身没脏（暂停后拖播放头就是这种情况）
    if (this.bundle.nest) {
      if (this.syncNestedViews()) this.dirty = true
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
    // Pose 态没有动画在推进播放器，而约束只在「播放器走一帧」时求解
    //（新建的运行时更是完全没求解过）：编辑完补一次，视口里的 IK 才跟得上改动
    const player = this.bundle?.player
    if (player && !player.currentAnimation) player.refresh()
    this.invalidateSkin()
    this.update(0)
  }

  fit(): void {
    this.viewport.fit(this.meshResult?.bounds ?? null)
    this.markDirty()
    this.viewport.render()
  }

  /**
   * 截取视口当前画面为 PNG data URL（含背景棋盘格、角色与叠加层）。
   *
   * 供外部 AI 工具「看」编辑器里显示的画面用。**与窗口是否激活无关**：
   * 窗口失焦 / 被别的应用挡住 / 最小化时浏览器会暂停 rAF，渲染循环停摆、dirty 留在原地，
   * 直接读画布只会拿到「命令跑完之前」的旧帧（甚至空白）。所以这里先自己同步跑一帧
   * （`update(0)`，dt 为 0 不推进播放），再离屏读取。
   *
   * 读取顺序：
   * 1. pixi `extract`：把 stage 离屏渲染到临时纹理再 readPixels —— 不读屏幕帧、不依赖
   *    `preserveDrawingBuffer`、也不需要窗口在前台（后台调用时的主路径）；
   * 2. 兜底：自己 `render()` 一帧后**同帧内**直接读画布 —— 合成前 drawing buffer 还完整，
   *    没有 `preserveDrawingBuffer` 也能拿到像素。extract 在某些驱动上抛错时走这条。
   *
   * WebGL 上下文丢失（系统休眠 / GPU 重置后会出现）时返回 null：宁可失败也不要交出
   * 一张空白图让 AI 以为「画面就是这样」。
   */
  captureViewport(): string | null {
    // 后台时 rAF 停摆：先把这一帧该算的算完（蒙皮重建、尺寸/相机兜底、叠加层重画）
    try {
      this.update(0)
    } catch (error) {
      console.warn('[hao2d] 截图前刷新场景失败（改用当前帧继续）', error)
    }

    const renderer = this.viewport.app.renderer
    if (!renderer) return null
    const gl = (renderer as unknown as { gl?: WebGLRenderingContext }).gl
    if (gl && gl.isContextLost()) return null

    if (renderer.extract) {
      try {
        const canvas = renderer.extract.canvas(this.viewport.app.stage) as HTMLCanvasElement
        const url = canvas.toDataURL('image/png')
        if (url.startsWith('data:image/png')) return url
      } catch {
        // extract 失败（驱动 / 极端状态）→ 落到下面的兜底
      }
    }

    try {
      this.viewport.render()
      const url = (this.viewport.app.canvas as HTMLCanvasElement).toDataURL('image/png')
      return url.startsWith('data:image/png') ? url : null
    } catch {
      return null
    }
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
    // 骨骼层关掉时**不按骨骼体拾取**：看不见的骨骼点中了也不知道点的是谁（正是「准星选不中」
    // 的根因 —— 准星旁边压着看不见的骨骼体，永远抢在约束兜底前面）。此时骨架里唯一可点的
    // 记号就是「约束」层上的目标准星，见下面的兜底
    if (this.viewState.overlay.bones) {
      const hit = pickBone(this.bundle.skeleton, worldX, worldY, this.viewport.pixelsToWorld(8))
      if (hit) return hit
    }
    // 约束手柄兜底：点在目标准星附近时，按「点中了目标骨骼」处理。
    // 合并显示后，视口里的约束准星就是那条约束的**节点骨**（IK 目标骨）——
    // 「只显示约束」时这是选中 / 拖拽 IK 节点的唯一入口。
    // 命中半径屏幕恒定（10px，与准星环同量级），多条约束重叠取最近
    const target = this.constraintTargetIndexAt(worldX, worldY)
    return target >= 0 ? { boneIndex: target, distance: 0 } : null
  }

  /** 约束准星悬停：命中返回**目标骨骼名**（光标提示用；「约束」叠加层关着时恒为 null） */
  pickConstraintTargetAt(worldX: number, worldY: number): string | null {
    if (!this.bundle) return null
    const target = this.constraintTargetIndexAt(worldX, worldY)
    if (target < 0) return null
    return this.bundle.asset.bones[target]?.name ?? null
  }

  /**
   * 约束目标准星的拾取：开关与画手柄的「约束」叠加层一致（enabled、非 physics、有目标）。
   * 返回目标骨骼下标（合并显示后「点约束」语义上就是点它的节点骨）；没命中返回 -1。
   * 公开给工具层用：准星要排在附件拾取前面（IK 节点常压在角色图片上）
   */
  constraintTargetIndexAt(worldX: number, worldY: number): number {
    if (!this.bundle || !this.viewState.overlay.constraints) return -1
    const tolerance = this.viewport.pixelsToWorld(10)
    let best = -1
    let bestDistance = tolerance
    for (const constraint of this.bundle.asset.constraints) {
      if (!constraint.enabled || constraint.type === 'physics') continue
      const target = constraint.targetBoneIndex
      if (target < 0 || target >= this.bundle.skeleton.boneCount) continue
      const distance = Math.hypot(
        this.bundle.skeleton.boneWorldX(target) - worldX,
        this.bundle.skeleton.boneWorldY(target) - worldY
      )
      if (distance <= bestDistance) {
        bestDistance = distance
        best = target
      }
    }
    return best
  }

  /**
   * 骨骼拾取：原点圈（移动）/ 骨骼体（旋转）。
   * 原点圈是屏幕恒定大小，按 zoom 换算成世界半径再判定；缩放走小坐标轴。
   * 半径取设置里的「原点圈大小」（见 `boneStyle`）—— 画出来的圈和点得到的圈是同一个。
   *
   * 骨骼层关掉时**一律不命中**：看不见的操作区不该有反应（拖拽起点、悬停高亮同此），
   * 此时骨架里唯一可点的是「约束」准星（见 pickBoneAt 的兜底），选中后走 gizmo 拖拽
   */
  pickBoneHandleAt(worldX: number, worldY: number): BoneHandleHit | null {
    if (!this.bundle || !this.viewState.overlay.bones) return null
    return pickBoneHandle(
      this.bundle.skeleton,
      worldX,
      worldY,
      this.viewport.pixelsToWorld(8),
      this.viewport.pixelsToWorld(this.boneStyle.jointRadius),
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
   * 文档里某个附件（按当前皮肤名找，找不到退回第一套皮肤）。
   *
   * 运行期附件（`attachmentAt`）只有「此刻真正显示的那一个」，改不到被关键帧切走的附件；
   * 顶点编辑 / region 框这些「按名字指名道姓」的事都得走这里。
   */
  private documentAttachment(slotName: string, attachmentName: string): AuthoringAttachment | null {
    const doc = this.document
    if (!doc) return null
    const skin = doc.skins.find((item) => item.name === this.skinName) ?? doc.skins[0]
    return (
      skin?.slots
        .find((item) => item.slot === slotName)
        ?.attachments.find((item) => item.name === attachmentName) ?? null
    )
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
    const attachment = this.documentAttachment(slotName, attachmentName)
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
    /*
     * 只画选中的那一个时，也只让那一个的顶点可抓 —— 否则会拖到看不见（甚至没画出来）的顶点。
     *
     * **没有可编辑插槽时一律不命中**（`editingSlotIndex()` 为 -1）。早先把这个 -1 直接喂给
     * `pickVertex`，而那里的 -1 表示「不限插槽」：Pose 工具选中骨骼后 `focusMeshSlot` 是空串
     * （顶点一个都不画），拾取却放开成**整个角色所有网格**的顶点 —— 点骨骼体时被压在下面的
     * 顶点抢走，表现就是「Pose 工具拖不动 / 转不动骨骼」，而选择工具没有这条抢占分支所以没事。
     */
    const slot = this.editingSlotIndex()
    if (slot < 0) return null
    return pickVertex(this.meshResult, worldX, worldY, this.viewport.pixelsToWorld(9), slot)
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
   * **在编辑谁**的插槽下标（**-1 = 谁都不可编辑**，不是「不限」）。覆盖层「画谁」与顶点拾取「抓谁」
   * 共用它，两处必须一致 —— 否则会拖到根本没画出来的顶点：
   * - 选择 / Pose 工具：选中项（`focusMeshSlot`）；选中骨骼时为空 → 不画也不抓；
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
    // 嵌套骨架先判：它是一整块子角色，点进去应该选中「骨架」display 本身
    const nested = this.pickNestDisplayAt(worldX, worldY)
    if (nested) return nested
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

  /**
   * 拾取嵌套骨架 display：用子骨架当前的**世界 AABB** 判定（不逐像素采样纹理）。
   *
   * 为什么不逐像素：子骨架是递归的一整棵视图，逐像素要穿过父子两级 alpha 缓存，
   * 而这层的用途只是「点中子角色 → 选中它的 display」，包围盒足够，且不受贴图未加载影响。
   */
  pickNestDisplayAt(worldX: number, worldY: number): { slot: string; attachment: string } | null {
    const bundle = this.bundle
    const nest = bundle?.nest
    if (!bundle || !nest) return null
    const instances = nest.instances
    // 绘制顺序靠后的在上层：从后往前找第一个命中的
    for (let i = instances.length - 1; i >= 0; i--) {
      const instance = instances[i]
      if (!instance.visible) continue
      const bounds = this.nestedViews.get(instance.key)?.view.result?.bounds
      if (!bounds || !(bounds.maxX > bounds.minX) || !(bounds.maxY > bounds.minY)) continue
      const m = instance.matrix
      let minX = Number.POSITIVE_INFINITY
      let minY = Number.POSITIVE_INFINITY
      let maxX = Number.NEGATIVE_INFINITY
      let maxY = Number.NEGATIVE_INFINITY
      for (const [x, y] of [
        [bounds.minX, bounds.minY],
        [bounds.maxX, bounds.minY],
        [bounds.maxX, bounds.maxY],
        [bounds.minX, bounds.maxY]
      ] as const) {
        const wx = m[0] * x + m[4] * y + m[12]
        const wy = m[1] * x + m[5] * y + m[13]
        if (wx < minX) minX = wx
        if (wx > maxX) maxX = wx
        if (wy < minY) minY = wy
        if (wy > maxY) maxY = wy
      }
      if (worldX < minX || worldX > maxX || worldY < minY || worldY > maxY) continue
      return {
        slot: bundle.asset.slots[instance.slotIndex]?.name ?? '',
        attachment: instance.attachmentName
      }
    }
    return null
  }

  /** 顶点对应的附件（权重显示与拾取共用） */
  attachmentAt(slotIndex: number, displayIndex: number): AttachmentData | null {
    return this.view?.meshBuilder.attachmentAt(slotIndex, displayIndex) ?? null
  }

  /** 按名字找附件（不要求它当前正在显示；遮罩选中 / 叠加层用） */
  attachmentByName(slotName: string, attachmentName: string): AttachmentData | null {
    const bundle = this.bundle
    const view = this.view
    if (!bundle || !view) return null
    const slotIndex = bundle.asset.slots.findIndex((slot) => slot.name === slotName)
    if (slotIndex < 0) return null
    const displayIndex = view.meshBuilder.attachmentIndexOf(slotIndex, attachmentName)
    return displayIndex >= 0 ? view.meshBuilder.attachmentAt(slotIndex, displayIndex) : null
  }

  /** 遮罩附件当前姿态的世界多边形（加权 / FFD 都按运行期同一套算法） */
  maskWorldPointsAt(slotName: string, attachmentName: string): Float32Array | null {
    const bundle = this.bundle
    const view = this.view
    if (!bundle || !view) return null
    const slotIndex = bundle.asset.slots.findIndex((slot) => slot.name === slotName)
    if (slotIndex < 0) return null
    const attachment = this.attachmentByName(slotName, attachmentName)
    if (!attachment || attachment.type !== AttachmentType.Clipping) return null
    return view.meshBuilder.clippingWorldPoints(bundle.skeleton, slotIndex, attachment)
  }

  /** 插槽骨骼局部坐标 → 世界坐标（遮罩控制点存储 / 绘制用） */
  slotBoneLocalToWorld(slotName: string, point: Vec2): Vec2 | null {
    const bundle = this.bundle
    if (!bundle) return null
    const slotIndex = bundle.asset.slots.findIndex((slot) => slot.name === slotName)
    if (slotIndex < 0) return null
    const boneIndex = bundle.asset.slots[slotIndex].boneIndex
    if (boneIndex < 0) return null
    const world = bundle.skeleton.world.slice(boneIndex * MAT4_LENGTH, boneIndex * MAT4_LENGTH + MAT4_LENGTH)
    return mulPoint(world, point)
  }

  /** 世界坐标 → 插槽骨骼局部坐标（提交遮罩时把画出来的点换算回存储空间） */
  worldToSlotBoneLocal(slotName: string, point: Vec2): Vec2 | null {
    const bundle = this.bundle
    if (!bundle) return null
    const slotIndex = bundle.asset.slots.findIndex((slot) => slot.name === slotName)
    if (slotIndex < 0) return null
    const boneIndex = bundle.asset.slots[slotIndex].boneIndex
    if (boneIndex < 0) return null
    const world = bundle.skeleton.world.slice(boneIndex * MAT4_LENGTH, boneIndex * MAT4_LENGTH + MAT4_LENGTH)
    return mulPoint(invert(world), point)
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
   * 附件显示空间 → 世界坐标（`attachmentWorldAt` 的正向变换，网格顶点编辑的反向换算见
   * `worldToAttachmentLocal`）。
   *
   * 网格子工具的折线预览用：点存的是附件空间坐标，画的时候才变换 —— 网格一动它跟着动。
   */
  attachmentLocalToWorld(slotIndex: number, x: number, y: number): Vec2 | null {
    const world = this.attachmentWorldAt(slotIndex)
    return world ? mulPoint(world, { x, y }) : null
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
    /*
     * 嵌套骨架：轮廓用**子骨架当前的世界 AABB**。
     * 不能走下面的 `size/vertices` 分支 —— 骨架附件的 size 是 0，会画出一个退化点。
     */
    if (attachment.type === AttachmentType.Armature) {
      const instance = bundle.nest?.instances.find((item) => item.slotIndex === slotIndex)
      const bounds = instance ? this.nestedViews.get(instance.key)?.view.result?.bounds : undefined
      if (!instance || !bounds) return null
      const m = instance.matrix
      const corners = [
        { x: bounds.minX, y: bounds.minY },
        { x: bounds.maxX, y: bounds.minY },
        { x: bounds.maxX, y: bounds.maxY },
        { x: bounds.minX, y: bounds.maxY }
      ]
      return [
        corners.map((corner) => ({
          x: m[0] * corner.x + m[4] * corner.y + m[12],
          y: m[1] * corner.x + m[5] * corner.y + m[13]
        }))
      ]
    }
    if (attachment.type === AttachmentType.Clipping) {
      const points = this.maskWorldPointsAt(slotName, attachmentName)
      if (!points || points.length < 6) return null
      const path: Array<{ x: number; y: number }> = []
      for (let i = 0; i + 1 < points.length; i += 2) path.push({ x: points[i], y: points[i + 1] })
      return [path]
    }

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
    this.clearNestedViews()
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
    // 绝对时钟（子骨架循环相位的来源）要先存下来：seek 会把它一起改掉
    const elapsed = player.elapsed
    /*
     * 前后偏移取时长的 8%（不低于 1/30s）：4% 时（1 秒动画 ≈ 40ms）姿态差异太小，
     * 幽灵几乎与本体完全重合，看上去就像「没开」。放大到 8% 才看得出前后姿态的走向。
     */
    const step = Math.max(1 / 30, duration * 0.08)

    const ghosts: Array<{ matrices: Float32Array; color: number }> = []
    for (const offset of [-step, step]) {
      let target = current + offset
      if (target < 0) target += duration
      if (target > duration) target -= duration
      player.seek(target)
      ghosts.push({
        matrices: skeleton.world.slice(),
        color: offset < 0 ? GHOST_PREV_COLOR : GHOST_NEXT_COLOR
      })
    }
    // 回到原来的时间点，恢复当前姿态（绝对时钟也恢复，别把子骨架循环相位带偏）
    player.seek(current)
    player.restoreElapsed(elapsed)

    const lengths = bundle.asset.bones.map((bone) => bone.length)
    for (const ghost of ghosts) {
      // alpha 0.45：只描边的空心风筝，压在角色贴图上要看得清，又不与当前姿态抢眼
      drawGhostBones(g, ghost.matrices, lengths, unitsPerPixel, ghost.color, 0.45)
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
   * 软边圆用的径向渐变（按「模式 + Feather」缓存）。
   *
   * 停止点取自落笔的衰减曲线（`brushFalloffStops`：距圆心比例 → 相对强度），强度折算成
   * alpha —— 于是**屏幕上看到的那团明暗就是实际刷出来的强度分布**，改 Feather 两边一起变。
   * 颜色用 8 位十六进制（`#RRGGBBAA`）把 alpha 编进去：渐变的颜色停止点没有独立的 alpha 字段。
   * 坐标按形状包围盒归一化（0..1），与半径、缩放无关 —— 所以一个「模式 + Feather」只建一次就够。
   */
  private brushGradient(mode: BrushMode, feather: number): FillGradient {
    const key = `${mode}:${Math.round(Math.min(1, Math.max(0, feather)) * 100)}`
    const cached = this.brushGradients.get(key)
    if (cached) return cached
    const rgb = BRUSH_MODE_COLORS[mode].slice(1)
    /** 圆心处的不透明度：够看清这团软边，又不遮住底下要刷的图 */
    const maxAlpha = 0.38
    const gradient = new FillGradient({
      type: 'radial',
      center: { x: 0.5, y: 0.5 },
      innerRadius: 0,
      outerRadius: 0.5,
      colorStops: brushFalloffStops(feather).map(([offset, strength]) => {
        const byte = Math.round(Math.max(0, Math.min(1, strength)) * maxAlpha * 255)
        return { offset, color: `#${rgb}${byte.toString(16).padStart(2, '0')}` }
      })
    })
    this.brushGradients.set(key, gradient)
    return gradient
  }

  /**
   * 网格子工具正在画的折线（绘制边界 / 自定义布线）。
   *
   * 三段画法：**已落下的折线**（实线 + 落点圆点）、**橡皮筋**（最后一点 → 光标，虚线；已有两个点时
   * 再补一条 光标 → 起点 的虚线，提示「点回起点就闭合」）、**起点**（画大一圈，同「闭合目标」）。
   * 点本来就是附件空间坐标，这里逐点乘附件世界矩阵，于是网格摆成什么姿态都跟得住。
   */
  private drawPendingMeshPath(unitPerPixel: number): void {
    const path = this.viewState.pendingMeshPath
    const bundle = this.bundle
    this.meshPath.clear()
    const world = bundle && path ? this.attachmentWorldByName(path.slot) : null
    if (!path || !world || path.points.length === 0) {
      this.meshPath.visible = false
      return
    }
    const toWorld = (point: Vec2): Vec2 => mulPoint(world, point)
    const points = path.points.map(toWorld)
    const cursor = path.cursor ? toWorld(path.cursor) : null
    this.meshPath.visible = true

    if (points.length >= 2) {
      this.meshPath.moveTo(points[0].x, points[0].y)
      for (let i = 1; i < points.length; i++) this.meshPath.lineTo(points[i].x, points[i].y)
      this.meshPath.stroke({ width: unitPerPixel * 1.6, color: MESH_PATH_COLOR, alpha: 0.95 })
    }
    if (cursor) {
      const last = points[points.length - 1]
      this.meshPath.moveTo(last.x, last.y).lineTo(cursor.x, cursor.y)
      if (points.length >= 2) this.meshPath.moveTo(cursor.x, cursor.y).lineTo(points[0].x, points[0].y)
      this.meshPath.stroke({ width: unitPerPixel * 1.2, color: MESH_PATH_COLOR, alpha: 0.4 })
    }
    for (let i = 0; i < points.length; i++) {
      this.meshPath
        .poly(circlePolygon(points[i].x, points[i].y, unitPerPixel * (i === 0 ? 5 : 3.5)))
        .fill({ color: MESH_PATH_COLOR, alpha: i === 0 ? 1 : 0.85 })
    }
  }

  /**
   * 遮罩叠加层：选中/正在绘制的多边形轮廓、半透明填充、控制点。
   *
   * 已存在的遮罩点存骨骼局部坐标，绘制时乘骨骼世界矩阵；绘制中的草稿点直接是世界坐标
   * （提交时才换算），所以摆 Pose / 播动画都不会让草稿错位。
   */
  private drawMaskOverlay(unitPerPixel: number): void {
    this.maskFill.clear()
    this.maskStroke.clear()
    this.maskPoints.clear()
    let visible = false
    const color = 0x22d3ee

    const drawPolygon = (points: Vec2[], closed: boolean, selectedIndex = -1): void => {
      if (points.length < 2) return
      const draw = (g: Graphics): void => {
        g.moveTo(points[0].x, points[0].y)
        for (let i = 1; i < points.length; i++) g.lineTo(points[i].x, points[i].y)
        if (closed) g.closePath()
      }
      draw(this.maskFill)
      this.maskFill.fill({ color, alpha: 0.1 })
      draw(this.maskStroke)
      this.maskStroke.stroke({ width: unitPerPixel * 1.5, color, alpha: closed ? 0.95 : 0.8 })
      for (let i = 0; i < points.length; i++) {
        const selected = i === selectedIndex
        const radius = unitPerPixel * (selected ? 6 : i === 0 ? 5 : 4)
        this.maskPoints
          .poly(circlePolygon(points[i].x, points[i].y, radius))
          .fill({ color: selected ? 0xffffff : color, alpha: selected ? 1 : i === 0 ? 1 : 0.9 })
        this.maskPoints
          .poly(circlePolygon(points[i].x, points[i].y, radius))
          .stroke({ width: unitPerPixel, color: selected ? color : 0xffffff, alpha: 0.95 })
        if (selected) {
          // 选中点外面再套一圈青色，缩小时也能一眼看出选的是哪个
          this.maskPoints
            .poly(circlePolygon(points[i].x, points[i].y, radius + unitPerPixel * 2))
            .stroke({ width: unitPerPixel, color, alpha: 0.9 })
        }
      }
    }

    const selected = this.viewState.selectedDisplay
    if (selected) {
      const attachment = this.attachmentByName(selected.slot, selected.attachment)
      if (attachment?.type === AttachmentType.Clipping) {
        const flat = this.maskWorldPointsAt(selected.slot, selected.attachment)
        if (flat && flat.length >= 6) {
          const points: Vec2[] = []
          for (let i = 0; i + 1 < flat.length; i += 2) points.push({ x: flat[i], y: flat[i + 1] })
          const picked = this.viewState.maskPoint
          const selectedIndex =
            picked && picked.slot === selected.slot && picked.attachment === selected.attachment
              ? picked.index
              : -1
          drawPolygon(points, true, selectedIndex >= 0 && selectedIndex < points.length ? selectedIndex : -1)
          visible = true
        }
      }
    }

    const pending = this.viewState.pendingMaskPath
    if (pending && pending.points.length > 0) {
      drawPolygon(pending.points, false)
      // 橡皮筋：最后一点 → 光标；已有两个点时再连回起点，提示可以闭合
      if (pending.cursor) {
        const last = pending.points[pending.points.length - 1]
        this.maskStroke.moveTo(last.x, last.y).lineTo(pending.cursor.x, pending.cursor.y)
        if (pending.points.length >= 2) {
          this.maskStroke.moveTo(pending.cursor.x, pending.cursor.y).lineTo(pending.points[0].x, pending.points[0].y)
        }
        this.maskStroke.stroke({ width: unitPerPixel * 1.2, color, alpha: 0.45 })
      }
      visible = true
    }

    this.maskFill.visible = visible
    this.maskStroke.visible = visible
    this.maskPoints.visible = visible
  }

  /**
   * 「自己绘制边界」时画的**图片 region 框**：附件在文档里的原图框（没被裁剪就是内容框），
   * 用虚线围一圈当范围提示 —— 用户据此知道笔尖该落在哪，点子工具也会把落点夹进这个框里
   *（见 authoringTools 的 clampToFrame，两边用的是同一个 `attachmentFrameBox`）。
   *
   * 框存的是附件显示空间的四角，逐点乘附件世界矩阵画出来 —— 摆 POSE / 附件带旋转都贴得住。
   * 虚线是手画的：pixi v8 的 stroke 不支持 dash 参数。深色垫底 + 浅色线各描一遍，
   * 贴图深浅两头都看得清。
   */
  private drawBoundaryFrame(unitPerPixel: number): void {
    const g = this.regionFrame
    g.clear()
    const target = this.viewState.boundaryTarget
    const world = target ? this.attachmentWorldByName(target.slot) : null
    const attachment = target ? this.documentAttachment(target.slot, target.attachment) : null
    const box = attachment ? attachmentFrameBox(attachment) : null
    if (!target || !world || !box || box.size.x <= 1e-6 || box.size.y <= 1e-6) {
      g.visible = false
      return
    }
    const halfWidth = box.size.x * 0.5
    const halfHeight = box.size.y * 0.5
    const corners = [
      { x: box.center.x - halfWidth, y: box.center.y - halfHeight },
      { x: box.center.x + halfWidth, y: box.center.y - halfHeight },
      { x: box.center.x + halfWidth, y: box.center.y + halfHeight },
      { x: box.center.x - halfWidth, y: box.center.y + halfHeight }
    ].map((corner) => mulPoint(world, corner))
    g.visible = true

    const dash = unitPerPixel * 7
    const gap = unitPerPixel * 5
    const trace = (): void => {
      for (let i = 0; i < corners.length; i++) {
        const from = corners[i]
        const to = corners[(i + 1) % corners.length]
        const length = Math.hypot(to.x - from.x, to.y - from.y)
        if (length <= 1e-6) continue
        const stepX = (to.x - from.x) / length
        const stepY = (to.y - from.y) / length
        for (let offset = 0; offset < length; offset += dash + gap) {
          const end = Math.min(length, offset + dash)
          g.moveTo(from.x + stepX * offset, from.y + stepY * offset)
          g.lineTo(from.x + stepX * end, from.y + stepY * end)
        }
      }
    }
    trace()
    g.stroke({ width: unitPerPixel * 3, color: 0x0b1220, alpha: 0.5 })
    trace()
    g.stroke({ width: unitPerPixel * 1.4, color: REGION_FRAME_COLOR, alpha: 0.9 })
  }

  /** 把舞台参考图的配置应用到精灵上（每帧调用：弹窗里改位置 / 大小 / 透明度实时生效） */
  private updateStageSprite(): void {
    const stage = this.viewState.stage
    const texture = this.stageSprite.texture
    if (!stage || !texture || texture === Texture.EMPTY) {
      this.stageSprite.visible = false
      return
    }
    this.stageSprite.visible = true
    // 锚点居中：配置里的 x/y 是图片**中心**的世界坐标；世界 y 轴向上（相机做了 y 翻转），
    // 贴图要再翻回来，否则参考图是倒立的
    this.stageSprite.anchor.set(0.5, 0.5)
    this.stageSprite.position.set(stage.x, stage.y)
    this.stageSprite.scale.set(stage.width / texture.width, -(stage.height / texture.height))
    this.stageSprite.alpha = stage.opacity
  }

  private drawOverlays(): void {
    const bundle = this.bundle
    const state = this.viewState
    const unitPerPixel = this.viewport.pixelsToWorld(1)
    this.updateStageSprite()
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
    // 权重刷 / 直接拖动的目标骨骼：只影响画法（高亮描边），不参与选中态
    const weightTargetIndex = bundle ? (bundle.boneIndex[state.weightTargetBone] ?? -1) : -1
    this.boneStroke.visible = showBoneLayer
    this.boneFill.visible = showBoneLayer
    /*
     * 洋葱皮画在**独立图层**：骨骼层每次重绘都会 clear()，幽灵画进 boneStroke 会被
     * 紧随其后的 drawBoneOverlay 当场擦掉（这就是「开了洋葱皮什么都看不到」的原因）。
     * 可见性跟骨骼开关走 —— 只在「显示骨骼」时幽灵才有参照意义。
     */
    this.ghostBones.visible = showSkeleton
    this.ghostBones.clear()
    if (showSkeleton && bundle && state.onionSkin) this.drawOnionSkin(this.ghostBones, unitPerPixel)
    if (showBoneLayer && bundle) {
      drawBoneOverlay(this.boneStroke, this.boneFill, bundle.skeleton, bundle.asset.constraints, {
        unitsPerPixel: unitPerPixel,
        selectedBones: selectedBoneIndices,
        hoveredBone: bundle.boneIndex[state.hoveredBone] ?? -1,
        weightBoneColors,
        targetBone: weightTargetIndex,
        showBones: showSkeleton,
        showConstraints,
        showSlots: false,
        hollowBones: this.hollowBones,
        // 正在拖拽新建骨骼：把待生成的骨骼画成虚线预览
        pendingBone: state.pendingBone,
        // 骨骼本体 / 原点圈的长相（「全局设置 → 骨骼样式」）
        style: this.boneStyle
      })
    } else {
      this.boneStroke.clear()
      this.boneFill.clear()
    }

    /*
     * 「自己绘制边界」进行中：**旧网格的形状整个让开** —— 不画网格线框、不画顶点手柄、
     * 也不画它的选中轮廓，改成画图片的 region 框（下面 drawBoundaryFrame）+ 正在画的折线。
     * 理由：重画边界时旧网格的形状与顶点全是干扰，用户只需要知道「图片范围在哪、笔尖落在里面」。
     */
    const boundaryDraw = state.boundaryTarget !== null && bundle !== null

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
      showBoneLayer &&
      bundle !== null &&
      !boundaryDraw &&
      (selectedDisplay !== null || hoveredDisplay !== null)
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

    this.drawMaskOverlay(unitPerPixel)

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
       * 明暗分布直接取落笔的衰减曲线（见 brushFalloffStops / Feather），且按形状包围盒归一化，
       * 所以半径 / 缩放怎么变，这团软边的相对形状都一样。
       * 外沿再描一圈实线当边界 —— 圈外一个顶点都不碰。
       */
      this.brushRing
        .poly(circlePolygon(ring.x, ring.y, ring.radius))
        .fill(this.brushGradient(ring.mode, ring.feather))
        .stroke({ width: unitPerPixel * 1.2, color, alpha: 0.8 })
      // 落点（鼠标精确位置）
      this.brushRing.poly(circlePolygon(ring.x, ring.y, unitPerPixel * 2)).fill({ color, alpha: 0.85 })
    }

    // 顶点框选矩形：半透明填充 + 细描边（画在最上层，别被网格线盖住）
    const box = state.vertexBox
    this.vertexBox.clear()
    this.vertexBox.visible = box !== null
    if (box) {
      const x = Math.min(box.x0, box.x1)
      const y = Math.min(box.y0, box.y1)
      const width = Math.abs(box.x1 - box.x0)
      const height = Math.abs(box.y1 - box.y0)
      this.vertexBox
        .rect(x, y, width, height)
        .fill({ color: 0x38bdf8, alpha: 0.08 })
        .stroke({ width: unitPerPixel * 1.2, color: 0x38bdf8, alpha: 0.85 })
    }

    // 网格子工具的折线（画边界 / 自定义布线）：同样是个「跟着鼠标走的光标」，画在最上层；
    // 画边界时它下面垫着图片的 region 框（「笔尖要落在框里」的那个框）
    this.drawBoundaryFrame(unitPerPixel)
    this.drawPendingMeshPath(unitPerPixel)

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
    // 重画边界时网格线框与顶点整个让开（否则旧网格的形状压在 region 框上，看不出该往哪画）
    const showMesh = (editingSlot >= 0 || isolating) && bundle !== null && !boundaryDraw
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

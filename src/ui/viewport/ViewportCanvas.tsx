import { useEffect, useRef, useState } from 'react'
import { Bone } from 'lucide-react'
import ContextMenu from '@ui/widgets/ContextMenu'
import { slotLayerMenuItems } from '@ui/widgets/slotLayerMenuItems'
import { EditorScene } from '@editor/scene'
import { TextureStore } from '@render/material'
import { ImageAlphaCache } from '@render/imageAlpha'
import { imageSources } from '@render/imageSourceRegistry'
import { getPlatform, dirName } from '@editor/platform'
import { useProjectStore } from '@editor/store/projectStore'
import { useSelectionStore } from '@editor/store/selectionStore'
import { useToolStore } from '@editor/store/toolStore'
import { useModeStore } from '@editor/store/modeStore'
import { useTimelineStore } from '@editor/store/timelineStore'
import { usePlayheadStore } from '@editor/store/playheadStore'
import { usePreviewStore } from '@editor/store/previewStore'
import { useSettingsStore } from '@editor/store/settingsStore'
import {
  baseBrushMode,
  brushModeFor,
  isDragging,
  meshSubtoolCancel,
  meshSubtoolHover,
  slotLocked,
  toolPointerDown,
  toolPointerMove,
  toolPointerUp
} from '@editor/tools/authoringTools'
import { meshSubtoolCursor } from './MeshSubtoolBar'
import type { ToolHost } from '@editor/tools/authoringTools'
import { BRUSH_MODE_COLORS } from '@core/weightPalette'
import type { BrushMode } from '@editor/commands/authoringCommands'
import {
  addWeightBone,
  createRegionFromImage,
  insertMeshVertex,
  PPU,
  resolveAttachment,
  weightBonesOf
} from '@editor/commands/authoringCommands'
import { hasImageDrag, readImageDrag } from '@ui/widgets/dragDrop'
import { gridDropLayout } from '@ui/viewport/dropLayout'
import type { AuthoringImage, EditorDocument } from '@core/model/authoring'
import { rootBoneName } from '@core/model/authoring'
import { stageFilePath } from '@editor/services/projectAssets'
import { ImageSource, Texture } from 'pixi.js'
import { loadImageElement } from '@render/imageLoader'

/**
 * 权重刷的鼠标光标：**形状本身就是提示** —— 加号=增加、减号=减少、圆点=覆盖（直接替换）。
 *
 * 用内联 SVG 画成 data URI：颜色与视口里的「刷子半径圈」同源（见 BRUSH_MODE_COLORS），
 * 热点固定在中心；末尾的 crosshair 是不支持图片光标时的兜底。
 * 为什么非要换光标：默认的十字看不出这一下是在加还是在减 —— 那是最容易刷反的地方。
 */
function brushCursor(mode: BrushMode): string {
  const color = BRUSH_MODE_COLORS[mode].replace('#', '%23')
  const glyph =
    mode === 'add'
      ? "<path d='M12 5v14M5 12h14'/>"
      : mode === 'subtract'
        ? "<path d='M5 12h14'/>"
        : mode === 'grow'
          ? // 生长：向上的箭头（只往已受影响的顶点上加）
            "<path d='M12 19V6M7 11l5-5 5 5'/>"
          : mode === 'smooth'
            ? // 平滑：两道波浪（朝邻居平均）
              "<path d='M4 10c2.5-3 5-3 7.5 0s5 3 7.5 0M4 15c2.5-3 5-3 7.5 0s5 3 7.5 0'/>"
            : `<circle cx='12' cy='12' r='4.5' fill='${color}' stroke='none'/>`
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none'` +
    ` stroke='${color}' stroke-width='2.4' stroke-linecap='round'>` +
    `<circle cx='12' cy='12' r='9' stroke='%23000000' stroke-opacity='0.5' stroke-width='1'/>` +
    `${glyph}</svg>`
  return `url("data:image/svg+xml;utf8,${svg}") 12 12, crosshair`
}

export interface ViewportCanvasProps {
  onSceneReady: (scene: EditorScene) => void
  onStatus: (text: string) => void
}

/** pixi 画布挂载：创建 EditorScene，订阅 store 投喂状态，处理平移 / 缩放 / 拾取 */
export default function ViewportCanvas({ onSceneReady, onStatus }: ViewportCanvasProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const sceneRef = useRef<EditorScene | null>(null)
  const texturesRef = useRef<TextureStore | null>(null)
  /** 绑定骨骼状态下跟着鼠标走的提示图标（用 ref 直接改位置，避免每次移动都触发重渲染） */
  const bindIconRef = useRef<HTMLDivElement | null>(null)
  const pendingWeightBone = useToolStore((s) => s.pendingWeightBone)
  /**
   * 视口右键菜单（Pose / Animate 下右键 slot / display）：
   * pose = 打开时是否 Pose 态（决定菜单里有没有「删除插槽」），打开后不再跟随模式变化。
   */
  const [slotMenu, setSlotMenu] = useState<{ x: number; y: number; slot: string; pose: boolean } | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const textures = new TextureStore()
    texturesRef.current = textures
    const scene = new EditorScene({ host, textures })
    sceneRef.current = scene
    let disposed = false

    void scene.init().then(() => {
      if (disposed) return
      onSceneReady(scene)
      scene.fit()
    })

    const resize = (): void => {
      scene.viewport.resize(host.clientWidth, host.clientHeight)
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(host)

    let raf = 0
    let last = performance.now()
    /** 上一帧是否在播放：用于在「播放 → 停止」的那一帧把最终时间落回主 store */
    let playing = false
    /**
     * 渲染循环。
     *
     * 下一帧的 rAF **必须**排在 try/catch 之外：`scene.update` 里任何一处抛异常
     * （渲染 / 采样 / 覆盖层）都会让整个循环停摆 —— 表现为「画面定格、拖拽缩放全无反应，
     * 但面板还能用」，而且 rAF 回调里的异常不会弹提示，只看控制台很容易漏掉。
     * 这里把单帧错误隔离开：跳过这一帧、打出堆栈，循环继续跑。
     */
    const loop = (now: number): void => {
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      try {
        scene.update(dt)
        // 首次拿到有效几何后自动适配视野（拖图会提前置 autoFitDone，见 onImageDrop）
        if (!scene.autoFitDone) {
          const bounds = scene.meshResult?.bounds
          if (bounds && bounds.maxX - bounds.minX > 1e-4 && bounds.maxY - bounds.minY > 1e-4) {
            scene.autoFitDone = true
            scene.fit()
          }
        }
        const timeline = useTimelineStore.getState()
        const isPlaying = Boolean(scene.currentAnimation) && timeline.playing
        const time = scene.runtime?.player.time ?? 0
        if (isPlaying) {
          // 播放推进：只写**播放头时钟**（高频通道），不写 timelineStore。
          // 写主 store 会通知整棵 UI 树重渲染（实测单帧净成本 ~100ms，帧率 44 → 8fps），
          // 而这一帧里的动画求值 + 蒙皮重建 + 绘制只占 1.3ms。播放头 / 标尺 / 状态栏读数
          // 是订阅高频通道自己更新的，不需要主 store 参与。
          usePlayheadStore.getState().setTime(time)
        } else if (playing) {
          // 暂停 / 播完：把最终时间落回主 store，让时间轴、层级树与世界状态对齐
          useTimelineStore.getState().setTime(time)
        }
        playing = isPlaying
      } catch (error) {
        console.error('[hao2d] 视口渲染循环出错（已跳过该帧，视口不会卡死）', error)
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      observer.disconnect()
      scene.destroy()
      textures.clear()
      scene.imageAlpha.clear()
      // 记账一起清掉：否则重新挂载时会以为贴图还在，跳过加载
      imageSources.clear()
      sceneRef.current = null
    }
  }, [onSceneReady, onStatus])

  // 文档 → 场景
  useEffect(() => {
    /**
     * 上一次同步过的文档 / 皮肤。
     *
     * 主 store 是**无选择器**订阅：任何 `set`（改面板偏好、切选中项、改工具设置…）都会跑到这里。
     * 不做守卫的话每次都白跑一遍 `setDocument` + `loadTextures`（贴图逐张查表）。文档没变就早退。
     */
    let syncedDocument: EditorDocument | null = null
    let syncedSkin: string | null = null
    const sync = (): void => {
      const scene = sceneRef.current
      if (!scene) return
      const { document } = useProjectStore.getState()
      const selection = useSelectionStore.getState()
      // `scene.runtime` 兜一层：视口重挂载后运行期是空的，即便文档没换也必须重新灌进去
      if (document === syncedDocument && selection.skin === syncedSkin && scene.runtime) return
      syncedDocument = document
      syncedSkin = selection.skin
      // 骨骼样式也在这里补一次：视口重挂载会新建场景（样式回到默认），
      // 而设置可能早于它改完 —— 这里保证新场景拿到的就是当前设置
      scene.setBoneStyle(useSettingsStore.getState().boneStyle)
      scene.setDocument(document, selection.skin)
      void loadTextures(texturesRef.current, document, scene.imageAlpha)
    }
    sync()
    const unsubscribe = useProjectStore.subscribe(sync)
    const unsubscribeSelection = useSelectionStore.subscribe((state, prev) => {
      if (state.skin !== prev.skin) sync()
    })
    return () => {
      unsubscribe()
      unsubscribeSelection()
    }
  }, [])

  /**
   * 全局设置（骨骼样式）→ 场景。
   *
   * 与预览通道同一个套路：设置写在 settings store（高频、不进工程），
   * 视口订阅它按需重画；不经过主 store，改动不会顺带触发文档同步那一套。
   */
  useEffect(() => {
    const apply = (): void => {
      sceneRef.current?.setBoneStyle(useSettingsStore.getState().boneStyle)
    }
    apply()
    return useSettingsStore.subscribe(apply)
  }, [])

  /**
   * 拖动预览 → 场景（**不进主 store**）。
   *
   * 拖颜色 / 拖滑杆时值只写这条高频通道：文档不动 ⇒ 不深拷贝、不重建运行期、不刷面板，
   * 只有这里按帧把颜色热写进运行期。松手时调用方提交一次文档（一条撤销记录）并清空预览。
   */
  useEffect(() => {
    const apply = (): void => {
      const scene = sceneRef.current
      if (!scene) return
      scene.setPreviewSlotColors(usePreviewStore.getState().slotColors)
    }
    apply()
    return usePreviewStore.subscribe(apply)
  }, [])

  // 选中 / 工具 / 时间轴 → 场景
  useEffect(() => {
    const push = (): void => {
      const scene = sceneRef.current
      if (!scene) return
      const selection = useSelectionStore.getState()
      const tools = useToolStore.getState()
      const timeline = useTimelineStore.getState()
      const mode = useModeStore.getState().mode
      /*
       * 选中的附件只解析**一次**，给「操作器」与「权重骨骼高亮」共用。
       *
       * 解析走 resolveAttachment：先按当前皮肤找，找不到跨皮肤兜底。皮肤是用户切出来的，
       * 选中的附件可能在别的皮肤里；早先写的是「按当前皮肤找、找不到退回 skins[0]」，
       * 于是「当前皮肤里没有这个附件」时兜底不生效 —— 操作器与权重骨骼高亮一起失效
       *（实测：皮肤切到 goblingirl 后再选 default 里的 spear，weightBones 变成空数组）。
       */
      const selectedAttachmentData =
        selection.slot && selection.attachment
          ? resolveAttachment(
              useProjectStore.getState().document,
              selection.slot,
              selection.attachment,
              selection.skin
            )
          : null

      // 选中附件的操作器（仅 Pose 态 + 选择工具）：中心 = 附件 position，轴 = 附件旋转叠加骨骼
      let selectedAttachment: {
        boneIndex: number
        position: { x: number; y: number }
        rotation: number
      } | null = null
      // 操作器仍要求 kind 是 attachment：否则「选了骨骼」时会在旧附件上冒出一个点不动的假手柄
      if (
        tools.tool === 'select' &&
        mode === 'pose' &&
        selection.kind === 'attachment' &&
        selectedAttachmentData &&
        scene.runtime
      ) {
        const doc = useProjectStore.getState().document
        const slot = doc.slots.find((item) => item.name === selection.slot)
        const boneIndex = slot ? (scene.runtime.boneIndex[slot.bone] ?? -1) : -1
        if (slot && boneIndex >= 0) {
          selectedAttachment = {
            boneIndex,
            position: { ...selectedAttachmentData.position },
            rotation: selectedAttachmentData.rotation
          }
        }
      }
      // 选中网格所绑定的骨骼：叠加层用高亮色画出来（权重骨骼列表里有哪几根就画哪几根）
      let weightBones: string[] = []
      if (selectedAttachmentData?.type === 'mesh') weightBones = weightBonesOf(selectedAttachmentData)
      /*
       * 网格线框 / 顶点画在哪个插槽上（场景按它决定**整个网格层**的显隐，见 Scene.drawOverlays
       * 的 `showMesh`；空串 = 不画）。
       *
       * - **权重工具**：只看 `slot`、不看 `kind`。「先选网格、再去点骨骼或刷顶点」是常态，
       *   那时 kind 已是 bone，但 slot 仍指向要刷的网格 —— 按 kind 卡死会让权重着色与顶点一起消失。
       * - **选择 / Pose 工具**：必须连 `kind` 一起看。这两个工具没有「骨骼 + 网格」的组合语义，
       *   而 `selectBone` 出于权重刷的需要**不会**清掉 `slot` / `attachment`，
       *   于是选了骨骼之后，上一个 display 的线框与四个顶点会一直留着
       *   —— 用户看到的「选了骨骼，图片的框还在」就是它。
       *   同一个顾虑在操作器（`selectedAttachment`）与轮廓（`selectedDisplay`）上都是按 kind 卡的，
       *   只有这里漏了。
       */
      const focusMeshSlot =
        selection.slot &&
        (tools.tool === 'weight' ||
          ((tools.tool === 'select' || tools.tool === 'pose') && selection.kind === 'attachment'))
          ? selection.slot
          : ''
      scene.setViewState({
        overlay: tools.overlay,
        gizmo: tools.gizmo,
        // 绘制类工具激活时操作器不可用，直接不画（否则是点不动的假手柄）；
        // Pose 工具要拖骨骼改绑定姿态（蒙皮随之变形），所以和选择工具一样给操作器
        showGizmo: tools.tool === 'select' || tools.tool === 'pose',
        selectedBone: selection.kind === 'bone' ? selection.bone : '',
        // 多选：整批高亮（操作器仍只画在主选中那根上）
        selectedBones: selection.kind === 'bone' ? selection.bones : [],
        // 权重着色（饼图）跟着工具走：顶部「权重」开关已移除
        weightTool: tools.tool === 'weight',
        weightBones,
        selectedVertices: selection.vertices,
        selectedAttachment,
        // 选中 display 的轮廓：与操作器不同，**任何模式 / 工具下都给**（动画态也要看得出选的是谁）
        selectedDisplay:
          selection.kind === 'attachment' && selection.slot && selection.attachment
            ? { slot: selection.slot, attachment: selection.attachment }
            : null,
        /*
         * 悬停轮廓平时由 pointermove 直接写（频率远高于帧率，不该走 React 状态）。
         * 这里只做一件事：**工具不是选择工具时清掉** —— 否则切工具会留下一圈卡住的悬停预览。
         * 是选择工具时原样带过去（写着同一个值，不会造成多余重绘）。
         */
        hoveredDisplay: tools.tool === 'select' ? (scene.state.hoveredDisplay ?? null) : null,
        playing: mode === 'animate' && timeline.playing,
        speed: timeline.speed,
        loop: timeline.loop,
        time: timeline.time,
        onionSkin: mode === 'animate' && timeline.onionSkin,
        /*
         * 网格显示分两套：
         * - **顶点工具（FFD）**：隔离 —— 只渲染正在编辑的那一个网格（其它附件一起隐藏，
         *   否则十几层网格互相遮挡，线框与纹理叠在一起根本看不清）；
         * - **选择 / Pose 工具**：不隔离，只把线框与顶点限制在选中的那个插槽上（focusMeshSlot）。
         *   这两件事必须分开：隔离会让角色"掉图层"，而这两个工具只是不想让所有
         *   displayObject 都铺线框 —— 其余部分照常显示。
         *
         * 选中项不是网格时由场景侧忽略（见 Scene.applyMeshIsolation）。
         */
        isolateMeshSlot: tools.tool === 'ffd' && selection.kind === 'attachment' ? selection.slot : '',
        isolateMeshAttachment:
          tools.tool === 'ffd' && selection.kind === 'attachment' ? selection.attachment : '',
        /*
         * 「自己绘制边界」的目标附件：视口据此把旧网格线框 / 顶点 / 选中轮廓全藏起来，
         * 改成画图片的 region 框（见 Scene.drawOverlays）。只在「Pose 态 + 网格工具 + 该子工具
         * + 选中的是网格」时给值 —— 其它情况（换了子工具、没选中网格）显示照旧，
         * 于是「退出绘制边界就恢复显示 Mesh 和顶点」是自动的，不用谁去还原。
         */
        boundaryTarget:
          tools.tool === 'ffd' &&
          mode === 'pose' &&
          tools.meshSubtool === 'boundary' &&
          selection.kind === 'attachment' &&
          Boolean(selection.slot) &&
          Boolean(selection.attachment) &&
          selectedAttachmentData?.type === 'mesh'
            ? { slot: selection.slot, attachment: selection.attachment }
            : null,
        // 取值规则与理由见上面 focusMeshSlot 的注释
        focusMeshSlot,
        // 舞台参考图：背景层，仅编辑器显示，不参与导出
        stage: useProjectStore.getState().document.editorMeta.stage
      })
    }
    push()
    const unsubscribers = [
      // projectStore 也要推：附件操作器的位置来自文档（拖动附件时 updateSilent 只改文档，
      // 不推的话 selectedAttachment 停在按下时的旧位置，小坐标轴不会跟着附件走）
      useProjectStore.subscribe(push),
      useSelectionStore.subscribe(push),
      useToolStore.subscribe(push),
      useTimelineStore.subscribe(push),
      useModeStore.subscribe(push)
    ]
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe()
    }
  }, [])

  // 舞台参考图贴图：舞台文件（或工程路径）变化时（重新）加载，喂给场景；移除时清掉
  useEffect(() => {
    let cancelled = false
    let lastKey = ''
    const load = async (): Promise<void> => {
      const state = useProjectStore.getState()
      const stage = state.document.editorMeta.stage
      const projectPath = state.projectPath
      const scene = sceneRef.current
      if (!stage || !projectPath || !scene) {
        scene?.setStageTexture(null)
        return
      }
      const absPath = stageFilePath(dirName(projectPath), stage.file)
      if (absPath === lastKey) return
      lastKey = absPath
      try {
        const url = await getPlatform().imageUrl(absPath)
        if (!url || cancelled) return
        const image = await loadImageElement(url)
        if (cancelled) return
        const texture = new Texture({
          source: new ImageSource({ resource: image, alphaMode: 'premultiply-alpha-on-upload' })
        })
        if (cancelled) {
          texture.destroy(true)
          return
        }
        scene.setStageTexture(texture)
      } catch (error) {
        console.error('[视口] 加载舞台参考图失败：', error)
        if (!cancelled) scene.setStageTexture(null)
      }
    }
    void load()
    const unsubscribe = useProjectStore.subscribe(() => void load())
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  // 动画切换
  useEffect(() => {
    const apply = (): void => {
      const scene = sceneRef.current
      if (!scene) return
      const timeline = useTimelineStore.getState()
      if (scene.currentAnimation !== timeline.currentAnimation) {
        scene.setAnimation(timeline.currentAnimation)
      }
    }
    apply()
    return useTimelineStore.subscribe((state, prev) => {
      if (state.currentAnimation !== prev.currentAnimation) apply()
    })
  }, [])

  const pointer = useRef<{
    panning: boolean
    lastX: number
    lastY: number
    /** Alt+点击的**待定插点**：松手时没拖动过才真的插入（拖了就转成平移，见 onPointerMove） */
    insert: { clientX: number; clientY: number; rect: DOMRect } | null
    /**
     * 权重刷的**待定选骨骼**：按下时点在骨骼上（且没压着顶点）就记下来，
     * 松手时仍未拖动 → 把它设为刷的目标骨骼。这样「点击选骨骼」与「拖动刷权重」
     * 互不打架（工具按下必接管，不先记一笔的话骨骼怎么都点不中）。
     */
    boneClick: { bone: string; clientX: number; clientY: number } | null
  }>({
    panning: false,
    lastX: 0,
    lastY: 0,
    insert: null,
    boneClick: null
  })

  /** 每次事件都从 store 现取状态，避免拖拽过程中持有过期快照 */
  const buildHost = (): ToolHost | null => {
    const scene = sceneRef.current
    if (!scene) return null
    return {
      scene,
      selection: useSelectionStore.getState(),
      tools: useToolStore.getState(),
      mode: useModeStore.getState().mode,
      time: useTimelineStore.getState().time,
      status: onStatus
    }
  }

  const toWorld = (
    event: React.PointerEvent<HTMLDivElement> | React.MouseEvent<HTMLDivElement>
  ): { x: number; y: number } | null => {
    const scene = sceneRef.current
    if (!scene) return null
    const rect = event.currentTarget.getBoundingClientRect()
    return scene.viewport.screenToWorld(event.clientX - rect.left, event.clientY - rect.top)
  }

  /** 网格 / FFD 工具 + 选中附件，才谈得上插顶点（模式不对时给出提示并返回 false） */
  const canInsertMeshVertex = (): boolean => {
    const selection = useSelectionStore.getState()
    if (useToolStore.getState().tool !== 'ffd' || selection.kind !== 'attachment') return false
    if (useModeStore.getState().mode !== 'pose') {
      onStatus('插入顶点改的是绑定网格：请切到 Pose 状态')
      return false
    }
    return true
  }

  /** 在指定屏幕位置插一个顶点（UV 与蒙皮权重按所在三角形插值）；返回是否插入成功 */
  const insertMeshVertexAt = (clientX: number, clientY: number, rect: DOMRect): boolean => {
    const scene = sceneRef.current
    const selection = useSelectionStore.getState()
    if (!scene || selection.kind !== 'attachment') return false
    const world = scene.viewport.screenToWorld(clientX - rect.left, clientY - rect.top)
    const local = scene.worldToAttachmentLocal(selection.slot, selection.attachment, world.x, world.y)
    if (!local) {
      onStatus('插入位置不在附件上')
      return false
    }
    let created: number | null = null
    useProjectStore.getState().update('插入网格顶点', (draft) => {
      created = insertMeshVertex(draft, selection.slot, selection.attachment, local as { x: number; y: number })
    })
    const index = created as number | null
    if (index === null) {
      onStatus('该位置不在网格内部：点在网格覆盖的区域内才能插入顶点')
      return false
    }
    useSelectionStore.getState().selectVertices([index])
    onStatus(`已插入顶点 #${index}（UV 与权重按位置插值，落在网格线上时会把那条边一分为二）`)
    return true
  }

  /**
   * 网格顶点插入的「一次性」入口（双击用）：工具 / 模式不对时返回 false，让调用方走别的逻辑。
   * Alt+点击不走这里 —— 它先记待定插点、松手才插（见 onPointerDown / releasePointer）。
   */
  const tryInsertMeshVertex = (clientX: number, clientY: number, rect: DOMRect): boolean => {
    if (!canInsertMeshVertex()) return false
    return insertMeshVertexAt(clientX, clientY, rect)
  }

  /**
   * 鼠标「已经不在视口上」时的一次性清理：跟随图标藏起来，悬停轮廓 / 刷子圈 / 网格悬停收掉。
   * onPointerLeave 用它；弹层上的事件也用它（见 isOwnEvent）。
   */
  const resetPointerPreview = (): void => {
    // 跟随图标藏起来（下次进来随手一动，它又回到鼠标旁边）
    if (bindIconRef.current) bindIconRef.current.style.visibility = 'hidden'
    // 悬停轮廓也要清掉：鼠标已经不在视口里了，留着会像「卡住的选中态」
    const scene = sceneRef.current
    if (scene?.state.hoveredDisplay) {
      scene.setViewState({ hoveredDisplay: null })
      scene.markDirty()
    }
    // 刷子半径圈同理：它是跟着鼠标走的光标，鼠标出去了就该收起来
    if (scene?.state.brushRing) scene.setViewState({ brushRing: null })
    // 网格子工具的悬停 / 橡皮筋末端也是跟鼠标走的，出去一并清掉
    if (scene) {
      const path = scene.state.pendingMeshPath
      if (scene.state.hoveredVertex >= 0 || path?.cursor) {
        scene.setViewState({ hoveredVertex: -1, pendingMeshPath: path ? { ...path, cursor: null } : null })
      }
    }
    pointer.current.boneClick = null
  }

  /**
   * 这个指针事件是不是**真的发生在视口里**。
   *
   * 右键菜单和拾色器都 portal 到 body，但**仍然是 ViewportCanvas 的 React 子树**：
   * React 的事件按 **React 树**（不是 DOM 树）冒泡，所以弹层里拖一下会一路冒到宿主的
   * onPointerMove / onPointerDown 上 —— 表现就是「穿透」：调颜色时视口跟着悬停骨骼、
   * 点选、甚至起拖，滚轮缩放、双击适配视野、右键还会弹插槽菜单。
   *
   * 判据：事件目标落在宿主的 DOM 子树里才算视口自己的事件（portal 的内容挂在 body 下，不在其中）。
   * 不属于视口时顺手清掉悬停预览 —— 鼠标已经不在视口上了，与 onPointerLeave 同一口径。
   */
  const isOwnEvent = (event: { target: EventTarget | null }): boolean => {
    if (event.target instanceof Node && hostRef.current?.contains(event.target) === true) return true
    resetPointerPreview()
    return false
  }

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!isOwnEvent(event)) return
    const scene = sceneRef.current
    if (!scene) return

    // 「绑定骨骼」状态（检查器点「添加绑定骨骼」进入）：
    // - 左键点骨骼 → 加进列表，**状态保持**，可以连着点几根
    // - 右键 / 再点按钮 / Esc → 结束绑定状态
    // 此状态下不响应平移与普通拾取，免得"想点第二根骨骼"却把视口拖走了
    const pending = useToolStore.getState().pendingWeightBone
    if (pending) {
      if (event.button === 2) {
        event.preventDefault()
        useToolStore.getState().setPendingWeightBone(null)
        onStatus('已结束绑定骨骼')
        return
      }
      // 中键仍然平移视口：绑骨骼时经常要挪一下视角，去找被网格 / 其它骨骼挡住的骨骼
      if (event.button === 1) {
        pointer.current = { panning: true, lastX: event.clientX, lastY: event.clientY, insert: null, boneClick: null }
        event.currentTarget.setPointerCapture(event.pointerId)
        return
      }
      if (event.button !== 0) return
      const target = toWorld(event)
      if (!target) return
      const hitBone = scene.pickBoneAt(target.x, target.y)
      if (!hitBone || !scene.runtime) {
        onStatus('请点在骨骼上（可连续点选多根；右键或再点按钮结束绑定）')
        return
      }
      const boneName = scene.runtime.asset.bones[hitBone.boneIndex]?.name ?? ''
      let added = false
      useProjectStore.getState().update('绑定权重骨骼', (draft) => {
        added = addWeightBone(draft, pending.slot, pending.attachment, boneName)
      })
      scene.setDocument(useProjectStore.getState().document, useSelectionStore.getState().skin)
      scene.refresh()
      onStatus(
        added
          ? `已绑定「${boneName}」；可继续点选其它骨骼，完成后右键或再点按钮结束`
          : `「${boneName}」已在列表里；继续点选，或右键结束绑定`
      )
      return
    }

    /*
     * 网格子工具（左下角图标条）：右键 = 收尾并回到「编辑顶点」。
     * 「自己绘制边界」正画到一半的话，右键先按规则把最后一个点连回起点闭合（见 meshSubtoolCancel）。
     */
    const meshTools = useToolStore.getState()
    if (event.button === 2 && meshTools.tool === 'ffd' && meshTools.meshSubtool !== 'edit') {
      event.preventDefault()
      const meshHost = buildHost()
      // 正在画边界：右键 = 收尾闭合，成功与否它自己报（那条提示比这句笼统的更具体）
      const boundaryDraw = meshTools.meshSubtool === 'boundary' && Boolean(meshHost?.scene.state.pendingMeshPath)
      if (meshHost) meshSubtoolCancel(meshHost)
      if (!boundaryDraw) onStatus('网格工具：已回到「编辑顶点」')
      meshTools.setMeshSubtool('edit')
      return
    }

    /*
     * 右键 = 上下文菜单（见 onContextMenu）。工具一律**不接管**右键按下：
     * 否则 Pose 态右键点附件会像左键一样开始拖拽，松手才弹菜单 —— 假交互。
     * （绑骨骼 / 网格子工具的右键语义在上面各自的分支里处理，轮不到这里。）
     */
    if (event.button === 2) return

    // Alt+点击 = 插入顶点。这里只**记下待定插点**（不在这里判工具 / 选中：松手时才决定
    // 是插点还是解释为什么不插），真正插入放到松手时 —— 期间没拖动过才算「点击」，
    // 所以 Alt 拖动依旧是平移，不会一按下去就多出一个顶点。
    //
    // 权重刷除外：那里 Alt = 减少权重（见 brushModeFor），必须落到工具手里，否则刷不了。
    if (event.altKey && useToolStore.getState().tool !== 'weight') {
      pointer.current = {
        panning: false,
        lastX: event.clientX,
        lastY: event.clientY,
        insert: {
          clientX: event.clientX,
          clientY: event.clientY,
          rect: event.currentTarget.getBoundingClientRect()
        },
        boneClick: null
      }
      event.currentTarget.setPointerCapture(event.pointerId)
      event.preventDefault()
      return
    }
    // 平移视口只认中键。右键不再参与平移（绑定骨骼状态下它是「结束绑定」，
    // 平时则什么都不做），避免右键误拖把视口挪走。
    if (event.button === 1) {
      pointer.current = { panning: true, lastX: event.clientX, lastY: event.clientY, insert: null, boneClick: null }
      event.currentTarget.setPointerCapture(event.pointerId)
      return
    }
    const world = toWorld(event)
    if (!world) return

    /*
     * 权重刷：按下时「点在骨骼上、且没压着顶点」就记一笔待定选骨骼 ——
     * 松手时若没拖动过，就把它设成刷的目标骨骼（见 releasePointer）。
     *
     * 为什么要记在 pointer 上：工具是「按下必接管」的（要开始刷），
     * 由它自己判骨骼会把「在网格上起笔」也吃掉。分开判就不会互相干扰：
     * 点击 = 选骨骼，拖动 = 刷权重。
     */
    if (useToolStore.getState().tool === 'weight' && !scene.pickVertexAt(world.x, world.y)) {
      const hitBone = scene.pickBoneAt(world.x, world.y)
      const name = hitBone && scene.runtime ? (scene.runtime.asset.bones[hitBone.boneIndex]?.name ?? '') : ''
      pointer.current.boneClick = name ? { bone: name, clientX: event.clientX, clientY: event.clientY } : null
    }

    /*
     * Shift / Cmd / Ctrl + 点骨骼 = 加选 / 减选，与层级树同一套规则。
     *
     * 这一步必须排在工具**前面**：选择 / Pose 工具点中骨骼就会开始拖拽并 return true，
     * 根本走不到下面的点选分支 —— 只在那儿判修饰键，视口里就永远只是单选。
     * Alt 不参与（视口里它是插顶点 / 权重工具里是「减少」），权重刷与绑骨骼工具也不参与。
     */
    const multiSelect = event.shiftKey || event.metaKey || event.ctrlKey
    const activeTool = useToolStore.getState().tool
    if (
      multiSelect &&
      !event.altKey &&
      scene.runtime &&
      (activeTool === 'select' || activeTool === 'pose')
    ) {
      const hitBone = scene.pickBoneAt(world.x, world.y)
      const name = hitBone ? (scene.runtime.asset.bones[hitBone.boneIndex]?.name ?? '') : ''
      if (name) {
        useSelectionStore.getState().toggleBone(name)
        const after = useSelectionStore.getState()
        onStatus(
          after.bones.length > 0
            ? `已选中 ${after.bones.length} 根骨骼（主选中「${after.bone}」；Shift / Cmd 点击可加选 / 减选）`
            : '已取消骨骼选择'
        )
        return
      }
    }

    const host = buildHost()
    if (host && toolPointerDown(host, { world, shift: event.shiftKey, ctrl: event.ctrlKey, alt: event.altKey })) {
      event.currentTarget.setPointerCapture(event.pointerId)
      return
    }

    const hit = scene.pickBoneAt(world.x, world.y)
    const selection = useSelectionStore.getState()
    if (hit && scene.runtime) {
      const name = scene.runtime.asset.bones[hit.boneIndex]?.name ?? ''
      const tools = useToolStore.getState()
      // 顶点工具 / 权重刷下，骨骼体上若压着顶点就优先选顶点（这两类工具就是在编顶点）
      if (tools.tool === 'ffd' || tools.tool === 'weight') {
        const vertex = scene.pickVertexAt(world.x, world.y)
        if (vertex) {
          selection.selectVertices([vertex.vertexIndex])
          onStatus(`顶点 #${vertex.vertexIndex}（${scene.meshResult?.vertexCount ?? 0} 个顶点）`)
          return
        }
      }
      selection.selectBone(name)
      onStatus(`选中骨骼「${name}」（骨骼体=旋转 / 原点圈=移动 / 末端方块=缩放）`)
    } else {
      selection.clear()
      onStatus('已取消选择')
    }
  }

  /** 绑定骨骼状态的跟随图标：贴在鼠标右下方（直接写 style，不走 state，免得每次移动都重渲染） */
  const moveBindIcon = (event: React.PointerEvent<HTMLDivElement>): void => {
    const icon = bindIconRef.current
    if (!icon) return
    const rect = event.currentTarget.getBoundingClientRect()
    icon.style.left = `${event.clientX - rect.left + 12}px`
    icon.style.top = `${event.clientY - rect.top + 12}px`
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!isOwnEvent(event)) return
    if (bindIconRef.current) moveBindIcon(event)
    const scene = sceneRef.current
    if (!scene) return
    const p = pointer.current
    // 待定插点：一旦拖动超过阈值，说明用户其实想平移 → 转成平移（这次就不再插点）。
    // 阈值给到 6px：真实鼠标 / 触控板的「点击」常带几像素抖动，阈值太小会把点击误判成拖动
    //（表现就是「点了没反应」）
    if (p.insert && Math.hypot(event.clientX - p.insert.clientX, event.clientY - p.insert.clientY) > 6) {
      p.insert = null
      p.panning = true
    }
    if (p.panning) {
      scene.viewport.pan(event.clientX - p.lastX, event.clientY - p.lastY)
      p.lastX = event.clientX
      p.lastY = event.clientY
      scene.markDirty()
      return
    }
    const world = toWorld(event)
    if (!world) return

    /*
     * 权重刷：光标与「刷子半径圈」都跟着**模式**走 —— Alt=减少（红）、Shift=覆盖（蓝）、
     * 默认增加（绿）。圈画在场景里、用的是世界半径（与真正落笔同一个值），所见即所得；
     * 悬在骨骼上时给 pointer 光标并收起圈，提示「点一下就把这根设成刷的目标骨骼」。
     */
    if (useToolStore.getState().tool === 'weight') {
      const tools = useToolStore.getState()
      const mode = brushModeFor(
        { alt: event.altKey, shift: event.shiftKey, ctrl: event.ctrlKey },
        baseBrushMode(tools.brush.mode)
      )
      const overBone =
        !scene.pickVertexAt(world.x, world.y) && scene.pickBoneAt(world.x, world.y) !== null
      const cursor = overBone ? 'pointer' : brushCursor(mode)
      if (event.currentTarget.style.cursor !== cursor) event.currentTarget.style.cursor = cursor
      scene.setViewState({
        brushRing: overBone
          ? null
          : { x: world.x, y: world.y, radius: tools.brush.size / 100, mode }
      })
      // 拖动超过阈值就不再算「点击」：这一次是刷权重，不是选骨骼（阈值同插点：6px）
      const click = pointer.current.boneClick
      if (click && Math.hypot(event.clientX - click.clientX, event.clientY - click.clientY) > 6) {
        pointer.current.boneClick = null
      }
      if (isDragging()) {
        const host = buildHost()
        if (host) toolPointerMove(host, { world, shift: event.shiftKey, ctrl: event.ctrlKey, alt: event.altKey })
      }
      return
    }
    if (scene.state.brushRing) scene.setViewState({ brushRing: null })

    if (isDragging()) {
      const host = buildHost()
      if (host) toolPointerMove(host, { world, shift: event.shiftKey, ctrl: event.ctrlKey, alt: event.altKey })
      return
    }

    /*
     * 网格子工具（视口左下角图标条，只在 Pose 态的网格工具下出现）：
     * - 光标换成本子工具带徽标的指针 —— 不看光标也知道这下点下去是加点还是删点；
     * - 悬停预览交回子工具：画边界时橡皮筋跟着鼠标走，删点 / 布线时高亮鼠标底下的顶点。
     * 「编辑顶点」是默认态：不换光标、也不吃掉后面的骨骼 / 操作器光标逻辑。
     */
    const meshTools = useToolStore.getState()
    if (meshTools.tool === 'ffd' && useModeStore.getState().mode === 'pose') {
      if (meshTools.meshSubtool !== 'edit') {
        const cursor = meshSubtoolCursor(meshTools.meshSubtool)
        if (event.currentTarget.style.cursor !== cursor) event.currentTarget.style.cursor = cursor
        // 选择工具留下的悬停轮廓（下面的悬停预览逻辑被跳过了）顺手清掉：子工具接管了鼠标，那圈高亮会误导
        if (scene.state.hoveredDisplay) {
          scene.setViewState({ hoveredDisplay: null })
          scene.markDirty()
        }
        const meshHost = buildHost()
        if (meshHost) meshSubtoolHover(meshHost, world)
        return
      }
      // 回到默认态：清掉上一次留下的徽标光标（React 只在值变化时写 style，得手动还原）
      if (event.currentTarget.style.cursor) event.currentTarget.style.cursor = ''
    }
    const hit = scene.pickBoneHandleAt(world.x, world.y)
    const name = hit && scene.runtime ? (scene.runtime.asset.bones[hit.boneIndex]?.name ?? '') : ''
    if (scene.state.hoveredBone !== name) scene.setViewState({ hoveredBone: name })

    /*
     * 悬停预览：把「鼠标底下的 display」也标出来，点下去之前就知道会选中谁。
     *
     * 两个约束：
     * ① 只在选择工具下算 —— 其它工具点下去干的是别的事（刷权重 / 插顶点），提示会误导；
     * ② 只在**变化时**写状态 —— pointermove 的频率远高于帧率，每次都写会白重绘。
     */
    const picked = useToolStore.getState().tool === 'select' ? scene.pickAttachmentAt(world.x, world.y) : null
    // 锁定的插槽不参与悬停高亮 —— 与「视口里点不中」保持一致，不然会看着能选却选不上
    const hovered = picked && slotLocked(picked.slot) ? null : picked
    const previous = scene.state.hoveredDisplay ?? null
    const sameHover =
      previous === null
        ? hovered === null
        : hovered !== null && previous.slot === hovered.slot && previous.attachment === hovered.attachment
    if (!sameHover) {
      scene.setViewState({ hoveredDisplay: hovered })
      scene.markDirty()
    }

    // 按住 Alt（网格 / FFD 工具 + 已选网格附件）：光标变「复制」——提示这里点一下会插顶点
    if (
      event.altKey &&
      useToolStore.getState().tool === 'ffd' &&
      useSelectionStore.getState().kind === 'attachment'
    ) {
      if (event.currentTarget.style.cursor !== 'copy') event.currentTarget.style.cursor = 'copy'
      return
    }

    // 光标：斜切包围盒 > 小坐标轴 > 原点圈（移动）> 骨骼体（旋转）> 约束准星
    const mode = useToolStore.getState().gizmo
    const shearEdge = mode === 'shear' ? scene.pickShearEdgeAt(world.x, world.y) : null
    const part = mode === 'shear' ? null : scene.pickGizmoAt(world.x, world.y)
    // 约束准星悬停：骨骼层关掉时 hoveredBone 高亮看不见，光标给 pointer 提示「准星能点」
    const overConstraint = !hit && scene.pickConstraintTargetAt(world.x, world.y) !== null
    const cursor = shearEdge
      ? shearEdge === 'top' || shearEdge === 'bottom'
        ? 'ew-resize'
        : 'ns-resize'
      : part
      ? mode === 'move'
        ? 'move'
        : mode === 'rotate'
          ? 'grab'
          : part === 'center'
            ? 'col-resize'
            : part === 'y'
              ? 'ns-resize'
              : 'ew-resize'
      : hit?.zone === 'origin'
        ? 'move'
        : hit
          ? // 落在骨骼本体上时按当前变换模式给光标（本体也能拖）
            mode === 'move'
            ? 'move'
            : mode === 'rotate'
              ? 'grab'
              : mode === 'scale'
                ? 'nwse-resize'
                : 'crosshair'
          : overConstraint
            ? 'pointer'
            : 'default'
    if (event.currentTarget.style.cursor !== cursor) event.currentTarget.style.cursor = cursor
  }

  const releasePointer = (event: React.PointerEvent<HTMLDivElement>): void => {
    /*
     * 这里**刻意不查 isOwnEvent**：松手必须收尾（清 pointer.current、结束工具拖拽）。
     * 它做的事都由「视口里的按下」触发（那些按下已经被 isOwnEvent 挡掉了），
     * 弹层上的松手进来也是空跑；挡掉反而可能把待定插点 / 拖拽状态留在半路。
     */
    const pending = pointer.current.insert
    pointer.current.panning = false
    pointer.current.insert = null
    // 松手时仍挂着待定插点 = 这是一次「Alt+点击」（期间没拖动过）。
    // 逐项检查并**明确说明为什么没插**：静默失败最让人困惑（看起来就像功能坏了）
    if (pending) {
      const selection = useSelectionStore.getState()
      const tool = useToolStore.getState().tool
      if (tool !== 'ffd') {
        onStatus('Alt+点击插入顶点：先切到网格工具（Pose 按 M / Animate 按 D）')
      } else if (selection.kind !== 'attachment') {
        onStatus('Alt+点击插入顶点：先在层级树里选中要编辑的网格附件')
      } else if (useModeStore.getState().mode !== 'pose') {
        onStatus('插入顶点改的是绑定网格：请切到 Pose 状态')
      } else {
        insertMeshVertexAt(pending.clientX, pending.clientY, pending.rect)
      }
    }
    const host = buildHost()
    if (isDragging() && host) toolPointerUp(host)
    /*
     * 权重刷：这一下没拖动过（待定选骨骼还在）、且按下时确实点在骨骼上 →
     * 把它设成刷的目标骨骼。工具本身仍拿不到骨骼就没法刷（状态栏会提示去层级树选），
     * 所以这一步是权重刷「在视口里选骨骼」的唯一入口。
     */
    const boneClick = pointer.current.boneClick
    pointer.current.boneClick = null
    if (boneClick && useToolStore.getState().tool === 'weight') {
      useSelectionStore.getState().selectBone(boneClick.bone)
      onStatus(`权重刷目标骨骼：「${boneClick.bone}」——按住拖动刷权重（Alt=减少 / Shift=覆盖）`)
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const onWheel = (event: React.WheelEvent<HTMLDivElement>): void => {
    if (!isOwnEvent(event)) return
    const scene = sceneRef.current
    if (!scene) return
    const rect = event.currentTarget.getBoundingClientRect()
    const factor = event.deltaY > 0 ? 0.9 : 1.1
    scene.viewport.zoomAt(factor, event.clientX - rect.left, event.clientY - rect.top)
    scene.markDirty()
  }

  /**
   * 资源面板拖进来的图片：在落点建「插槽 + Region display」。
   *
   * 支持一次多张（资源面板里多选后整组拖动）：以落点为中心排成紧凑网格，避免互相盖住；
   * 全部在**同一次 update** 里创建，撤销时整组一起退回。
   * 宿主骨骼：鼠标下压着的那根（明确的「挂到它身上」意图），否则挂到层级根骨骼 `root` 下 ——
   * 刻意不看当前选中骨骼：列表里选着的骨骼常和这次拖入无关，静默挂过去很难发现。
   * 一根骨骼都没有（老工程 / 空白骨架）时提示先画一根骨骼。
   * 只在 Pose 态建档：插槽 / 附件属于绑定数据，Animate 态改 setup 会污染动画基线。
   */
  const onImageDrop = (event: React.DragEvent<HTMLDivElement>): void => {
    const scene = sceneRef.current
    const droppedNames = readImageDrag(event.dataTransfer)
    if (!scene || droppedNames.length === 0) return

    if (useModeStore.getState().mode !== 'pose') {
      onStatus('切到 Pose 状态才能把图片放进场景：插槽 / 附件属于绑定数据')
      return
    }

    const store = useProjectStore.getState()
    // 按资源面板里的选择顺序保留；找不到的（刚被移除）跳过并计数
    const images = droppedNames
      .map((name) => store.document.images.find((item) => item.name === name))
      .filter((item): item is AuthoringImage => Boolean(item))
    const missing = droppedNames.length - images.length
    if (images.length === 0) {
      onStatus(`找不到图片「${droppedNames[0]}」（可能已被移除）`)
      return
    }

    const rect = event.currentTarget.getBoundingClientRect()
    const world = scene.viewport.screenToWorld(event.clientX - rect.left, event.clientY - rect.top)
    // 场景此前没有可见内容（如新建工程的第一次拖入）：落点聚焦 + 适配缩放，
    // 并阻止渲染循环随后又自动 fit 把视角拉走（表现为图片「不在鼠标位置」）
    const emptyScene = !scene.hasVisibleContent
    const hit = scene.pickBoneAt(world.x, world.y)
    let host = (hit && scene.runtime ? scene.runtime.asset.bones[hit.boneIndex]?.name : '') ?? ''
    // 没压在骨骼上就挂到层级根骨骼 root 下：插槽 / 附件与其他节点一样，都必须在 root 之下
    if (!host) host = rootBoneName(store.document.bones)
    if (!host) {
      onStatus('场景里还没有骨骼：先用「绑骨骼 (B)」画一根骨骼，再把图片拖进来')
      return
    }

    // 多张排成网格；间隙按屏幕像素换算，缩放后间距观感一致
    const layout = gridDropLayout(
      images.map((image) => ({ width: image.width / PPU, height: image.height / PPU })),
      scene.viewport.pixelsToWorld(14)
    )

    const created: { slot: string; attachment: string }[] = []
    store.update(images.length > 1 ? `拖入 ${images.length} 张图片创建插槽` : '拖入图片创建插槽', (draft) => {
      images.forEach((image, index) => {
        const target = { x: world.x + layout.offsets[index].x, y: world.y + layout.offsets[index].y }
        // 落点 → 骨骼局部坐标（宿主骨骼当前姿态下的显示空间）
        const local = scene.worldToBoneLocal(host, target.x, target.y) ?? target
        const result = createRegionFromImage(draft, {
          image: image.name,
          bone: host,
          width: image.width,
          height: image.height,
          position: local,
          skin: useSelectionStore.getState().skin
        })
        if (result) created.push(result)
      })
    })

    if (created.length === 0) {
      onStatus(`无法用「${images[0].name}」创建插槽`)
      return
    }
    // 插槽是单选模型：选中这一批里的第一个，多选拖拽时也只能单选
    const first = created[0]
    useSelectionStore.getState().selectAttachment(first.slot, first.attachment)
    if (emptyScene) {
      scene.autoFitDone = true
      scene.focusOnContent(world.x, world.y, layout.width, layout.height)
    }
    const skipped = missing > 0 ? `；另有 ${missing} 张图片已不存在，未创建` : ''
    if (created.length === 1) {
      onStatus(`已创建插槽「${first.slot}」：图片「${images[0].name}」作为 display 挂到骨骼「${host}」下${skipped}`)
    } else {
      const names = images.slice(0, created.length).map((image) => image.name).join('、')
      onStatus(`已创建 ${created.length} 个插槽（${names}）挂到骨骼「${host}」下${skipped}`)
    }
  }

  return (
    <div
      ref={hostRef}
      className="hao-checkerboard relative flex-1 overflow-hidden"
      onMouseDown={(e) => {
        if (!isOwnEvent(e)) return
        // 中键默认会触发浏览器的「自动滚动」（四向箭头 + 滚动页面），在 mousedown 阶段拦掉
        if (e.button === 1) e.preventDefault()
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={releasePointer}
      onPointerCancel={releasePointer}
      onPointerEnter={() => {
        if (bindIconRef.current) bindIconRef.current.style.visibility = ''
      }}
      // 离开视口（含移到弹层上，见 isOwnEvent）就把跟随图标藏起来 + 清掉悬停预览
      onPointerLeave={resetPointerPreview}
      onWheel={onWheel}
      onDoubleClick={(event) => {
        if (!isOwnEvent(event)) return
        // 网格 / FFD 工具下双击网格内部 = 插一个顶点（与 Alt+点击共用同一实现）
        if (tryInsertMeshVertex(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect())) {
          return
        }
        sceneRef.current?.fit()
        onStatus('已适配视野')
      }}
      onDragOver={(event) => {
        if (!isOwnEvent(event)) return
        if (!hasImageDrag(event.dataTransfer)) return
        // 内部图片拖拽在视口里处理完就停下，别冒泡去触发整窗的拖放兜底处理
        event.preventDefault()
        event.stopPropagation()
        event.dataTransfer.dropEffect = 'copy'
      }}
      onDrop={(event) => {
        if (!isOwnEvent(event)) return
        if (!hasImageDrag(event.dataTransfer)) return
        event.preventDefault()
        event.stopPropagation()
        onImageDrop(event)
      }}
      onContextMenu={(event) => {
        if (!isOwnEvent(event)) return
        event.preventDefault()
        // 右键菜单只服务 Pose / Animate（选择 / Pose 工具）下对 slot / display 的操作：
        // 权重刷 / 网格 / 顶点这些工具有自己的右键语义（收尾、结束绑定），别抢
        const tools = useToolStore.getState()
        if (tools.tool !== 'select' && tools.tool !== 'pose') return
        const mode = useModeStore.getState().mode
        if (mode !== 'pose' && mode !== 'animate') return
        const world = toWorld(event)
        const hit = world ? sceneRef.current?.pickAttachmentAt(world.x, world.y) : null
        if (!hit) return
        // 菜单**只认点中的附件**：选中骨骼 / 空白处右键都不弹（层级操作针对的就是被点中的这个插槽）
        // 右键谁就选谁（与左键一致），菜单标题和检查器都跟着切过去
        const selection = useSelectionStore.getState()
        if (selection.kind !== 'attachment' || selection.slot !== hit.slot || selection.attachment !== hit.attachment) {
          selection.selectAttachment(hit.slot, hit.attachment)
        }
        setSlotMenu({ x: event.clientX, y: event.clientY, slot: hit.slot, pose: mode === 'pose' })
      }}
      style={{ cursor: pointer.current.panning ? 'grabbing' : 'default' }}
    >
      {/* 绑定骨骼状态：一个「骨骼」图标跟在鼠标右下角，提示此时点视口是在选骨骼。
          pointer-events-none：别挡住视口自己的命中判定；初始放在视野外，鼠标一动就归位 */}
      {pendingWeightBone ? (
        <div
          ref={bindIconRef}
          className="pointer-events-none absolute z-30 flex size-6 items-center justify-center rounded-full border border-lime-400/80 bg-ink-900/85 text-lime-400 shadow-lg shadow-black/50"
          style={{ left: -9999, top: -9999 }}
        >
          <Bone size={14} />
        </div>
      ) : null}

      {/* 右键菜单：插槽层级操作
          （Pose 改 setup / Animate 打层级帧；Animate 态没有「删除」） */}
      {slotMenu ? (
        <ContextMenu
          x={slotMenu.x}
          y={slotMenu.y}
          title={`插槽「${slotMenu.slot}」`}
          items={[...slotLayerMenuItems(slotMenu.slot, { pose: slotMenu.pose, onStatus })]}
          onClose={() => setSlotMenu(null)}
        />
      ) : null}
    </div>
  )
}

/*
 * 图集页来源记账见 `@render/imageSourceRegistry` 的模块级单例 `imageSources`：
 * 视图卸载时会清掉（下面 effect 的清理函数），新建项目 / 导入资源时由
 * `releaseDocumentAssets()` 清掉 —— 视口没挂载时也得能清，所以不放这儿。
 */

async function loadTextures(
  store: TextureStore | null,
  document: ReturnType<typeof useProjectStore.getState>['document'],
  imageAlpha: ImageAlphaCache | null
): Promise<void> {
  if (!store && !imageAlpha) return
  const platform = getPlatform()
  /*
   * 先释放「换了源路径 / 已不在清单里」的图集页。
   *
   * 不同资源的图集页常常**同名**（DragonBones 示例里 Dragon / DragonOpening / Ubbie_MeshAnim /
   * Demon 都叫 `texture.png`），而两个缓存都按名字做键：不释放就会继续用上一份贴图，
   * 新资源的 UV 是按新页尺寸归一化的，贴到旧图上整块错位 —— 看起来就像「零件位置不对」。
   */
  for (const name of imageSources.sync(document.images)) {
    store?.delete(name)
    imageAlpha?.delete(name)
  }
  // 并行加载：串行时一张张排队，最后一张读完前面才全部就绪（视口里先是白块，等得越久越明显）
  await Promise.all(
    document.images.map(async (image) => {
      // 纹理与 alpha 缓存的就绪状态分开判断：纹理已加载不代表像素拾取能采样了
      const ready = imageSources.has(image)
      const needTexture = store !== null && !(ready && store.has(image.name))
      const needAlpha = imageAlpha !== null && !(ready && imageAlpha.has(image.name))
      if (!needTexture && !needAlpha) return
      // imageUrl：Electron 会读文件字节给同源 blob:（协议 URL 跨源，WebGL 用不了）
      const url = await platform.imageUrl(image.path)
      if (!url) return
      if (needTexture && store) await store.load(image.name, url)
      if (needAlpha && imageAlpha) imageAlpha.ensure(image.name, url)
      imageSources.markLoaded(image)
    })
  )
}

import { useEffect, useRef } from 'react'
import { Bone } from 'lucide-react'
import { EditorScene } from '@editor/scene'
import { TextureStore } from '@render/material'
import { ImageAlphaCache } from '@render/imageAlpha'
import { getPlatform } from '@editor/platform'
import { useProjectStore } from '@editor/store/projectStore'
import { useSelectionStore } from '@editor/store/selectionStore'
import { useToolStore } from '@editor/store/toolStore'
import { useModeStore } from '@editor/store/modeStore'
import { useTimelineStore } from '@editor/store/timelineStore'
import { usePlayheadStore } from '@editor/store/playheadStore'
import { isDragging, toolPointerDown, toolPointerMove, toolPointerUp } from '@editor/tools/authoringTools'
import type { ToolHost } from '@editor/tools/authoringTools'
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
import type { AuthoringImage } from '@core/model/authoring'

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
      sceneRef.current = null
    }
  }, [onSceneReady, onStatus])

  // 文档 → 场景
  useEffect(() => {
    const sync = (): void => {
      const scene = sceneRef.current
      if (!scene) return
      const { document } = useProjectStore.getState()
      const selection = useSelectionStore.getState()
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
      scene.setViewState({
        overlay: tools.overlay,
        gizmo: tools.gizmo,
        // 绘制类工具激活时操作器不可用，直接不画（否则是点不动的假手柄）；
        // Pose 工具要拖骨骼改绑定姿态（蒙皮随之变形），所以和选择工具一样给操作器
        showGizmo: tools.tool === 'select' || tools.tool === 'pose',
        selectedBone: selection.kind === 'bone' ? selection.bone : '',
        weightBone: tools.overlay.weight ? selection.bone : '',
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
         * 只看 `slot`、不看 `kind`：权重工具里「先选骨骼、再点顶点刷」是常态，那时 kind 是 bone，
         * 但 slot 仍指向要刷的网格 —— 按 kind 卡死会让权重着色与顶点一起消失。
         */
        focusMeshSlot:
          (tools.tool === 'select' || tools.tool === 'pose' || tools.tool === 'weight') && selection.slot
            ? selection.slot
            : ''
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
  }>({
    panning: false,
    lastX: 0,
    lastY: 0,
    insert: null
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

  const toWorld = (event: React.PointerEvent<HTMLDivElement>): { x: number; y: number } | null => {
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

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
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
        pointer.current = { panning: true, lastX: event.clientX, lastY: event.clientY, insert: null }
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

    // Alt+点击 = 插入顶点。这里只**记下待定插点**（不在这里判工具 / 选中：松手时才决定
    // 是插点还是解释为什么不插），真正插入放到松手时 —— 期间没拖动过才算「点击」，
    // 所以 Alt 拖动依旧是平移，不会一按下去就多出一个顶点
    if (event.altKey) {
      pointer.current = {
        panning: false,
        lastX: event.clientX,
        lastY: event.clientY,
        insert: {
          clientX: event.clientX,
          clientY: event.clientY,
          rect: event.currentTarget.getBoundingClientRect()
        }
      }
      event.currentTarget.setPointerCapture(event.pointerId)
      event.preventDefault()
      return
    }
    // 平移视口只认中键。右键不再参与平移（绑定骨骼状态下它是「结束绑定」，
    // 平时则什么都不做），避免右键误拖把视口挪走。
    if (event.button === 1) {
      pointer.current = { panning: true, lastX: event.clientX, lastY: event.clientY, insert: null }
      event.currentTarget.setPointerCapture(event.pointerId)
      return
    }
    const world = toWorld(event)
    if (!world) return

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
      if (tools.overlay.ffd || tools.overlay.weight) {
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
    if (isDragging()) {
      const host = buildHost()
      if (host) toolPointerMove(host, { world, shift: event.shiftKey, ctrl: event.ctrlKey, alt: event.altKey })
      return
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
    const hovered = useToolStore.getState().tool === 'select' ? scene.pickAttachmentAt(world.x, world.y) : null
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

    // 光标：斜切包围盒 > 小坐标轴 > 原点圈（移动）> 骨骼体（旋转）
    const mode = useToolStore.getState().gizmo
    const shearEdge = mode === 'shear' ? scene.pickShearEdgeAt(world.x, world.y) : null
    const part = mode === 'shear' ? null : scene.pickGizmoAt(world.x, world.y)
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
          : 'default'
    if (event.currentTarget.style.cursor !== cursor) event.currentTarget.style.cursor = cursor
  }

  const releasePointer = (event: React.PointerEvent<HTMLDivElement>): void => {
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
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const onWheel = (event: React.WheelEvent<HTMLDivElement>): void => {
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
   * 宿主骨骼优先取鼠标下的那根，其次当前选中骨骼，再退回第一根；
   * 一根骨骼都没有（空白工程）时先补一根根骨骼，这样直接拖图就能开工。
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
    const selection = useSelectionStore.getState()
    let host = (hit && scene.runtime ? scene.runtime.asset.bones[hit.boneIndex]?.name : '') ?? ''
    if (!host) host = selection.kind === 'bone' ? selection.bone : ''
    if (!host) host = store.document.bones[0]?.name ?? ''
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
      onPointerLeave={() => {
        // 鼠标离开视口就把跟随图标藏起来（下次进来随手一动，它又回到鼠标旁边）
        if (bindIconRef.current) bindIconRef.current.style.visibility = 'hidden'
        // 悬停轮廓也要清掉：鼠标已经不在视口里了，留着会像「卡住的选中态」
        const scene = sceneRef.current
        if (scene?.state.hoveredDisplay) {
          scene.setViewState({ hoveredDisplay: null })
          scene.markDirty()
        }
      }}
      onWheel={onWheel}
      onDoubleClick={(event) => {
        // 网格 / FFD 工具下双击网格内部 = 插一个顶点（与 Alt+点击共用同一实现）
        if (tryInsertMeshVertex(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect())) {
          return
        }
        sceneRef.current?.fit()
        onStatus('已适配视野')
      }}
      onDragOver={(event) => {
        if (!hasImageDrag(event.dataTransfer)) return
        // 内部图片拖拽在视口里处理完就停下，别冒泡去触发整窗的拖放兜底处理
        event.preventDefault()
        event.stopPropagation()
        event.dataTransfer.dropEffect = 'copy'
      }}
      onDrop={(event) => {
        if (!hasImageDrag(event.dataTransfer)) return
        event.preventDefault()
        event.stopPropagation()
        onImageDrop(event)
      }}
      onContextMenu={(e) => e.preventDefault()}
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
    </div>
  )
}

async function loadTextures(
  store: TextureStore | null,
  document: ReturnType<typeof useProjectStore.getState>['document'],
  imageAlpha: ImageAlphaCache | null
): Promise<void> {
  if (!store && !imageAlpha) return
  const platform = getPlatform()
  // 并行加载：串行时一张张排队，最后一张读完前面才全部就绪（视口里先是白块，等得越久越明显）
  await Promise.all(
    document.images.map(async (image) => {
      // 纹理与 alpha 缓存的就绪状态分开判断：纹理已加载不代表像素拾取能采样了
      const needTexture = store !== null && !store.has(image.name)
      const needAlpha = imageAlpha !== null && !imageAlpha.has(image.name)
      if (!needTexture && !needAlpha) return
      // imageUrl：Electron 会读文件字节给同源 blob:（协议 URL 跨源，WebGL 用不了）
      const url = await platform.imageUrl(image.path)
      if (!url) return
      if (needTexture && store) await store.load(image.name, url)
      if (needAlpha && imageAlpha) imageAlpha.ensure(image.name, url)
    })
  )
}

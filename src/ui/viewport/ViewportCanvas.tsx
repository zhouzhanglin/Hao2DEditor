import { useEffect, useRef } from 'react'
import { EditorScene } from '@editor/scene'
import { TextureStore } from '@render/material'
import { getPlatform } from '@editor/platform'
import { useProjectStore } from '@editor/store/projectStore'
import { useSelectionStore } from '@editor/store/selectionStore'
import { useToolStore } from '@editor/store/toolStore'
import { useModeStore } from '@editor/store/modeStore'
import { useTimelineStore } from '@editor/store/timelineStore'
import { isDragging, toolPointerDown, toolPointerMove, toolPointerUp } from '@editor/tools/authoringTools'
import type { ToolHost } from '@editor/tools/authoringTools'
import { createRegionFromImage, insertMeshVertex, PPU } from '@editor/commands/authoringCommands'
import { hasImageDrag, readImageDrag } from '@ui/widgets/dragDrop'

/** 临时诊断：拖放链路日志累积（定位「第一次拖图坐标不对」后移除） */
const dropDebugLines: string[] = []

export interface ViewportCanvasProps {
  onSceneReady: (scene: EditorScene) => void
  onStatus: (text: string) => void
}

/** pixi 画布挂载：创建 EditorScene，订阅 store 投喂状态，处理平移 / 缩放 / 拾取 */
export default function ViewportCanvas({ onSceneReady, onStatus }: ViewportCanvasProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const sceneRef = useRef<EditorScene | null>(null)
  const texturesRef = useRef<TextureStore | null>(null)

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
    const loop = (now: number): void => {
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
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
      if (scene.currentAnimation && timeline.playing) {
        // 播放推进后把时间回写到 store，供时间轴显示
        const time = scene.runtime?.player.time ?? 0
        if (Math.abs(time - timeline.time) > 1e-4) timeline.setTime(time)
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
      void loadTextures(texturesRef.current, document)
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
      // 选中附件的操作器（仅 Pose 态 + 选择工具）：中心 = 附件 position，轴 = 附件旋转叠加骨骼
      let selectedAttachment: {
        boneIndex: number
        position: { x: number; y: number }
        rotation: number
      } | null = null
      if (tools.tool === 'select' && mode === 'pose' && selection.kind === 'attachment' && scene.runtime) {
        const doc = useProjectStore.getState().document
        const slot = doc.slots.find((item) => item.name === selection.slot)
        const boneIndex = slot ? (scene.runtime.boneIndex[slot.bone] ?? -1) : -1
        const skin =
          doc.skins.find((item) => item.name === selection.skin) ?? doc.skins[0]
        const attachment = skin?.slots
          .find((item) => item.slot === selection.slot)
          ?.attachments.find((item) => item.name === selection.attachment)
        if (slot && boneIndex >= 0 && attachment) {
          selectedAttachment = {
            boneIndex,
            position: { ...attachment.position },
            rotation: attachment.rotation
          }
        }
      }
      scene.setViewState({
        overlay: tools.overlay,
        gizmo: tools.gizmo,
        // 绘制类工具激活时操作器不可用，直接不画（否则是点不动的假手柄）
        showGizmo: tools.tool === 'select',
        selectedBone: selection.kind === 'bone' ? selection.bone : '',
        weightBone: tools.overlay.weight ? selection.bone : '',
        selectedVertices: selection.vertices,
        selectedAttachment,
        playing: mode === 'animate' && timeline.playing,
        speed: timeline.speed,
        loop: timeline.loop,
        time: timeline.time,
        onionSkin: mode === 'animate' && timeline.onionSkin
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

  const pointer = useRef<{ panning: boolean; lastX: number; lastY: number }>({
    panning: false,
    lastX: 0,
    lastY: 0
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

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    const scene = sceneRef.current
    if (!scene) return
    if (event.button === 1 || event.button === 2 || event.altKey) {
      pointer.current = { panning: true, lastX: event.clientX, lastY: event.clientY }
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

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const scene = sceneRef.current
    if (!scene) return
    if (pointer.current.panning) {
      scene.viewport.pan(event.clientX - pointer.current.lastX, event.clientY - pointer.current.lastY)
      pointer.current.lastX = event.clientX
      pointer.current.lastY = event.clientY
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
    pointer.current.panning = false
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
   * 宿主骨骼优先取鼠标下的那根，其次当前选中骨骼，再退回第一根；
   * 一根骨骼都没有（空白工程）时先补一根根骨骼，这样直接拖图就能开工。
   * 只在 Pose 态建档：插槽 / 附件属于绑定数据，Animate 态改 setup 会污染动画基线。
   */
  const onImageDrop = (event: React.DragEvent<HTMLDivElement>): void => {
    const scene = sceneRef.current
    const imageName = readImageDrag(event.dataTransfer)
    if (!scene || !imageName) return

    if (useModeStore.getState().mode !== 'pose') {
      onStatus('切到 Pose 状态才能把图片放进场景：插槽 / 附件属于绑定数据')
      return
    }

    const store = useProjectStore.getState()
    const image = store.document.images.find((item) => item.name === imageName)
    if (!image) {
      onStatus(`找不到图片「${imageName}」（可能已被移除）`)
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

    let created: { slot: string; attachment: string } | null = null
    let local: { x: number; y: number } = { x: world.x, y: world.y }
    store.update('拖入图片创建插槽', (draft) => {
      // 落点 → 骨骼局部坐标（宿主骨骼当前姿态下的显示空间）
      local = scene.worldToBoneLocal(host, world.x, world.y) ?? { x: world.x, y: world.y }
      created = createRegionFromImage(draft, {
        image: image.name,
        bone: host,
        width: image.width,
        height: image.height,
        position: local,
        skin: useSelectionStore.getState().skin
      })
    })

    if (!created) {
      onStatus(`无法用「${image.name}」创建插槽`)
      return
    }
    const result: { slot: string; attachment: string } = created
    useSelectionStore.getState().selectAttachment(result.slot, result.attachment)
    if (emptyScene) {
      scene.autoFitDone = true
      scene.focusOnContent(world.x, world.y, image.width / PPU, image.height / PPU)
    }
    // 临时诊断：把拖放链路的关键数值写日志（定位「第一次拖图坐标不对」用）
    {
      const after = scene.viewport.worldToScreen(local.x, local.y)
      const info = {
        screen: [Math.round(event.clientX - rect.left), Math.round(event.clientY - rect.top)],
        rect: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)],
        dpr: window.devicePixelRatio,
        cameraBefore: { zoom: scene.viewport.zoom, offset: scene.viewport.offset },
        world: { x: world.x, y: world.y },
        emptyScene,
        host,
        hitBone: hit ? hit.boneIndex : null,
        bones: store.document.bones.map((b) => b.name),
        local: { x: local.x, y: local.y },
        posScreenAfter: { x: Math.round(after.x), y: Math.round(after.y) },
        cameraAfter: { zoom: scene.viewport.zoom, offset: scene.viewport.offset }
      }
      const line = `[drop-debug] ${new Date().toISOString()} ${JSON.stringify(info)}\n`
      console.log(line.trim())
      dropDebugLines.push(line)
      void getPlatform()
        .writeText('/tmp/hao2d-drop-debug.txt', dropDebugLines.join(''))
        .catch(() => undefined)
    }
    onStatus(`已创建插槽「${result.slot}」：图片「${image.name}」作为 display 挂到骨骼「${host}」下`)
  }

  return (
    <div
      ref={hostRef}
      className="hao-checkerboard relative flex-1 overflow-hidden"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={releasePointer}
      onPointerCancel={releasePointer}
      onWheel={onWheel}
      onDoubleClick={(event) => {
        const scene = sceneRef.current
        if (!scene) return
        const selection = useSelectionStore.getState()
        const tools = useToolStore.getState()
        // 网格 / FFD 工具下双击网格内部 = 插一个顶点（UV 与蒙皮权重按所在三角形插值）
        if ((tools.tool === 'mesh' || tools.tool === 'ffd') && selection.kind === 'attachment') {
          if (useModeStore.getState().mode !== 'pose') {
            onStatus('插入顶点改的是绑定网格：请切到 Pose 状态')
            return
          }
          const rect = event.currentTarget.getBoundingClientRect()
          const world = scene.viewport.screenToWorld(event.clientX - rect.left, event.clientY - rect.top)
          const local = scene.worldToAttachmentLocal(selection.slot, selection.attachment, world.x, world.y)
          if (!local) {
            onStatus('双击位置不在附件上')
            return
          }
          let created: number | null = null
          useProjectStore.getState().update('插入网格顶点', (draft) => {
            created = insertMeshVertex(draft, selection.slot, selection.attachment, local as { x: number; y: number })
          })
          const index = created as number | null
          if (index === null) {
            onStatus('双击位置不在网格内部（先选中一个网格附件）')
            return
          }
          useSelectionStore.getState().selectVertices([index])
          onStatus(`已插入顶点 #${index}（UV 与权重按所在三角形插值）`)
          return
        }
        scene.fit()
        onStatus('已适配视野')
      }}
      onDragOver={(event) => {
        if (!hasImageDrag(event.dataTransfer)) return
        // 内部图片拖拽在视口里处理完就停下，别冒泡去触发整窗的「拖入文件导入」覆盖层
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
    </div>
  )
}

async function loadTextures(store: TextureStore | null, document: ReturnType<typeof useProjectStore.getState>['document']): Promise<void> {
  if (!store) return
  const platform = getPlatform()
  for (const image of document.images) {
    if (store.has(image.name)) continue
    // imageUrl：Electron 会读文件字节给同源 blob:（协议 URL 跨源，WebGL 用不了）
    const url = await platform.imageUrl(image.path)
    if (!url) continue
    await store.load(image.name, url)
  }
}

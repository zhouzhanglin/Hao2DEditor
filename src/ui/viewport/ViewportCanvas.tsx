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
    let fitted = false
    const loop = (now: number): void => {
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      scene.update(dt)
      // 首次拿到有效几何后自动适配视野
      if (!fitted) {
        const bounds = scene.meshResult?.bounds
        if (bounds && bounds.maxX - bounds.minX > 1e-4 && bounds.maxY - bounds.minY > 1e-4) {
          fitted = true
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
      scene.setViewState({
        overlay: tools.overlay,
        gizmo: tools.gizmo,
        // 绘制类工具激活时骨骼操作器不可用，直接不画（否则是点不动的假手柄）
        showGizmo: tools.tool === 'select' || tools.tool === 'bone',
        selectedBone: selection.kind === 'bone' ? selection.bone : '',
        weightBone: tools.overlay.weight ? selection.bone : '',
        selectedVertices: selection.vertices,
        playing: mode === 'animate' && timeline.playing,
        speed: timeline.speed,
        loop: timeline.loop,
        time: timeline.time,
        onionSkin: mode === 'animate' && timeline.onionSkin
      })
    }
    push()
    const unsubscribers = [
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

  return (
    <div
      ref={hostRef}
      className="hao-checkerboard relative flex-1 overflow-hidden"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={releasePointer}
      onPointerCancel={releasePointer}
      onWheel={onWheel}
      onDoubleClick={() => {
        sceneRef.current?.fit()
        onStatus('已适配视野')
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
    const url = platform.fileUrl(image.path)
    if (!url) continue
    await store.load(image.name, url)
  }
}

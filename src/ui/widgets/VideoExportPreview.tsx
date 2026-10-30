import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { EditorScene } from '@editor/scene'
import {
  type ExportView,
  panViewByPixels,
  zoomViewAtPixel
} from '@render/exportCamera'
import { hexToColorInt } from '@editor/services/videoExport'

export interface VideoExportPreviewProps {
  scene: EditorScene | null
  /** 视频画幅（真实像素） */
  width: number
  height: number
  background: string
  view: ExportView
  /** 预览用的时间点（秒） */
  time: number
  onViewChange: (view: ExportView) => void
}

/** 预览画布的最大尺寸（面板内留给它的方框） */
const BOX_WIDTH = 372
const BOX_HEIGHT = 300

/**
 * 导出取景预览：用**导出同一条渲染链路**（`scene.captureFrame`）出一张静帧，
 * 画到 2D canvas 上，所以看到的就是成片那一帧。
 *
 * 交互：拖拽平移、滚轮以光标为锚缩放，全部直接换算成「视频像素」再改取景，
 * 与右侧数值框共享同一个 `view`。
 */
export default function VideoExportPreview({
  scene,
  width,
  height,
  background,
  view,
  time,
  onViewChange
}: VideoExportPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const draggingRef = useRef<{ x: number; y: number } | null>(null)
  const renderingRef = useRef(false)
  const pendingRef = useRef(false)
  const [cursor, setCursor] = useState<'grab' | 'grabbing'>('grab')

  /** 预览像素尺寸：按视频宽高比塞进方框 */
  const preview = useMemo(() => {
    const scale = Math.min(BOX_WIDTH / width, BOX_HEIGHT / height)
    return {
      width: Math.max(2, Math.round(width * scale)),
      height: Math.max(2, Math.round(height * scale)),
      /** 预览像素 ÷ 视频像素（拖拽换算要用） */
      ratio: scale
    }
  }, [width, height])

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || !scene) return
    if (renderingRef.current) {
      // 上一帧还在读像素：记一笔，等它画完再用最新参数补一帧（拖动时避免堆积）
      pendingRef.current = true
      return
    }
    renderingRef.current = true
    try {
      canvas.width = preview.width
      canvas.height = preview.height
      const frame = scene.captureFrame({
        time,
        width: preview.width,
        height: preview.height,
        background: hexToColorInt(background),
        // 预览画幅比视频小：zoom 同比缩放，取景框覆盖的世界范围才与成片一致
        view: { ...view, zoom: view.zoom * preview.ratio }
      })
      if (!frame || frame.byteLength !== preview.width * preview.height * 4) return
      const context = canvas.getContext('2d')
      if (!context) return
      // 拷一份再交给 ImageData：导出用的缓冲会被下一次捕获复用（且 TS 要求 ArrayBuffer 而非 SharedArrayBuffer）
      const clamped = new Uint8ClampedArray(frame.byteLength)
      clamped.set(frame)
      context.putImageData(new ImageData(clamped, preview.width, preview.height), 0, 0)
    } finally {
      renderingRef.current = false
      if (pendingRef.current) {
        pendingRef.current = false
        requestAnimationFrame(() => draw())
      }
    }
  }, [scene, time, background, view, preview])

  useEffect(() => {
    draw()
  }, [draw])

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    draggingRef.current = { x: event.clientX, y: event.clientY }
    setCursor('grabbing')
  }

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    const from = draggingRef.current
    if (!from) return
    const dx = event.clientX - from.x
    const dy = event.clientY - from.y
    draggingRef.current = { x: event.clientX, y: event.clientY }
    // 预览像素 → 视频像素：取景是按视频像素定义的
    onViewChange(panViewByPixels(view, dx / preview.ratio, dy / preview.ratio))
  }

  const endDrag = (): void => {
    draggingRef.current = null
    setCursor('grab')
  }

  const onWheel = (event: React.WheelEvent<HTMLCanvasElement>): void => {
    event.preventDefault()
    const rect = event.currentTarget.getBoundingClientRect()
    // 光标位置换算到视频像素空间
    const px = ((event.clientX - rect.left) / preview.ratio) as number
    const py = ((event.clientY - rect.top) / preview.ratio) as number
    const factor = event.deltaY > 0 ? 0.92 : 1.08
    onViewChange(zoomViewAtPixel(view, width, height, px, py, factor))
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 rounded-[5px] border border-line/70 bg-ink-900/60 p-2">
      <div className="relative">
        <canvas
          ref={canvasRef}
          className="block rounded-[3px] shadow-lg shadow-black/40 ring-1 ring-white/15"
          style={{ cursor, touchAction: 'none' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onPointerLeave={endDrag}
          onWheel={onWheel}
        />
      </div>
    </div>
  )
}

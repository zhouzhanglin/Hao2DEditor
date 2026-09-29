import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ImageOff } from 'lucide-react'
import { getPlatform } from '@editor/platform'
import type { AuthoringImage } from '@core/model/authoring'

/** 悬停大图的最大边长（px）；图片按原始宽高比缩放，不拉伸 */
const PREVIEW_MAX = 240
/** 预览浮层与行的间距 */
const PREVIEW_GAP = 10
const PREVIEW_MARGIN = 8

/** 图片文件 → 可显示的 URL（Electron 走 hao2d-file://，浏览器走 blob:） */
function useImageUrl(path: string): string {
  return useMemo(() => (path ? getPlatform().fileUrl(path) : ''), [path])
}

/** 列表行里的小缩略图：棋盘打底，透明图也能看清边界 */
export function ImageThumb({ path, size = 26 }: { path: string; size?: number }) {
  const url = useImageUrl(path)
  const [failed, setFailed] = useState(false)
  const broken = !url || failed

  return (
    <span
      className="hao-checkerboard-sm flex shrink-0 items-center justify-center overflow-hidden rounded border border-line/70"
      style={{ width: size, height: size }}
      title={broken ? '无法读取图片文件' : undefined}
    >
      {broken ? (
        <ImageOff size={12} className="text-content-lo" />
      ) : (
        <img
          src={url}
          alt=""
          draggable={false}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
          className="h-full w-full object-contain"
          style={{ imageRendering: 'pixelated' }}
        />
      )}
    </span>
  )
}

/**
 * 悬停预览：渲染到 body 上（不受面板 overflow 裁剪），
 * 默认贴在行的右侧，右侧放不下就翻到左边，垂直居中对齐该行并夹在窗口内。
 * 锚点传元素本身而不是快照，列表滚动时能重新贴边（滚动/缩放都会重算）。
 */
export function ImageHoverPreview({ image, anchor }: { image: AuthoringImage; anchor: HTMLElement }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const url = useImageUrl(image.path)
  const [failed, setFailed] = useState(false)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const [tick, setTick] = useState(0)

  const ratio = image.height > 0 ? image.width / image.height : 1
  const box = ratio >= 1
    ? { width: PREVIEW_MAX, height: Math.max(48, Math.round(PREVIEW_MAX / ratio)) }
    : { width: Math.max(48, Math.round(PREVIEW_MAX * ratio)), height: PREVIEW_MAX }

  // 捕获阶段的 scroll 能收到面板容器的滚动（不冒泡到 window 的那层也拦得住）
  useEffect(() => {
    const bump = (): void => setTick((value) => value + 1)
    window.addEventListener('scroll', bump, true)
    window.addEventListener('resize', bump)
    return () => {
      window.removeEventListener('scroll', bump, true)
      window.removeEventListener('resize', bump)
    }
  }, [])

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const rect = element.getBoundingClientRect()
    const source = anchor.getBoundingClientRect()
    let left = source.right + PREVIEW_GAP
    if (left + rect.width > window.innerWidth - PREVIEW_MARGIN) {
      left = source.left - rect.width - PREVIEW_GAP
    }
    left = Math.max(PREVIEW_MARGIN, Math.min(left, window.innerWidth - rect.width - PREVIEW_MARGIN))
    const centered = source.top + source.height / 2 - rect.height / 2
    const top = Math.max(
      PREVIEW_MARGIN,
      Math.min(centered, window.innerHeight - rect.height - PREVIEW_MARGIN)
    )
    setPosition({ left, top })
  }, [anchor, image.name, box.width, box.height, tick])

  return createPortal(
    <div
      ref={ref}
      className="pointer-events-none fixed z-50 flex flex-col gap-1 rounded border border-line bg-ink-800/95 p-1.5 shadow-xl"
      style={{
        left: position?.left ?? -10000,
        top: position?.top ?? -10000,
        opacity: position ? 1 : 0,
        transition: 'opacity 90ms linear'
      }}
    >
      <div
        className="hao-checkerboard flex items-center justify-center overflow-hidden rounded"
        style={{ width: box.width, height: box.height }}
      >
        {!url || failed ? (
          <span className="flex flex-col items-center gap-1 text-3xs text-content-lo">
            <ImageOff size={18} />
            无法读取
          </span>
        ) : (
          <img
            src={url}
            alt={image.name}
            draggable={false}
            onError={() => setFailed(true)}
            className="h-full w-full object-contain"
            style={{ imageRendering: 'pixelated' }}
          />
        )}
      </div>
      <div className="flex items-center justify-between gap-2 px-0.5">
        <span className="min-w-0 truncate text-3xs text-content-hi" title={image.name}>
          {image.name}
        </span>
        <span className="shrink-0 font-mono text-3xs text-content-lo">
          {image.width}×{image.height}
        </span>
        <span
          className={[
            'shrink-0 rounded px-1 text-3xs',
            image.loose ? 'bg-warn/20 text-warn' : 'bg-ink-600 text-content-lo'
          ].join(' ')}
        >
          {image.loose ? '碎图' : '图集'}
        </span>
      </div>
      <span className="truncate px-0.5 text-3xs text-content-lo/70" title={image.path}>
        {image.path}
      </span>
    </div>,
    document.body
  )
}

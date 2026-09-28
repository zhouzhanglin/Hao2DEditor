import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface ContextMenuItem {
  key: string
  label: string
  icon?: React.ReactNode
  hint?: string
  danger?: boolean
  disabled?: boolean
  /** 画一条分隔线（该项自身不可点击） */
  separator?: boolean
  onSelect?: () => void
}

export interface ContextMenuProps {
  x: number
  y: number
  title?: string
  items: ContextMenuItem[]
  onClose: () => void
}

/**
 * 通用右键菜单：渲染到 body 上（不受面板 overflow 裁剪），自动贴边收拢。
 * 点击外部 / Esc / 滚动 / 改变窗口大小都会关闭。
 */
export default function ContextMenu({ x, y, title, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [position, setPosition] = useState({ left: x, top: y })

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const rect = element.getBoundingClientRect()
    const margin = 6
    setPosition({
      left: Math.max(margin, Math.min(x, window.innerWidth - rect.width - margin)),
      top: Math.max(margin, Math.min(y, window.innerHeight - rect.height - margin))
    })
  }, [x, y, items.length])

  useEffect(() => {
    const close = (): void => onClose()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    // 捕获阶段：确保面板内部的点击不会先触发其它逻辑
    window.addEventListener('pointerdown', close, true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', close)
    window.addEventListener('wheel', close, { passive: true })
    return () => {
      window.removeEventListener('pointerdown', close, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', close)
      window.removeEventListener('wheel', close)
    }
  }, [onClose])

  return createPortal(
    <div
      ref={ref}
      className="fixed z-[999] min-w-[196px] rounded border border-line bg-ink-800 py-1 shadow-xl shadow-black/50"
      style={{ left: position.left, top: position.top }}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {title ? (
        <div className="truncate border-b border-line/60 px-2 pb-1 text-3xs uppercase tracking-[0.08em] text-content-lo">
          {title}
        </div>
      ) : null}
      {items.map((item) =>
        item.separator ? (
          <div key={item.key} className="my-1 h-px bg-line/70" />
        ) : (
          <button
            key={item.key}
            type="button"
            disabled={item.disabled}
            title={item.hint}
            className={[
              'flex w-full items-center gap-2 px-2 py-[5px] text-left text-xs transition-colors duration-panel',
              item.disabled
                ? 'cursor-not-allowed text-content-lo/50'
                : item.danger
                  ? 'cursor-pointer text-danger/90 hover:bg-danger/15'
                  : 'cursor-pointer text-content-mid hover:bg-ink-700 hover:text-content-hi'
            ].join(' ')}
            onClick={() => {
              onClose()
              item.onSelect?.()
            }}
          >
            <span className="flex h-[14px] w-[14px] shrink-0 items-center justify-center text-content-lo">
              {item.icon}
            </span>
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
          </button>
        )
      )}
    </div>,
    document.body
  )
}

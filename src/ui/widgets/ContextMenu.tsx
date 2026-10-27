import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface ContextMenuItem {
  key: string
  /** 菜单文字；分隔线项（`separator: true`）不需要 */
  label?: string
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
    const onPointerDown = (event: PointerEvent): void => {
      // 点在本菜单内：不能关。这里是最外层（捕获阶段）监听，一定会先于菜单项自己的
      // 处理器执行；靠子元素的 stopPropagation 拦不住它 —— 一旦在这里关闭菜单，
      // 元素当场卸载，随后的 click 落到菜单下面的元素上，菜单项永远点不中。
      if (ref.current?.contains(event.target as Node | null)) return
      onClose()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', onClose)
    window.addEventListener('wheel', onClose, { passive: true })
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('wheel', onClose)
    }
  }, [onClose])

  return createPortal(
    <div
      ref={ref}
      className="fixed z-[999] min-w-[196px] rounded-[6px] border border-white/10 bg-ink-700/95 px-1 py-1 shadow-2xl shadow-black/60 backdrop-blur-xl"
      style={{ left: position.left, top: position.top }}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {title ? (
        <div className="truncate px-2 pb-1 text-3xs text-content-lo">
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
              'flex w-full items-center gap-2 rounded-[4px] px-2 py-[5px] text-left text-panel transition-colors duration-panel',
              item.disabled
                ? 'cursor-not-allowed text-content-lo/50'
                : item.danger
                  ? 'cursor-pointer text-danger hover:bg-danger/20'
                  : 'cursor-pointer text-content-hi hover:bg-accent-deep hover:text-white'
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

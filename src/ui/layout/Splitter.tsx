import { useCallback, useEffect, useRef } from 'react'

interface SplitterProps {
  direction: 'horizontal' | 'vertical'
  /** 拖拽时回调：percent 为起始边到指针的像素位置（已按容器缩放） */
  onResize: (deltaPx: number, event: PointerEvent) => void
  className?: string
}

/**
 * 极简分隔条：指针按下后锁定捕获，结束后解除。
 * horizontal = 竖向分隔条（左右分栏），vertical = 横向分隔条（上下分栏）。
 */
export default function Splitter({ direction, onResize, className }: SplitterProps) {
  const state = useRef<{ last: number } | null>(null)

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      const target = event.currentTarget
      target.setPointerCapture(event.pointerId)
      state.current = { last: direction === 'horizontal' ? event.clientX : event.clientY }
      document.body.style.cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize'
    },
    [direction]
  )

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!state.current) return
      const current = direction === 'horizontal' ? event.clientX : event.clientY
      const delta = current - state.current.last
      state.current.last = current
      if (delta !== 0) onResize(delta, event.nativeEvent)
    },
    [direction, onResize]
  )

  const release = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!state.current) return
    state.current = null
    document.body.style.cursor = ''
    const target = event.currentTarget
    if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId)
  }, [])

  useEffect(() => {
    return () => {
      document.body.style.cursor = ''
    }
  }, [])

  return (
    <div
      role="separator"
      aria-orientation={direction === 'horizontal' ? 'vertical' : 'horizontal'}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={release}
      onPointerCancel={release}
      className={[
        direction === 'horizontal' ? 'hao-splitter-v' : 'hao-splitter-h',
        className ?? ''
      ].join(' ')}
    />
  )
}

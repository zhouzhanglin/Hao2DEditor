import { useCallback, useEffect, useRef, useState } from 'react'
import Splitter from './Splitter'

export interface DockLayoutProps {
  menuBar: React.ReactNode
  toolbar: React.ReactNode
  left: React.ReactNode
  center: React.ReactNode
  right: React.ReactNode
  /** 为 null 时整个时间轴区域不渲染（Pose 态） */
  timeline: React.ReactNode | null
  statusBar: React.ReactNode
}

interface LayoutSizes {
  left: number
  right: number
  timeline: number
}

const DEFAULTS: LayoutSizes = { left: 268, right: 300, timeline: 236 }
const STORAGE_KEY = 'hao2d:layout'
const MIN_SIDE = 180
const MAX_SIDE = 520
const MIN_TIMELINE = 160
const MAX_TIMELINE = 560

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function loadSizes(): LayoutSizes {
  if (typeof localStorage === 'undefined') return DEFAULTS
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return DEFAULTS
  const parsed = JSON.parse(raw) as Partial<LayoutSizes>
  return { ...DEFAULTS, ...parsed }
}

/** 单窗口停靠式布局：顶部菜单与工具条固定，中间三栏，底部时间轴（按需出现）与状态栏。 */
export default function DockLayout(props: DockLayoutProps) {
  const [sizes, setSizes] = useState<LayoutSizes>(loadSizes)
  const persistTimer = useRef<number | null>(null)

  useEffect(() => {
    if (typeof localStorage === 'undefined') return
    if (persistTimer.current !== null) window.clearTimeout(persistTimer.current)
    persistTimer.current = window.setTimeout(() => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(sizes))
    }, 260)
    return () => {
      if (persistTimer.current !== null) window.clearTimeout(persistTimer.current)
    }
  }, [sizes])

  useEffect(() => {
    const handler = (): void => setSizes(DEFAULTS)
    window.addEventListener('hao2d:reset-layout', handler)
    return () => window.removeEventListener('hao2d:reset-layout', handler)
  }, [])

  const resizeLeft = useCallback((delta: number) => {
    setSizes((s) => ({ ...s, left: clamp(s.left + delta, MIN_SIDE, MAX_SIDE) }))
  }, [])

  const resizeRight = useCallback((delta: number) => {
    setSizes((s) => ({ ...s, right: clamp(s.right - delta, MIN_SIDE, MAX_SIDE) }))
  }, [])

  const resizeTimeline = useCallback((delta: number) => {
    setSizes((s) => ({ ...s, timeline: clamp(s.timeline - delta, MIN_TIMELINE, MAX_TIMELINE) }))
  }, [])

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-ink-900">
      <div className="z-20 shrink-0">{props.menuBar}</div>
      <div className="z-10 shrink-0">{props.toolbar}</div>

      <div className="flex min-h-0 flex-1">
        <aside
          className="flex min-h-0 shrink-0 flex-col gap-[3px] overflow-hidden"
          style={{ width: sizes.left }}
        >
          {props.left}
        </aside>
        <Splitter direction="horizontal" onResize={resizeLeft} />

        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {props.center}
        </main>

        <Splitter direction="horizontal" onResize={resizeRight} />
        <aside
          className="flex min-h-0 shrink-0 flex-col gap-[3px] overflow-hidden"
          style={{ width: sizes.right }}
        >
          {props.right}
        </aside>
      </div>

      {props.timeline !== null ? (
        <div className="flex shrink-0 flex-col">
          <Splitter direction="vertical" onResize={resizeTimeline} />
          <div className="animate-slide-up overflow-hidden" style={{ height: sizes.timeline }}>
            {props.timeline}
          </div>
        </div>
      ) : null}

      <div className="z-20 shrink-0">{props.statusBar}</div>
    </div>
  )
}

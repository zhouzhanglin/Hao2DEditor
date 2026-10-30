import { useCallback, useEffect, useRef, useState } from 'react'
import { useTimelineStore } from '@editor/store/timelineStore'
import Splitter from './Splitter'

export interface DockLayoutProps {
  menuBar: React.ReactNode
  /** 菜单栏下面那一行（可选：现在已没有内容，留着这个槽备用） */
  toolbar?: React.ReactNode
  left: React.ReactNode
  center: React.ReactNode
  /** 为 null 时整个右栏（含分隔条）不渲染，空间让给中间列（Animate 态收起属性面板） */
  right: React.ReactNode | null
  /** 为 null 时整个时间轴区域不渲染（Pose 态） */
  timeline: React.ReactNode | null
  statusBar: React.ReactNode
}

interface LayoutSizes {
  left: number
  right: number
  timeline: number
}

/**
 * 首次启动（localStorage 里还没有布局记录）时的默认尺寸。
 *
 * `left` 比原来多给 30px：层级树一行里除了骨骼 / 插槽名，行尾还要并排显示显示哪一个
 * display 与 px 值，268 时名字经常被截断。只影响第一次打开 —— 拖过分隔条之后
 * 以存下来的宽度为准（`loadSizes` 里保存值覆盖默认值）。
 */
const DEFAULTS: LayoutSizes = { left: 300, right: 300, timeline: 236 }
const STORAGE_KEY = 'hao2d:layout'
const MIN_SIDE = 180
const MAX_SIDE = 520
const MIN_TIMELINE = 160
const MAX_TIMELINE = 560
/** 时间轴收起时的高度：正好放下顶部播放条（30px），下方轨道一根都不渲染 */
const TIMELINE_COLLAPSED_HEIGHT = 30

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
  /**
   * 时间轴收起（只剩播放条）：高度由播放条决定，不再用 `sizes.timeline`。
   * 状态放在 timelineStore 里而不是本地：时间轴面板自己的按钮要能改它，
   * 这一层要跟着改高度 —— 跨组件就只能走 store。
   */
  const timelineCollapsed = useTimelineStore((s) => s.collapsed)

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
      {/*
        菜单栏的层级必须**高于视口里的浮动面板**（它们都是 z-20 / z-30）：
        导出 / 最近列表这些下拉是从菜单栏里弹出来的，被「准备 / 动画」切换按钮压住
        会直接挡住点击。窗口内的弹窗（z-[900]）走 portal 到 body，不受这里影响。
      */}
      <div className="z-40 shrink-0">{props.menuBar}</div>
      {/* 原来这里是一整行工具条（骨骼 / 约束 + 缩放）；那两块已并进视口右上角的浮动面板 */}
      {props.toolbar ? <div className="z-10 shrink-0">{props.toolbar}</div> : null}

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
          {/* 时间轴只占中列宽度：在视口下面，不侵占左右两侧的面板 */}
          {props.timeline !== null ? (
            <>
              {/* 收起时连分隔条一起不渲染：此时高度固定为播放条，拖它没有意义 */}
              {timelineCollapsed ? null : <Splitter direction="vertical" onResize={resizeTimeline} />}
              <div
                className="animate-slide-up mx-[3px] mb-[3px] shrink-0 overflow-hidden"
                style={{ height: timelineCollapsed ? TIMELINE_COLLAPSED_HEIGHT : sizes.timeline }}
              >
                {props.timeline}
              </div>
            </>
          ) : null}
        </main>

        {props.right ? (
          <>
            <Splitter direction="horizontal" onResize={resizeRight} />
            <aside
              className="flex min-h-0 shrink-0 flex-col gap-[3px] overflow-hidden"
              style={{ width: sizes.right }}
            >
              {props.right}
            </aside>
          </>
        ) : null}
      </div>

      <div className="z-20 shrink-0">{props.statusBar}</div>
    </div>
  )
}

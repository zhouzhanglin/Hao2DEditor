import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Flag, Lock, ZoomIn } from 'lucide-react'
import { TIMELINE_ZOOM_MAX, TIMELINE_ZOOM_MIN } from '@editor/store/timelineStore'
import type { KeySelector, TimelineTrack } from '@editor/timeline/model'
import { useProjectStore } from '@editor/store/projectStore'
import { useTimelineStore } from '@editor/store/timelineStore'

export interface DopeSheetProps {
  tracks: TimelineTrack[]
  /** 时间轴总长度（秒）：动画时长 + 尾部留白 */
  axis: number
  /** 动画时长（擦洗上限 + 结束线位置） */
  length: number
  /** 时间缩放：1 = 完整适配，越大可见时间范围越窄、关键帧越松散 */
  zoom: number
  onZoom: (zoom: number) => void
  time: number
  frameRate: number
  snapToFrame: boolean
  selectedKeys: KeySelector[]
  onSelectKeys: (keys: KeySelector[]) => void
  onSetTimes: (entries: Array<{ selector: KeySelector; time: number }>) => void
  onScrub: (time: number) => void
  onSelectTarget: (track: TimelineTrack) => void
  onBeginDrag: () => void
  onEndDrag: () => void
  /** 状态栏提示（右键「显示」通道切换 display 时反馈） */
  onStatus?: (text: string) => void
}

/** 时间→像素的映射（拖拽期间冻结，保证关键帧 1:1 跟随指针） */
interface TimeMap {
  start: number
  span: number
}

interface DragState {
  selectors: KeySelector[]
  originTimes: number[]
  startTime: number
  active: boolean
  map: TimeMap
}

const ROW_HEIGHT = 22
const LABEL_WIDTH = 172
const RULER_HEIGHT = 30
/** 相邻主刻度之间的最小像素间距，用于挑选刻度步长 */
const MIN_TICK_GAP = 58
const FRAME_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 240, 600]
const ZOOM_SENSITIVITY = 0.0016
/**
 * 时间轴左侧留白（占帧区域宽度的比例）。
 * 时间 0 不是贴着左边缘，第 0 帧的关键帧菱形就不会被裁掉；
 * 右侧同理多出一点余量，整体观感更舒展。
 */
const LEAD_RATIO = 0.022

function toSelector(track: TimelineTrack, channel: string, target: string, attachment: string, time: number): KeySelector {
  return { kind: track.kind, target, attachment, channel, time }
}

/** 轨道在提示里的完整名称：子轨道要带上骨骼名，否则只看「旋转」不知道是谁的 */
function rowLabel(track: TimelineTrack): string {
  return track.depth > 0 ? `${track.group} · ${track.label}` : track.label
}

/** 通道子轨道的圆点配色，便于一眼区分位置 / 旋转 / 缩放 / 斜切、显示 / 颜色 / 可见性 */
const CHANNEL_TONE: Record<string, string> = {
  translate: 'bg-ok',
  rotate: 'bg-accent',
  scale: 'bg-warn',
  shear: 'bg-accent-violet',
  display: 'bg-accent-violet',
  color: 'bg-warn',
  visible: 'bg-ok'
}

function sameSelector(a: KeySelector, b: KeySelector): boolean {
  return (
    a.kind === b.kind &&
    a.target === b.target &&
    a.attachment === b.attachment &&
    a.channel === b.channel &&
    Math.abs(a.time - b.time) < 1e-4
  )
}

/**
 * 多轨道 dope sheet：顶部是帧 / 时间刻度尺，下方是关键帧轨道。
 *
 * - 中键滚动（或 Ctrl/Cmd + 滚轮）缩放时间轴长度，缩放以光标处的时间为锚点；
 *   Shift + 滚轮横向平移，普通滚轮仍用于纵向滚动轨道
 * - 刻度尺与轨道共用同一套「时间 → 像素」映射，播放头严格对齐
 * - 动画结束线右侧留白可以继续拖入关键帧，拖过去即自动延长动画时长
 * - 同一轨道同一时间点的多通道关键帧合并成一个标记，整组拖动
 */
export default function DopeSheet(props: DopeSheetProps) {
  const { tracks, axis, length, time, frameRate, selectedKeys } = props
  const hostRef = useRef<HTMLDivElement | null>(null)
  const areaRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const scrubRef = useRef(false)
  /** 中键平移会话 */
  const panRef = useRef<{ x: number; start: number } | null>(null)
  /** 框选会话：左键按下记录起点，拖动超过阈值才进入框选 */
  const bandRef = useRef<{ x0: number; y0: number; active: boolean } | null>(null)
  /** 框选矩形（相对关键帧区的坐标），用于画选框 */
  const [band, setBand] = useState<{ left: number; top: number; width: number; height: number } | null>(null)
  /** 框选判定用的最新轨道 / 标记快照 + 选取逻辑（window 监听里用，避免闭包过期） */
  const pickRef = useRef<{ tracks: typeof tracks; markers: Array<Array<{ slot: number; selectors: KeySelector[] }>> }>({
    tracks,
    markers: []
  })
  const applyBandRef = useRef<(x0: number, y0: number, x1: number, y1: number) => void>(() => undefined)
  const [areaWidth, setAreaWidth] = useState(0)

  /**
   * 视窗（起点 + 缩放）以 ref 为权威：滚轮事件一帧内可能来很多个，
   * 若只读 state 会互相覆盖导致锚点漂移。ref 同步更新、state 只负责触发重绘。
   * 初始值来自 store（切换 Pose/Animate 后仍保留缩放）。
   */
  const [view, setView] = useState(() => ({ start: 0, zoom: props.zoom }))
  const viewRef = useRef(view)
  viewRef.current = view
  const applyView = (patch: Partial<TimeMap> & { zoom?: number }): void => {
    const next = { ...viewRef.current, ...patch }
    viewRef.current = next
    setView(next)
  }

  const zoom = view.zoom
  const span = zoom > 0 ? axis / zoom : axis
  const maxStart = Math.max(0, axis - span)
  const start = Math.min(Math.max(0, view.start), maxStart)

  const mapRef = useRef<TimeMap>({ start, span })
  mapRef.current = { start, span }
  const propsRef = useRef(props)
  propsRef.current = props

  // 刻度尺宽度必须与轨道区完全一致（轨道区右侧有滚动条，因此以它的真实宽度为准）
  useEffect(() => {
    const element = areaRef.current
    if (!element) return
    const update = (): void => setAreaWidth(element.clientWidth)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // 外部（store / 其它入口）改变缩放时同步到本地视窗。
  // 本地状态是连续滚轮事件的权威来源，这里只处理「外部值与本地上次写入不一致」的情况。
  useEffect(() => {
    if (Math.abs(props.zoom - viewRef.current.zoom) < 1e-6) return
    applyView({ zoom: props.zoom })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.zoom])

  // 缩放后把播放头拉回可见范围（只跟随时间变化，避免破坏缩放锚点）
  const lastTimeRef = useRef(time)
  useEffect(() => {
    if (time === lastTimeRef.current) return
    lastTimeRef.current = time
    const { start: currentStart, span: currentSpan } = mapRef.current
    if (time < currentStart || time > currentStart + currentSpan) {
      applyView({ start: Math.max(0, Math.min(maxStart, time - currentSpan * 0.5)) })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [time, maxStart])

  const isSelected = (selector: KeySelector): boolean => selectedKeys.some((item) => sameSelector(selector, item))

  /**
   * 当前选中的**子轨道（通道）**：点击通道行时由 TimelinePanel 写入。
   * 它同时决定「按 K 只给这条通道打帧」，所以行上必须有明确的选中反馈。
   */
  /** 轨道列表滚动容器：打帧后把对应行滚到可见 */
  const trackListRef = useRef<HTMLDivElement | null>(null)
  /** 刚打帧的轨道 id（短暂高亮） */
  const [flashTrackId, setFlashTrackId] = useState<string | null>(null)
  /**
   * 打帧（含右键菜单 / K / 时间轴右键选 display）后把该轨道滚进视野并闪一下。
   * 轨道多的时候新帧落在列表下方，不这么做会像「点了打关键帧但时间轴没反应」。
   */
  const lastKeyed = useTimelineStore((state) => state.lastKeyed)
  useEffect(() => {
    if (!lastKeyed) return
    // ① 垂直：把该轨道行滚进视野
    const row = trackListRef.current?.querySelector(
      `[data-track-id="${CSS.escape(lastKeyed.trackId)}"]`
    )
    row?.scrollIntoView({ block: 'nearest' })
    // ② 水平：时间点不在当前可见时间段内时，把视图挪过去 ——
    //    时间轴可以缩放/平移，新帧可能落在水平方向的可视区之外
    const current = viewRef.current
    const currentSpan = current.zoom > 0 ? axis / current.zoom : axis
    const viewStart = Math.min(Math.max(0, current.start), Math.max(0, axis - currentSpan))
    if (lastKeyed.time < viewStart || lastKeyed.time > viewStart + currentSpan) {
      const limit = Math.max(0, axis - currentSpan)
      applyView({
        start: Math.max(0, Math.min(limit, lastKeyed.time - currentSpan * 0.5))
      })
    }
    // ③ 高亮一下
    setFlashTrackId(lastKeyed.trackId)
    const timer = window.setTimeout(() => setFlashTrackId(null), 900)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastKeyed, axis])

  const activeTrack = useTimelineStore((state) => state.selectedTrack)
  const isTrackActive = (track: TimelineTrack): boolean =>
    !track.isGroup &&
    activeTrack !== null &&
    activeTrack.kind === track.kind &&
    activeTrack.target === track.target &&
    (activeTrack.attachment ?? '') === (track.attachment ?? '') &&
    activeTrack.channel === (track.channel ?? '')

  /** 折叠的骨骼分组（只影响显示，不动数据） */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const toggleCollapse = (id: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  /** 实际渲染的轨道：折叠的分组行下面的子轨道会被过滤掉 */
  const visibleTracks = useMemo(
    () => tracks.filter((track) => !track.parentId || !collapsed.has(track.parentId)),
    [tracks, collapsed]
  )

  /** 同一轨道同一时间点的多通道关键帧合并成一个标记 */
  const markersByTrack = useMemo(
    () =>
      visibleTracks.map((track) => {
        const byTime = new Map<number, KeySelector[]>()
        for (const key of track.keys) {
          const slot = Math.round(key.time * 1e4) / 1e4
          const list = byTime.get(slot) ?? []
          list.push(toSelector(track, key.channel, key.target, key.attachment, key.time))
          byTime.set(slot, list)
        }
        return [...byTime.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([slot, selectors]) => ({ slot, selectors, channels: selectors.map((s) => s.channel) }))
      }),
    [visibleTracks]
  )

  // 框选判定要在 window 监听里读最新数据，这里保持一份同步快照
  pickRef.current = { tracks: visibleTracks, markers: markersByTrack }

  /** 像素比例 → 时间（含左侧留白补偿） */
  const timeAtRatio = (ratio: number, map?: TimeMap): number => {
    const { start: from, span: width } = map ?? mapRef.current
    const usable = 1 - LEAD_RATIO
    return from + ((ratio - LEAD_RATIO) / usable) * width
  }

  /** 客户端 x → 时间；map 传入时使用该映射（拖拽期间冻结） */
  const timeAtClientX = (clientX: number, map?: TimeMap): number => {
    const rect = areaRef.current?.getBoundingClientRect()
    const { start: from } = map ?? mapRef.current
    if (!rect || rect.width <= 0) return from
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    return timeAtRatio(ratio, map)
  }

  const snap = (value: number): number => {
    const { axis: total, frameRate: fps, snapToFrame: doSnap } = propsRef.current
    const clamped = Math.max(0, Math.min(total, value))
    if (!doSnap || fps <= 0) return Number(clamped.toFixed(4))
    return Number((Math.round(clamped * fps) / fps).toFixed(4))
  }

  /** 擦洗时间不能超过动画时长（超过会让播放器循环回卷，画面会跳） */
  const snapScrub = (value: number): number => snap(Math.min(propsRef.current.length, value))

  /**
   * 帧区域滚轮 = 缩放时间轴长度（以光标处的时间为锚点）。
   * - Shift + 滚轮 / 横向滚动：平移可见窗口
   * - Alt + 滚轮：让出给原生纵向滚动（轨道多时用它翻轨道）
   * - 左侧「轨道 / 对象」列：保持原生纵向滚动
   * 注：滚轮事件的 button 在 Chromium 里恒为 0，无法区分「中键滚轮」，
   * 因此按「指针是否落在帧区域」来决定缩放，这也符合时间轴类工具的通行交互。
   */
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const onWheel = (event: WheelEvent): void => {
      if (event.altKey) return
      const rect = areaRef.current?.getBoundingClientRect()
      if (!rect || rect.width <= 0) return
      if (event.clientX < rect.left - 1) return
      event.preventDefault()

      const current = propsRef.current
      const { start: rawStart, zoom: currentZoom } = viewRef.current
      const currentSpan = currentZoom > 0 ? current.axis / currentZoom : current.axis
      const from = Math.min(Math.max(0, rawStart), Math.max(0, current.axis - currentSpan))

      const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY)
      if (event.shiftKey || horizontal) {
        const pixels = event.deltaX !== 0 ? event.deltaX : event.deltaY
        applyView({
          start: Math.max(0, Math.min(current.axis - currentSpan, from + (pixels / rect.width) * currentSpan))
        })
        return
      }

      const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
      const anchorTime = from + ratio * currentSpan
      const next = Math.max(
        TIMELINE_ZOOM_MIN,
        Math.min(TIMELINE_ZOOM_MAX, currentZoom * Math.exp(-event.deltaY * ZOOM_SENSITIVITY))
      )
      const nextSpan = current.axis / next
      // 保持光标处的时间不动
      applyView({
        zoom: next,
        start: Math.max(0, Math.min(current.axis - nextSpan, anchorTime - ratio * nextSpan))
      })
      current.onZoom(next)
    }
    host.addEventListener('wheel', onWheel, { passive: false })
    return () => host.removeEventListener('wheel', onWheel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * 中键按住拖动 = 左右平移时间轴（与滚轮缩放共用同一个可见窗口）。
   * 顺带 preventDefault 掉 mousedown，避免浏览器触发中键自动滚动。
   */
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const onMiddleDown = (event: PointerEvent): void => {
      if (event.button !== 1) return
      event.preventDefault()
      panRef.current = { x: event.clientX, start: viewRef.current.start }
      host.style.cursor = 'grabbing'
    }
    const onMiddleMove = (event: PointerEvent): void => {
      const pan = panRef.current
      if (!pan) return
      const rect = areaRef.current?.getBoundingClientRect()
      if (!rect || rect.width <= 0) return
      const current = propsRef.current
      const { zoom: currentZoom } = viewRef.current
      const currentSpan = currentZoom > 0 ? current.axis / currentZoom : current.axis
      const maxStart = Math.max(0, current.axis - currentSpan)
      // 换算要扣掉左侧留白占用的宽度，保证拖动与画面 1:1
      const delta = ((event.clientX - pan.x) / (rect.width * (1 - LEAD_RATIO))) * currentSpan
      applyView({ start: Math.max(0, Math.min(maxStart, pan.start - delta)) })
    }
    const onMiddleUp = (): void => {
      if (!panRef.current) return
      panRef.current = null
      host.style.cursor = ''
    }
    // 捕获阶段拦下中键，避免被浏览器解释为自动滚动
    const blockMiddle = (event: MouseEvent): void => {
      if (event.button === 1) event.preventDefault()
    }
    host.addEventListener('pointerdown', onMiddleDown, true)
    host.addEventListener('mousedown', blockMiddle, true)
    window.addEventListener('pointermove', onMiddleMove)
    window.addEventListener('pointerup', onMiddleUp)
    return () => {
      host.removeEventListener('pointerdown', onMiddleDown, true)
      host.removeEventListener('mousedown', blockMiddle, true)
      window.removeEventListener('pointermove', onMiddleMove)
      window.removeEventListener('pointerup', onMiddleUp)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 拖拽关键帧 / 拖动刻度尺：都在 window 上监听，避免指针移出面板后丢失事件
  useEffect(() => {
    const onMove = (event: PointerEvent): void => {
      if (panRef.current) return
      // 行区左键拖动 = 框选（拖过阈值才算，避免和「点一下定位播放头」打架）
      const bandState = bandRef.current
      if (bandState && !dragRef.current) {
        if (
          !bandState.active &&
          Math.hypot(event.clientX - bandState.x0, event.clientY - bandState.y0) < 4
        ) {
          return
        }
        bandState.active = true
        applyBandRef.current(bandState.x0, bandState.y0, event.clientX, event.clientY)
        return
      }
      if (scrubRef.current) {
        propsRef.current.onScrub(snapScrub(timeAtClientX(event.clientX)))
        return
      }
      const drag = dragRef.current
      if (!drag) return
      drag.active = true
      const delta = timeAtClientX(event.clientX, drag.map) - drag.startTime
      const times = drag.selectors.map((_, index) => snap(drag.originTimes[index] + delta))
      propsRef.current.onSetTimes(drag.selectors.map((selector, index) => ({ selector, time: times[index] })))
      // 选择器随之后移：下一次 move 才能定位到已移动的帧，同时保持选中高亮
      drag.selectors = drag.selectors.map((selector, index) => ({ ...selector, time: times[index] }))
      propsRef.current.onSelectKeys(drag.selectors)
    }
    const onUp = (): void => {
      scrubRef.current = false
      const bandState = bandRef.current
      bandRef.current = null
      if (bandState) {
        // 没拖动 = 单击行区空白：定位播放头并清空选择（保持原来的「点哪跳哪」手感）
        if (!bandState.active) {
          propsRef.current.onScrub(snapScrub(timeAtClientX(bandState.x0)))
          propsRef.current.onSelectKeys([])
        }
        setBand(null)
      }
      const drag = dragRef.current
      dragRef.current = null
      // 只有真正移动过才产生一条撤销记录
      if (drag?.active) propsRef.current.onEndDrag()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- 刻度（按可见窗口生成） ----
  const frameCount = Math.max(1, Math.round(axis * frameRate))
  const endFrame = Math.max(0, Math.round(length * frameRate))
  const lastFrame = Math.min(frameCount, Math.ceil((start + span) * frameRate))
  const pxPerFrame = areaWidth > 0 && span > 0 ? areaWidth / (span * frameRate) : 0
  const frameStep = FRAME_STEPS.find((step) => step * pxPerFrame >= MIN_TICK_GAP) ?? FRAME_STEPS[FRAME_STEPS.length - 1]
  const firstFrame = Math.max(0, Math.floor((start - span * LEAD_RATIO) * frameRate))
  const majorFrames: number[] = []
  for (let frame = Math.ceil(firstFrame / frameStep) * frameStep; frame <= lastFrame; frame += frameStep) {
    majorFrames.push(frame)
  }
  const minorStep = frameStep >= 5 && (frameStep / 5) * pxPerFrame >= 5 ? frameStep / 5 : 0
  /** 时间 → 帧区域内的百分比（含左侧留白） */
  const percent = (value: number): number =>
    span > 0 ? (LEAD_RATIO + ((value - start) / span) * (1 - LEAD_RATIO)) * 100 : LEAD_RATIO * 100
  const frameToTime = (frame: number): number => (frameRate > 0 ? frame / frameRate : 0)
  const totalKeys = tracks.reduce((sum, track) => sum + track.keys.length, 0)
  const channelCount = tracks.filter((track) => !track.isGroup).length
  const endPercent = percent(length)
  const playheadPercent = percent(time)
  const zoomed = Math.abs(zoom - 1) > 0.001

  /**
   * 框选：把矩形覆盖到的关键帧全部选中。
   * 用「行号 + 时间范围」判定而不是 DOM 命中 —— 行高固定、时间可从 x 反算，更稳也更快。
   */
  const applyBand = (x0: number, y0: number, x1: number, y1: number): void => {
    const rect = areaRef.current?.getBoundingClientRect()
    if (!rect) return
    const left = Math.min(x0, x1)
    const right = Math.max(x0, x1)
    const top = Math.min(y0, y1)
    const bottom = Math.max(y0, y1)
    const tStart = Math.min(timeAtClientX(left), timeAtClientX(right))
    const tEnd = Math.max(timeAtClientX(left), timeAtClientX(right))
    const firstRow = Math.floor((top - rect.top) / ROW_HEIGHT)
    const lastRow = Math.floor((bottom - rect.top) / ROW_HEIGHT)
    const { tracks: list, markers } = pickRef.current
    const picked: KeySelector[] = []
    for (let row = Math.max(0, firstRow); row <= Math.min(list.length - 1, lastRow); row++) {
      if (list[row].isGroup) continue
      for (const marker of markers[row] ?? []) {
        if (marker.slot >= tStart - 1e-6 && marker.slot <= tEnd + 1e-6) picked.push(...marker.selectors)
      }
    }
    propsRef.current.onSelectKeys(picked)
    setBand({
      left: left - rect.left,
      top: top - rect.top,
      width: right - left,
      height: bottom - top
    })
  }
  applyBandRef.current = applyBand

  /**
   * 标记（菱形关键帧 / 事件小红旗）的统一点击逻辑：选中 + 开始拖动。
   *
   * 点中关键帧同时把它所属的**通道**设为当前目标（打关键帧的目标跟着走）；
   * Shift / Ctrl / Cmd 点击为多选（已选中则取消），随后可整段左右移动。
   */
  const startMarkerDrag = (
    event: React.PointerEvent<HTMLButtonElement>,
    marker: { slot: number; selectors: KeySelector[] },
    selected: boolean,
    track: TimelineTrack
  ): void => {
    event.stopPropagation()
    if (event.button !== 0) return
    props.onSelectTarget(track)
    // 直接读 store 的选择状态：连续快速点击时 props / propsRef 都还没跟上渲染，会读到过期值
    const live = useTimelineStore.getState().selectedKeys
    const isLive = (s: KeySelector): boolean => live.some((item) => sameSelector(item, s))
    const selectedNow = marker.selectors.every(isLive)
    void selected
    const additive = event.ctrlKey || event.metaKey || event.shiftKey
    const next = additive
      ? selectedNow
        ? live.filter((item) => !marker.selectors.some((s) => sameSelector(s, item)))
        : [...live, ...marker.selectors.filter((s) => !isLive(s))]
      : selectedNow
        ? live
        : marker.selectors
    props.onSelectKeys(next)
    if (next.length === 0) return
    props.onBeginDrag()
    dragRef.current = {
      selectors: next,
      originTimes: next.map((item) => item.time),
      startTime: timeAtClientX(event.clientX),
      active: false,
      map: { ...mapRef.current }
    }
  }

  return (
    <div ref={hostRef} className="flex min-h-0 flex-1 flex-col">
      {/* 表头：轨道信息 + 帧 / 时间刻度尺 */}
      <div className="flex shrink-0 items-stretch border-b border-line bg-ink-800/80" style={{ height: RULER_HEIGHT }}>
        <div
          className="flex shrink-0 flex-col justify-center gap-[1px] border-r border-line px-2"
          style={{ width: LABEL_WIDTH }}
        >
          <span className="text-3xs text-content-lo">轨道 / 对象</span>
          <span className="flex items-center gap-1 font-mono text-3xs text-content-lo/70">
            {channelCount} 轨 · {totalKeys} 关键帧
            {zoomed ? (
              <button
                type="button"
                title="当前已缩放，点击恢复「完整适配」"
                className="flex items-center gap-0.5 rounded bg-accent/15 px-1 text-accent hover:bg-accent/25 cursor-pointer"
                onClick={() => {
                  applyView({ start: 0, zoom: 1 })
                  props.onZoom(1)
                }}
              >
                <ZoomIn size={9} />
                {zoom.toFixed(1)}×
              </button>
            ) : null}
          </span>
        </div>

        <div
          className="relative shrink-0 cursor-ew-resize select-none overflow-hidden"
          style={{ width: areaWidth > 0 ? areaWidth : undefined }}
          onPointerDown={(event) => {
            if (event.button !== 0) return
            scrubRef.current = true
            props.onScrub(snapScrub(timeAtClientX(event.clientX)))
          }}
          title="关键帧区：左键拖动框选关键帧（Shift / Ctrl 点击加选或减选），选中后可整段左右拖动；单击空白定位播放头；滚轮缩放时间轴长度（Shift+滚轮横向平移，Alt+滚轮纵向翻轨道）"
        >
          {minorStep > 0
            ? majorFrames.flatMap((frame) =>
                Array.from({ length: Math.max(0, Math.round(frameStep / minorStep) - 1) }, (_, index) => {
                  const minorFrame = frame + minorStep * (index + 1)
                  if (minorFrame > frameCount) return null
                  return (
                    <span
                      key={`m${minorFrame}`}
                      className="absolute bottom-0 w-px bg-line"
                      style={{ left: `${percent(frameToTime(minorFrame))}%`, height: 4 }}
                    />
                  )
                })
              )
            : null}

          {majorFrames.map((frame) => {
            const at = frameToTime(frame)
            const beyond = frame > endFrame
            return (
              <span
                key={`M${frame}`}
                className="absolute top-0 flex h-full flex-col justify-center border-l border-line/80 pl-1"
                style={{ left: `${percent(at)}%` }}
              >
                <span
                  className={[
                    'font-mono text-3xs leading-[11px]',
                    beyond ? 'text-content-lo/50' : 'text-content-mid'
                  ].join(' ')}
                >
                  {frame}
                </span>
                <span
                  className={[
                    'font-mono text-[9px] leading-[10px]',
                    beyond ? 'text-content-lo/40' : 'text-content-lo'
                  ].join(' ')}
                >
                  {at.toFixed(2)}s
                </span>
              </span>
            )
          })}

          <span
            className="pointer-events-none absolute top-0 z-10 h-full w-px bg-accent"
            style={{ left: `${playheadPercent}%` }}
          />
        </div>
        {/* 右侧留白：与轨道区的滚动条宽度对齐 */}
        <div className="min-w-0 flex-1" />
      </div>

      <div ref={trackListRef} className="min-h-0 flex-1 overflow-auto hao-scroll">
        <div className="flex min-h-full">
          {/* 轨道名（骨骼是「分组行 + 通道子轨」两层结构） */}
          <div className="shrink-0 border-r border-line bg-ink-800/60" style={{ width: LABEL_WIDTH }}>
            {visibleTracks.map((track) => {
              const trackActive = isTrackActive(track)
              return (
              <button
                key={track.id}
                type="button"
                data-track-id={track.id}
                className={[
                  'relative flex w-full items-center gap-1 border-b border-line/40 pr-1.5 text-left text-3xs cursor-pointer',
                  track.isGroup
                    ? 'bg-ink-900/50 font-semibold text-content-hi hover:bg-ink-700'
                    : trackActive
                      ? 'bg-accent/15 font-semibold text-accent'
                      : 'text-content-mid hover:bg-ink-700',
                  // 刚打帧的行短暂高亮：帧大概率埋在列表下方，光靠滚动还不够醒目
                  flashTrackId === track.id ? 'bg-accent/30' : ''
                ].join(' ')}
                style={{ height: ROW_HEIGHT, paddingLeft: 5 + track.depth * 12 }}
                title={
                  track.kind === 'drawOrder'
                    ? '插槽层级（绘制顺序）：每帧是一份完整顺序快照，在 slot 层级面板调完顺序后打帧；点选后按 Delete 可删除整条通道'
                    : track.isGroup
                      ? `${track.kind === 'slot' ? '插槽' : '骨骼'}「${track.label}」的通道（点击选中该对象）`
                      : track.kind === 'slot' && track.channel === 'display'
                        ? `${track.group} · 显示 · 单击选中插槽，按 K 在当前时间打显示帧`
                        : `${track.group} · ${track.label} · 点击选中该通道（按 K 只给它打帧，Delete 删除整条通道）`
                }
                onClick={() => props.onSelectTarget(track)}
              >
                {/* 选中通道的左侧色条：与 hover 区分开，一眼能看出「按 K 会打到哪条通道」 */}
                {trackActive ? (
                  <span className="pointer-events-none absolute left-0 top-0 h-full w-[2px] bg-accent" />
                ) : null}
                {track.isGroup ? (
                  <span
                    role="presentation"
                    className="flex h-[13px] w-[13px] shrink-0 items-center justify-center rounded text-content-lo hover:bg-ink-600 hover:text-content-hi"
                    title="折叠 / 展开该骨骼的通道"
                    onClick={(event) => {
                      event.stopPropagation()
                      toggleCollapse(track.id)
                    }}
                  >
                    {collapsed.has(track.id) ? <ChevronRight size={10} /> : <ChevronDown size={10} />}
                  </span>
                ) : track.depth > 0 ? (
                  <span className="flex h-[13px] w-[13px] shrink-0 items-center justify-center">
                    <span className={['h-[5px] w-[5px] rounded-full', CHANNEL_TONE[track.channel ?? ''] ?? 'bg-content-lo'].join(' ')} />
                  </span>
                ) : (
                  <Lock size={9} className="shrink-0 text-content-lo/0" />
                )}
                <span className="min-w-0 flex-1 truncate">{track.label}</span>
                <span className="shrink-0 rounded bg-ink-600 px-1 text-content-lo">
                  {track.isGroup ? track.keyCount ?? 0 : track.keys.length}
                </span>
              </button>
              )
            })}
            {visibleTracks.length === 0 ? (
              <div className="px-2 py-3 text-3xs text-content-lo">
                没有轨道：在 Pose 状态调整骨骼/插槽后按 K 打关键帧
              </div>
            ) : null}
          </div>

          {/* 关键帧区（缩放后超出窗口的关键帧会被裁掉，靠平移查看） */}
          <div ref={areaRef} className="relative min-w-0 flex-1 overflow-hidden">
            <div
              className="pointer-events-none absolute top-0 z-10 h-full border-r border-dashed border-warn/60"
              style={{ left: `${endPercent}%`, opacity: endPercent < 0 || endPercent > 100 ? 0 : 1 }}
            />
            <div
              className="pointer-events-none absolute top-0 z-0 h-full bg-ink-900/40"
              style={{ left: `${Math.max(0, endPercent)}%`, right: 0 }}
            />
            {playheadPercent >= 0 && playheadPercent <= 100 ? (
              <div
                className="pointer-events-none absolute top-0 z-20 h-full w-px bg-accent"
                style={{ left: `${playheadPercent}%` }}
              >
                <span className="absolute -left-[4px] top-0 h-0 w-0 border-x-[4px] border-t-[6px] border-x-transparent border-t-accent" />
              </div>
            ) : null}

            {/* 框选矩形 */}
            {band ? (
              <div
                className="pointer-events-none absolute z-30 rounded-sm border border-accent/70 bg-accent/10"
                style={{ left: band.left, top: band.top, width: band.width, height: band.height }}
              />
            ) : null}

            {visibleTracks.map((track, trackIndex) => (
              <div
                key={track.id}
                className={[
                  'relative border-b border-line/40',
                  track.isGroup
                    ? 'bg-ink-900/30'
                    : isTrackActive(track)
                      ? 'bg-accent/10'
                      : ''
                ].join(' ')}
                style={{ height: ROW_HEIGHT }}
                onPointerDown={(event) => {
                  if (event.button !== 0) return
                  // 记下起点：拖动超过阈值变成框选；只点一下则在松开时定位播放头
                  bandRef.current = { x0: event.clientX, y0: event.clientY, active: false }
                }}
              >
                {(markersByTrack[trackIndex] ?? []).map((marker) => {
                  const left = percent(marker.slot)
                  if (left < -1 || left > 101) return null
                  const selected = marker.selectors.every(isSelected)
                  // 事件轨用小红旗（旗杆对准触发时刻），其余轨道用菱形关键帧
                  if (track.kind === 'event') {
                    return (
                      <button
                        key={marker.slot}
                        type="button"
                        className={[
                          'absolute top-[4px] -translate-x-[1px] transition-transform duration-panel cursor-pointer',
                          selected
                            ? 'scale-125 text-danger drop-shadow-[0_0_6px_rgba(248,113,113,0.9)]'
                            : 'text-danger/85 hover:text-danger'
                        ].join(' ')}
                        style={{ left: `${left}%` }}
                        title={`${marker.channels[0]} @ ${marker.slot.toFixed(3)}s（事件；拖动改时间，Delete 删除）`}
                        onPointerDown={(event) => startMarkerDrag(event, marker, selected, track)}
                      >
                        <Flag size={11} fill="currentColor" strokeWidth={2} />
                      </button>
                    )
                  }
                  return (
                    <button
                      key={marker.slot}
                      type="button"
                      className={[
                        'absolute top-[7px] h-[8px] w-[8px] -translate-x-1/2 rotate-45 border transition-transform duration-panel cursor-pointer',
                        selected
                          ? 'scale-125 border-accent bg-accent shadow-[0_0_8px_rgba(34,211,238,0.7)]'
                          : 'border-accent/70 bg-accent/40 hover:bg-accent/70'
                      ].join(' ')}
                      style={{ left: `${left}%` }}
                      title={`${rowLabel(track)} · ${marker.channels.join(' / ')} @ ${marker.slot.toFixed(3)}s（拖动整组改时间，Delete 删除）`}
                      onPointerDown={(event) => startMarkerDrag(event, marker, selected, track)}
                    />
                  )
                })}
              </div>
            ))}
          </div>
        </div>
      </div>

    </div>
  )
}

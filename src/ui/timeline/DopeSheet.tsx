import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Filter, Flag, Lock, Minus, Plus, Zap, ZoomIn } from 'lucide-react'
import { TIMELINE_ZOOM_MAX, TIMELINE_ZOOM_MIN } from '@editor/store/timelineStore'
import { sameSelector } from '@editor/timeline/model'
import type { KeySelector, TimelineTrack } from '@editor/timeline/model'
import { useProjectStore } from '@editor/store/projectStore'
import { useSelectionStore } from '@editor/store/selectionStore'
import { useTimelineStore } from '@editor/store/timelineStore'
import { useModeStore } from '@editor/store/modeStore'

/**
 * 标记「本次选中来自时间轴内的点击」（点轨道行 / 点关键帧）。
 * reveal 效果读到这个标记就**跳过**滚动 + 高亮 —— 否则点时间轴里的轨道，
 * 列表会自己滚回顶 + 闪一下，既没必要也晃眼。
 * 由 TimelinePanel 的 `selectTrack` 在改 selection 之前设置，reveal effect 消费一次后清掉。
 */
let skipReveal = false
export function markTimelineSelection(): void {
  skipReveal = true
}
import { playheadTime, usePlayheadStore } from '@editor/store/playheadStore'

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
  /** 选中某个通道；传 `null` = 取消通道选择（轨道列表里右键） */
  onSelectTarget: (track: TimelineTrack | null) => void
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

/**
 * 选框左右边缘拖拽缩放会话。
 *
 * - `mode: 'scale'`：左右两边分别固定在 oppositeEdge / originEdge，拖曳边改变时按比例
 *   拉伸 / 压缩所有选中的关键帧。
 * - `mode: 'translate'`：所有选中关键帧挤在同一个时间点（宽度为 0），退化成平移整组。
 */
interface ScaleState {
  side: 'left' | 'right'
  mode: 'scale' | 'translate'
  selectors: KeySelector[]
  originTimes: number[]
  originEdge: number
  oppositeEdge: number
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
  /** 选中关键帧包围盒的左右缩放会话 */
  const scaleRef = useRef<ScaleState | null>(null)
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

  /** 缩放（底部工具栏的滑块 / ±按钮）：以可见窗口中心为锚点，缩放后画面不跳走 */
  const zoomAround = (next: number): void => {
    const clamped = Math.max(TIMELINE_ZOOM_MIN, Math.min(TIMELINE_ZOOM_MAX, next))
    const current = viewRef.current
    const currentSpan = current.zoom > 0 ? axis / current.zoom : axis
    const from = Math.min(Math.max(0, current.start), Math.max(0, axis - currentSpan))
    const center = from + currentSpan / 2
    const nextSpan = axis / clamped
    applyView({
      zoom: clamped,
      start: Math.max(0, Math.min(Math.max(0, axis - nextSpan), center - nextSpan / 2))
    })
    props.onZoom(clamped)
  }

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

  /**
   * 播放头走**高频通道 + ref 直接改 DOM**：播放时每帧只挪这两个节点，
   * 不触发任何 React 重渲染。
   *
   * 为什么要这样：播放时每帧写 `timelineStore.time` 会让整张 DopeSheet（还有 App、层级树…）
   * 每帧重渲染，实测单帧净成本 ~100ms、帧率 8fps；而动画求值 + 蒙皮 + 绘制只要 1.3ms。
   * 真正常变的只有「播放头那一根线」—— 用 ref 改 `left` 就够了（见 playheadStore 的说明）。
   */
  const playheadRulerRef = useRef<HTMLSpanElement | null>(null)
  const playheadHeadRef = useRef<HTMLDivElement | null>(null)
  const placePlayheadRef = useRef<(value: number) => void>(() => undefined)
  /** 帧区域宽度（ResizeObserver 维护）：算像素位移用，避免每帧去读 clientWidth 强制重排 */
  const areaWidthRef = useRef(areaWidth)
  areaWidthRef.current = areaWidth
  placePlayheadRef.current = (value: number): void => {
    const { start: currentStart, span: currentSpan } = mapRef.current
    const ratio = currentSpan > 0 ? (value - currentStart) / currentSpan : 0
    const position = LEAD_RATIO + ratio * (1 - LEAD_RATIO)
    // 用 transform 而不是 left：改 left 会让浏览器重做样式/布局（实测这一条占 ~9ms/帧），
    // transform 只走合成，播放头每帧都动也不心疼
    const x = position * areaWidthRef.current
    const ruler = playheadRulerRef.current
    if (ruler) ruler.style.transform = `translateX(${x}px)`
    const head = playheadHeadRef.current
    if (head) {
      head.style.transform = `translateX(${x}px)`
      head.style.opacity = position < 0 || position > 1 ? '0' : '1'
    }
  }
  /** 播放头走出可见窗口时把它拉回来（用 ref 拿最新闭包，避免 effect 里读到旧的 maxStart） */
  const followPlayheadRef = useRef<(value: number) => void>(() => undefined)
  followPlayheadRef.current = (value: number): void => {
    const { start: currentStart, span: currentSpan } = mapRef.current
    if (value < currentStart || value > currentStart + currentSpan) {
      applyView({ start: Math.max(0, Math.min(maxStart, value - currentSpan * 0.5)) })
    }
  }

  useEffect(() => {
    placePlayheadRef.current(playheadTime())
    let timer = 0
    const unsubscribe = usePlayheadStore.subscribe((state) => {
      placePlayheadRef.current(state.time)
      // 跟随可见窗口：节流 250ms（这段会改视窗状态、触发一次重渲染，不能每帧来）
      if (timer !== 0) return
      timer = window.setTimeout(() => {
        timer = 0
        followPlayheadRef.current(playheadTime())
      }, 250)
    })
    return () => {
      unsubscribe()
      window.clearTimeout(timer)
    }
  }, [])

  // 缩放 / 横向平移改变视窗后重摆一次：播放头平时由高频通道用 ref 维持，React 不知道它的位置
  useEffect(() => {
    placePlayheadRef.current(playheadTime())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start, span])

  const isSelected = (selector: KeySelector): boolean => selectedKeys.some((item) => sameSelector(selector, item))

  /**
   * 当前选中的**子轨道（通道）**：点击通道行时由 TimelinePanel 写入。
   * 它同时决定「按 K 只给这条通道打帧」，所以行上必须有明确的选中反馈。
   */
  /** 轨道列表滚动容器：打帧后把对应行滚到可见 */
  const trackListRef = useRef<HTMLDivElement | null>(null)
  /** 刚打帧的轨道 id（短暂高亮） */
  const [flashTrackId, setFlashTrackId] = useState<string | null>(null)

  /** 选中对象（骨骼 / 插槽）时短暂高亮的轨道组 id（整组：分组行 + 子通道行） */
  const [revealId, setRevealId] = useState<string | null>(null)
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
  // 仅拖框选择才显示缩放框，逐点点击不显示
  const selectionByBox = useTimelineStore((state) => state.selectionByBox)
  /** 洋葱皮（显示前后帧骨骼姿态）：从 store 直接读，避免为这一个按钮拖累 TimelinePanel 顶部栏 */
  const onionSkin = useTimelineStore((state) => state.onionSkin)
  const toggleOnionSkin = useTimelineStore((state) => state.toggleOnionSkin)
  const isTrackActive = (track: TimelineTrack): boolean =>
    !track.isGroup &&
    activeTrack !== null &&
    activeTrack.kind === track.kind &&
    activeTrack.target === track.target &&
    (activeTrack.attachment ?? '') === (track.attachment ?? '') &&
    activeTrack.channel === (track.channel ?? '')

  /**
   * 智能过滤的匹配对象：选中骨骼 → 骨骼轨，选中插槽 / 附件 → 该插槽的轨，
   * 选中约束 → 该约束的轨；什么都没选中时按钮置灰（没有可过滤的目标）
   */
  const selection = useSelectionStore()
  const filterTarget =
    selection.kind === 'bone'
      ? selection.bone
      : selection.kind === 'slot' || selection.kind === 'attachment'
        ? selection.slot
        : selection.kind === 'constraint'
          ? selection.constraint
          : ''
  const [smartFilter, setSmartFilter] = useState(false)

  /** 折叠的骨骼分组（只影响显示，不动数据） */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const toggleCollapse = (id: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  /**
   * 实际渲染的轨道：先过「智能过滤」（只留选中对象的轨道，分组行与子轨共用同一个
   * `target`，按 target 匹配即可整组保留；事件 / 绘制顺序这类全局轨 target 为空，
   * 过滤时一并隐藏 —— 它们不属于任何对象），再滤掉折叠分组下面的子轨道
   */
  const visibleTracks = useMemo(() => {
    const scoped = smartFilter && filterTarget ? tracks.filter((track) => track.target === filterTarget) : tracks
    return scoped.filter((track) => !track.parentId || !collapsed.has(track.parentId))
  }, [tracks, collapsed, smartFilter, filterTarget])

  /**
   * 选中对象（骨骼 / 插槽）→ 把它的轨道组**滚到顶部**并**高亮一下背景**：
   * 与层级树「定位」、打帧后的高亮同款体验。
   *
   * 只在 Animate 态有意义（轨道才有意义）；Pose 态整块右栏是收起的。
   * 触发条件只认「选中对象的名字」—— 同对象内再点它的子通道不会改变名字，
   * 也就不会反复把列表滚来滚去（点轨道行选对象也不会触发二次滚动）。
   */
  const mode = useModeStore((s) => s.mode)
  const revealName =
    mode === 'animate'
      ? selection.kind === 'bone'
        ? selection.bone
        : selection.kind === 'slot' || selection.kind === 'attachment'
          ? selection.slot
          : ''
      : ''
  /**
   * 已经 reveal 过的对象名：**同一个对象不重复滚 / 不重复闪**。
   * 依赖里带着 `visibleTracks`（新建轨道要等它出现才能滚），而打关键帧会让轨道列表每一帧都是新数组 ——
   * 比如拖着视口拾色器改颜色，明明「选中的还是它」，列表却一遍遍滚回顶部 + 反复闪。
   * 名字变了（换了对象）或者取消选中后才重新记名，这样再选回同一个对象还会正常 reveal。
   */
  const revealedRef = useRef('')
  useEffect(() => {
    // 消费「时间轴内点击」标记：点了时间轴里的轨道就不滚动 / 不闪（见 markTimelineSelection）
    const fromTimeline = skipReveal
    skipReveal = false
    // 取消选中 / 切回 Pose：这次没得 reveal，名字作废，下次再选它还要滚
    if (!revealName) {
      revealedRef.current = ''
      return
    }
    // 点了时间轴里的轨道：这次不滚 / 不闪，但记成「已处理」——
    // 否则紧接着的轨道列表变动（例如打帧新建颜色轨）会把同一次选中又滚一遍
    if (fromTimeline) {
      revealedRef.current = revealName
      return
    }
    const group = visibleTracks.find((track) => track.isGroup && track.target === revealName)
    if (!group) return
    if (revealedRef.current === revealName) return
    revealedRef.current = revealName
    const row = trackListRef.current?.querySelector(`[data-track-id="${CSS.escape(group.id)}"]`)
    // block: 'start' = 滚到滚动容器顶部可见（相当于显示在 timeline 最上面）
    row?.scrollIntoView({ block: 'start' })
    setRevealId(group.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealName, visibleTracks])

  /** 高亮只闪一下（900ms）：定时器单独一个 effect，reveal 提前 return 也不会把高亮卡住 */
  useEffect(() => {
    if (revealId === null) return
    const timer = window.setTimeout(() => setRevealId(null), 900)
    return () => window.clearTimeout(timer)
  }, [revealId])

  /** 某行是否处于「选中对象高亮」状态（分组行 / 它的子通道行都算） */
  const isRevealed = (track: TimelineTrack): boolean =>
    revealId !== null && (revealId === track.id || revealId === track.parentId)

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
   * 帧区域滚轮 = **上下翻轨道**（交给原生滚动；缩放入口已收拢到底部工具栏）。
   * - Shift + 滚轮 / 触控板横扫：横向平移可见窗口
   * - 左侧「轨道 / 对象」列：同样是原生纵向滚动
   */
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const onWheel = (event: WheelEvent): void => {
      const rect = areaRef.current?.getBoundingClientRect()
      if (!rect || rect.width <= 0) return
      if (event.clientX < rect.left - 1) return
      const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY)
      // 垂直滚轮不拦截：让滚动容器自然上下翻轨道
      if (!horizontal && !event.shiftKey) return
      event.preventDefault()

      const current = propsRef.current
      const { start: rawStart, zoom: currentZoom } = viewRef.current
      const currentSpan = currentZoom > 0 ? current.axis / currentZoom : current.axis
      const from = Math.min(Math.max(0, rawStart), Math.max(0, current.axis - currentSpan))
      const pixels = event.deltaX !== 0 ? event.deltaX : event.deltaY
      applyView({
        start: Math.max(0, Math.min(current.axis - currentSpan, from + (pixels / rect.width) * currentSpan))
      })
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

  // 拖拽关键帧 / 拖动刻度尺 / 缩放选中框：都在 window 上监听，避免指针移出面板后丢失事件
  useEffect(() => {
    const onMove = (event: PointerEvent): void => {
      if (panRef.current) return

      const scale = scaleRef.current
      if (scale) {
        scale.active = true
        const times =
          scale.mode === 'translate'
            ? scale.originTimes.map((t) => snap(t + (timeAtClientX(event.clientX, scale.map) - scale.startTime)))
            : (() => {
                const raw = timeAtClientX(event.clientX, scale.map)
                const clamped =
                  scale.side === 'left'
                    ? Math.min(raw, scale.oppositeEdge - 0.001)
                    : Math.max(raw, scale.oppositeEdge + 0.001)
                const edge = snap(clamped)
                const originSpan = scale.originEdge - scale.oppositeEdge
                if (Math.abs(originSpan) < 1e-6) return scale.originTimes
                const factor = (edge - scale.oppositeEdge) / originSpan
                return scale.originTimes.map((t) => snap(scale.oppositeEdge + (t - scale.oppositeEdge) * factor))
              })()
        propsRef.current.onSetTimes(scale.selectors.map((selector, index) => ({ selector, time: times[index] })))
        // 选择器随之后移：下一次 move 才能定位到已移动的帧，同时保持选中高亮
        scale.selectors = scale.selectors.map((selector, index) => ({ ...selector, time: times[index] }))
        propsRef.current.onSelectKeys(scale.selectors)
        // onSelectKeys 会默认关掉缩放框，缩放手柄拖拽期间要重新打开
        useTimelineStore.getState().setSelectionByBox(true)
        return
      }

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
      const scale = scaleRef.current
      scaleRef.current = null
      if (scale?.active) propsRef.current.onEndDrag()

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
   * 已选关键帧的持久包围盒：框选结束后显示一个带左右拉伸手柄的蓝色矩形。
   * 范围由「最早 / 最晚时间」×「最上 / 最下轨道行」决定。
   */
  const selectionBox = useMemo(() => {
    // 只给拖框（橡皮筋）选择显示缩放框；逐点点击选中不显示
    if (!selectionByBox || selectedKeys.length === 0) return null
    const times = selectedKeys.map((k) => k.time)
    const minTime = Math.min(...times)
    const maxTime = Math.max(...times)
    let minRow = Infinity
    let maxRow = -Infinity
    for (let row = 0; row < visibleTracks.length; row++) {
      const markers = markersByTrack[row] ?? []
      for (const marker of markers) {
        if (marker.selectors.some((s) => selectedKeys.some((k) => sameSelector(s, k)))) {
          minRow = Math.min(minRow, row)
          maxRow = Math.max(maxRow, row)
        }
      }
    }
    if (!isFinite(minRow) || !isFinite(maxRow)) return null
    const leftRatio = span > 0 ? LEAD_RATIO + ((minTime - start) / span) * (1 - LEAD_RATIO) : LEAD_RATIO
    const rightRatio = span > 0 ? LEAD_RATIO + ((maxTime - start) / span) * (1 - LEAD_RATIO) : LEAD_RATIO
    return {
      left: leftRatio * 100,
      right: rightRatio * 100,
      top: minRow * ROW_HEIGHT,
      bottom: (maxRow + 1) * ROW_HEIGHT,
      minTime,
      maxTime
    }
  }, [selectionByBox, selectedKeys, visibleTracks, markersByTrack, start, span])

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
    // 拖框选择才显示缩放手柄：onSelectKeys 会默认关掉，这里重新打开（注意顺序）
    useTimelineStore.getState().setSelectionByBox(true)
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
    // 点击关键帧的同时把播放头定位到该帧（未播放时点哪条竖线就跳到哪帧上方）
    props.onScrub(snapScrub(marker.slot))
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
    // 逐点点击（含 Shift/Ctrl 多选）不是拖框，不显示缩放框
    useTimelineStore.getState().setSelectionByBox(false)
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

  /**
   * 选中关键帧包围盒的左右边缘缩放：拖动左 / 右边把整组关键帧按对侧边缘为锚点拉伸或压缩。
   * 当所有选中的帧都在同一时间点时退化为平移。
   */
  const startScale = (event: React.PointerEvent<HTMLButtonElement>, side: 'left' | 'right'): void => {
    event.stopPropagation()
    event.preventDefault()
    if (event.button !== 0) return
    // 直接读 store 的最新选择态，避免渲染间隙拿到过期数据
    const live = useTimelineStore.getState().selectedKeys
    if (live.length === 0) return
    props.onBeginDrag()
    const times = live.map((k) => k.time)
    const minTime = Math.min(...times)
    const maxTime = Math.max(...times)
    const span = maxTime - minTime
    scaleRef.current = {
      side,
      mode: span < 1e-6 ? 'translate' : 'scale',
      selectors: live,
      originTimes: times,
      originEdge: side === 'left' ? minTime : maxTime,
      oppositeEdge: side === 'left' ? maxTime : minTime,
      startTime: timeAtClientX(event.clientX),
      active: false,
      map: { ...mapRef.current }
    }
  }

  /**
   * 关键帧区右键：取消关键帧的选择。
   *
   * 只在**确实选着**的时候写 store（否则每次右键都触发一次全面板重渲染）；
   * 顺手拦掉浏览器菜单 —— 这块区域里它没有用处。
   */
  const cancelKeySelection = (event: React.MouseEvent): void => {
    event.preventDefault()
    if (selectedKeys.length > 0) props.onSelectKeys([])
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
                className="flex items-center gap-0.5 rounded bg-accent-deep px-1 text-white hover:bg-accent cursor-pointer"
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
          title="关键帧区：左键拖动框选关键帧（Shift / Ctrl 点击加选或减选），选中后可整段左右拖动；单击空白定位播放头；滚轮上下翻轨道，Shift+滚轮横向平移；缩放用底部工具栏"
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

          {/* 初始位置只取一次，之后由高频通道用 ref 直接改 transform（见 placePlayheadRef） */}
          <span
            ref={playheadRulerRef}
            className="pointer-events-none absolute top-0 left-0 z-10 h-full w-px bg-accent"
            style={{
              transform: `translateX(${(playheadPercent / 100) * areaWidth}px)`,
              // 提升为独立合成层：每帧挪它只走合成，不触发重绘
              willChange: 'transform'
            }}
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
                  'relative flex w-full items-center gap-1 border-b border-line/40 pr-1.5 text-left text-3xs cursor-pointer transition-colors duration-200',
                  track.isGroup
                    ? 'bg-ink-900/50 font-semibold text-content-hi hover:bg-ink-700'
                    : trackActive
                      ? 'bg-accent-deep font-semibold text-white'
                      : 'text-content-mid hover:bg-ink-700',
                  // 刚打帧的行短暂高亮：帧大概率埋在列表下方，光靠滚动还不够醒目
                  flashTrackId === track.id ? 'bg-accent/30' : '',
                  // 选中对象时整组短暂高亮（与打帧高亮同色系，但更淡，避免和通道选中撞色）
                  isRevealed(track) ? 'bg-accent/25' : ''
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
                onContextMenu={(event) => {
                  // 右键轨道行：取消通道的选择（父级会先判断是否选着，再决定要不要写 store）
                  event.preventDefault()
                  props.onSelectTarget(null)
                }}
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
          <div
            ref={areaRef}
            className="relative min-w-0 flex-1 overflow-hidden"
            onContextMenu={cancelKeySelection}
          >
            <div
              className="pointer-events-none absolute top-0 z-10 h-full border-r border-dashed border-warn/60"
              style={{ left: `${endPercent}%`, opacity: endPercent < 0 || endPercent > 100 ? 0 : 1 }}
            />
            <div
              className="pointer-events-none absolute top-0 z-0 h-full bg-ink-900/40"
              style={{ left: `${Math.max(0, endPercent)}%`, right: 0 }}
            />
            {/*
              原来按 playheadPercent 条件渲染 —— 高频通道要求这个节点常驻，
              所以改成始终渲染、用 opacity 控制可见性（同上面的结束标记写法）。
            */}
            <div
              ref={playheadHeadRef}
              className="pointer-events-none absolute top-0 left-0 z-20 h-full w-px bg-accent"
              style={{
                transform: `translateX(${(playheadPercent / 100) * areaWidth}px)`,
                opacity: playheadPercent < 0 || playheadPercent > 100 ? 0 : 1,
                // 同标尺：独立合成层，播放时每帧挪动不触发重绘
                willChange: 'transform'
              }}
            >
              <span className="absolute -left-[4px] top-0 h-0 w-0 border-x-[4px] border-t-[6px] border-x-transparent border-t-accent" />
            </div>

            {/* 框选矩形：拖拽时要盖在已选包围盒和手柄之上 */}
            {band ? (
              <div
                className="pointer-events-none absolute z-50 rounded-sm border border-accent/70 bg-accent/10"
                style={{ left: band.left, top: band.top, width: band.width, height: band.height }}
              />
            ) : null}

            {/* 已选关键帧包围盒 + 左右缩放手柄 */}
            {selectionBox ? (
              <>
                <div
                  className="pointer-events-none absolute z-30 rounded-sm border border-accent/70 bg-accent/10"
                  style={{
                    left: `${selectionBox.left}%`,
                    top: selectionBox.top,
                    width: `${selectionBox.right - selectionBox.left}%`,
                    height: selectionBox.bottom - selectionBox.top
                  }}
                />
                <button
                  type="button"
                  title="左右拖动缩放选中关键帧"
                  className="absolute z-40 w-1.5 cursor-ew-resize bg-accent/80 hover:bg-accent active:bg-white"
                  style={{
                    left: `${selectionBox.left}%`,
                    top: selectionBox.top,
                    height: selectionBox.bottom - selectionBox.top,
                    transform: 'translateX(-50%)'
                  }}
                  onPointerDown={(event) => startScale(event, 'left')}
                />
                <button
                  type="button"
                  title="左右拖动缩放选中关键帧"
                  className="absolute z-40 w-1.5 cursor-ew-resize bg-accent/80 hover:bg-accent active:bg-white"
                  style={{
                    left: `${selectionBox.right}%`,
                    top: selectionBox.top,
                    height: selectionBox.bottom - selectionBox.top,
                    transform: 'translateX(-50%)'
                  }}
                  onPointerDown={(event) => startScale(event, 'right')}
                />
              </>
            ) : null}

            {visibleTracks.map((track, trackIndex) => (
              <div
                key={track.id}
                className={[
                  'relative border-b border-line/40 transition-colors duration-200',
                  track.isGroup
                    ? 'bg-ink-900/30'
                    : isTrackActive(track)
                      ? 'bg-accent/10'
                      : '',
                  // 选中对象时整组短暂高亮：左列行首 + 右列关键帧行一起亮，一眼锁定
                  isRevealed(track) ? 'bg-accent/25' : ''
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

      {/*
        底部工具栏：智能过滤 / 横向平移滑块 / 缩放组。
        滚轮不再缩放时间轴（只上下翻轨道），缩放与快速平移的入口统一收拢到这里
      */}
      <div className="flex h-[26px] shrink-0 items-center gap-2 border-t border-line/60 bg-ink-800/80 px-1.5">
        <button
          type="button"
          title="洋葱皮：显示前后帧的骨骼姿态"
          className={['hao-tool-button', onionSkin ? 'hao-tool-button-active' : ''].join(' ')}
          onClick={toggleOnionSkin}
        >
          <Zap size={13} />
        </button>
        <button
          type="button"
          disabled={!filterTarget}
          title={
            filterTarget
              ? '智能过滤：只显示当前选中对象的轨道（再点一次恢复全部）'
              : '智能过滤：先在层级树 / 视口 / 时间轴里选中一个对象'
          }
          onClick={() => setSmartFilter((value) => !value)}
          className={[
            'flex h-[18px] shrink-0 items-center gap-1 rounded-[4px] px-1.5 text-3xs transition-colors duration-panel',
            smartFilter && filterTarget
              ? 'bg-accent-deep text-white'
              : 'text-content-mid hover:bg-ink-600 hover:text-content-hi',
            !filterTarget ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'
          ].join(' ')}
        >
          <Filter size={11} />
          <span>智能过滤</span>
        </button>
        {smartFilter && filterTarget ? (
          <span className="shrink-0 text-3xs text-accent" title="再点一次「智能过滤」恢复全部轨道">
            「{filterTarget}」
          </span>
        ) : null}

        {/* 横向平移：拖动滑块快速左右滑动时间轴（与中键拖拽 / Shift+滚轮等效） */}
        <input
          type="range"
          className="h-[4px] min-w-0 flex-1 cursor-pointer appearance-none rounded bg-ink-600 accent-accent disabled:cursor-not-allowed disabled:opacity-40"
          min={0}
          max={1000}
          step={1}
          disabled={maxStart <= 0}
          value={Math.round((maxStart > 0 ? start / maxStart : 0) * 1000)}
          onChange={(event) => applyView({ start: (Number(event.target.value) / 1000) * maxStart })}
          title="左右滑动时间轴（拖到最右 = 时间轴末尾）"
        />

        {/* 缩放组：以可见窗口中心为锚点 */}
        <button
          type="button"
          title="缩小时间轴（看得更全）"
          className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded text-content-mid hover:bg-ink-600 hover:text-content-hi"
          onClick={() => zoomAround(zoom / 1.25)}
        >
          <Minus size={12} />
        </button>
        <input
          type="range"
          className="h-[4px] w-28 shrink-0 cursor-pointer appearance-none rounded bg-ink-600 accent-accent"
          min={Math.round(TIMELINE_ZOOM_MIN * 100)}
          max={Math.round(TIMELINE_ZOOM_MAX * 100)}
          step={1}
          value={Math.round(zoom * 100)}
          onChange={(event) => zoomAround(Number(event.target.value) / 100)}
          title="时间轴缩放"
        />
        <button
          type="button"
          title="放大时间轴（逐帧精修）"
          className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded text-content-mid hover:bg-ink-600 hover:text-content-hi"
          onClick={() => zoomAround(zoom * 1.25)}
        >
          <Plus size={12} />
        </button>
        {zoomed ? (
          <button
            type="button"
            title="恢复「完整适配」"
            className="shrink-0 rounded bg-accent-deep px-1 text-3xs text-white hover:bg-accent"
            onClick={() => {
              applyView({ start: 0, zoom: 1 })
              props.onZoom(1)
            }}
          >
            1×
          </button>
        ) : null}
      </div>
    </div>
  )
}

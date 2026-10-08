import { create } from 'zustand'
import type { KeySelector } from '../timeline/model'
import { usePlayheadStore } from './playheadStore'

export interface TimelineState {
  /** 当前编辑的动画名；null = 未选择动画 */
  currentAnimation: string | null
  /** 当前时间（秒） */
  time: number
  playing: boolean
  loop: boolean
  speed: number
  onionSkin: boolean
  snapToFrame: boolean
  /**
   * 时间轴时间缩放（1 = 完整适配动画长度；越大时间轴越长、关键帧越松散）。
   * 用鼠标中键在帧区域滚动即可调整，Ctrl/Cmd + 滚轮同样可用。
   */
  zoom: number
  /** 选中的关键帧（含轨道定位信息，可直接用于增删改） */
  selectedKeys: KeySelector[]
  /**
   * 时间轴上点中的轨道（分组行不算）。打关键帧时优先用它：
   * 选中插槽的「显示」行按 K 就只打显示帧，而不是把该插槽的通道全打一遍。
   */
  selectedTrack: { kind: string; target: string; attachment: string; channel: string } | null
  /**
   * 最近打过关键帧的轨道（id 与 `buildTimeline` 的子轨道 id 一致）。
   * 打帧的位置往往在轨道列表下方看不见，DopeSheet 靠它自动滚动到该行并高亮一下 ——
   * 否则「点了打关键帧但时间轴没反应」会让人以为是没打上。
   * `stamp` 递增：连续给同一轨道打帧也能重新触发滚动/高亮。
   */
  lastKeyed: { trackId: string; time: number; stamp: number } | null

  notifyKeyed: (trackId: string, time: number) => void
  setAnimation: (name: string | null) => void
  setTime: (time: number) => void
  setPlaying: (playing: boolean) => void
  togglePlaying: () => void
  toggleLoop: () => void
  setSpeed: (speed: number) => void
  toggleOnionSkin: () => void
  setSnapToFrame: (snap: boolean) => void
  setZoom: (zoom: number) => void
  setSelectedKeys: (keys: KeySelector[]) => void
  setSelectedTrack: (track: TimelineState['selectedTrack']) => void
}

/**
 * 时间轴缩放范围。
 * 1 = 完整适配动画长度；< 1 可以把时间轴压得更短（长动画一屏看完、帧距更小），
 * 上限用于逐帧精修。
 */
export const TIMELINE_ZOOM_MIN = 0.5
export const TIMELINE_ZOOM_MAX = 2
/** 打开时间轴时的默认缩放（与上下限解耦，改范围不会连带改默认观感） */
export const TIMELINE_ZOOM_DEFAULT = 1

export const useTimelineStore = create<TimelineState>((set, get) => ({
  currentAnimation: null,
  time: 0,
  playing: false,
  loop: true,
  speed: 1,
  onionSkin: false,
  snapToFrame: true,
  zoom: TIMELINE_ZOOM_DEFAULT,
  selectedKeys: [],
  selectedTrack: null,
  lastKeyed: null,

  notifyKeyed: (trackId, time) =>
    set((state) => ({ lastKeyed: { trackId, time, stamp: (state.lastKeyed?.stamp ?? 0) + 1 } })),
  setAnimation: (name) => {
    set({ currentAnimation: name, time: 0, selectedKeys: [], selectedTrack: null })
    // 播放头时钟归零，否则切动画后播放头会停在上一段的旧位置
    usePlayheadStore.getState().setTime(0)
  },
  /**
   * 低频跳转（擦洗 / 逐帧 / 换动画）。这里同时把值镜像进**播放头时钟**：
   * 播放头与状态栏读的是高频通道，只有镜像过来才能在跳转瞬间跟上。
   * 反向不需要同步 —— 播放期间只写高频通道、不写主 store（见 ViewportCanvas 的渲染循环）。
   */
  setTime: (time) => {
    set({ time })
    usePlayheadStore.getState().setTime(time)
  },
  setPlaying: (playing) => set({ playing }),
  // 不在这里静默拦截「未选动画」的情况：调用方（App 命令）会先自动选中动画并给出提示
  togglePlaying: () => set({ playing: !get().playing }),
  toggleLoop: () => set({ loop: !get().loop }),
  setSpeed: (speed) => set({ speed: Math.max(0.1, Math.min(4, speed)) }),
  toggleOnionSkin: () => set({ onionSkin: !get().onionSkin }),
  setSnapToFrame: (snapToFrame) => set({ snapToFrame }),
  setZoom: (zoom) => set({ zoom: Math.max(TIMELINE_ZOOM_MIN, Math.min(TIMELINE_ZOOM_MAX, zoom)) }),
  setSelectedKeys: (key) => set({ selectedKeys: key }),
  setSelectedTrack: (track) => set({ selectedTrack: track })
}))

export function currentTimeline(): TimelineState {
  return useTimelineStore.getState()
}

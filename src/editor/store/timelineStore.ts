import { create } from 'zustand'
import type { KeySelector } from '../timeline/model'

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

  setAnimation: (name) => set({ currentAnimation: name, time: 0, selectedKeys: [], selectedTrack: null }),
  setTime: (time) => set({ time }),
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

import { create } from 'zustand'
import { useEffect, useState } from 'react'

/**
 * 播放头时钟：**每帧**更新的高频时间，与 `timelineStore.time`（低频）分开存放。
 *
 * 为什么要拆开：播放时每帧把时间写进 `timelineStore` 会通知**所有**订阅者 ——
 * App、时间轴面板、DopeSheet、层级树、属性面板整棵树一起重渲染。实测（Demon，60fps 动画）：
 *
 * | 场景 | 核心耗时/帧（动画求值+蒙皮重建+绘制） | 实测帧间隔 | 长任务 |
 * | --- | --- | --- | --- |
 * | 暂停 | 0.33 ms | 21.2 ms（47fps） | 10 个 / 731ms |
 * | 播放（每帧写主 store） | 1.70 ms | **121.3 ms（8fps）** | 40 个 / 3261ms |
 * | 播放（不写主 store） | 1.13 ms | **22.8 ms（44fps）** | 16 个 / 1069ms |
 *
 * 单次写入的净重渲染成本 ≈ 102.7 ms，而 MutationObserver 显示**真正需要改动的 DOM 只有 10 处**
 * （播放头、标尺、状态栏读数）—— 也就是说：要动的节点很少，React 却在重建整棵树。
 *
 * 所以这里把「要跟着播放头动的那几个节点」单独接一条高频通道：
 * - 写 `usePlayheadStore` 只通知真正订阅它的少数小组件 / ref 回调，不惊动整棵 UI 树；
 * - 播放期间**不写** `timelineStore`，只在暂停 / 播完 / 擦洗 / 切动画时同步一次（见 `timelineStore`）。
 */
interface PlayheadState {
  /** 当前播放头时间（秒） */
  time: number
  setTime: (time: number) => void
}

export const usePlayheadStore = create<PlayheadState>((set) => ({
  time: 0,
  setTime: (time) => set({ time })
}))

/** 直接读取播放头时间（非 React 上下文：rAF 循环、事件回调、帧订阅里用） */
export function playheadTime(): number {
  return usePlayheadStore.getState().time
}

/**
 * 节流版的播放头时间：给「需要跟着播放刷新、但不必每帧都刷」的面板用
 * （层级树里插槽当前显示的附件名、属性面板的当前时间读数…）。
 *
 * 每 `intervalMs` 最多触发一次重渲染 —— 这些面板整体重渲染不便宜，
 * 每帧都刷等于把刚拆掉的开销又搬回来。
 */
export function useThrottledPlayheadTime(intervalMs = 250): number {
  const [value, setValue] = useState(() => usePlayheadStore.getState().time)

  useEffect(() => {
    let timer = 0
    let pending = false
    const unsubscribe = usePlayheadStore.subscribe((state) => {
      if (pending) return
      pending = true
      timer = window.setTimeout(() => {
        pending = false
        setValue(state.time)
      }, intervalMs)
    })
    return () => {
      unsubscribe()
      window.clearTimeout(timer)
    }
  }, [intervalMs])

  return value
}

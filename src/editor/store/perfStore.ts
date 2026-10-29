/**
 * 视口帧统计：给「看性能」用的一条独立通道。
 *
 * 采集在 `ViewportCanvas` 的 rAF 循环里（每帧两个 `performance.now()`，成本可忽略），
 * 但**只每 500ms 发布一次** —— 读数每秒跳两下足够看清趋势，又不会让状态栏按帧重渲染。
 * 订阅方（状态栏）拿到值后直接写文本节点，不经过 React state，与播放头读数同一套路。
 *
 * 三个数的分工（定位瓶颈时最有用）：
 * - `fps` / `frameMs`：实际呈现节奏。frameMs 明显大于 16.7 就说明没跑满 60fps；
 * - `jsMs`：`scene.update()` 的主线程耗时（采样 + 蒙皮重建 + 叠加层 + 提交 render）。
 *   若 jsMs 接近 frameMs，瓶颈在 CPU；若远小于 frameMs，说明卡在掉帧 / 合成 / 等 GPU；
 * - `worstMs`：窗口内最差的一帧 —— 判断「整体偏慢」还是「周期性卡一下」靠它。
 */
export interface PerfStats {
  /** 窗口内平均帧率 */
  fps: number
  /** 窗口内平均帧间隔（ms） */
  frameMs: number
  /** 窗口内平均主线程耗时（ms） */
  jsMs: number
  /** 窗口内最差的一帧间隔（ms） */
  worstMs: number
}

const EMPTY: PerfStats = { fps: 0, frameMs: 0, jsMs: 0, worstMs: 0 }

let latest: PerfStats = EMPTY
const listeners = new Set<(stats: PerfStats) => void>()

/** 非 React 上下文读取最近一次统计 */
export function perfStats(): PerfStats {
  return latest
}

export function subscribePerf(listener: (stats: PerfStats) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 由渲染循环调用（2Hz） */
export function publishPerf(stats: PerfStats): void {
  latest = stats
  for (const listener of listeners) listener(stats)
}

/** 状态栏读数：`58fps · 17.2ms · JS 1.4ms` */
export function formatPerf(stats: PerfStats): string {
  if (!(stats.fps > 0)) return '—'
  return `${Math.round(stats.fps)}fps · ${stats.frameMs.toFixed(1)}ms · JS ${stats.jsMs.toFixed(2)}ms`
}

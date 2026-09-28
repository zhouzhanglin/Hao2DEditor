export interface StatusBarProps {
  stats: { bones: number; slots: number; constraints: number; vertices: number; triangles: number }
  selection: string
  animationName: string | null
  time: number
  frameRate: number
  hint?: string
  /** 正在执行的耗时操作（导入 / 导出 / 打包），非空时显示进度提示 */
  busy?: string | null
}

/** 最底状态栏：高密度统计信息，右侧动画名与帧号。 */
export default function StatusBar({
  stats,
  selection,
  animationName,
  time,
  frameRate,
  hint,
  busy
}: StatusBarProps) {
  const frame = Math.round(time * frameRate)
  return (
    <footer className="flex h-[22px] items-center gap-3 border-t border-line bg-ink-800 px-2 text-3xs text-content-lo">
      <span className="flex items-center gap-2 font-mono">
        <Stat label="骨骼" value={stats.bones} />
        <Stat label="插槽" value={stats.slots} />
        <Stat label="约束" value={stats.constraints} />
        <Stat label="顶点" value={stats.vertices} />
        <Stat label="三角面" value={stats.triangles} />
      </span>

      <span className="h-[12px] w-px bg-line" />
      <span className="truncate text-content-mid">{selection}</span>

      <span className="ml-auto flex items-center gap-3">
        {busy ? (
          <span className="flex animate-fade-in items-center gap-1 text-warn">
            <span className="inline-block h-[8px] w-[8px] animate-spin rounded-full border border-warn border-t-transparent" />
            {busy}
          </span>
        ) : null}
        {hint ? <span className="animate-fade-in text-accent/80">{hint}</span> : null}
        {animationName ? (
          <>
            <span className="text-content-mid">{animationName}</span>
            <span className="font-mono text-content-lo">
              {frame} / {frameRate}fps · {time.toFixed(3)}s
            </span>
          </>
        ) : (
          <span className="text-content-lo">未选择动画</span>
        )}
      </span>
    </footer>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <span className="flex items-baseline gap-1">
      <span className="text-content-lo">{label}</span>
      <span className="text-content-mid">{value}</span>
    </span>
  )
}

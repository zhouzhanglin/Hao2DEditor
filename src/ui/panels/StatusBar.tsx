import { usePlayheadStore } from '@editor/store/playheadStore'

export interface StatusBarProps {
  stats: {
    bones: number
    slots: number
    constraints: number
    vertices: number
    triangles: number
    /** 已载入的图片纹理数 / 工程里的图片总数：不相等说明有图没加载出来（视口会画成白色） */
    texturesLoaded: number
    texturesTotal: number
  }
  selection: string
  animationName: string | null
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
  frameRate,
  hint,
  busy
}: StatusBarProps) {
  /**
   * 时间从**播放头时钟**读（高频通道）：播放时每帧更新，但只让这一小块重渲染，
   * 不牵扯 App / 时间轴 / 层级树（详见 `playheadStore`）。擦洗与切动画都会镜像过来，
   * 所以这里始终是当前真实时间。
   */
  const time = usePlayheadStore((s) => s.time)
  const frame = Math.round(time * frameRate)
  return (
    <footer className="flex h-[22px] items-center gap-3 border-t border-line bg-ink-800 px-2 text-2xs text-content-lo">
      <span className="flex items-center gap-2 font-mono">
        <Stat label="骨骼" value={stats.bones} />
        <Stat label="插槽" value={stats.slots} />
        <Stat label="约束" value={stats.constraints} />
        <Stat label="顶点" value={stats.vertices} />
        <Stat label="三角面" value={stats.triangles} />
        {stats.texturesTotal > 0 ? (
          // 只在缺图时标红：一眼看出「模型画成白块」是纹理没加载，而不是几何有问题
          <span
            className={stats.texturesLoaded < stats.texturesTotal ? 'flex items-baseline gap-1 text-warn' : 'flex items-baseline gap-1'}
            title={
              stats.texturesLoaded < stats.texturesTotal
                ? `有 ${stats.texturesTotal - stats.texturesLoaded} 张图片没加载出纹理，视口里会显示为白块`
                : '图片纹理全部就绪'
            }
          >
            <span className="text-content-lo">纹理</span>
            <span className="text-content-mid">
              {stats.texturesLoaded}/{stats.texturesTotal}
            </span>
          </span>
        ) : null}
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

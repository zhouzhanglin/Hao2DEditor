import { useEffect, useRef } from 'react'
import { playheadTime, usePlayheadStore } from '@editor/store/playheadStore'
import { t } from '@i18n'

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

/** 播放头读数：`帧号 / fps · 秒数`（写进纯文本节点，不走 React） */
function formatReadout(time: number, frameRate: number): string {
  return `${Math.round(time * frameRate)} / ${frameRate}fps · ${time.toFixed(3)}s`
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
   * 时间从**播放头时钟**读（高频通道），但**不进 React state** —— 直接写 DOM。
   *
   * 播放时这个读数每帧都在变。之前是 `usePlayheadStore((s) => s.time)`：值一变就重渲染
   * 整个状态栏（十几个节点 + commit），而且经过 React 调度器的 MessagePort 派发，
   * 落在哪一帧不确定 —— 60fps 只有 16.6ms 的预算，每帧多一次调度就可能把某帧挤出去。
   * 这里与时间轴面板 / DopeSheet 的播放头同一套路：只有这一个文本节点动。
   */
  const readoutRef = useRef<HTMLSpanElement | null>(null)
  useEffect(() => {
    const apply = (time: number): void => {
      const el = readoutRef.current
      if (!el) return
      el.textContent = formatReadout(time, frameRate)
    }
    apply(playheadTime())
    return usePlayheadStore.subscribe((state) => apply(state.time))
  }, [frameRate])

  return (
    <footer className="flex h-[22px] items-center gap-3 border-t border-line bg-ink-800 px-2 text-2xs text-content-lo">
      <span className="flex items-center gap-2 font-mono">
        <Stat label={t('骨骼')} value={stats.bones} />
        <Stat label={t('插槽')} value={stats.slots} />
        <Stat label={t('约束')} value={stats.constraints} />
        <Stat label={t('顶点')} value={stats.vertices} />
        <Stat label={t('三角面')} value={stats.triangles} />
        {stats.texturesTotal > 0 ? (
          // 只在缺图时标红：一眼看出「模型画成白块」是纹理没加载，而不是几何有问题
          <span
            className={stats.texturesLoaded < stats.texturesTotal ? 'flex items-baseline gap-1 text-warn' : 'flex items-baseline gap-1'}
            title={
              stats.texturesLoaded < stats.texturesTotal
                ? t('有 {0} 张图片没加载出纹理，视口里会显示为白块', stats.texturesTotal - stats.texturesLoaded)
                : t('图片纹理全部就绪')
            }
          >
            <span className="text-content-lo">{t('纹理')}</span>
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
            {/*
              内容由 effect 直接写，React 不管这个文本节点（播放时也照常每帧更新）。
              ref 回调里**再补一次**：切动画 / 切到「未选择动画」再切回来时这个 span 会
              先卸载再挂载，而 effect 的依赖（frameRate）没变、不会重跑 ——
              不补的话读数会空着，直到下一次播放头变化（暂停时永远等不到）。
            */}
            <span
              ref={(el) => {
                readoutRef.current = el
                if (el) el.textContent = formatReadout(playheadTime(), frameRate)
              }}
              className="font-mono text-content-lo"
            />
          </>
        ) : (
          <span className="text-content-lo">{t('未选择动画')}</span>
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

import { useEffect, useRef, useState } from 'react'
import { formatPerf, perfStats, subscribePerf } from '@editor/store/perfStore'
import type { PerfStats } from '@editor/store/perfStore'
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
  hint?: string
  /** 正在执行的耗时操作（导入 / 导出 / 打包），非空时显示进度提示 */
  busy?: string | null
}

/** 帧率读数的开关（软件级偏好：与工程无关，跨工程保留） */
const PERF_KEY = 'hao2d:show-perf'

function readShowPerf(): boolean {
  if (typeof localStorage === 'undefined') return false
  return localStorage.getItem(PERF_KEY) === '1'
}

/** 最底状态栏：高密度统计信息 + 右下的操作提示 / 帧率读数开关。 */
export default function StatusBar({ stats, selection, hint, busy }: StatusBarProps) {
  /**
   * 帧率读数：默认关（不占地方），点右侧 `FPS` 打开。
   *
   * 数值从 `perfStore`（2Hz 发布）来，同样**只写文本节点**，不触发重渲染；
   * 只有「开关」本身走 React state（一次点击一次重渲染，可以忽略）。
   */
  const [showPerf, setShowPerf] = useState(readShowPerf)
  const perfRef = useRef<HTMLSpanElement | null>(null)
  useEffect(() => {
    if (!showPerf) return
    const apply = (stats: PerfStats): void => {
      const el = perfRef.current
      if (!el) return
      el.textContent = formatPerf(stats)
      el.title = t('最差一帧 {0}ms', stats.worstMs.toFixed(1))
    }
    apply(perfStats())
    return subscribePerf(apply)
  }, [showPerf])

  const togglePerf = (): void => {
    setShowPerf((prev) => {
      const next = !prev
      if (typeof localStorage !== 'undefined') localStorage.setItem(PERF_KEY, next ? '1' : '0')
      return next
    })
  }

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

      {/* 没选中对象时 selection 为空串：连分隔线一起不渲染，免得留一条悬空竖线 */}
      {selection ? (
        <>
          <span className="h-[12px] w-px bg-line" />
          <span className="truncate text-content-mid">{selection}</span>
        </>
      ) : null}

      <span className="ml-auto flex items-center gap-3">
        {busy ? (
          <span className="flex animate-fade-in items-center gap-1 text-warn">
            <span className="inline-block h-[8px] w-[8px] animate-spin rounded-full border border-warn border-t-transparent" />
            {busy}
          </span>
        ) : null}
        {hint ? <span className="animate-fade-in text-accent/80">{hint}</span> : null}
        {/* 帧率读数开关：关闭时只是一个 `FPS` 按钮，打开后原地显示读数（内容由上面的 effect 写） */}
        <button
          type="button"
          onClick={togglePerf}
          className={`shrink-0 rounded px-1 font-mono ${
            showPerf ? 'text-accent' : 'text-content-lo hover:text-content-mid'
          }`}
          title={showPerf ? t('点击隐藏帧率读数') : t('点击显示视口帧率')}
        >
          {showPerf ? (
            <span
              ref={(el) => {
                perfRef.current = el
                if (el) el.textContent = formatPerf(perfStats())
              }}
            />
          ) : (
            'FPS'
          )}
        </button>
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

import { useRef } from 'react'
import { Easing } from '@core/model/animation'
import type { KeySelector } from '@editor/timeline/model'
import { t } from '@i18n'

export interface CurveEditorProps {
  selectedKeys: KeySelector[]
  /** 当前选中关键帧的缓动（取第一个） */
  easing: Easing
  curve: number[] | null
  onChange: (easing: Easing, curve: number[] | null) => void
  /** 面板已由外层 PanelShell 给出「曲线」标题时传 false，避免标题重复 */
  showTitle?: boolean
}

/** 预设缓动：`label` 是词典键（渲染时过 `t`，`key` 也用原文，换语言时按钮不重建） */
const PRESETS: Array<{ label: string; easing: Easing; curve: number[] | null }> = [
  { label: '线性', easing: Easing.Linear, curve: null },
  { label: '阶跃', easing: Easing.Stepped, curve: null },
  { label: '缓入缓出', easing: Easing.Bezier, curve: [0.42, 0, 0.58, 1] },
  { label: '缓入', easing: Easing.Bezier, curve: [0.42, 0, 1, 1] },
  { label: '缓出', easing: Easing.Bezier, curve: [0, 0, 0.58, 1] },
  { label: '回弹', easing: Easing.Bezier, curve: [0.68, -0.55, 0.27, 1.55] }
]

const SIZE = 104
const PAD = 10

/**
 * 贝塞尔曲线编辑器：四点手柄（p0(0,0) / p1 / p2 / p3(1,1)），x 为时间进度、y 为值进度。
 * 手柄可拖动，坐标与 Runtime 的 `curve = [cx1, cy1, cx2, cy2]` 一一对应。
 */
export default function CurveEditor({ selectedKeys, easing, curve, onChange, showTitle = true }: CurveEditorProps) {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const dragging = useRef<0 | 1 | null>(null)
  const active = curve ?? [0.25, 0.25, 0.75, 0.75]
  const enabled = selectedKeys.length > 0

  const toScreen = (x: number, y: number): { cx: number; cy: number } => ({
    cx: PAD + x * (SIZE - PAD * 2),
    cy: SIZE - PAD - y * (SIZE - PAD * 2)
  })

  const fromClient = (clientX: number, clientY: number): { x: number; y: number } => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    const span = SIZE - PAD * 2
    return {
      x: Math.max(-0.5, Math.min(1.5, (clientX - rect.left - PAD) / span)),
      y: Math.max(-0.5, Math.min(1.5, (rect.bottom - clientY - PAD) / span))
    }
  }

  const commit = (next: number[]): void => onChange(Easing.Bezier, next)

  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>): void => {
    if (dragging.current === null) return
    const point = fromClient(event.clientX, event.clientY)
    const next = [...active]
    const index = dragging.current === 0 ? 0 : 2
    next[index] = Number(point.x.toFixed(3))
    next[index + 1] = Number(point.y.toFixed(3))
    commit(next)
  }

  const p0 = toScreen(0, 0)
  const p3 = toScreen(1, 1)
  const p1 = toScreen(active[0], active[1])
  const p2 = toScreen(active[2], active[3])
  const path = `M ${p0.cx} ${p0.cy} C ${p1.cx} ${p1.cy}, ${p2.cx} ${p2.cy}, ${p3.cx} ${p3.cy}`

  return (
    <div className="flex shrink-0 flex-wrap items-start gap-2">
      <svg
        ref={svgRef}
        width={SIZE}
        height={SIZE}
        className={enabled ? 'cursor-crosshair' : 'opacity-40'}
        onPointerMove={onPointerMove}
        onPointerUp={() => {
          dragging.current = null
        }}
        onPointerLeave={() => {
          dragging.current = null
        }}
      >
        <rect x={0} y={0} width={SIZE} height={SIZE} fill="transparent" />
        {[0, 0.25, 0.5, 0.75, 1].map((t) => {
          const a = toScreen(t, 0)
          const b = toScreen(t, 1)
          const c = toScreen(0, t)
          const d = toScreen(1, t)
          return (
            <g key={t} stroke="#2C2C2E" strokeWidth={1}>
              <line x1={a.cx} y1={a.cy} x2={b.cx} y2={b.cy} />
              <line x1={c.cx} y1={c.cy} x2={d.cx} y2={d.cy} />
            </g>
          )
        })}
        <rect x={PAD} y={PAD} width={SIZE - PAD * 2} height={SIZE - PAD * 2} fill="none" stroke="#3A3A3C" />
        {easing === Easing.Bezier ? (
          <>
            <path d={path} fill="none" stroke="#0A84FF" strokeWidth={1.6} />
            <line x1={p0.cx} y1={p0.cy} x2={p1.cx} y2={p1.cy} stroke="#BF5AF2" strokeDasharray="3 3" />
            <line x1={p3.cx} y1={p3.cy} x2={p2.cx} y2={p2.cy} stroke="#BF5AF2" strokeDasharray="3 3" />
          </>
        ) : (
          <path
            d={
              easing === Easing.Stepped
                ? `M ${p0.cx} ${p0.cy} L ${p3.cx} ${p0.cy} L ${p3.cx} ${p3.cy}`
                : `M ${p0.cx} ${p0.cy} L ${p3.cx} ${p3.cy}`
            }
            fill="none"
            stroke="#0A84FF"
            strokeWidth={1.6}
          />
        )}
        <circle cx={p0.cx} cy={p0.cy} r={3} fill="#8E8E93" />
        <circle cx={p3.cx} cy={p3.cy} r={3} fill="#8E8E93" />
        {enabled && easing === Easing.Bezier ? (
          <>
            {[1, 2].map((index) => {
              const point = index === 1 ? p1 : p2
              return (
                <circle
                  key={index}
                  cx={point.cx}
                  cy={point.cy}
                  r={5}
                  fill="#BF5AF2"
                  className="cursor-grab"
                  onPointerDown={(event) => {
                    event.stopPropagation()
                    dragging.current = index === 1 ? 0 : 1
                    ;(event.target as Element).setPointerCapture?.(event.pointerId)
                  }}
                />
              )
            })}
          </>
        ) : null}
      </svg>

      <div className="flex min-w-[104px] flex-1 flex-col gap-1">
        {showTitle ? <span className="hao-panel-title">{t('曲线')}</span> : null}
        <div className="flex flex-wrap gap-1">
          {PRESETS.map((preset) => {
            const isActive =
              preset.easing === easing &&
              (preset.easing !== Easing.Bezier ||
                (curve !== null && Math.abs(curve[0] - (preset.curve?.[0] ?? 0)) < 1e-3 && Math.abs(curve[1] - (preset.curve?.[1] ?? 0)) < 1e-3))
            return (
              <button
                key={preset.label}
                type="button"
                disabled={!enabled}
                className={[
                  'h-[20px] rounded border px-1.5 text-3xs transition-colors duration-panel',
                  !enabled
                    ? 'cursor-not-allowed border-line text-content-lo/50'
                    : isActive
                      ? 'cursor-pointer border-transparent bg-accent-deep text-white'
                      : 'cursor-pointer border-line bg-ink-900/60 text-content-mid hover:text-content-hi'
                ].join(' ')}
                onClick={() => onChange(preset.easing, preset.curve)}
              >
                {t(preset.label)}
              </button>
            )
          })}
        </div>
        <p className="text-3xs text-content-lo">
          {enabled
            ? easing === Easing.Bezier
              ? `c1(${active[0].toFixed(2)}, ${active[1].toFixed(2)}) c2(${active[2].toFixed(2)}, ${active[3].toFixed(2)})`
              : easing === Easing.Stepped
                ? t('阶跃：保持前一帧直到下一关键帧')
                : t('线性：匀速插值')
            : t('先在 dope sheet 里选中关键帧')}
        </p>
      </div>
    </div>
  )
}

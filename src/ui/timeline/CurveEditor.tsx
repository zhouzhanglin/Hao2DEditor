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

/**
 * 预设缓动：`label` 是词典键（渲染时过 `t`，`key` 也用原文，换语言时按钮不重建）。
 *
 * **按类型分组排列**（基础 → 缓入 → 缓出 → 缓入缓出 → 回弹），按钮图标也是按这个顺序铺，
 * 想找「更陡一点的缓出」时眼睛不用满面板乱扫。
 */
const PRESETS: Array<{ label: string; easing: Easing; curve: number[] | null }> = [
  // 基础：两段之间的插值方式（没有曲线可调）
  { label: '线性', easing: Easing.Linear, curve: null },
  { label: '阶跃', easing: Easing.Stepped, curve: null },
  // 缓入：起步慢，越来越快
  { label: '缓入', easing: Easing.Bezier, curve: [0.42, 0, 1, 1] },
  { label: '强缓入', easing: Easing.Bezier, curve: [0.7, 0, 0.84, 0] },
  // 缓出：起步快，慢慢收住（越往下越陡）
  { label: '缓出', easing: Easing.Bezier, curve: [0, 0, 0.58, 1] },
  { label: '强缓出', easing: Easing.Bezier, curve: [0.16, 1, 0.3, 1] },
  { label: '急停', easing: Easing.Bezier, curve: [0.1, 0.9, 0.2, 1] },
  // 缓入缓出：两头慢中间快
  { label: '缓入缓出', easing: Easing.Bezier, curve: [0.42, 0, 0.58, 1] },
  { label: '平滑', easing: Easing.Bezier, curve: [0.37, 0, 0.63, 1] },
  // 回弹：会冲过目标再折回（对称）、只在起点蹲一下（缓入）、只在到位时过冲（缓出）
  { label: '回弹', easing: Easing.Bezier, curve: [0.68, -0.55, 0.27, 1.55] },
  { label: '缓入回弹', easing: Easing.Bezier, curve: [0.36, 0, 0.66, -0.56] },
  { label: '缓出回弹', easing: Easing.Bezier, curve: [0.34, 1.56, 0.64, 1] }
]

/*
 * 绘图区：横向 4 格（0..1），纵向 12 格 —— **中间 4 格**是真正可用的 0..1，
 * 上下各留 4 格给越界（回弹 / 过冲）。格子因此是横宽的长方形。
 *
 * 为什么固定成 12 格而不是让值域自适应：自适应时「往上能拖多远」取决于当前曲线，
 * 一拖手柄画面就跟着缩放，反而不好控制。固定 12 格后，纵向可拖范围恒为 -1..2。
 */
const WIDTH = 132
const HEIGHT = 176
const PAD = 12
/** 纵轴每格 0.25：中间 4 格 = 0..1，上下各 4 格 → 值域 -1 .. 2 */
const STEP = 0.25
const VALUE_MIN = -1
const VALUE_MAX = 2
const COLS = 4
const ROWS = Math.round((VALUE_MAX - VALUE_MIN) / STEP)

type Domain = { min: number; max: number }

/**
 * 只给**预设缩略图**用的自适应值域。
 *
 * 小图只有 26px，固定 -1..2 的话曲线会挤成一条几乎水平的中线；
 * 这里按手柄范围收紧，形状才看得出差别（主图不用它，主图是固定 12 格）。
 */
function thumbDomain(curve: number[]): Domain {
  const lo = Math.min(0, curve[1], curve[3])
  const hi = Math.max(1, curve[1], curve[3])
  const margin = Math.max(1, hi - lo) * 0.12
  return { min: lo - margin, max: hi + margin }
}

/**
 * 预设按钮的图标：在 `THUMB` 见方的小图里画一遍这条缓动曲线（形状所见即所得，
 * 与主图同一套控制点 → 不写文字也不会认错）。
 */
const THUMB = 26
const THUMB_PAD = 3

function presetPath(easing: Easing, curve: number[] | null): string {
  const span = THUMB - THUMB_PAD * 2
  const pts = curve ?? [0.25, 0.25, 0.75, 0.75]
  // 缩略图用收紧后的值域：回弹这类越界曲线也不会画到框外，形状又能看出来
  const domain = thumbDomain(pts)
  const sx = (x: number): number => THUMB_PAD + Math.min(1, Math.max(0, x)) * span
  const sy = (y: number): number => THUMB - THUMB_PAD - ((y - domain.min) / (domain.max - domain.min)) * span
  const start = `M ${sx(0)} ${sy(0)}`
  const end = `${sx(1)} ${sy(1)}`
  if (easing === Easing.Stepped) return `${start} L ${sx(1)} ${sy(0)} L ${end}`
  if (easing === Easing.Linear) return `${start} L ${end}`
  return `${start} C ${sx(pts[0])} ${sy(pts[1])}, ${sx(pts[2])} ${sy(pts[3])}, ${end}`
}

/**
 * 贝塞尔曲线编辑器：四点手柄（p0(0,0) / p1 / p2 / p3(1,1)），x 为时间进度、y 为值进度。
 * 手柄可拖动，坐标与 Runtime 的 `curve = [cx1, cy1, cx2, cy2]` 一一对应。
 */
export default function CurveEditor({ selectedKeys, easing, curve, onChange, showTitle = true }: CurveEditorProps) {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const dragging = useRef<0 | 1 | null>(null)
  const active = curve ?? [0.25, 0.25, 0.75, 0.75]
  const enabled = selectedKeys.length > 0
  const spanX = WIDTH - PAD * 2
  const spanY = HEIGHT - PAD * 2

  /**
   * 数值 → 屏幕。
   * x 夹在 0..1：贝塞尔的 x 是时间进度，越界会让采样不单调；老数据里越界的 x
   * 画在框边上（能抓到，拖一下就被拉回合法范围）。
   * y 用**固定**值域 -1..2（中间 4 格是 0..1），所以手柄永远在画面内、拖动不会缩放。
   */
  const toScreen = (x: number, y: number): { cx: number; cy: number } => ({
    cx: PAD + Math.min(1, Math.max(0, x)) * spanX,
    cy: HEIGHT - PAD - ((y - VALUE_MIN) / (VALUE_MAX - VALUE_MIN)) * spanY
  })

  /** 屏幕 → 数值：x 夹到 0..1，y 夹到 -1..2（就是画得出来的范围） */
  const fromClient = (clientX: number, clientY: number): { x: number; y: number } => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    const nx = (clientX - rect.left - PAD) / spanX
    const ny = (rect.bottom - clientY - PAD) / spanY
    return {
      x: Math.min(1, Math.max(0, nx)),
      y: VALUE_MIN + Math.min(1, Math.max(0, ny)) * (VALUE_MAX - VALUE_MIN)
    }
  }

  const commit = (next: number[]): void => onChange(Easing.Bezier, next)

  /** 开始拖手柄：抓指针（拖出 svg 也继续跟手） */
  const startDrag = (index: 1 | 2) => (event: React.PointerEvent<SVGCircleElement>) => {
    if (!enabled) return
    event.stopPropagation()
    event.preventDefault()
    dragging.current = index === 1 ? 0 : 1
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const endDrag = (): void => {
    dragging.current = null
  }

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
    <div className="flex h-full min-h-0 items-center gap-2.5">
      <svg
        ref={svgRef}
        width={WIDTH}
        height={HEIGHT}
        // 深一档的底 + 圆角：与面板底色拉开层次，曲线和网格都更容易看清
        className={['shrink-0 rounded-[5px] bg-ink-900/70', enabled ? 'cursor-crosshair' : 'opacity-40'].join(' ')}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <rect x={0} y={0} width={WIDTH} height={HEIGHT} fill="transparent" />
        {/* 0..1 那条带子铺一层浅底：中间 4 格才是有效取值区，上下 4 格只是越界余量 */}
        <rect
          x={PAD}
          y={toScreen(0, 1).cy}
          width={spanX}
          height={toScreen(0, 0).cy - toScreen(0, 1).cy}
          fill="#FFFFFF"
          opacity={0.05}
        />
        {/* 竖线 = 时间轴 4 格；横线 = 值轴 12 格（0.25 一格，中间 4 格正好是 0..1） */}
        {Array.from({ length: COLS + 1 }, (_, index) => index / COLS).map((x) => {
          const top = toScreen(x, VALUE_MAX)
          const bottom = toScreen(x, VALUE_MIN)
          return (
            <line key={`v${x}`} x1={top.cx} y1={top.cy} x2={bottom.cx} y2={bottom.cy} stroke="#2C2C2E" strokeWidth={1} />
          )
        })}
        {Array.from({ length: ROWS + 1 }, (_, index) => VALUE_MIN + index * STEP).map((y) => {
          const left = toScreen(0, y)
          const right = toScreen(1, y)
          return (
            <line key={`h${y}`} x1={left.cx} y1={left.cy} x2={right.cx} y2={right.cy} stroke="#2C2C2E" strokeWidth={1} />
          )
        })}
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
              const handle = index === 1 ? 1 : 2
              const onPointerDown = startDrag(handle)
              return (
                <g key={index}>
                  {/*
                    真身是外面这个透明的大圆（r=10）：5px 的小圆点在密集面板里几乎点不中，
                    拖动全靠它兜住鼠标。可视的小圆点不接事件（pointer-events-none），
                    免得挡住命中区。
                  */}
                  <circle
                    cx={point.cx}
                    cy={point.cy}
                    r={10}
                    fill="transparent"
                    className={enabled ? 'cursor-grab' : undefined}
                    onPointerDown={onPointerDown}
                  />
                  <circle cx={point.cx} cy={point.cy} r={5} fill="#BF5AF2" pointerEvents="none" />
                </g>
              )
            })}
          </>
        ) : null}
      </svg>

      <div className="flex min-w-0 flex-1 flex-col justify-center gap-1.5">
        {showTitle ? <span className="hao-panel-title">{t('曲线')}</span> : null}
        {/* 预设铺成一排小图：每格画的就是这条缓动的形状（名称放 title 里），比文字按钮好挑 */}
        <div className="flex flex-wrap gap-1">
          {PRESETS.map((preset) => {
            const isActive =
              preset.easing === easing &&
              (preset.easing !== Easing.Bezier ||
                (curve !== null &&
                  curve.length === 4 &&
                  preset.curve !== null &&
                  // 四个分量都要比：只比 c1 的话，几组 c2 不同、c1 相近的预设会一起亮起来
                  curve.every((value, index) => Math.abs(value - preset.curve![index]) < 1e-3)))
            return (
              <button
                key={preset.label}
                type="button"
                disabled={!enabled}
                title={t(preset.label)}
                aria-label={t(preset.label)}
                className={[
                  'flex h-[26px] w-[30px] items-center justify-center rounded-[5px] border transition-colors duration-panel',
                  !enabled
                    ? 'cursor-not-allowed border-line text-content-lo/40'
                    : isActive
                      ? 'cursor-pointer border-transparent bg-accent-deep text-white'
                      : 'cursor-pointer border-line bg-ink-900/60 text-content-mid hover:border-accent/60 hover:text-content-hi'
                ].join(' ')}
                onClick={() => onChange(preset.easing, preset.curve)}
              >
                <svg width={THUMB} height={THUMB} viewBox={`0 0 ${THUMB} ${THUMB}`} aria-hidden>
                  {/* 淡网格 + 边框：让人看出这是 0..1 的缩略图，曲线形状才可比 */}
                  <g stroke="#2F2F31" strokeWidth={1}>
                    <line x1={THUMB_PAD} y1={THUMB / 2} x2={THUMB - THUMB_PAD} y2={THUMB / 2} />
                    <line x1={THUMB / 2} y1={THUMB_PAD} x2={THUMB / 2} y2={THUMB - THUMB_PAD} />
                  </g>
                  <rect
                    x={THUMB_PAD}
                    y={THUMB_PAD}
                    width={THUMB - THUMB_PAD * 2}
                    height={THUMB - THUMB_PAD * 2}
                    fill="none"
                    stroke="#3A3A3C"
                  />
                  <path
                    d={presetPath(preset.easing, preset.curve)}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.6}
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

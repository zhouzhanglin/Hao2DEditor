import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { CommitTextField, parseHexColor } from './fields'
import { hexToRgba, rgbaToHex } from '@core/util/color'

/** HSV：h 0..360、s / v 0..1。文档里存的是 `#RRGGBBAA`，这里只作拾色器的内部状态 */
interface Hsv {
  h: number
  s: number
  v: number
}

interface PickerState {
  hsv: Hsv
  /** 透明度 0..1 */
  a: number
}

export interface ColorPickerPopoverProps {
  x: number
  y: number
  title: string
  /** 打开时的颜色（`#RRGGBB` / `#RRGGBBAA`）。打开后由弹层自己维护，父组件不用回灌 */
  value: string
  /**
   * 拖动中的实时值（每帧都发）：调用方在这里写文档，画面就是逐帧预览。
   * 拖动整段的写入由 `onDragStart` 开的事务合并成一条撤销记录。
   */
  onChange: (value: string) => void
  /** 一次性提交（hex / 透明度输入框）：调用方按「一条撤销记录」写入 */
  onCommit?: (value: string) => void
  /** 拖动开始 / 结束：调用方在这里 `beginTransaction` / `endTransaction` */
  onDragStart?: () => void
  onDragEnd?: () => void
  /** 底部说明（写 setup 还是打关键帧、打在哪一秒） */
  hint?: string
  /**
   * 点外部关闭时，如果这一下按在返回 true 的区域里，就把事件**吞掉**（不再往下传）。
   * 视口用它保住选中态：关弹层的那一按不该同时被当成「点空白取消选择 / 换选中的 display」。
   * 只吞 pointerdown —— 按钮 / 输入框这些靠 click 的控件不受影响（下一次点击照常）。
   */
  absorbDismiss?: (target: EventTarget | null) => boolean
  onClose: () => void
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))
const byte = (value: number): number => Math.round(clamp01(value) * 255)

function rgbToHsv(r: number, g: number, b: number): Hsv {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  let h = 0
  if (delta > 1e-6) {
    if (max === r) h = ((g - b) / delta) % 6
    else if (max === g) h = (b - r) / delta + 2
    else h = (r - g) / delta + 4
    h *= 60
    if (h < 0) h += 360
  }
  return { h, s: max <= 1e-6 ? 0 : delta / max, v: max }
}

function hsvToRgb(h: number, s: number, v: number): { r: number; g: number; b: number } {
  const c = v * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = v - c
  const segment = Math.floor(h / 60) % 6
  const table = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x]
  ]
  const rgb = table[segment] ?? [0, 0, 0]
  return { r: rgb[0] + m, g: rgb[1] + m, b: rgb[2] + m }
}

/** 拾色器内部状态 → `#RRGGBBAA`（走同一套取整，保证与文档里存的值逐个字节一致） */
function toHex(state: PickerState): string {
  const { r, g, b } = hsvToRgb(state.hsv.h, state.hsv.s, state.hsv.v)
  return rgbaToHex({ r, g, b, a: state.a })
}

function fromHex(value: string): PickerState {
  const color = hexToRgba(value)
  return { hsv: rgbToHsv(color.r, color.g, color.b), a: color.a }
}

type DragKind = 'sv' | 'hue' | 'alpha'

/**
 * 小号拾色器弹层：饱和 / 明度方块 + 色相条 + 透明度条 + hex / 透明度百分比输入。
 *
 * 为什么不用原生 `<input type=color>`：它只能开系统 / Chromium 的拾色器弹窗，**没有透明度**
 * （见 ColorField 的注释），而这里的透明度真要写进文档 / 关键帧。弹层渲染到 body 上
 * （与右键菜单一致，不受面板 overflow 裁剪），点击外部 / Esc / 改窗口大小关闭。
 *
 * 拖动整段的取舍与 ColorField 相同：逐帧 `onChange` 实时预览，但只由调用方在
 * `onDragStart` 开一次事务、`onDragEnd` 收尾 —— 整段拖动只留一条撤销记录。
 */
export default function ColorPickerPopover({
  x,
  y,
  title,
  value,
  onChange,
  onCommit,
  onDragStart,
  onDragEnd,
  hint,
  absorbDismiss,
  onClose
}: ColorPickerPopoverProps) {
  const ref = useRef<HTMLDivElement | null>(null)
  const svRef = useRef<HTMLDivElement | null>(null)
  const hueRef = useRef<HTMLDivElement | null>(null)
  const alphaRef = useRef<HTMLDivElement | null>(null)
  const [position, setPosition] = useState({ left: x, top: y })
  // 打开时的颜色只取一次：之后弹层自己维护（拖动中若被父组件回灌会跟手抖）
  const [state, setState] = useState<PickerState>(() => fromHex(value))
  const stateRef = useRef(state)
  stateRef.current = state
  /** 拖动中的会话（null = 没在拖）；kind 用来判断指针事件该改哪一段 */
  const dragRef = useRef<DragKind | null>(null)

  // 回调走 ref：拖动中的 pointermove 是常驻监听，别让它闭包里的旧回调拦住新值
  const latest = useRef({ onChange, onCommit, onDragStart, onDragEnd, absorbDismiss, onClose })
  latest.current = { onChange, onCommit, onDragStart, onDragEnd, absorbDismiss, onClose }

  const hex = toHex(state)
  const { r, g, b } = hsvToRgb(state.hsv.h, state.hsv.s, state.hsv.v)
  const red = byte(r)
  const green = byte(g)
  const blue = byte(b)
  const css = `rgb(${red}, ${green}, ${blue})`
  /** 带上当前透明度的色块（右上角预览用） */
  const alphaCss = `rgba(${red}, ${green}, ${blue}, ${state.a.toFixed(3)})`
  const hueColor = `hsl(${state.hsv.h.toFixed(1)} 100% 50%)`
  /** 棋盘垫底：透明度低的时候能看出「是颜色淡了」而不是「色块没了」 */
  const checker = 'repeating-conic-gradient(#4A4A4D 0% 25%, #333336 0% 50%)'

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const rect = element.getBoundingClientRect()
    const margin = 6
    setPosition({
      left: Math.max(margin, Math.min(x, window.innerWidth - rect.width - margin)),
      top: Math.max(margin, Math.min(y, window.innerHeight - rect.height - margin))
    })
  }, [x, y])

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (ref.current?.contains(event.target as Node | null)) return
      latest.current.onClose()
      /*
       * 关弹层的那一按只用来关弹层：窗口捕获阶段就把它拦下，视口 / 面板拿不到这次按下。
       * 不这么做的话，点视口空白处关拾色器会顺手执行一次「点空白 = 取消选择」，
       * 点在别的 display 上还会把选中换过去 —— 用户看到的就是「关个弹层选中没了」。
       * 只拦 pointerdown：click 照常发，按钮 / 层级树这些点击式控件不受影响。
       */
      if (latest.current.absorbDismiss?.(event.target) === true) event.stopPropagation()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') latest.current.onClose()
    }
    const onResize = (): void => latest.current.onClose()
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onResize)
    }
  }, [])

  // 拖动中被关掉（Esc / 点外部）时收尾事务：不然撤销记录一直挂着，后续编辑全被并进这一条
  useEffect(
    () => () => {
      if (dragRef.current) latest.current.onDragEnd?.()
    },
    []
  )

  const apply = (next: PickerState, oneShot: boolean): void => {
    setState(next)
    const nextHex = toHex(next)
    if (oneShot) latest.current.onCommit?.(nextHex)
    else latest.current.onChange(nextHex)
  }

  /** 按指针位置算出新的颜色（各段都是「横向比例 → 分量」） */
  const updateFromPointer = (kind: DragKind, clientX: number, clientY: number): void => {
    const element = kind === 'sv' ? svRef.current : kind === 'hue' ? hueRef.current : alphaRef.current
    if (!element) return
    const rect = element.getBoundingClientRect()
    const width = rect.width || 1
    const height = rect.height || 1
    const current = stateRef.current
    if (kind === 'sv') {
      apply(
        {
          hsv: {
            h: current.hsv.h,
            s: clamp01((clientX - rect.left) / width),
            v: 1 - clamp01((clientY - rect.top) / height)
          },
          a: current.a
        },
        false
      )
      return
    }
    if (kind === 'hue') {
      apply({ hsv: { ...current.hsv, h: clamp01((clientX - rect.left) / width) * 360 }, a: current.a }, false)
      return
    }
    apply({ hsv: current.hsv, a: clamp01((clientX - rect.left) / width) }, false)
  }

  /** 收尾：只认「当前正在拖的那一段」，重复触发（up 之后紧跟 lostcapture）不会重复收尾 */
  const finishDrag = (kind: DragKind, event: React.PointerEvent<HTMLDivElement>): void => {
    if (dragRef.current !== kind) return
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    latest.current.onDragEnd?.()
  }

  const surfaceHandlers = (
    kind: DragKind
  ): {
    onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void
    onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void
    onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => void
    onPointerCancel: (event: React.PointerEvent<HTMLDivElement>) => void
    onLostPointerCapture: (event: React.PointerEvent<HTMLDivElement>) => void
  } => ({
    onPointerDown: (event) => {
      if (event.button !== 0) return
      event.preventDefault()
      // 指针捕获：拖出弹层（拖到视口上）也继续跟着走，松开才收尾
      event.currentTarget.setPointerCapture(event.pointerId)
      dragRef.current = kind
      latest.current.onDragStart?.()
      updateFromPointer(kind, event.clientX, event.clientY)
    },
    onPointerMove: (event) => {
      if (dragRef.current !== kind) return
      updateFromPointer(kind, event.clientX, event.clientY)
    },
    onPointerUp: (event) => finishDrag(kind, event),
    onPointerCancel: (event) => finishDrag(kind, event),
    // 捕获被系统抢走（窗口失焦等）时的兜底：别让事务一直挂着
    onLostPointerCapture: (event) => finishDrag(kind, event)
  })

  const alphaPercent = Math.round(state.a * 100)

  return createPortal(
    <div
      ref={ref}
      className="fixed z-[999] w-[216px] rounded-[6px] border border-white/10 bg-ink-700/95 p-2 shadow-2xl shadow-black/60 backdrop-blur-xl"
      style={{ left: position.left, top: position.top }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className="mb-2 flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-3xs text-content-lo">{title}</span>
        <span
          className="size-[14px] shrink-0 rounded-[3px] border border-line"
          // 棋盘垫底 + 真带上 alpha 的色块：一眼看出「是颜色淡了」而不是「色块没了」
          style={{
            backgroundImage: `linear-gradient(${alphaCss}, ${alphaCss}), ${checker}`,
            backgroundSize: '100% 100%, 8px 8px'
          }}
        />
        <button
          type="button"
          title="关闭（Esc）"
          className="flex size-[16px] shrink-0 cursor-pointer items-center justify-center rounded-[3px] text-content-lo transition-colors duration-panel hover:bg-ink-600 hover:text-content-hi"
          onClick={() => latest.current.onClose()}
        >
          <X size={11} />
        </button>
      </div>

      {/* 饱和 / 明度方块：横向 = 饱和度、纵向（上→下）= 明度 */}
      <div
        ref={svRef}
        className="relative h-[104px] w-full cursor-crosshair touch-none rounded-[4px] border border-line"
        style={{ background: `linear-gradient(to top, #000, rgba(0, 0, 0, 0)), linear-gradient(to right, #fff, ${hueColor})` }}
        {...surfaceHandlers('sv')}
      >
        <span
          className="pointer-events-none absolute size-[11px] -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.55)]"
          style={{
            left: `${state.hsv.s * 100}%`,
            top: `${(1 - state.hsv.v) * 100}%`,
            background: css
          }}
        />
      </div>

      {/* 色相条 */}
      <div
        ref={hueRef}
        className="relative mt-2 h-[10px] w-full cursor-pointer touch-none rounded-full border border-line"
        style={{
          background:
            'linear-gradient(to right, #f00 0%, #ff0 16.7%, #0f0 33.3%, #0ff 50%, #00f 66.7%, #f0f 83.3%, #f00 100%)'
        }}
        {...surfaceHandlers('hue')}
      >
        <span
          className="pointer-events-none absolute top-1/2 size-[12px] -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.55)]"
          style={{ left: `${(state.hsv.h / 360) * 100}%`, background: hueColor }}
        />
      </div>

      {/* 透明度条：左透明 → 右实色，棋盘垫底 */}
      <div
        ref={alphaRef}
        className="relative mt-2 h-[10px] w-full cursor-pointer touch-none rounded-full border border-line"
        style={{
          backgroundImage: `linear-gradient(to right, rgba(${red}, ${green}, ${blue}, 0), ${css}), ${checker}`,
          backgroundSize: '100% 100%, 8px 8px'
        }}
        {...surfaceHandlers('alpha')}
      >
        <span
          className="pointer-events-none absolute top-1/2 size-[12px] -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.55)]"
          style={{
            left: `${state.a * 100}%`,
            backgroundImage: `linear-gradient(${css}, ${css}), ${checker}`,
            backgroundSize: '100% 100%, 6px 6px'
          }}
        />
      </div>

      <div className="mt-2 flex items-center gap-1.5">
        <CommitTextField
          className="hao-field min-w-0 flex-1 text-2xs font-mono uppercase"
          value={hex}
          title="颜色 #RRGGBBAA（回车 / 失焦生效）"
          sanitize={parseHexColor}
          onCommit={(next) => apply(fromHex(next), true)}
        />
        <div className="relative shrink-0">
          <CommitTextField
            className="hao-field w-[46px] pr-4 text-right font-mono text-3xs"
            value={String(alphaPercent)}
            inputMode="decimal"
            title="透明度百分比（0–100）；失焦 / 回车生效，中键左右拖动可调"
            scrub
            sanitize={(raw) => {
              const next = Number(raw)
              if (!Number.isFinite(next)) return null
              return String(Math.round(Math.min(100, Math.max(0, next))))
            }}
            onCommit={(raw) => apply({ hsv: stateRef.current.hsv, a: clamp01(Number(raw) / 100) }, true)}
          />
          <span className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-3xs text-content-lo">
            %
          </span>
        </div>
      </div>

      {hint ? <p className="mt-1.5 text-3xs leading-[13px] text-content-lo">{hint}</p> : null}
    </div>,
    document.body
  )
}

import { useEffect, useRef, useState } from 'react'
import { useProjectStore } from '@editor/store/projectStore'
import { hasTreeDrag, readTreeDrag } from './dragDrop'

/**
 * 拖动步长的**兜底**：调用方没声明 `step` 时，按当前值是否是整数猜（整数 ±1、浮点 ±0.1）。
 *
 * 有 `step` 的字段一律以 `step` 为准 —— 按值猜会把「值为 1 的浮点字段」误判成整数字段：
 * 缩放 1.0 拖一下直接跳 1（应为 0.1），长度 0.05 的粒度也会被吃成 0.1。
 */
function scrubStepFor(value: number): number {
  return Number.isInteger(value) ? 1 : 0.1
}

/** 步长对应的小数位数（0.1 → 1 位、0.05 → 2 位），拖动取整时用它规避浮点噪声 */
function digitsForStep(step: number): number {
  if (!(step > 0) || step >= 1) return 0
  const text = step.toFixed(6).replace(/0+$/, '')
  const dot = text.indexOf('.')
  return dot < 0 ? 0 : Math.min(6, text.length - dot - 1)
}

/**
 * 按住**中键**左右拖动调值（DCC 手感）：向左减小、向右增大，每移动 1 像素变化一个步长
 * —— 步长以字段声明的 `step` 为准（缩放 0.1、长度 0.05、旋转 1…），与上下键微调一致。
 *
 * 用中键而不是左键：左键要留给「点进输入框改文本」，两者抢同一个手势会互相干扰
 * （左键版本要么点不进输入框，要么得靠移动阈值勉强区分）。
 *
 * - 中键默认会触发浏览器的「自动滚动」，必须在 `mousedown` 阶段拦掉
 * - 拖动真正开始时才退出文本编辑态、才开事务（一次拖动只留一条撤销记录）
 * - `pointerup` / `pointercancel` 都必须清理监听：漏掉 cancel 会让 `pointermove`
 *   常驻在 window 上，表现为「鼠标没按下、只是划过就改数值」
 */
function useScrubDrag(
  value: number,
  onChange: (next: number) => void,
  options?: { enabled?: boolean; min?: number; max?: number; step?: number }
): {
  onMouseDown: (event: React.MouseEvent<HTMLInputElement>) => void
  onPointerDown: (event: React.PointerEvent<HTMLInputElement>) => void
} {
  const enabled = options?.enabled ?? true
  const stepOption = options?.step
  return {
    // 中键默认会进入浏览器的「自动滚动」（四向箭头 + 滚动页面），提前拦掉
    onMouseDown: (event: React.MouseEvent<HTMLInputElement>) => {
      if (!enabled || event.button !== 1) return
      event.preventDefault()
    },
    onPointerDown: (event: React.PointerEvent<HTMLInputElement>) => {
      if (!enabled || event.button !== 1) return
      const target = event.currentTarget
      // 左右箭头光标只在**按住中键期间**显示：悬停时用普通文本光标，
      // 否则鼠标只是划过输入框就变成拖动样式，会让人误以为可以拖。
      // 必须同时设在输入框**自身**上：光标虽是可继承属性，但输入框自带的光标声明
      // 会盖住从 body 继承来的值，只设 body 的话鼠标停在输入框上仍是文本光标。
      target.style.cursor = 'ew-resize'
      document.body.style.cursor = 'ew-resize'
      const startX = event.clientX
      const start = value
      // 步长以字段声明的 step 为准（与上下键微调同一步长），没声明才按值兜底猜
      const step = stepOption ?? scrubStepFor(start)
      const digits = digitsForStep(step)
      const clamp = (next: number): number => {
        let out = next
        if (options?.min !== undefined) out = Math.max(options.min, out)
        if (options?.max !== undefined) out = Math.min(options.max, out)
        return out
      }
      /** 越过阈值前当点击处理（不拦默认行为），越过之后才真正进入拖动 */
      let dragging = false
      let last = start

      const move = (ev: PointerEvent): void => {
        if (!dragging) {
          if (Math.abs(ev.clientX - startX) < 3) return
          dragging = true
          target.blur()
          document.body.style.userSelect = 'none'
          useProjectStore.getState().beginTransaction('调整数值')
        }
        const next = clamp(Number((start + (ev.clientX - startX) * step).toFixed(digits)))
        if (next === last) return
        last = next
        onChange(next)
      }
      const finish = (): void => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', finish)
        window.removeEventListener('pointercancel', finish)
        target.style.cursor = ''
        document.body.style.cursor = ''
        if (!dragging) return
        document.body.style.userSelect = ''
        useProjectStore.getState().endTransaction()
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', finish)
      window.addEventListener('pointercancel', finish)
    }
  }
}

export interface NumberFieldProps {
  label: string
  value: number
  onChange: (value: number) => void
  step?: number
  min?: number
  max?: number
  precision?: number
  disabled?: boolean
  suffix?: string
}

/** 数值输入：失焦或回车提交，支持上下键微调 */
export function NumberField({
  label,
  value,
  onChange,
  step = 1,
  min,
  max,
  precision = 3,
  disabled,
  suffix
}: NumberFieldProps) {
  const [text, setText] = useState(format(value, precision))
  const editing = useRef(false)

  useEffect(() => {
    if (!editing.current) setText(format(value, precision))
  }, [value, precision])

  const commit = (raw: string): void => {
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) {
      setText(format(value, precision))
      return
    }
    let next = parsed
    if (min !== undefined) next = Math.max(min, next)
    if (max !== undefined) next = Math.min(max, next)
    onChange(next)
    setText(format(next, precision))
  }

  // 中键左右拖动调值：步长与字段的 step 一致（与上下键微调同步）
  const scrub = useScrubDrag(value, (next) => commit(String(next)), {
    enabled: !disabled,
    min,
    max,
    step
  })

  return (
    <label className="flex items-center gap-1.5">
      <span className="hao-label w-[52px] shrink-0">{label}</span>
      <input
        className="hao-field font-mono"
        type="text"
        inputMode="decimal"
        disabled={disabled}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onFocus={() => {
          editing.current = true
        }}
        onBlur={(e) => {
          editing.current = false
          commit(e.target.value)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit((e.target as HTMLInputElement).value)
            ;(e.target as HTMLInputElement).blur()
          } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault()
            const delta = (e.key === 'ArrowUp' ? step : -step) * (e.shiftKey ? 10 : 1)
            commit(String(value + delta))
          }
        }}
        {...scrub}
      />
      {suffix ? <span className="text-3xs text-content-lo">{suffix}</span> : null}
    </label>
  )
}

export function format(value: number, precision = 3): string {
  if (!Number.isFinite(value)) return '0'
  const rounded = Number(value.toFixed(precision))
  return String(rounded)
}

export interface SliderFieldProps {
  label: string
  /**
   * 写值。`silent = true` 是**拖动中**的高频写入，要走不记历史的 `updateSilent`
   * （事务由控件按下 / 松开时开关，整段拖动只留一条撤销记录）；
   * `silent = false` 是键盘微调 / 数字框提交这类一次性写入，按普通可撤销编辑写。
   */
  onChange: (value: number, silent: boolean) => void
  min?: number
  max?: number
  step?: number
  precision?: number
  disabled?: boolean
  /** 拖动事务的撤销记录名（一次拖动 = 一条记录） */
  transaction?: string
  /** 悬停提示 */
  hint?: string
  /** 右侧数字读数（可直接输入精确值）；不要读数就传 false */
  showValue?: boolean
}

/**
 * 滑杆 + 数字读数（0..1 的混合 / 权重这类参数）。
 *
 * 拖动是高频写入：按下时开事务、松开时收尾，中途走调用方的 `silent` 分支 ——
 * 直接一路 `update` 的话每移动一像素就是一条撤销记录，撤销得按几十下才退回去。
 * 键盘方向键与数字框提交不属于拖动，按普通可撤销编辑写入。
 */
export function SliderField({
  label,
  value,
  onChange,
  min = 0,
  max = 1,
  step = 0.05,
  precision = 3,
  disabled,
  transaction = '调整数值',
  hint,
  showValue = true
}: SliderFieldProps) {
  /** 是否处在拖动中：只有拖动期间才把写入降级成 silent（键盘调值没有按下 / 松开的配对） */
  const dragging = useRef(false)
  const digits = digitsForStep(step)
  const clamp = (next: number): number => Math.min(max, Math.max(min, next))
  /** range 的原生步进会带出 0.30000000000000004 这类浮点噪声，按步长取整 */
  const quantize = (next: number): number => clamp(Number(next.toFixed(digits)))

  const beginDrag = (): void => {
    if (disabled) return
    dragging.current = true
    useProjectStore.getState().beginTransaction(transaction)
  }

  const finishDrag = (): void => {
    if (!dragging.current) return
    dragging.current = false
    useProjectStore.getState().endTransaction()
  }

  return (
    <label className="flex items-center gap-1.5" title={hint}>
      <span className="hao-label w-[52px] shrink-0">{label}</span>
      <input
        type="range"
        className="h-[14px] min-w-0 flex-1 cursor-pointer accent-accent disabled:cursor-not-allowed disabled:opacity-40"
        min={min}
        max={max}
        step={step}
        value={clamp(value)}
        disabled={disabled}
        onPointerDown={beginDrag}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onChange={(event) => onChange(quantize(Number(event.target.value)), dragging.current)}
      />
      {showValue ? (
        <CommitTextField
          className="hao-field h-[20px] w-[46px] shrink-0 text-right font-mono text-3xs"
          value={format(value, precision)}
          disabled={disabled}
          inputMode="decimal"
          scrub
          title="失焦 / 回车生效；中键左右拖动可调"
          sanitize={(raw) => {
            const next = Number(raw)
            return Number.isFinite(next) ? format(quantize(next), precision) : null
          }}
          onCommit={(next) => onChange(quantize(Number(next)), false)}
        />
      ) : null}
    </label>
  )
}

export interface Vector2FieldProps {
  label: string
  value: { x: number; y: number }
  onChange: (value: { x: number; y: number }) => void
  step?: number
}

/**
 * 数值输入框（无标签）：**编辑期间保留用户输入的原文**，失焦 / 回车才解析提交。
 *
 * 不能边打字边解析回写：输入 `1.` 时 `Number('1.')` 就是 1，值没变 → React 把输入框
 * 重新渲染成 `1`，小数点当场被吃掉（小数根本打不进去）。留原文再提交就没这个问题。
 */
function VectorInput({
  value,
  onCommit,
  step = 1
}: {
  value: number
  onCommit: (next: number) => void
  step?: number
}) {
  const [text, setText] = useState(format(value))
  const editing = useRef(false)

  // 外部改动（拖拽、撤销、选中别的对象）时同步显示；编辑期间不覆盖用户输入
  useEffect(() => {
    if (!editing.current) setText(format(value))
  }, [value])

  const commit = (raw: string): void => {
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) {
      setText(format(value))
      return
    }
    onCommit(parsed)
    setText(format(parsed))
  }

  // 中键左右拖动调值：步长与字段的 step 一致（与上下键微调同步）
  const scrub = useScrubDrag(
    value,
    (next) => {
      onCommit(next)
      setText(format(next))
    },
    { step }
  )

  return (
    <input
      className="hao-field font-mono"
      type="text"
      inputMode="decimal"
      value={text}
      onChange={(event) => setText(event.target.value)}
      onFocus={() => {
        editing.current = true
      }}
      onBlur={(event) => {
        editing.current = false
        commit(event.target.value)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          commit((event.target as HTMLInputElement).value)
          ;(event.target as HTMLInputElement).blur()
        } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault()
          const delta = (event.key === 'ArrowUp' ? step : -step) * (event.shiftKey ? 10 : 1)
          commit(String(value + delta))
        }
      }}
      {...scrub}
    />
  )
}

export function Vector2Field({ label, value, onChange, step = 1 }: Vector2FieldProps) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="hao-label w-[52px] shrink-0">{label}</span>
      <VectorInput value={value.x} step={step} onCommit={(x) => onChange({ x, y: value.y })} />
      <VectorInput value={value.y} step={step} onCommit={(y) => onChange({ x: value.x, y })} />
    </div>
  )
}

export interface ColorFieldProps {
  label: string
  value: string
  onChange: (value: string) => void
}

export interface CommitTextFieldProps {
  value: string
  /**
   * 失焦 / 回车时对输入原文做校验，返回要提交的规范化文本；返回 null 视为非法，回退到 value。
   * 不传时原样提交。
   */
  sanitize?: (raw: string) => string | null
  onCommit: (value: string) => void
  className?: string
  title?: string
  placeholder?: string
  disabled?: boolean
  inputMode?: 'none' | 'text' | 'decimal' | 'numeric'
  /** 内容是数值时开启中键左右拖动调值（整数每次 ±1、浮点每次 ±0.1） */
  scrub?: boolean
}

/**
 * 无标签的提交式文本输入：编辑期间只改本地文本，**失焦 / 回车才提交**。
 *
 * 用于「每敲一个字符就提交」会出问题的场合：
 * - 中间态会被写进文档（输入 `90` 时先写成 `9`，时长瞬间变成 9 帧）
 * - 每个字符一条撤销记录，撤销时会退回打字中间态而不是改之前的值
 */
export function CommitTextField({
  value,
  sanitize,
  onCommit,
  className,
  title,
  placeholder,
  disabled,
  inputMode,
  scrub
}: CommitTextFieldProps) {
  const [text, setText] = useState(value)
  const editing = useRef(false)
  const numeric = Number(value)
  // 数值内容才启用中键拖动（颜色这类文本内容不启用）
  const scrubHandlers = useScrubDrag(numeric, (next) => onCommit(String(next)), {
    enabled: !!scrub && Number.isFinite(numeric) && !disabled
  })

  useEffect(() => {
    if (!editing.current) setText(value)
  }, [value])

  const commit = (raw: string): void => {
    const next = sanitize ? sanitize(raw) : raw
    if (next === null) {
      setText(value)
      return
    }
    if (next !== value) onCommit(next)
    setText(next)
  }

  return (
    <input
      className={className}
      type="text"
      inputMode={inputMode}
      title={title}
      placeholder={placeholder}
      disabled={disabled}
      value={text}
      onChange={(event) => setText(event.target.value)}
      onFocus={() => {
        editing.current = true
      }}
      onBlur={(event) => {
        editing.current = false
        commit(event.target.value)
      }}
      onKeyDown={(event) => {
        const input = event.target as HTMLInputElement
        if (event.key === 'Enter') {
          commit(input.value)
          input.blur()
        } else if (event.key === 'Escape') {
          setText(value)
          input.blur()
        }
      }}
      {...scrubHandlers}
    />
  )
}

/** 十六进制颜色：#RGB / #RRGGBB / 可带两位 alpha */
function parseHexColor(raw: string): string | null {
  const digits = raw.trim().replace(/^#/, '')
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(digits)) return null
  return `#${digits.toUpperCase()}`
}

export function ColorField({ label, value, onChange }: ColorFieldProps) {
  const rgb = value.length === 9 ? value.slice(0, 7) : value
  return (
    <label className="flex items-center gap-1.5">
      <span className="hao-label w-[52px] shrink-0">{label}</span>
      <input
        type="color"
        className="h-[22px] w-[30px] cursor-pointer rounded border border-line bg-ink-900 p-0"
        value={rgb.startsWith('#') ? rgb : '#ffffff'}
        onChange={(e) => {
          const alpha = value.length === 9 ? value.slice(7) : 'FF'
          onChange(`${e.target.value.toUpperCase()}${alpha}`)
        }}
      />
      <CommitTextField
        className="hao-field font-mono uppercase"
        value={value}
        sanitize={parseHexColor}
        onCommit={onChange}
      />
    </label>
  )
}

export interface ToggleFieldProps {
  label: string
  value: boolean
  onChange: (value: boolean) => void
  disabled?: boolean
  /** 悬停提示；给了也会在开关右侧显示一行说明（与 CheckboxField 一致） */
  hint?: string
}

export function ToggleField({ label, value, onChange, disabled, hint }: ToggleFieldProps) {
  return (
    <div className="flex items-center gap-1.5" title={hint}>
      <span className="hao-label w-[52px] shrink-0">{label}</span>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange(!value)}
        className={[
          'relative h-[16px] w-[30px] rounded-full border transition-colors duration-panel',
          value ? 'border-accent/60 bg-accent/30' : 'border-line bg-ink-900',
          disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'
        ].join(' ')}
      >
        <span
          className={[
            'absolute top-[1px] h-[12px] w-[12px] rounded-full transition-all duration-panel',
            value ? 'left-[15px] bg-accent' : 'left-[1px] bg-content-lo'
          ].join(' ')}
        />
      </button>
      {hint ? <span className="truncate text-3xs text-content-lo">{hint}</span> : null}
    </div>
  )
}

export interface CheckboxFieldProps {
  label: string
  value: boolean
  onChange: (value: boolean) => void
  disabled?: boolean
  /** 悬停提示 */
  hint?: string
}

/** 复选框（原生 checkbox，仅用 accent-color 跟随主题） */
export function CheckboxField({ label, value, onChange, disabled, hint }: CheckboxFieldProps) {
  return (
    <label
      className={[
        'flex items-center gap-1.5',
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'
      ].join(' ')}
      title={hint}
    >
      <span className="hao-label w-[52px] shrink-0">{label}</span>
      <input
        type="checkbox"
        checked={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="h-[13px] w-[13px] shrink-0 cursor-pointer accent-accent disabled:cursor-not-allowed"
      />
      {hint ? <span className="truncate text-3xs text-content-lo">{hint}</span> : null}
    </label>
  )
}

export interface SelectFieldProps {
  label: string
  value: string
  options: Array<{ value: string; label: string }>
  onChange: (value: string) => void
  disabled?: boolean
  /** 选择框右侧的附加控件（例如「定位到目标骨骼」按钮），与选择框同一行 */
  trailing?: React.ReactNode
  /** 接受从层级树拖来的骨骼：拖到选择框上松手时回调骨骼名 */
  onDropBone?: (name: string) => void
}

/**
 * 下拉选择。
 *
 * `onDropBone` 打开「从层级树拖骨骼进来」的落点（目标骨骼 / 受约束骨链这类**选骨骼**的框）：
 * dragover 阶段浏览器只肯暴露 MIME、读不到内容，所以先按 `TREE_MIME` 放行并高亮，
 * 是不是骨骼要等 drop 读 payload 才知道 —— 插槽 / display 拖进来静默忽略。
 */
export function SelectField({
  label,
  value,
  options,
  onChange,
  disabled,
  trailing,
  onDropBone
}: SelectFieldProps) {
  const [boneOver, setBoneOver] = useState(false)

  return (
    <label className="flex items-center gap-1.5">
      <span className="hao-label w-[52px] shrink-0">{label}</span>
      <select
        className={[
          'hao-field cursor-pointer bg-ink-900 disabled:cursor-not-allowed disabled:opacity-40',
          boneOver ? 'ring-1 ring-inset ring-accent/70' : ''
        ].join(' ')}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onDragOver={
          onDropBone
            ? (event) => {
                if (!hasTreeDrag(event.dataTransfer)) return
                // 内部拖拽就地处理：不拦的话会冒泡到视口 / 整窗的兜底处理，松手时可能不派发 drop
                event.preventDefault()
                event.stopPropagation()
                event.dataTransfer.dropEffect = 'move'
                if (!boneOver) setBoneOver(true)
              }
            : undefined
        }
        onDragLeave={onDropBone ? () => setBoneOver(false) : undefined}
        onDrop={
          onDropBone
            ? (event) => {
                setBoneOver(false)
                if (!hasTreeDrag(event.dataTransfer)) return
                event.preventDefault()
                event.stopPropagation()
                const payload = readTreeDrag(event.dataTransfer)
                if (payload?.kind === 'bone') onDropBone(payload.name)
              }
            : undefined
        }
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {trailing}
    </label>
  )
}

export function TextField({
  label,
  value,
  onChange,
  commitOnBlur = false,
  placeholder
}: {
  label: string
  value: string
  onChange: (value: string) => void
  /**
   * true 时在失焦 / 回车才提交：避免每敲一个字符就产生一条撤销记录
   * （编辑事件名、参数这类可写文本用这个模式）
   */
  commitOnBlur?: boolean
  placeholder?: string
}) {
  const [text, setText] = useState(value)
  const editing = useRef(false)

  useEffect(() => {
    if (!editing.current) setText(value)
  }, [value])

  return (
    <label className="flex items-center gap-1.5">
      <span className="hao-label w-[52px] shrink-0">{label}</span>
      <input
        className="hao-field"
        type="text"
        placeholder={placeholder}
        value={commitOnBlur ? text : value}
        onFocus={() => {
          if (commitOnBlur) editing.current = true
        }}
        onChange={(e) => {
          if (!commitOnBlur) {
            onChange(e.target.value)
            return
          }
          editing.current = true
          setText(e.target.value)
        }}
        onBlur={() => {
          if (!commitOnBlur) return
          editing.current = false
          if (text !== value) onChange(text)
        }}
        onKeyDown={(e) => {
          if (commitOnBlur && e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
      />
    </label>
  )
}

/** 检查器分组卡片；`actions` 渲染在标题右侧（内嵌约束分组的删除按钮用） */
export function FieldGroup({
  title,
  actions,
  children
}: {
  title: string
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="border-b border-line/70 px-2 py-2">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <h3 className="hao-panel-title">{title}</h3>
        {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      </div>
      <div className="flex flex-col gap-1.5">{children}</div>
    </section>
  )
}

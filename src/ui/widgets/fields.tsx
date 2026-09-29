import { useEffect, useRef, useState } from 'react'
import { useProjectStore } from '@editor/store/projectStore'

/** 中键拖动调值的步长：整数用 1、浮点用 0.1（按拖动开始时的值判断，拖动期间固定，避免半路变步长） */
function scrubStepFor(value: number): number {
  return Number.isInteger(value) ? 1 : 0.1
}

/**
 * 左键左右拖动调值（DCC 手感）：向左减小、向右增大，每移动 1 像素变化一个步长。
 *
 * - 拖动开始先退出文本编辑态；中键默认的自动滚动会被拦掉
 * - 整段拖动用一条事务包住，只留一条撤销记录（否则每像素一条，撤销会疯掉）
 */
function useScrubDrag(
  value: number,
  onChange: (next: number) => void,
  options?: { enabled?: boolean; min?: number; max?: number }
): { onPointerDown: (event: React.PointerEvent<HTMLInputElement>) => void } {
  const enabled = options?.enabled ?? true
  return {
    onPointerDown: (event: React.PointerEvent<HTMLInputElement>) => {
      if (!enabled || event.button !== 0) return
      event.preventDefault()
      const target = event.currentTarget
      target.blur()
      const startX = event.clientX
      const start = value
      const step = scrubStepFor(start)
      const digits = step < 1 ? 1 : 0
      const clamp = (next: number): number => {
        let out = next
        if (options?.min !== undefined) out = Math.max(options.min, out)
        if (options?.max !== undefined) out = Math.min(options.max, out)
        return out
      }
      useProjectStore.getState().beginTransaction('调整数值')
      let last = start
      const move = (ev: PointerEvent): void => {
        const next = clamp(Number((start + (ev.clientX - startX) * step).toFixed(digits)))
        if (next === last) return
        last = next
        onChange(next)
      }
      const finish = (): void => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', finish)
        useProjectStore.getState().endTransaction()
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', finish)
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

  // 中键左右拖动调值：整数每次 ±1、浮点每次 ±0.1
  const scrub = useScrubDrag(value, (next) => commit(String(next)), {
    enabled: !disabled,
    min,
    max
  })

  return (
    <label className="flex items-center gap-1.5">
      <span className="hao-label w-[52px] shrink-0">{label}</span>
      <input
        className="hao-field cursor-ew-resize font-mono"
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

  // 中键左右拖动调值：整数每次 ±1、浮点每次 ±0.1
  const scrub = useScrubDrag(value, (next) => {
    onCommit(next)
    setText(format(next))
  })

  return (
    <input
      className="hao-field cursor-ew-resize font-mono"
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
      className={scrub ? `${className ?? ''} cursor-ew-resize` : className}
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
}

export function ToggleField({ label, value, onChange, disabled }: ToggleFieldProps) {
  return (
    <div className="flex items-center gap-1.5">
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
}

export function SelectField({ label, value, options, onChange }: SelectFieldProps) {
  return (
    <label className="flex items-center gap-1.5">
      <span className="hao-label w-[52px] shrink-0">{label}</span>
      <select
        className="hao-field cursor-pointer bg-ink-900"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
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

/** 检查器分组卡片 */
export function FieldGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-line/70 px-2 py-2">
      <h3 className="hao-panel-title mb-1.5">{title}</h3>
      <div className="flex flex-col gap-1.5">{children}</div>
    </section>
  )
}

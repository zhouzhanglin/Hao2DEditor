import { useEffect, useRef, useState } from 'react'

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

export function Vector2Field({ label, value, onChange, step = 1 }: Vector2FieldProps) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="hao-label w-[52px] shrink-0">{label}</span>
      <input
        className="hao-field font-mono"
        type="text"
        inputMode="decimal"
        value={format(value.x)}
        onChange={(e) => {
          const parsed = Number(e.target.value)
          if (Number.isFinite(parsed)) onChange({ x: parsed, y: value.y })
        }}
      />
      <input
        className="hao-field font-mono"
        type="text"
        inputMode="decimal"
        value={format(value.y)}
        onChange={(e) => {
          const parsed = Number(e.target.value)
          if (Number.isFinite(parsed)) onChange({ x: value.x, y: parsed })
        }}
      />
      <span className="sr-only">{step}</span>
    </div>
  )
}

export interface ColorFieldProps {
  label: string
  value: string
  onChange: (value: string) => void
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
      <input
        className="hao-field font-mono uppercase"
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
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

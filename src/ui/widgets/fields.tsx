import { useEffect, useRef, useState, type ReactNode } from 'react'
import { PPU } from '@editor/commands/authoringCommands'
import { useProjectStore } from '@editor/store/projectStore'
import { hasTreeDrag, readTreeDrag } from './dragDrop'
import { t } from '@i18n'

/**
 * 世界单位 → 像素的显示换算系数。
 *
 * 内部数据（工程文件 / 导出 Spine / `.hao2d` / 运行时包）一律用**世界单位**存长度
 * （1 单位 = PPU 像素）；该系数只服务界面，让长度类数值按美术稿的像素口径显示与输入，
 * 不改变任何存储值与导出结果。
 */
export const PX_PER_UNIT = PPU

/** 世界单位 → 像素（仅用于界面显示；换算不改动数据本身） */
export function unitsToPx(units: number): number {
  return units * PX_PER_UNIT
}

/** `requestAnimationFrame` 的兜底（测试 / 无 DOM 环境退化成 16ms 定时器） */
function nextFrame(fn: () => void): number {
  return typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : (setTimeout(fn, 16) as unknown as number)
}

function cancelFrame(id: number): void {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id)
  else clearTimeout(id)
}

/**
 * 连续拖动的**帧级合并**：把高频写入压成「每帧最多一次」，且最后一次一定落地。
 *
 * 原生拾色器 / 滑杆一次拖动能连发几十上百个 `input`（拾色器最凶，一秒上百个），
 * 而每次写入的代价远不止一帧：深拷贝整份文档 + 换掉文档对象 → 视口按 `needsRebuild`
 * 重建整个运行期 + 所有订阅 `document` 的面板（时间轴 / 层级树 / 检查器…）全部重渲染。
 * 于是事件越堆越多、写入永远追不上手 —— 表现就是「拖颜色越来越卡、颜色半天不跟手」。
 *
 * 这里只留最新值：`push` 只写一个 ref（几乎零成本），真正的写入交给 `rAF`。
 * `rAF` 只会在主线程空下来时才轮到，所以队列不会积压 —— 卡也就只卡在「一帧一次」上，
 * 而不是「几百个事件排队」。
 *
 * 用法：拖动中的每个事件 `push(最新值)`，收尾（关事务前）`flush()` ——
 * **必须先 flush 再关事务**，否则最后那个值会落在事务之外，多出一条撤销记录。
 */
export function createFrameWriter<T>(write: (value: T) => void): {
  push: (value: T) => void
  flush: () => void
} {
  // 包一层对象：值本身可能是 0 或空串，不能用假值判断「有没有待写」
  let pending: { value: T } | null = null
  let frame = 0
  const land = (): void => {
    frame = 0
    if (!pending) return
    const value = pending.value
    pending = null
    write(value)
  }
  return {
    push: (value) => {
      pending = { value }
      if (!frame) frame = nextFrame(land)
    },
    flush: () => {
      if (frame) cancelFrame(frame)
      land()
    }
  }
}

/** `createDragWriter` 的返回值：连续编辑的三个动作 */
export interface DragWriter<T> {
  /** 拖动中的每个事件（内部按帧合并），只在主线程空下来时落地 */
  push: (value: T) => void
  /** 立刻把待写的值落地（不改提交语义） */
  flush: () => void
  /** 收尾：先落地最后一个值；走预览通道时再把它**提交**进主 store */
  settle: () => void
}

/**
 * 「拖动中只做预览、松手提交一次」的写入器 —— 连续编辑（拾色器 / 滑杆）的推荐用法。
 *
 * 拖动中的每个事件只付 `createFrameWriter` 的代价（每帧最多一次），而且写的是**预览通道**
 * （`preview` 非空时）：主 store 一动不动 —— 于是不再每帧深拷贝整份文档、不再重建视口运行期、
 * 也不会让订阅 `document` 的面板（时间轴 / 层级树 / 检查器…）整棵重渲染。视口自己订阅预览通道
 * 按帧热更新（见 `@editor/store/previewStore`）。
 *
 * `settle()` 是收尾：先把最后一个预览值落地，再把它提交进主 store（一次 `commit`，
 * 因此只留一条撤销记录）。`preview` 返回空（没传 `onPreview`）时退回老行为：拖动中每帧走 `commit`。
 *
 * 为什么 `preview` 是**函数**而不是值：调用方（如 `ColorField`）的 props 每帧都可能换，
 * 用 `latest.current` 取当下的那个才不会写到过期的回调上。
 */
export function createDragWriter<T>(
  preview: () => ((value: T) => void) | null,
  commit: (value: T) => void
): DragWriter<T> {
  let last: { value: T } | null = null
  /** 这一次拖动是否真的走过预览通道：决定收尾要不要补一次提交 */
  let previewed = false
  const frame = createFrameWriter<T>((value) => {
    const write = preview()
    if (!write) {
      commit(value)
      return
    }
    previewed = true
    write(value)
  })
  return {
    push: (value) => {
      last = { value }
      frame.push(value)
    },
    flush: () => frame.flush(),
    settle: () => {
      frame.flush()
      // 预览值只是画面上的临时值，必须真的落进文档，否则松手后颜色会退回去
      if (previewed && last) commit(last.value)
      last = null
      previewed = false
    }
  }
}

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
          useProjectStore.getState().beginTransaction(t('调整数值'))
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
  /**
   * 显示换算（默认 1 = 不换算）：显示值 = `value × unitScale`，提交值 ÷ `unitScale` 写回。
   * `step / min / max / precision` 一律按**显示空间**解释。
   * 长度类字段传 `PX_PER_UNIT` 即按像素显示（输入 200 写回 2 个世界单位）。
   */
  unitScale?: number
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
  unitScale = 1,
  step = 1,
  min,
  max,
  precision = 3,
  disabled,
  suffix
}: NumberFieldProps) {
  // 显示空间 = 内部值 × unitScale；输入 / 拖动 / 上下键都在显示空间走，提交时除回去
  const scale = unitScale > 0 ? unitScale : 1
  const shown = value * scale
  const [text, setText] = useState(format(shown, precision))
  const editing = useRef(false)

  useEffect(() => {
    if (!editing.current) setText(format(shown, precision))
  }, [shown, precision])

  const commit = (raw: string): void => {
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) {
      setText(format(shown, precision))
      return
    }
    let next = parsed
    if (min !== undefined) next = Math.max(min, next)
    if (max !== undefined) next = Math.min(max, next)
    onChange(next / scale)
    setText(format(next, precision))
  }

  // 中键左右拖动调值：显示值是整数时按 1 步进（整数字段的手感），否则用字段声明的 step。
  // 显示空间里看到的是整数（如长度 200 / 缩放 1.0），就该一格一格走，别被分数 step 拖成 0.05 这种细碎增量。
  const scrubStep = Number.isInteger(shown) ? 1 : step
  const scrub = useScrubDrag(shown, (next) => commit(String(next)), {
    enabled: !disabled,
    min,
    max,
    step: scrubStep
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
            commit(String(shown + delta))
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
   * 当前值（滑杆与读数框都以它为准）。
   *
   * 之前漏了这条声明：组件里 destructure 了 `value`，类型上却没有这个字段 ——
   * `tsc` 一直在报「Property 'value' does not exist on type 'SliderFieldProps'」，
   * 调用方把值传错也检查不出来。
   */
  value: number
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
  transaction = t('调整数值'),
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
          title={t('失焦 / 回车生效；中键左右拖动可调')}
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
  /** 显示换算（语义同 `NumberFieldProps.unitScale`），x / y 用同一系数；长度类字段传 `PX_PER_UNIT` */
  unitScale?: number
  step?: number
  /** 行尾的小动作按钮（如「恢复到图片大小」）；不传就不渲染 */
  action?: ReactNode
}

/**
 * 数值输入框（无标签）：**编辑期间保留用户输入的原文**，失焦 / 回车才解析提交。
 *
 * 不能边打字边解析回写：输入 `1.` 时 `Number('1.')` 就是 1，值没变 → React 把输入框
 * 重新渲染成 `1`，小数点当场被吃掉（小数根本打不进去）。留原文再提交就没这个问题。
 *
 * 导出给视口左下角的「属性打帧条」用：那里一个图标旁边就是一两个这样的小框
 * （宽度由调用方在外层包裹元素上控制 —— 输入框自己是 `hao-field` 的 `w-full`）。
 */
export function VectorInput({
  value,
  onCommit,
  unitScale = 1,
  step = 1
}: {
  value: number
  onCommit: (next: number) => void
  unitScale?: number
  step?: number
}) {
  // 显示空间 = 内部值 × unitScale（与 NumberField 同口径）：显示 / 输入 / 拖动都在显示空间走
  const scale = unitScale > 0 ? unitScale : 1
  const shown = value * scale
  const [text, setText] = useState(format(shown))
  const editing = useRef(false)

  // 外部改动（拖拽、撤销、选中别的对象）时同步显示；编辑期间不覆盖用户输入
  useEffect(() => {
    if (!editing.current) setText(format(shown))
  }, [shown])

  const commit = (raw: string): void => {
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) {
      setText(format(shown))
      return
    }
    onCommit(parsed / scale)
    setText(format(parsed))
  }

  // 中键左右拖动调值：显示值是整数时按 1 步进（与 NumberField 同口径）
  const scrubStep = Number.isInteger(shown) ? 1 : step
  const scrub = useScrubDrag(
    shown,
    (next) => {
      onCommit(next / scale)
      setText(format(next))
    },
    { step: scrubStep }
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
          commit(String(shown + delta))
        }
      }}
      {...scrub}
    />
  )
}

export function Vector2Field({ label, value, onChange, unitScale, step = 1, action }: Vector2FieldProps) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="hao-label w-[52px] shrink-0">{label}</span>
      <VectorInput value={value.x} unitScale={unitScale} step={step} onCommit={(x) => onChange({ x, y: value.y })} />
      <VectorInput value={value.y} unitScale={unitScale} step={step} onCommit={(y) => onChange({ x: value.x, y })} />
      {action}
    </div>
  )
}

export interface ColorFieldProps {
  label: string
  value: string
  onChange: (value: string) => void
  /**
   * 拖动中的**预览**（可选）。给了它就**不再每帧写主 store**：拾色器 / 透明度滑杆的
   * 高频事件（帧级合并后每帧一次）只调它，由调用方转给预览通道 ——
   * 视口按帧热更新颜色，而文档 / 历史 / 面板一动不动；松手时才用最终值走一次 `onChange`
   * （一次提交 = 一条撤销记录）。
   *
   * 不传 = 老行为：拖动中每帧写主 store（每帧深拷贝文档 + 重建运行期 + 全 UI 重渲染）。
   * 典型用法：`onPreview={(hex) => usePreviewStore.getState().setSlotColor(slot, hex)}`。
   */
  onPreview?: (value: string) => void
  /**
   * 连续拖拽（拾色器打开 → 关闭）的开始 / 结束回调。
   *
   * 传了就把这段拖拽包成**单条撤销记录**：拖动期间每帧都实时 `onChange`（实时预览），
   * 但只在 `onDragStart` 记一次「修改前」快照、`onDragEnd` 收尾，避免每帧都往撤销栈
   * 塞一条等价记录，也消掉每帧「整个项目快照深拷贝」的卡顿。
   * 典型传 `useProjectStore.getState().beginTransaction(label)` / `endTransaction()`。
   * 不传（如只改场景染色这类不进文档的值）就每帧直接提交。
   */
  onDragStart?: () => void
  onDragEnd?: () => void
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

/** 十六进制颜色：#RGB / #RRGGBB / 可带两位 alpha（拾色器弹层也用它校验 hex 输入） */
export function parseHexColor(raw: string): string | null {
  const digits = raw.trim().replace(/^#/, '')
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(digits)) return null
  return `#${digits.toUpperCase()}`
}

export function ColorField({ label, value, onChange, onDragStart, onDragEnd, onPreview }: ColorFieldProps) {
  /**
   * 拾色器拖动期间实时预览：每帧都发 input 事件，直接 `onChange`（实时预览视口 / 色块）。
   * 拖动开始（pointerdown / 首个 input）开事务，结束（拾色器关闭的 `change` / 失焦）收尾，
   * 整段合并成一条撤销记录 —— 与骨骼、权重刷、关键帧的连续编辑是同一套路，既流畅又不污染撤销栈。
   */
  const dragging = useRef(false)
  const latest = useRef({ onChange, onDragStart, onDragEnd, onPreview })
  latest.current = { onChange, onDragStart, onDragEnd, onPreview }
  /**
   * 拾色器 / 透明度滑杆的连续写入走 `createDragWriter`：
   * - 传了 `onPreview`：拖动中只写预览通道（主 store 一动不动 —— 不深拷贝文档、不重建运行期、
   *   不刷面板），松手 `settle()` 才把最终值提交一次；
   * - 没传：老行为 —— 帧级合并后每帧写主 store，整段由 `onDragStart/onDragEnd` 的事务收成一条。
   */
  const writer = useRef<DragWriter<string> | null>(null)
  if (!writer.current) {
    writer.current = createDragWriter<string>(
      () => (latest.current.onPreview ? (hex: string) => latest.current.onPreview?.(hex) : null),
      (hex) => latest.current.onChange(hex)
    )
  }
  const begin = (): void => {
    if (dragging.current) return
    dragging.current = true
    latest.current.onDragStart?.()
  }
  const end = (): void => {
    if (!dragging.current) return
    // settle：先落地最后一个值，再补一次提交 —— 两步都在关事务之前，顺序反了会多出一条撤销记录
    writer.current?.settle()
    dragging.current = false
    latest.current.onDragEnd?.()
  }
  const inputRef = useRef<HTMLInputElement>(null)
  // 原生 `change` 只在拾色器**关闭（确认）**时发一次，用它收尾事务最可靠；
  // `onBlur` 作兜底（如点空白处关闭）；卸载时也收尾，避免事务一直挂着。
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.addEventListener('change', end)
    return () => {
      el.removeEventListener('change', end)
      end()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const rgb = value.length === 9 ? value.slice(0, 7) : value
  /*
   * alpha 通道（#RRGGBBAA 的 AA）：原生 `<input type=color>` 的弹窗只有 RGB + 色相条，
   * **没有 alpha**——而颜色值本身带 alpha 且运行时真的在用（mesh.alpha = color.a），
   * 所以在行内补一条透明度滑杆 + 百分比输入，不用再手动改 hex 的后两位。
   */
  const alpha = value.length === 9 ? parseInt(value.slice(7), 16) / 255 : 1
  /*
   * 拖动中的透明度（0~1）。
   *
   * 传了 `onPreview` 时，拖动期间**不写主 store**（见上面 `createDragWriter` 的说明），
   * 于是 `value` / `alpha` 一动不动 —— 而 range 是受控输入：React 在每个 `change` 事件
   * 末尾都会把 DOM 值「恢复」成最近一次渲染的 props 值（`restoreControlledState`），
   * 拖动中被拨回原处，表现就是「滑杆怎么拖滑块都不动」（颜色本身在视口里是跟手的，
   * 所以更显得像滑杆坏了）。所以拖动期间取值交给本地状态，松手清掉、交回文档真值
   * （`writer.settle()` 已经把最后一个值提交进去了）。
   */
  const [dragAlpha, setDragAlpha] = useState<number | null>(null)
  /** 滑杆与百分比读数显示的值：拖动中跟手，其余时刻跟文档 */
  const shownAlpha = dragAlpha ?? alpha
  /** 透明度百分比 → `#RRGGBBAA`（RGB 取当前值，只换后两位） */
  const hexWithAlpha = (percent: number): string => {
    const clamped = Math.min(100, Math.max(0, percent))
    const byte = Math.round((clamped / 100) * 255)
      .toString(16)
      .padStart(2, '0')
      .toUpperCase()
    return `${rgb}${byte}`
  }
  const setAlphaPercent = (percent: number): void => onChange(hexWithAlpha(percent))
  return (
    <label className="flex items-center gap-1.5">
      <span className="hao-label w-[52px] shrink-0">{label}</span>
      <input
        ref={inputRef}
        type="color"
        className="h-[22px] w-[30px] shrink-0 cursor-pointer rounded border border-line bg-ink-900 p-0"
        value={rgb.startsWith('#') ? rgb : '#ffffff'}
        onBlur={end}
        onChange={(e) => {
          begin()
          const alphaHex = value.length === 9 ? value.slice(7) : 'FF'
          // 拾色器拖动中连发的 input 按帧合并；透明度仍取当前值（拾色器只改 RGB）
          writer.current?.push(`${e.target.value.toUpperCase()}${alphaHex}`)
        }}
      />
      <CommitTextField
        className="hao-field min-w-0 flex-1 font-mono uppercase"
        value={value}
        sanitize={parseHexColor}
        onCommit={(hex) => {
          // 手打 hex 是单次提交：先收尾掉拖动残留的预览（含它自己的提交与状态清理），
          // 再写手打的值 —— 顺序反了会被残留值顶回去
          writer.current?.settle()
          onChange(hex)
        }}
      />
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        className="h-[14px] w-[64px] shrink-0 cursor-pointer accent-accent"
        title={t('透明度（alpha）')}
        value={shownAlpha}
        onPointerDown={begin}
        onPointerUp={() => {
          end()
          setDragAlpha(null)
        }}
        onPointerCancel={() => {
          end()
          setDragAlpha(null)
        }}
        onChange={(event) => {
          begin()
          const next = Number(event.target.value)
          setDragAlpha(next)
          // 滑杆也是连续拖动：按帧合并（`begin` 只开一次事务，整段仍是一条撤销记录）
          writer.current?.push(hexWithAlpha(next * 100))
        }}
      />
      <div className="relative shrink-0">
        <CommitTextField
          className="hao-field w-[46px] pr-4 text-right font-mono text-3xs"
          value={String(Math.round(shownAlpha * 100))}
          inputMode="decimal"
          title={t('透明度百分比（0–100）；失焦 / 回车生效，中键左右拖动可调')}
          scrub
          sanitize={(raw) => {
            const next = Number(raw)
            if (!Number.isFinite(next)) return null
            return String(Math.round(Math.min(100, Math.max(0, next))))
          }}
          onCommit={(raw) => {
            // 手输百分比是单次提交：先收尾掉拖动残留的预览，再写手输的值
            writer.current?.settle()
            setAlphaPercent(Number(raw))
          }}
        />
        <span className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-3xs text-content-lo">
          %
        </span>
      </div>
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

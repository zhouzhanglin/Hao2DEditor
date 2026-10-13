import type { Args } from './registry'

/**
 * 命令参数读取工具。
 *
 * 命令的实参来自 HTTP 请求体（AI 生成的 JSON），什么形状都可能，
 * 所以这里每个函数都「要么拿到合法值、要么抛一句人能看懂的话」——
 * 注册表会把异常折成 `ok:false` 回给 AI，AI 据此自己纠正参数重试。
 *
 * 报错信息里一定写清**期望什么**（「必须是数字」而不是「参数非法」），
 * 因为读这句话的是替你调接口的 AI。
 */

/** 必填空字符串参数 */
export function need(args: Args, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`缺少参数 ${key}（字符串）`)
  return value.trim()
}

/** 可选字符串：空串视为「没给」 */
export function optText(args: Args, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** 保留空串语义的可选字符串（例如「显示的附件名，空串 = 不显示」） */
export function rawText(args: Args, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' ? value.trim() : undefined
}

export function optNum(args: Args, key: string): number | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`参数 ${key} 必须是数字`)
  return value
}

/** 必填数字 */
export function needNum(args: Args, key: string): number {
  const value = optNum(args, key)
  if (value === undefined) throw new Error(`缺少参数 ${key}（数字）`)
  return value
}

export function optBool(args: Args, key: string): boolean | undefined {
  const value = args[key]
  return typeof value === 'boolean' ? value : undefined
}

/** 可选 {x,y} 向量 */
export function optVec(args: Args, key: string): { x: number; y: number } | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`参数 ${key} 必须是 {x,y}`)
  const { x, y } = value as { x?: unknown; y?: unknown }
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`参数 ${key} 的 x / y 必须是数字`)
  }
  return { x, y }
}

/** 可选字符串数组（自动丢掉空串） */
export function optTextList(args: Args, key: string): string[] | undefined {
  return optList(args, key, (item) => (typeof item === 'string' && item.trim() !== '' ? item.trim() : null))
}

/** 可选数字数组 */
export function optNumList(args: Args, key: string): number[] | undefined {
  return optList(args, key, (item) => (typeof item === 'number' && Number.isFinite(item) ? item : null))
}

function optList<T>(args: Args, key: string, pick: (item: unknown) => T | null): T[] | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new Error(`参数 ${key} 必须是数组`)
  const result: T[] = []
  for (const item of value) {
    const picked = pick(item)
    if (picked === null) throw new Error(`参数 ${key} 里有不合法的一项：${JSON.stringify(item)}`)
    result.push(picked)
  }
  return result
}

/** 丢掉值为 undefined 的字段：纯函数靠「有没有这个 key」判断该不该改 */
export function compact<T extends object>(source: T): T {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) result[key] = value
  }
  return result as T
}

/** 枚举校验：值不在名单里就报错，并把合法取值写进错误里，省得 AI 再猜一次 */
export function needOneOf<T extends string>(args: Args, key: string, allowed: readonly T[]): T {
  const value = need(args, key)
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`参数 ${key} 只能是 ${allowed.join(' / ')}，收到 ${value}`)
  }
  return value as T
}

/** 一个可选字段都没给：不当成一次编辑，免得白记一条撤销 */
export function requireSomeField(fields: readonly string[]): void {
  if (fields.length === 0) throw new Error('至少要给一个要改的字段')
}

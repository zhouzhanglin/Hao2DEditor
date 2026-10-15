import { useSyncExternalStore } from 'react'
import { en } from './locales/en'
import { zhCN } from './locales/zh-CN'

/**
 * 轻量 i18n 核心。
 *
 * 设计取舍：**用中文原文当 key**。
 * 项目原本就是全中文文案，直接以中文原文作为词条 key，好处是：
 * - 改造是「增量安全」的 —— 没接 `t()` 的文案在英文下原样显示中文，不会崩；
 * - 简中词典天然为空（`t('打开')` → `'打开'`），只需要维护「中文 → 英文」一份映射；
 * - 翻译文件一眼能看懂对应关系，方便用 scripts/extract-i18n.mjs 继续补齐。
 *
 * 用法：
 *   - 组件里：`const t = useT()` 后 `t('打开')`；
 *   - 组件外（命令 / 服务层）：直接 `import { t } from '@i18n'`，`t()` 读当前语言快照。
 *
 * 注意：`t()` 是**非响应式**的普通函数 —— 它读模块级当前语言，不会自己触发重渲染。
 * 切换语言时由 App 根组件订阅 `useLocale()` 后整体重渲染，从而让所有 `t()` 重新求值。
 */

export type Locale = 'zh-CN' | 'en'

/** 支持的语言列表（设置界面用它渲染下拉） */
export const LOCALES: ReadonlyArray<{ id: Locale; label: string }> = [
  { id: 'zh-CN', label: '简体中文' },
  { id: 'en', label: 'English' }
]

/** 持久化 key（localStorage）；与工程无关，跨工程保留 */
const STORAGE_KEY = 'hao2d:locale'

/** 各语言的词条表。简中为恒等映射（key 即原文），英文为「中文 → 英文」 */
const DICTIONARIES: Record<Locale, Record<string, string>> = {
  'zh-CN': zhCN,
  en
}

function isLocale(value: unknown): value is Locale {
  return value === 'zh-CN' || value === 'en'
}

/**
 * 把系统语言标签（`zh-CN` / `zh-Hans-CN` / `en-US` / `ja-JP` …）归一成受支持的语言。
 * 目前只分「中文 / 其它」两类：以 `zh` 开头走简中，其余一律英文。
 */
export function normalizeLocale(tag: string | undefined | null): Locale {
  if (!tag) return 'zh-CN'
  return tag.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
}

/** 读取操作系统 / 运行时的语言标签（Electron 渲染进程里等于 app locale，默认即系统语言） */
export function systemLocaleTag(): string | undefined {
  if (typeof navigator !== 'undefined' && navigator.language) return navigator.language
  return undefined
}

/**
 * 首次启动选语言：
 * 1. 本地存过用户选择 → 用它（用户手动选过就不再被系统语言覆盖）；
 * 2. 没存过 → 按系统语言判断（中文系统给简中，其余给英文）。
 *
 * `systemTag` 允许调用方传入更准确的语言标签（例如主进程 `app.getLocale()`），
 * 不传则退回 `navigator.language`。
 */
export function resolveInitialLocale(systemTag?: string): Locale {
  if (typeof localStorage !== 'undefined') {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (isLocale(saved)) return saved
  }
  return normalizeLocale(systemTag ?? systemLocaleTag())
}

/** 是否已存过用户的显式选择（用于「跟随系统」这类扩展，目前设置界面直接写死语言） */
export function hasStoredLocale(): boolean {
  if (typeof localStorage === 'undefined') return false
  return isLocale(localStorage.getItem(STORAGE_KEY))
}

let current: Locale = resolveInitialLocale()

const listeners = new Set<() => void>()

export function getLocale(): Locale {
  return current
}

/** 切换语言：写 localStorage → 通知订阅者 → 同步 <html lang> */
export function setLocale(next: Locale): void {
  if (next === current) return
  current = next
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // 隐私模式 / 配额满：忽略持久化，本次会话内仍然生效
    }
  }
  applyDocumentLang()
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** `useLocale()` 订阅当前语言；切换时触发重渲染 */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, getLocale, getLocale)
}

/** 组件里取翻译函数；返回的是稳定引用，可直接放进依赖数组 */
export function useT(): typeof t {
  return t
}

/** 插值参数：命名对象，或位置参数（数组 / 单个原始值，对应 `{0}`） */
export type TParams =
  | Record<string, unknown>
  | readonly unknown[]
  | string
  | number
  | boolean

/**
 * 取词条并做插值。
 * - 位置参数：`t('已复制 {0} 项', 3)` 或 `t('{0} → {1}', [a, b])`
 * - 命名参数：`t('已切换到骨架「{name}」', { name })`
 */
export function t(key: string, params?: TParams): string {
  const text = DICTIONARIES[current][key] ?? key
  if (params === undefined) return text
  return interpolate(text, params)
}

function interpolate(text: string, params: TParams): string {
  // 命名参数：传的是普通对象（非数组）
  if (params !== null && typeof params === 'object' && !Array.isArray(params)) {
    const map = params as Record<string, unknown>
    return text.replace(/\{(\w+)\}/g, (match, name: string) => {
      const value = map[name]
      return value === undefined ? match : String(value)
    })
  }
  // 位置参数：数组或单个原始值
  const list = Array.isArray(params) ? params : [params]
  return text.replace(/\{(\d+)\}/g, (match, index: string) => {
    const value = list[Number(index)]
    return value === undefined ? match : String(value)
  })
}

/** 把当前语言写进 <html lang>（便于字体 / 断行等按语言适配） */
export function applyDocumentLang(): void {
  if (typeof document !== 'undefined') document.documentElement.lang = current
}

/**
 * 应用启动时调用一次：写入初始语言（首次启动已按系统语言判定），
 * 同步 <html lang>，并返回最终语言供主进程对齐菜单。
 */
export function initI18n(systemTag?: string): Locale {
  current = resolveInitialLocale(systemTag)
  applyDocumentLang()
  return current
}

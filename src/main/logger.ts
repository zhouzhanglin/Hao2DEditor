/**
 * 轻量 logger：按级别输出，只打摘要，不打印整份资源内容。
 * 主进程、worker、preload 共用。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

let threshold: LogLevel = process.env.HAO2D_LOG ? (process.env.HAO2D_LOG as LogLevel) : 'info'

export function setLogLevel(level: LogLevel): void {
  threshold = level
}

function emit(level: LogLevel, scope: string, message: string, extra?: unknown): void {
  if (ORDER[level] < ORDER[threshold]) return
  const line = `[hao2d:${scope}] ${message}`
  if (level === 'error') console.error(line, extra ?? '')
  else if (level === 'warn') console.warn(line, extra ?? '')
  else console.log(line, extra ?? '')
}

export interface Logger {
  debug(message: string, extra?: unknown): void
  info(message: string, extra?: unknown): void
  warn(message: string, extra?: unknown): void
  error(message: string, extra?: unknown): void
  /** 记录耗时摘要 */
  time(label: string, ms: number, summary?: string): void
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, e) => emit('debug', scope, m, e),
    info: (m, e) => emit('info', scope, m, e),
    warn: (m, e) => emit('warn', scope, m, e),
    error: (m, e) => emit('error', scope, m, e),
    time: (label, ms, summary) =>
      emit('info', scope, `${label} 用时 ${ms.toFixed(1)}ms${summary ? ` · ${summary}` : ''}`)
  }
}

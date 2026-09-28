import type { RGBA } from '../model/types'

/** 0..1 浮点颜色 ↔ #RRGGBBAA 十六进制字符串（编辑期可读性优先） */
export function rgbaToHex(color: RGBA): string {
  const to = (v: number): string => {
    const byte = Math.round(Math.max(0, Math.min(1, v)) * 255)
    return byte.toString(16).padStart(2, '0').toUpperCase()
  }
  return `#${to(color.r)}${to(color.g)}${to(color.b)}${to(color.a)}`
}

export function hexToRgba(hex: string, fallback?: RGBA): RGBA {
  const base = fallback ?? { r: 1, g: 1, b: 1, a: 1 }
  if (typeof hex !== 'string') return { ...base }
  let text = hex.trim()
  if (text.startsWith('#')) text = text.slice(1)
  if (text.length === 3) {
    text = `${text[0]}${text[0]}${text[1]}${text[1]}${text[2]}${text[2]}ff`
  } else if (text.length === 4) {
    text = `${text[0]}${text[0]}${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}`
  } else if (text.length === 6) {
    text = `${text}ff`
  }
  if (text.length !== 8 || !/^[0-9a-fA-F]{8}$/.test(text)) return { ...base }

  const value = (offset: number): number => parseInt(text.slice(offset, offset + 2), 16) / 255
  return { r: value(0), g: value(2), b: value(4), a: value(6) }
}

/** 用于编辑器 UI：把 0..1 颜色转成 CSS 颜色（忽略 alpha） */
export function rgbaToCss(color: RGBA): string {
  const to = (v: number): number => Math.round(Math.max(0, Math.min(1, v)) * 255)
  return `rgb(${to(color.r)}, ${to(color.g)}, ${to(color.b)})`
}

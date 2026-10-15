import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  LOCALES,
  getLocale,
  normalizeLocale,
  resolveInitialLocale,
  setLocale,
  t
} from '../src/i18n'

describe('i18n 语言判定', () => {
  const original = getLocale()

  beforeEach(() => setLocale('zh-CN'))
  afterEach(() => setLocale(original))

  it('受支持的语言就两种：简中 + 英文', () => {
    expect(LOCALES.map((item) => item.id)).toEqual(['zh-CN', 'en'])
  })

  it('系统语言标签归一：zh* → 简中，其余 → 英文，缺省 → 简中', () => {
    expect(normalizeLocale('zh')).toBe('zh-CN')
    expect(normalizeLocale('zh-CN')).toBe('zh-CN')
    expect(normalizeLocale('zh-Hans-CN')).toBe('zh-CN')
    expect(normalizeLocale('zh-TW')).toBe('zh-CN')
    expect(normalizeLocale('en-US')).toBe('en')
    expect(normalizeLocale('ja-JP')).toBe('en')
    expect(normalizeLocale('')).toBe('zh-CN')
    expect(normalizeLocale(undefined)).toBe('zh-CN')
  })

  it('首次启动（无本地存档）按系统语言选：中文系统 → 简中，其它 → 英文', () => {
    expect(resolveInitialLocale('en-US')).toBe('en')
    expect(resolveInitialLocale('ja-JP')).toBe('en')
    expect(resolveInitialLocale('zh-CN')).toBe('zh-CN')
    expect(resolveInitialLocale('zh-Hant-TW')).toBe('zh-CN')
  })
})

describe('i18n 取词与插值', () => {
  const original = getLocale()
  afterEach(() => setLocale(original))

  it('简中：中文原文即 key，直接返回原文', () => {
    setLocale('zh-CN')
    expect(t('层级结构')).toBe('层级结构')
    expect(t('这个 key 不存在')).toBe('这个 key 不存在')
  })

  it('英文：命中词典则返回译文，未命中回退中文', () => {
    setLocale('en')
    expect(t('层级结构')).toBe('Hierarchy')
    // 未翻译的 key 原样回退，不会变成 undefined
    expect(t('这个 key 不存在')).toBe('这个 key 不存在')
  })

  it('位置参数插值：{0} / {1}', () => {
    setLocale('en')
    expect(t('已复制 {0} 项', 3)).toBe('Copied 3 item(s)')
    expect(t('已删除「{0}」的顶点 #{1}', ['帽子', 5])).toBe('Deleted vertex #5 of "帽子"')
  })

  it('命名参数插值：{name}', () => {
    setLocale('zh-CN')
    expect(t('已切换到骨架「{0}」', '身体')).toBe('已切换到骨架「身体」')
  })

  it('缺参数时占位符原样保留（不吞掉花括号字面量，如 {名称}）', () => {
    setLocale('zh-CN')
    expect(t('导出 {名称}_ske.json')).toBe('导出 {名称}_ske.json')
  })
})

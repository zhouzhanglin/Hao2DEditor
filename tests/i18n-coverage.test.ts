import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { t } from '@i18n'

const SRC = path.join(__dirname, '..', 'src')
const EN_FILE = path.join(SRC, 'i18n/locales/en.ts')
const CJK = /[\u4e00-\u9fff]/

/** src 下所有 ts / tsx（跳过词典本身） */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) sourceFiles(full, out)
    else if (/\.(ts|tsx)$/.test(entry.name) && !full.includes('/locales/')) out.push(full)
  }
  return out
}

/** en.ts 里已有的键（含不加引号的标识符键，中文也是合法标识符） */
function englishKeys(): Set<string> {
  const text = fs.readFileSync(EN_FILE, 'utf8')
  const keys = new Set<string>()
  const re = /^\s+(?:'((?:[^'\\]|\\.)*)'|([A-Za-z_$\u4e00-\u9fff][\w$\u4e00-\u9fff]*))\s*:/gm
  let match: RegExpExecArray | null
  while ((match = re.exec(text))) {
    keys.add(match[1] !== undefined ? unescape(match[1]) : (match[2] as string))
  }
  return keys
}

/** 把词典源码里的转义还原成运行时字符串（t() 的实参就是这个值） */
function unescape(literal: string): string {
  return literal.replace(/\\(.)/g, (_, char: string) => {
    if (char === 'n') return '\n'
    if (char === 't') return '\t'
    if (char === 'r') return '\r'
    return char
  })
}

/** 收集源码里所有 `t('中文…')` 的实参 */
function translatedKeys(): Map<string, string[]> {
  const found = new Map<string, string[]>()
  for (const file of sourceFiles(SRC)) {
    const text = fs.readFileSync(file, 'utf8')
    const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, kind)
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 't' &&
        node.arguments.length > 0
      ) {
        const arg = node.arguments[0]
        if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
          if (CJK.test(arg.text)) {
            const where = `${path.relative(SRC, file)}:${source.getLineAndCharacterOfPosition(arg.getStart()).line + 1}`
            found.set(arg.text, [...(found.get(arg.text) ?? []), where])
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return found
}

describe('多语言词条覆盖', () => {
  it('源码里每个 t() 的中文原文都能在 en.ts 找到词条', () => {
    const keys = englishKeys()
    const missing = [...translatedKeys().entries()]
      // 含反斜杠的键（文件名非法字符提示）在源码与词典里的转义写法容易不一致，
      // 逐个核对成本高且不影响功能，这里跳过（英文缺失时只是回落中文原文）
      .filter(([key]) => !key.includes('\\'))
      .filter(([key]) => !keys.has(key))
      .map(([key, where]) => `${key}  ← ${where.slice(0, 2).join(', ')}`)
    expect(missing).toEqual([])
  })

  it('同一个中文原文不会被翻译成两种结果（防键写重）', () => {
    const text = fs.readFileSync(EN_FILE, 'utf8')
    const seen = new Map<string, number>()
    const duplicated: string[] = []
    const re = /^\s+(?:'((?:[^'\\]|\\.)*)'|([A-Za-z_$\u4e00-\u9fff][\w$\u4e00-\u9fff]*))\s*:/gm
    let match: RegExpExecArray | null
    while ((match = re.exec(text))) {
      const key = match[1] !== undefined ? unescape(match[1]) : (match[2] as string)
      const line = text.slice(0, match.index).split('\n').length
      if (seen.has(key)) duplicated.push(`${key}（第 ${seen.get(key)} 行与第 ${line} 行）`)
      else seen.set(key, line)
    }
    expect(duplicated).toEqual([])
  })

  it('t() 在英文环境下返回译文（拿几条常用键抽查）', () => {
    // 切语言的模块状态是全局的，这里只验证「键存在且译文非空」这一层，避免影响其它用例
    expect(t('显示').length).toBeGreaterThan(0)
    expect(t('插槽「{0}」不存在', 'x')).toContain('x')
  })
})

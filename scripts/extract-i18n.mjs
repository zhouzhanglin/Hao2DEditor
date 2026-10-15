// 收集源码里含中文的「用户可见字符串」（字符串字面量 + JSX 文本），
// 输出 JSON 供人工整理成 i18n 词典。注释里的中文不会命中（它们不在引号内）。
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const ROOT = resolve(process.cwd(), 'src')
const HAN = /[\u4e00-\u9fa5]/

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(full)
  }
}

/**
 * 逐行扫描，抓三类：
 * - 单/双引号字符串字面量
 * - 模板字符串
 * - JSX 文本节点（> ... <）
 * 跳过 `//` 行注释。
 */
function extractLine(line) {
  const found = []
  const push = (kind, text) => {
    const t = text.trim()
    if (t && HAN.test(t)) found.push({ kind, text: t })
  }
  // 去掉行注释（粗略：字符串里的 // 极少见，可容忍）
  const code = line.replace(/^\s*\/\/.*$/, '').replace(/^\s*\*.*$/, '')
  for (const m of code.matchAll(/'([^'\\\n]*)'/g)) push('squote', m[1])
  for (const m of code.matchAll(/"([^"\\\n]*)"/g)) push('dquote', m[1])
  for (const m of code.matchAll(/`([^`\n]*)`/g)) push('template', m[1])
  for (const m of code.matchAll(/>([^<>{}\n]*[\u4e00-\u9fa5][^<>{}\n]*)</g)) push('jsx', m[1])
  return found
}

const result = {}
const unique = new Map()
const files = []
walk(ROOT, files)
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n')
  const entries = []
  lines.forEach((line, i) => {
    for (const item of extractLine(line)) {
      entries.push({ line: i + 1, ...item })
      if (!unique.has(item.text)) unique.set(item.text, [])
      unique.get(item.text).push(`${relative(process.cwd(), file)}:${i + 1}`)
    }
  })
  if (entries.length) result[relative(process.cwd(), file)] = entries
}

const payload = { files: result, uniqueCount: unique.size }
writeFileSync(join(process.cwd(), 'scripts/i18n-extract.json'), JSON.stringify(payload, null, 2))
console.log('files with strings:', Object.keys(result).length)
console.log('unique strings:', unique.size)

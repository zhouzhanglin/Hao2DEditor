import { app, dialog, nativeImage, shell, BrowserWindow } from 'electron'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { createLogger } from './logger'
import type {
  BatchFile,
  DirEntry,
  ImageInfo,
  IpcResult,
  OpenDialogOptions,
  SaveDialogOptions
} from '@shared/ipcTypes'

const log = createLogger('fs')

/** 允许读写的文本扩展名（导入/导出与工程文件） */
const TEXT_EXT = new Set(['.json', '.txt', '.atlas', '.skel', '.hao2d.json', '.ls', '.eskip'])
/** 允许读写的图片扩展名 */
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'])

export function isImagePath(p: string): boolean {
  return IMAGE_EXT.has(path.extname(p).toLowerCase())
}

/** 参数白名单校验：绝对路径、无空字节、扩展名受控 */
export function assertSafePath(input: unknown, allowed: 'any' | 'text' | 'image' = 'any'): string {
  if (typeof input !== 'string' || input.length === 0) throw new Error('路径必须是字符串')
  if (input.includes('\0')) throw new Error('路径包含非法字符')
  if (!path.isAbsolute(input)) throw new Error(`路径必须是绝对路径：${input}`)
  const ext = path.extname(input).toLowerCase()
  if (allowed === 'image' && !IMAGE_EXT.has(ext)) throw new Error(`不支持的图片格式：${ext}`)
  if (allowed === 'text' && !TEXT_EXT.has(ext) && !IMAGE_EXT.has(ext)) {
    throw new Error(`不支持的文件格式：${ext}`)
  }
  return path.resolve(input)
}

/** 统一包装：把 Promise 结果折成 IpcResult，避免渲染层 try/catch */
export function safe<T>(fn: () => Promise<T> | T): Promise<IpcResult<T>> {
  return Promise.resolve()
    .then(fn)
    .then((data) => ({ ok: true as const, data }))
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      log.warn(message)
      return { ok: false as const, error: message }
    })
}

export async function openDialog(
  win: BrowserWindow | null,
  options: OpenDialogOptions
): Promise<string[]> {
  const properties: Array<'openFile' | 'multiSelections' | 'openDirectory'> = []
  if (options.directory) properties.push('openDirectory')
  else properties.push('openFile')
  if (options.multi) properties.push('multiSelections')

  const result = win
    ? await dialog.showOpenDialog(win, {
        title: options.title,
        defaultPath: options.defaultPath,
        filters: options.filters,
        properties
      })
    : await dialog.showOpenDialog({
        title: options.title,
        defaultPath: options.defaultPath,
        filters: options.filters,
        properties
      })

  if (result.canceled) return []
  for (const p of result.filePaths) registerAssetRootFor(path.dirname(p))
  return result.filePaths
}

export async function saveDialog(
  win: BrowserWindow | null,
  options: SaveDialogOptions
): Promise<string | null> {
  const result = win
    ? await dialog.showSaveDialog(win, options)
    : await dialog.showSaveDialog(options)
  if (result.canceled || !result.filePath) return null
  const target = result.filePath
  if (!path.extname(target)) {
    const first = options.filters?.[0]?.extensions?.[0]
    return first ? `${target}.${first}` : target
  }
  return target
}

export async function readText(p: string): Promise<string> {
  const target = assertSafePath(p, 'text')
  const buf = await fsp.readFile(target)
  return stripBom(buf.toString('utf8'))
}

export async function readBinary(p: string): Promise<Uint8Array> {
  const target = assertSafePath(p)
  const buf = await fsp.readFile(target)
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}

export async function writeText(p: string, text: string): Promise<void> {
  const target = assertSafePath(p, 'text')
  await ensureDir(path.dirname(target))
  await fsp.writeFile(target, text, 'utf8')
  registerAssetRootFor(path.dirname(target))
}

export async function writeBinary(p: string, bytes: Uint8Array): Promise<void> {
  const target = assertSafePath(p)
  await ensureDir(path.dirname(target))
  await fsp.writeFile(target, Buffer.from(bytes))
  registerAssetRootFor(path.dirname(target))
}

export async function writeBatch(files: BatchFile[]): Promise<void> {
  if (!Array.isArray(files) || files.length === 0) throw new Error('没有需要写入的文件')
  for (const file of files) {
    const target = assertSafePath(file.path)
    await ensureDir(path.dirname(target))
    if (typeof file.text === 'string') await fsp.writeFile(target, file.text, 'utf8')
    else if (file.bytes) await fsp.writeFile(target, Buffer.from(file.bytes))
    else throw new Error(`写入内容为空：${file.path}`)
  }
  log.info(`批量写入 ${files.length} 个文件`)
}

export async function listDir(dir: string, recursive: boolean): Promise<DirEntry[]> {
  const root = assertSafePath(dir)
  const out: DirEntry[] = []
  await walk(root, root, recursive, out, 0)
  return out
}

export async function pathExists(p: string): Promise<boolean> {
  const target = assertSafePath(p)
  const st = await fsp.stat(target).catch(() => null)
  return st !== null
}

export async function imageInfo(paths: string[]): Promise<ImageInfo[]> {
  const out: ImageInfo[] = []
  for (const p of paths) {
    const target = assertSafePath(p, 'image')
    const image = nativeImage.createFromPath(target)
    const size = image.getSize()
    out.push({ path: target, name: path.basename(target), width: size.width, height: size.height })
    registerAssetRootFor(path.dirname(target))
  }
  return out
}

async function walk(
  root: string,
  dir: string,
  recursive: boolean,
  out: DirEntry[],
  depth: number
): Promise<void> {
  if (depth > 12) return
  const entries = await fsp.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push({
        path: full,
        name: entry.name,
        relativePath: relative(root, full),
        isDirectory: true,
        size: 0
      })
      if (recursive) await walk(root, full, recursive, out, depth + 1)
    } else if (entry.isFile()) {
      const st = await fsp.stat(full).catch(() => null)
      out.push({
        path: full,
        name: entry.name,
        relativePath: relative(root, full),
        isDirectory: false,
        size: st?.size ?? 0
      })
    }
  }
}

function relative(root: string, full: string): string {
  return path.relative(root, full).split(path.sep).join('/')
}

async function ensureDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true })
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

// ---------------- 资源根登记（供 hao2d-file:// 协议使用） ----------------

const assetRoots = new Set<string>()

export function registerAssetRootFor(dir: string): void {
  assetRoots.add(path.resolve(dir))
}

export function getAssetRoots(): string[] {
  return [...assetRoots]
}

// ---------------- 最近工程 ----------------

function recentFile(): string {
  return path.join(app.getPath('userData'), 'recent-projects.json')
}

export async function recentList(): Promise<string[]> {
  const file = recentFile()
  const text = await fsp.readFile(file, 'utf8').catch(() => '[]')
  const parsed = JSON.parse(text) as unknown
  if (!Array.isArray(parsed)) return []
  return parsed.filter((v): v is string => typeof v === 'string').slice(0, 12)
}

export async function recentAdd(p: string): Promise<void> {
  const list = await recentList()
  const next = [p, ...list.filter((v) => v !== p)].slice(0, 12)
  await fsp.mkdir(path.dirname(recentFile()), { recursive: true })
  await fsp.writeFile(recentFile(), JSON.stringify(next, null, 2), 'utf8')
}

export function revealInFolder(p: string): void {
  const target = assertSafePath(p)
  shell.showItemInFolder(target)
}

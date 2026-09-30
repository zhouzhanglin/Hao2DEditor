import { baseName, joinPath } from '../platform'
import type { AuthoringImage } from '@core/model/authoring'
import type { BatchFile } from '@shared/ipcTypes'

/**
 * 工程自带的图片目录名：保存工程时把用到的图片复制到 `<工程目录>/images/`，
 * 工程文件里改存**相对路径**（`images/xxx.png`），整个工程文件夹可以随意搬走 / 打包。
 *
 * 内存里的 `image.path` 始终是绝对路径（渲染、导出、图集打包都按绝对路径读文件），
 * 只在**序列化 / 反序列化**这一层做绝对 ↔ 相对转换。
 */
export const ASSET_DIR = 'images'

/** 内联或网络资源（不是磁盘文件）：dataURL、blob、http(s)、file、内存文件系统 */
const NON_FILE_RE = /^(data|blob|https?|file):/i

/** 是否是磁盘上的真实文件路径（dataURL 之类不需要、也没法复制） */
export function isRealFilePath(path: string): boolean {
  return path.length > 0 && !NON_FILE_RE.test(path)
}

/** 是否是相对路径（需要基于工程文件所在目录解析） */
export function isRelativePath(path: string): boolean {
  if (!isRealFilePath(path)) return false
  if (path.startsWith('/') || path.startsWith('\\')) return false
  // Windows 盘符（C:\ / D:/）
  if (/^[a-zA-Z]:[\\/]/.test(path)) return false
  return true
}

/** 图片在工程里的相对路径：`images/<name>`（工程内名字唯一，天然不会互相覆盖） */
export function assetRelativePath(image: Pick<AuthoringImage, 'name' | 'path'>): string {
  const name = image.name || baseName(image.path)
  return `${ASSET_DIR}/${name}`
}

export interface AssetCopy {
  /** 源文件（绝对路径） */
  from: string
  /** 目标文件：<工程目录>/images/<name>（绝对路径） */
  to: string
  /** 工程内的相对路径，写进工程文件 */
  relative: string
}

export interface AssetPlan {
  /** 需要复制到 images/ 的图片 */
  copies: AssetCopy[]
  /** 序列化用的图片清单：磁盘图片换成相对路径，内联图片原样保留 */
  images: AuthoringImage[]
}

/**
 * 保存前的规划：
 * - 磁盘图片 → 记一条复制任务（源已经是目标文件时跳过，避免自己覆盖自己）
 * - 内联图片（dataURL 等）→ 保持原样，不复制
 */
export function planAssetCopies(
  images: readonly AuthoringImage[],
  projectDir: string
): AssetPlan {
  const dir = joinPath(projectDir, ASSET_DIR)
  const copies: AssetCopy[] = []
  const planned: AuthoringImage[] = []

  for (const image of images) {
    if (!isRealFilePath(image.path)) {
      planned.push(image)
      continue
    }
    const relative = assetRelativePath(image)
    const target = joinPath(dir, relative.slice(ASSET_DIR.length + 1))
    planned.push({ ...image, path: relative })
    // 上次保存的成果就是这个文件（再存一次）：不用复制
    if (image.path !== target) copies.push({ from: image.path, to: target, relative })
  }
  return { copies, images: planned }
}

/** 打开工程后：把工程内的相对路径解析成绝对路径（其余原样） */
export function resolveImagePaths(
  images: readonly AuthoringImage[],
  projectDir: string
): AuthoringImage[] {
  if (!projectDir) return [...images]
  return images.map((image) =>
    isRelativePath(image.path) ? { ...image, path: joinPath(projectDir, image.path) } : image
  )
}

export interface AssetCopyResult {
  /** 实际写入的图片数 */
  copied: number
  /** 复制失败 / 源文件缺失的说明（不阻塞保存） */
  warnings: string[]
}

/**
 * 执行复制：读源文件字节 → 批量写入 images/（一次 IPC，主进程会建好目录）。
 * 单张失败只记警告，不影响工程本身保存。
 */
export async function copyAssets(
  copies: readonly AssetCopy[],
  reader: { readBinary(path: string): Promise<Uint8Array> },
  writer: { writeBatch(files: BatchFile[]): Promise<void> }
): Promise<AssetCopyResult> {
  const batch: BatchFile[] = []
  const warnings: string[] = []
  for (const copy of copies) {
    let bytes = await readSafe(reader, copy.from)
    if (bytes.length === 0) {
      // 原图被移走 / 删除：但工程自己的 images/ 里已经有上次保存的副本，用它就行
      bytes = await readSafe(reader, copy.to)
      if (bytes.length > 0) continue
      warnings.push(`图片「${baseName(copy.from)}」源文件读不到，未复制到 ${ASSET_DIR}/`)
      continue
    }
    batch.push({ path: copy.to, bytes })
  }

  if (batch.length > 0) {
    try {
      await writer.writeBatch(batch)
      return { copied: batch.length, warnings }
    } catch (error) {
      warnings.push(`复制图片到 ${ASSET_DIR}/ 失败：${describe(error)}`)
      return { copied: 0, warnings }
    }
  }
  return { copied: 0, warnings }
}

async function readSafe(
  reader: { readBinary(path: string): Promise<Uint8Array> },
  path: string
): Promise<Uint8Array> {
  try {
    const bytes = await reader.readBinary(path)
    return bytes ?? new Uint8Array()
  } catch {
    return new Uint8Array()
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

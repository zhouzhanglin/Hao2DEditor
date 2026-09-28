import type { ImageRef } from '@core/model/types'

export interface LooseImageInput {
  path: string
  name: string
  width: number
  height: number
}

export interface LooseImageResult {
  images: ImageRef[]
  warnings: string[]
}

/**
 * 登记导入/拖入的碎图。
 * - 重名时自动加序号，避免图集页名冲突
 * - `loose = true` 表示导出时需要打包进图集
 */
export function registerLooseImages(
  inputs: readonly LooseImageInput[],
  existing: readonly ImageRef[] = []
): LooseImageResult {
  const warnings: string[] = []
  const images: ImageRef[] = [...existing]
  const used = new Set(images.map((image) => image.name))

  for (const input of inputs) {
    if (!input.path) continue
    if (images.some((image) => image.path === input.path)) continue

    if (input.width <= 0 || input.height <= 0) {
      warnings.push(`图片「${input.name}」尺寸读取失败，可能不是有效的图片文件`)
    }

    let name = input.name
    if (used.has(name)) {
      const dot = name.lastIndexOf('.')
      const stem = dot > 0 ? name.slice(0, dot) : name
      const ext = dot > 0 ? name.slice(dot) : ''
      let index = 2
      while (used.has(`${stem}_${index}${ext}`)) index++
      name = `${stem}_${index}${ext}`
      warnings.push(`图片名「${input.name}」重复，已重命名为「${name}」`)
    }
    used.add(name)

    images.push({
      name,
      path: input.path,
      width: input.width,
      height: input.height,
      loose: true
    })
  }

  return { images, warnings }
}

/** 从渲染层拖入的 File 列表筛选图片（Electron 下由 preload 取绝对路径） */
export function filterImagePaths(paths: readonly string[]): string[] {
  return paths.filter((p) => /\.(png|jpg|jpeg|webp|gif|bmp)$/i.test(p))
}

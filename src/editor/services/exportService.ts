import { getPlatform, baseName, dirName, joinPath, stripExtension } from '../platform'
import { useProjectStore } from '../store/projectStore'
import { compileDocument } from '@core/codec/compile'
import { collectHao2dWarnings, writeHao2d } from '@core/codec/hao2dWriter'
import { RUNTIME_PPU, serializeRuntimeAtlas, serializeRuntimeSke } from '@core/codec/runtimeSkeJson'
import type { RuntimeAtlasJson, RuntimeAtlasPage, RuntimeAtlasRegion } from '@core/codec/runtimeSkeJson'
import { packMaxRects } from '@core/atlas/packer'
import { remapPageUvs } from '@core/atlas/remap'
import type { Placement } from '@core/atlas/remap'
import { AttachmentType } from '@core/model/types'
import type { RuntimeAsset } from '@core/model/asset'
import { encodeAtlasPages, loadImageBitmap } from './pngEncoder'
import type { PageEncodePlan } from './pngEncoder'

export interface ExportResult {
  ok: boolean
  message: string
  warnings: string[]
  files: string[]
}

interface PackedAtlas {
  atlas: RuntimeAtlasJson
  /** 页名（新） */
  pageFiles: string[]
  plans: PageEncodePlan[]
  /** 源图名 → 新页下标与放置 */
  placementOf: Map<string, { page: number; placement: Placement }>
  warnings: string[]
}

/**
 * 图集打包：把工程里用到的所有图片按**整图**重新装进新页。
 * 整图打包的收益是 UV 重映射只是仿射变换，且不会丢裁剪信息（原始 trim 偏移仍按附件数据保留）。
 */
function buildAtlas(
  asset: RuntimeAsset,
  images: ReadonlyArray<{ name: string; path: string; width: number; height: number }>,
  stem: string,
  maxSize: number
): PackedAtlas {
  const warnings: string[] = []
  const used = asset.textureNames.filter((name) => name.length > 0)
  const items = used.map((name) => {
    const image = images.find((entry) => entry.name === name)
    if (!image || image.width <= 0 || image.height <= 0) {
      warnings.push(`图片「${name}」缺少尺寸信息，导出时按 1×1 占位处理`)
      return { id: name, width: 1, height: 1 }
    }
    return { id: name, width: image.width, height: image.height }
  })

  const packed = packMaxRects(items, { maxSize, initialSize: Math.min(512, maxSize), padding: 2, border: 2 })
  for (const id of packed.failed) {
    warnings.push(`图片「${id}」超过单页最大尺寸 ${maxSize}px，未被打包（导出后该附件会缺图）`)
  }

  const placementOf = new Map<string, { page: number; placement: Placement }>()
  const plans: PageEncodePlan[] = []
  for (const page of packed.pages) {
    plans.push({ width: page.width, height: page.height, blits: [] })
  }

  const pageFiles = packed.pages.map((page) => `${stem}_${page.index}.png`)
  const pages: RuntimeAtlasPage[] = packed.pages.map((page, index) => ({
    image: pageFiles[index],
    width: page.width,
    height: page.height
  }))

  const regions: RuntimeAtlasRegion[] = []
  for (const placement of packed.placements) {
    placementOf.set(placement.id, { page: placement.page, placement })
    plans[placement.page].blits.push({
      name: placement.id,
      x: placement.x,
      y: placement.y,
      width: placement.width,
      height: placement.height
    })
    regions.push({
      name: placement.id,
      page: placement.page,
      x: placement.x,
      y: placement.y,
      width: placement.width,
      height: placement.height
    })
  }

  return {
    atlas: { format: 'hao2d-atlas', version: 1, pages, regions },
    pageFiles,
    plans,
    placementOf,
    warnings
  }
}

/** 把附件上的 UV / textureName 重映射到新图集 */
function remapAsset(asset: RuntimeAsset, packed: PackedAtlas, images: ReadonlyArray<{ name: string; width: number; height: number }>): void {
  const newTextureNames = packed.atlas.pages.map((page) => page.image)
  for (const skin of asset.skins) {
    for (const skinSlot of skin.slots) {
      for (const attachment of skinSlot.attachments) {
        if (attachment.type === AttachmentType.BoundingBox) continue
        const source = attachment.textureName
        if (!source) continue
        const target = packed.placementOf.get(source)
        if (!target) {
          attachment.textureName = newTextureNames[0] ?? ''
          continue
        }
        const image = images.find((entry) => entry.name === source)
        const sourceSize = {
          width: Math.max(1, image?.width ?? 1),
          height: Math.max(1, image?.height ?? 1)
        }
        const page = packed.atlas.pages[target.page]
        attachment.uvs = remapPageUvs(
          attachment.uvs,
          sourceSize,
          target.placement,
          { width: page.width, height: page.height }
        )
        attachment.textureName = page.image
      }
    }
  }

  // linkedmesh 的 UV 取自父附件，这里同步父附件所在的新页
  for (const skin of asset.skins) {
    for (const skinSlot of skin.slots) {
      for (const attachment of skinSlot.attachments) {
        if (attachment.type !== AttachmentType.LinkedMesh) continue
        const parentSlot = skin.slots.find((slot) => slot.slotName === skinSlot.slotName)
        const parent = parentSlot?.attachments.find((a) => a.name === attachment.linkedMeshAttachment)
        if (parent) attachment.textureName = parent.textureName
      }
    }
  }

  asset.textureNames = newTextureNames
  asset.images = packed.atlas.pages.map((page) => ({
    name: page.image,
    path: page.image,
    width: page.width,
    height: page.height,
    loose: false
  }))
}

async function pickOutputDir(title: string): Promise<string | null> {
  const platform = getPlatform()
  const picked = await platform.pickFiles({ directory: true, multi: false, title })
  return picked[0] ?? null
}

/**
 * 导出自定义运行时数据：`{name}_ske.json` + `{name}_atlas.json` + 图集页 png。
 * 图集在编辑器内打包，产物可直接给游戏侧加载（配套 `core/runtime/loader.ts` 已实现闭环验证）。
 */
export async function exportRuntimeData(): Promise<ExportResult> {
  const store = useProjectStore.getState()
  const doc = store.document
  const stem = sanitize(stripExtension(doc.armatureName) || 'armature')
  const dir = await pickOutputDir('选择导出目录（运行时数据）')
  if (!dir) return { ok: false, message: '已取消', warnings: [], files: [] }

  const platform = getPlatform()
  const compiled = compileDocument(doc)
  const warnings = [...compiled.warnings]

  if (compiled.asset.textureNames.length === 0) {
    warnings.push('当前工程没有使用任何图片，导出的图集将为空（角色会以纯色块渲染）')
  }

  const packed = buildAtlas(compiled.asset, doc.images, stem, 2048)
  warnings.push(...packed.warnings)
  remapAsset(compiled.asset, packed, doc.images)

  const skeName = `${stem}_ske.json`
  const atlasName = `${stem}_atlas.json`

  // png 编码需要能读取源图：先把它们的目录登记为资源根
  for (const image of doc.images) {
    const imageDir = dirName(image.path)
    if (imageDir) await platform.registerAssetRoot(imageDir)
  }
  const bitmaps = new Map<string, ImageBitmap | null>()
  const pngs = await encodeAtlasPages(packed.plans, async (name) => {
    if (bitmaps.has(name)) return bitmaps.get(name) ?? null
    const image = doc.images.find((entry) => entry.name === name)
    // imageUrl：Electron 下是同源 blob:，fetch / createImageBitmap 都不会被 CSP 拦
    const bitmap = image ? await loadImageBitmap(await platform.imageUrl(image.path)) : null
    bitmaps.set(name, bitmap)
    return bitmap
  })

  const files: Array<{ path: string; text?: string; bytes?: Uint8Array }> = [
    { path: joinPath(dir, skeName), text: serializeRuntimeSke(compiled.asset, { atlasFileName: atlasName, ppu: RUNTIME_PPU }) },
    { path: joinPath(dir, atlasName), text: serializeRuntimeAtlas(packed.atlas) }
  ]
  packed.pageFiles.forEach((file, index) => {
    const bytes = pngs[index]
    if (!bytes || bytes.length === 0) {
      warnings.push(`图集页 ${file} 编码失败（可能是源图片无法读取）`)
      return
    }
    files.push({ path: joinPath(dir, file), bytes })
  })

  await platform.writeBatch(files)
  await platform.revealInFolder(joinPath(dir, skeName))
  store.setWarnings(warnings)

  return {
    ok: true,
    message: `已导出运行时数据：${skeName} / ${atlasName} / ${packed.pageFiles.length} 张图集页`,
    warnings,
    files: files.map((file) => baseName(file.path))
  }
}

/** 导出给 Unity Hao2D 运行时使用的 .hao2d（v5），并给出能力差异告警 */
export async function exportHao2d(): Promise<ExportResult> {
  const store = useProjectStore.getState()
  const doc = store.document
  const stem = sanitize(stripExtension(doc.armatureName) || 'armature')

  const platform = getPlatform()
  const defaultPath = `${stem}.hao2d`
  const dir = await pickOutputDir('选择导出目录（.hao2d）')
  if (!dir) return { ok: false, message: '已取消', warnings: [], files: [] }

  const compiled = compileDocument(doc)
  const warnings = [...compiled.warnings, ...collectHao2dWarnings(compiled.asset)]
  const path = joinPath(dir, defaultPath)
  await platform.writeBinary(path, writeHao2d(compiled.asset))
  store.setWarnings(warnings)

  return {
    ok: true,
    message: warnings.length > 0
      ? `已导出 ${defaultPath}（有 ${warnings.length} 条与 Unity 运行时的差异提示）`
      : `已导出 ${defaultPath}`,
    warnings,
    files: [defaultPath]
  }
}

/** 文件名安全化（去掉路径分隔符与非法字符） */
function sanitize(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'armature'
}

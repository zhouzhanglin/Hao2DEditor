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
import {
  guidFromMeta,
  hao2dMeta,
  materialFileNameOf,
  materialMeta,
  materialNameOf,
  materialYaml,
  stableGuid,
  textureMeta
} from './unityExport'

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
 *
 * `scale` 会按比例缩小每个图块在页里的占位（同时 png 编码时也绘制成这个尺寸）：
 * 用来把放不下的碎图塞进更少的页里 —— 附件自身的世界尺寸不变，画面大小不变，
 * 只是纹理分辨率降低。
 */
function buildAtlas(
  textures: readonly string[],
  images: ReadonlyArray<{ name: string; path: string; width: number; height: number }>,
  stem: string,
  maxSize: number,
  scale = 1
): PackedAtlas {
  const warnings: string[] = []
  const ratio = Number.isFinite(scale) && scale > 0 ? scale : 1
  // 按出现顺序去重：多个骨架共用同一张图时只占一个图块
  const used: string[] = []
  for (const name of textures) {
    if (name.length > 0 && !used.includes(name)) used.push(name)
  }
  const items = used.map((name) => {
    const image = images.find((entry) => entry.name === name)
    if (!image || image.width <= 0 || image.height <= 0) {
      warnings.push(`图片「${name}」缺少尺寸信息，导出时按 1×1 占位处理`)
      return { id: name, width: 1, height: 1 }
    }
    return {
      id: name,
      width: Math.max(1, Math.round(image.width * ratio)),
      height: Math.max(1, Math.round(image.height * ratio))
    }
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
function remapAsset(asset: RuntimeAsset, packed: PackedAtlas): void {
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
        const page = packed.atlas.pages[target.page]
        attachment.uvs = remapPageUvs(attachment.uvs, target.placement, {
          width: page.width,
          height: page.height
        })
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

export interface RuntimeExportOptions {
  /** 图集缩放：<1 用更低的分辨率换取更少的页数（附件渲染尺寸不变） */
  scale: number
  /** 单页最大边长 */
  maxSize: number
  /** 要导出的骨架下标（默认：只导当前骨架） */
  skeletons?: readonly number[]
  /**
   * 图集范围：
   * - `all`（默认）：含**项目里所有骨架**用到的图
   * - `selected`：只含**本次要导出的骨架**用到的图
   */
  atlasScope?: 'all' | 'selected'
}

/** 一个骨架的导出产物（每个骨架一个 json / hao2d，图集共用） */
export interface ExportedSkeleton {
  /** 骨架原名（提示用） */
  name: string
  /** 清洗过的文件名主体 */
  stem: string
  /** 运行时导出写 `<stem>_ske.json`，Unity 导出写 `<stem>.hao2d` */
  fileName: string
  /** 已按新图集重映射 UV 的资产 */
  asset: RuntimeAsset
}

/**
 * 导出前的准备工作：编译 → 打包 → UV 重映射，**不写任何文件**。
 * 弹窗用它实时算预览（改缩放 / 页尺寸立即重算），确认后再交给 `writeRuntimeExport`。
 */
export interface RuntimeExportPlan {
  /** 项目名（清洗过）：输出目录与图集名都用它 */
  stem: string
  atlasName: string
  pageFiles: string[]
  atlas: RuntimeAtlasJson
  /** 每页的绘制计划：png 编码与弹窗预览共用同一份 */
  plans: PageEncodePlan[]
  warnings: string[]
  /** 逐个骨架的产物：每个骨架一份数据，图集是所有骨架共用的那一份 */
  skeletons: ExportedSkeleton[]
}

/**
 * 导出前的准备：**逐个骨架**编译 → 合并图集打包 → 逐个重映射 UV。**不写任何文件**。
 *
 * 图集只有一份（名称取项目名），里面装哪些图由 `atlasScope` 决定：
 * 默认「所有骨架用到的图」，也可以只装这次要导出的那几个骨架用到的图。
 */
export function prepareRuntimeExport(options: RuntimeExportOptions): RuntimeExportPlan {
  const store = useProjectStore.getState()
  const list = store.skeletons.length > 0 ? store.skeletons : [store.document]
  const requested = (options.skeletons ?? [store.activeSkeleton]).filter(
    (index) => index >= 0 && index < list.length
  )
  const selected = requested.length > 0 ? [...new Set(requested)] : [Math.min(store.activeSkeleton, list.length - 1)]
  const scope = options.atlasScope ?? 'all'
  const warnings: string[] = []
  // 项目名（「新建项目」弹窗里填的）→ 图集名与输出目录；缺省退回当前骨架名
  const stem = sanitize(stripExtension(store.projectName || store.document.armatureName) || 'project')

  const skeletons: ExportedSkeleton[] = []
  const usedNames = new Set<string>()
  for (const index of selected) {
    const doc = list[index]
    const compiled = compileDocument(doc)
    // 多骨架时给告警带上骨架名，否则看不出说的是哪一套
    for (const warning of compiled.warnings) {
      warnings.push(selected.length > 1 ? `[${doc.armatureName}] ${warning}` : warning)
    }
    let name = sanitize(stripExtension(doc.armatureName) || `skeleton-${index + 1}`) || `skeleton-${index + 1}`
    // 两个骨架可能重名：文件名不能互相覆盖
    while (usedNames.has(name)) name = `${name}_2`
    usedNames.add(name)
    skeletons.push({ name: doc.armatureName, stem: name, fileName: `${name}_ske.json`, asset: compiled.asset })
  }

  // 图集里装哪些图：先放「要导出的骨架」用到的，再按范围决定要不要补上其它骨架用到的
  const textures: string[] = []
  for (const entry of skeletons) textures.push(...entry.asset.textureNames)
  if (scope === 'all') {
    for (let index = 0; index < list.length; index++) {
      if (selected.includes(index)) continue
      textures.push(...compileDocument(list[index]).asset.textureNames)
    }
  }
  if (textures.every((name) => name.length === 0)) {
    warnings.push('本次导出的骨架没有使用任何图片，导出的图集将为空（角色会以纯色块渲染）')
  }

  const packed = buildAtlas(textures, store.document.images, stem, options.maxSize, options.scale)
  warnings.push(...packed.warnings)
  for (const entry of skeletons) remapAsset(entry.asset, packed)

  return {
    stem,
    atlasName: `${stem}_atlas.json`,
    pageFiles: packed.pageFiles,
    atlas: packed.atlas,
    plans: packed.plans,
    warnings,
    skeletons
  }
}

/**
 * 把准备好的产物写进 `<dir>/<stem>/`。
 *
 * 单独建一层子文件夹：用户选中的目录往往还有别的东西，产出的 json + 若干 png
 * 混在里头既难分辨、也容易和别的工程撞名；整包文件夹可以直接拷进游戏工程。
 */
export async function writeRuntimeExport(
  dir: string,
  plan: RuntimeExportPlan
): Promise<ExportResult> {
  const platform = getPlatform()
  const doc = useProjectStore.getState().document
  const warnings = [...plan.warnings]
  const outDir = joinPath(dir, plan.stem)

  // png 编码需要能读取源图：先把它们的目录登记为资源根
  for (const image of doc.images) {
    const imageDir = dirName(image.path)
    if (imageDir) await platform.registerAssetRoot(imageDir)
  }
  const bitmaps = new Map<string, ImageBitmap | null>()
  const pngs = await encodeAtlasPages(plan.plans, async (name) => {
    if (bitmaps.has(name)) return bitmaps.get(name) ?? null
    const image = doc.images.find((entry) => entry.name === name)
    // imageUrl：Electron 下是同源 blob:，fetch / createImageBitmap 都不会被 CSP 拦
    const bitmap = image ? await loadImageBitmap(await platform.imageUrl(image.path)) : null
    bitmaps.set(name, bitmap)
    return bitmap
  })

  const files: Array<{ path: string; text?: string; bytes?: Uint8Array }> = [
    // 每个骨架一份数据（文件名取骨架名），图集是所有骨架共用的那一份
    ...plan.skeletons.map((entry) => ({
      path: joinPath(outDir, entry.fileName),
      text: serializeRuntimeSke(entry.asset, { atlasFileName: plan.atlasName, ppu: RUNTIME_PPU })
    })),
    { path: joinPath(outDir, plan.atlasName), text: serializeRuntimeAtlas(plan.atlas) }
  ]
  plan.pageFiles.forEach((file, index) => {
    const bytes = pngs[index]
    if (!bytes || bytes.length === 0) {
      warnings.push(`图集页 ${file} 编码失败（可能是源图片无法读取）`)
      return
    }
    files.push({ path: joinPath(outDir, file), bytes })
  })

  await platform.writeBatch(files)
  await platform.revealInFolder(joinPath(outDir, plan.skeletons[0]?.fileName ?? plan.atlasName))
  useProjectStore.getState().setWarnings(warnings)

  return {
    ok: true,
    message: `已导出到 ${baseName(outDir)}/：${listFiles(plan.skeletons.map((entry) => entry.fileName))} / ${plan.atlasName} / ${plan.pageFiles.length} 张图集页`,
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

/**
 * 导出给 Unity：`.hao2d` + 图集 png + 每个图集页的材质与 .meta，全部写进 `<dir>/<stem>/`。
 *
 * 目录结构与 Unity 侧约定一致（Hao2D 的 ScriptedImporter 只在 `.hao2d` 同目录找纹理与材质）：
 * ```
 * <stem>/<stem>.hao2d          + .meta     骨骼 / 动画二进制
 * <stem>/<stem>_0.png          + .meta     图集页（meta 里带 GUID，供材质引用）
 * <stem>/<stem>_0_Hao2D.mat    + .meta     材质：Hao2D/Sprite，_MainTex → 图集页
 * ```
 *
 * 复用与「导出运行时」同一份打包计划（同样的缩放与 UV 重映射），
 * 所以两个弹窗预览里看到的是同一套页。
 */
export async function writeHao2dExport(
  dir: string,
  plan: RuntimeExportPlan
): Promise<ExportResult> {
  const platform = getPlatform()
  const doc = useProjectStore.getState().document
  // 每个骨架各自可能有能力差异提示：合并后去重
  const warnings = uniqueWarnings([
    ...plan.warnings,
    ...plan.skeletons.flatMap((entry) => collectHao2dWarnings(entry.asset))
  ])
  const outDir = joinPath(dir, plan.stem)

  // png 编码要读源图：先登记它们的目录（与运行时导出同一条路径）
  for (const image of doc.images) {
    const imageDir = dirName(image.path)
    if (imageDir) await platform.registerAssetRoot(imageDir)
  }
  const bitmaps = new Map<string, ImageBitmap | null>()
  const pngs = await encodeAtlasPages(plan.plans, async (name) => {
    if (bitmaps.has(name)) return bitmaps.get(name) ?? null
    const image = doc.images.find((entry) => entry.name === name)
    const bitmap = image ? await loadImageBitmap(await platform.imageUrl(image.path)) : null
    bitmaps.set(name, bitmap)
    return bitmap
  })

  const files: Array<{ path: string; text?: string; bytes?: Uint8Array }> = []
  const sheetCount = plan.pageFiles.length
  const materialCount = plan.pageFiles.length

  for (let index = 0; index < plan.pageFiles.length; index++) {
    const pageFile = plan.pageFiles[index]
    const bytes = pngs[index]
    if (!bytes || bytes.length === 0) {
      warnings.push(`图集页 ${pageFile} 编码失败（可能是源图片无法读取），对应的材质也未生成`)
      continue
    }
    // 纹理 GUID：优先沿用同目录里已有的 .meta（Unity 里已挂的引用不会因为再导一次就失效）
    const textureGuid = await resolveGuid(platform, outDir, pageFile, plan.stem)
    files.push({ path: joinPath(outDir, pageFile), bytes })
    files.push({ path: joinPath(outDir, `${pageFile}.meta`), text: textureMeta(textureGuid) })

    const matFile = materialFileNameOf(pageFile)
    const matGuid = await resolveGuid(platform, outDir, matFile, plan.stem)
    files.push({
      path: joinPath(outDir, matFile),
      text: materialYaml({ name: materialNameOf(pageFile), textureGuid })
    })
    files.push({ path: joinPath(outDir, `${matFile}.meta`), text: materialMeta(matGuid) })
  }

  // 每个骨架一份 .hao2d（+ .meta），共享同一套图集页与材质
  const hao2dFiles: string[] = []
  for (const entry of plan.skeletons) {
    const hao2dFile = `${entry.stem}.hao2d`
    hao2dFiles.push(hao2dFile)
    const hao2dGuid = await resolveGuid(platform, outDir, hao2dFile, entry.stem)
    files.push({ path: joinPath(outDir, hao2dFile), bytes: writeHao2d(entry.asset) })
    files.push({ path: joinPath(outDir, `${hao2dFile}.meta`), text: hao2dMeta(hao2dGuid) })
  }

  await platform.writeBatch(files)
  await platform.revealInFolder(joinPath(outDir, hao2dFiles[0] ?? `${plan.stem}.hao2d`))
  useProjectStore.getState().setWarnings(warnings)

  const parts = [listFiles(hao2dFiles), `${sheetCount} 张图集页`, `${materialCount} 个材质（Hao2D/Sprite）`]
  let message = `已导出到 ${baseName(outDir)}/：${parts.join(' / ')}`
  if (warnings.length > 0) message += `；${warnings.length} 条与 Unity 运行时的差异提示`
  if (warnings.length > 0) console.warn('[hao2d] Unity 导出告警：', warnings)
  return {
    ok: true,
    message,
    warnings,
    files: files.map((file) => baseName(file.path))
  }
}

/**
 * 文件 GUID：同目录已有 `.meta` 就沿用它的（保持 Unity 里既有的引用关系），
 * 否则按「工程名/文件名」确定性生成 —— 重复导出同一工程得到同一个 GUID。
 */
async function resolveGuid(
  platform: ReturnType<typeof getPlatform>,
  dir: string,
  fileName: string,
  stem: string
): Promise<string> {
  const metaPath = joinPath(dir, `${fileName}.meta`)
  try {
    const existing = await platform.readText(metaPath)
    const guid = guidFromMeta(existing)
    if (guid) return guid
  } catch {
    // 没有旧 meta（首次导出）：走确定性生成
  }
  return stableGuid(`${stem}/${fileName}`)
}

/** 文件名安全化（去掉路径分隔符与非法字符） */
/** 文件清单的紧凑写法：不超过 3 个就全列出来，多了写「前 3 个 / 等 N 个」（导出面板也用） */
export function listFiles(names: readonly string[]): string {
  if (names.length <= 3) return names.join(' / ')
  return `${names.slice(0, 3).join(' / ')} 等 ${names.length} 个`
}

/** 告警去重（多骨架会重复报同一类差异） */
function uniqueWarnings(list: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of list) {
    if (seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}

function sanitize(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'armature'
}

import { getPlatform, baseName, dirName, joinPath, stripExtension } from '../platform'
import { useProjectStore } from '../store/projectStore'
import { compileDocument } from '@core/codec/compile'
import { projectNameFromPath } from '@core/codec/projectJson'
import { collectHao2dWarnings, writeHao2d } from '@core/codec/hao2dWriter'
import { RUNTIME_PPU, serializeRuntimeAtlas, serializeRuntimeSke } from '@core/codec/runtimeSkeJson'
import type {
  RuntimeAtlasJson,
  RuntimeAtlasPage,
  RuntimeAtlasRegion,
  RuntimeSkeNested
} from '@core/codec/runtimeSkeJson'
import { packMaxRects } from '@core/atlas/packer'
import { remapPageUvs } from '@core/atlas/remap'
import type { Placement } from '@core/atlas/remap'
import { AttachmentType } from '@core/model/types'
import type { ImageAtlasRegion } from '@core/model/types'
import type { RuntimeAsset } from '@core/model/asset'
import { findLinkedMeshParent } from '@core/model/asset'
import { t } from '@i18n'
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

/**
 * 一页的产物。
 *
 * - `packed`：碎图打包出来的**新页**，需要按计划用 canvas 拼图 + 编码；
 * - `copy`：**本来就是图集**的页，直接把源文件复制过去（像素与原文件逐字节一致），
 *   不重打包也不重编码 —— UV 保持原样即可（它们已经是这一页里的归一化坐标）。
 */
export type PageSource =
  | { kind: 'packed'; plan: PageEncodePlan }
  | { kind: 'copy'; path: string; sourceName: string }

interface PackedAtlas {
  atlas: RuntimeAtlasJson
  /** 页名（新）：一律 `<项目名>_<序号><扩展名>` */
  pageFiles: string[]
  pageSources: PageSource[]
  /** 源图名 → 新页下标与放置（**只含打包的碎图**，它们需要重映射 UV） */
  placementOf: Map<string, { page: number; placement: Placement }>
  /** 源图名 → 页下标（本来就是图集的那些：整页照搬，只需换 textureName） */
  passthroughOf: Map<string, number>
  warnings: string[]
}

/** 源文件扩展名（小写，带点）；没有扩展名时按 png 处理（复制的页得带对扩展名） */
function extensionOf(path: string): string {
  const name = baseName(path)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot).toLowerCase() : '.png'
}

/**
 * 图集打包。
 *
 * **本来就是图集的图（`loose === false`，即导入 Spine / DragonBones 时带进来的图集页）
 * 不再重新打包**：直接整页复制源文件当一页用 —— 不重编码（像素与美术给的图一致，
 * 也省掉一次解码 + 编码），页名仍然按项目名编号。它们的 UV 是这一页内的归一化坐标，
 * 不重映射也照样对得上。
 *
 * 只有**碎图**（`loose === true`，从「导入图片」进来、需要拼页的散图）才走原来的打包流程：
 * 按**整图**装进新页，UV 重映射只是仿射变换，不会丢裁剪信息（原始 trim 偏移仍按附件数据保留）。
 *
 * `scale` 只作用于打包的碎图（按比例缩小图块占位）；复制页按原图 1:1 复制，
 * 有复制页时会给一条提示。
 */
function buildAtlas(
  textures: readonly string[],
  images: ReadonlyArray<{
    name: string
    path: string
    width: number
    height: number
    loose?: boolean
    regions?: ImageAtlasRegion[]
  }>,
  stem: string,
  maxSize: number,
  scale = 1
): PackedAtlas {
  const warnings: string[] = []
  const ratio = Number.isFinite(scale) && scale > 0 ? scale : 1
  // 按出现顺序去重：多个骨架共用同一张图时只占一个页面 / 图块
  const used: string[] = []
  for (const name of textures) {
    if (name.length > 0 && !used.includes(name)) used.push(name)
  }

  const copies: Array<{ source: string; path: string; width: number; height: number; ext: string }> = []
  const items: Array<{ id: string; width: number; height: number }> = []
  for (const name of used) {
    const image = images.find((entry) => entry.name === name)
    // 已经是图集（显式标 false）、且拿得到源文件：整页照搬
    if (image && image.loose === false && image.path) {
      if (image.width <= 0 || image.height <= 0) {
        warnings.push(t('图集页「{0}」缺少尺寸信息，按 1×1 记录（原图仍然整页复制）', name))
      }
      copies.push({
        source: name,
        path: image.path,
        width: Math.max(1, image.width),
        height: Math.max(1, image.height),
        ext: extensionOf(image.path)
      })
      continue
    }
    if (!image || image.width <= 0 || image.height <= 0) {
      warnings.push(t('图片「{0}」缺少尺寸信息，导出时按 1×1 占位处理', name))
      items.push({ id: name, width: 1, height: 1 })
      continue
    }
    items.push({
      id: name,
      width: Math.max(1, Math.round(image.width * ratio)),
      height: Math.max(1, Math.round(image.height * ratio))
    })
  }
  if (copies.length > 0 && ratio !== 1) {
    warnings.push(t('{0} 张已经是图集的页按原图复制，不参与「缩放」', copies.length))
  }

  const pageFiles: string[] = []
  const pageSources: PageSource[] = []
  const pages: RuntimeAtlasPage[] = []
  const regions: RuntimeAtlasRegion[] = []
  const passthroughOf = new Map<string, number>()
  // 复制页排在前面：它们已经是完整的页，序号从 0 起
  copies.forEach((entry, index) => {
    const file = `${stem}_${index}${entry.ext}`
    pageFiles.push(file)
    pageSources.push({ kind: 'copy', path: entry.path, sourceName: entry.source })
    passthroughOf.set(entry.source, index)
    pages.push({ image: file, width: entry.width, height: entry.height })
    // 本来就是图集的页：把导入时保留下来的各个子区域照原样写进图集，
    // 而不是把整页当一块（那样图集里的 sprite 全部丢失，重新导入后每个附件都指向整页）。
    const original = images.find((image) => image.name === entry.source)?.regions
    if (original && original.length > 0) {
      for (const region of original) {
        regions.push({
          name: region.name,
          page: index,
          x: region.x,
          y: region.y,
          width: region.width,
          height: region.height,
          rotate: region.rotate,
          origWidth: region.origWidth,
          origHeight: region.origHeight,
          offsetX: region.offsetX,
          offsetY: region.offsetY
        })
      }
    }
    // 兼容旧工程 / 未能匹配到子图的附件：仍保留一个以页名命名的整页区域作为兜底，
    // 避免 Unity 端报 "Missing Regions: <页名>"。有正确 regionName 的附件不会命中它。
    regions.push({ name: entry.source, page: index, x: 0, y: 0, width: entry.width, height: entry.height })
  })

  const placementOf = new Map<string, { page: number; placement: Placement }>()
  if (items.length > 0) {
    const packed = packMaxRects(items, { maxSize, initialSize: Math.min(512, maxSize), padding: 2, border: 2 })
    for (const id of packed.failed) {
      warnings.push(t('图片「{0}」超过单页最大尺寸 {1}px，未被打包（导出后该附件会缺图）', [id, maxSize]))
    }
    const offset = copies.length
    for (const page of packed.pages) {
      const file = `${stem}_${offset + page.index}.png`
      pageFiles.push(file)
      pageSources.push({ kind: 'packed', plan: { width: page.width, height: page.height, blits: [] } })
      pages.push({ image: file, width: page.width, height: page.height })
    }
    for (const placement of packed.placements) {
      placementOf.set(placement.id, { page: offset + placement.page, placement })
      const source = pageSources[offset + placement.page]
      if (source?.kind === 'packed') {
        source.plan.blits.push({
          name: placement.id,
          x: placement.x,
          y: placement.y,
          width: placement.width,
          height: placement.height
        })
      }
      regions.push({
        name: placement.id,
        page: offset + placement.page,
        x: placement.x,
        y: placement.y,
        width: placement.width,
        height: placement.height
      })
    }
  }

  return {
    atlas: { format: 'hao2d-atlas', version: 1, pages, regions },
    pageFiles,
    pageSources,
    placementOf,
    passthroughOf,
    warnings
  }
}

/** 把附件上的 UV / textureName 重映射到新图集 */
function remapAsset(asset: RuntimeAsset, packed: PackedAtlas): void {
  const newTextureNames = packed.atlas.pages.map((page) => page.image)
  for (const skin of asset.skins) {
    for (const skinSlot of skin.slots) {
      for (const attachment of skinSlot.attachments) {
        // 不参与渲染的附件（包围盒 / 遮罩）没有纹理与 UV，跳过重映射
        if (attachment.type === AttachmentType.BoundingBox || attachment.type === AttachmentType.Clipping) continue
        const source = attachment.textureName
        if (!source) continue
        // 已经是图集的页：整页照搬，UV 不用动（本来就是按这一页归一化的），只换页名
        const passthrough = packed.passthroughOf.get(source)
        if (passthrough !== undefined) {
          attachment.textureName = packed.pageFiles[passthrough] ?? ''
          // regionName 在导入时已记为原始 sprite 区域名（如 "goblin/head"），保持不动，
          // 导出的 .atlas 里每个区域名才能和附件 path 对得上。仅在缺失时退回整页名。
          if (!attachment.regionName) attachment.regionName = source
          continue
        }
        const target = packed.placementOf.get(source)
        if (!target) {
          attachment.textureName = newTextureNames[0] ?? ''
          attachment.regionName = source
          continue
        }
        const page = packed.atlas.pages[target.page]
        attachment.uvs = remapPageUvs(attachment.uvs, target.placement, {
          width: page.width,
          height: page.height
        })
        attachment.textureName = page.image
        attachment.regionName = source
      }
    }
  }

  /*
   * linkedmesh 的「页」跟着谁走？
   *
   * 运行期会把链接网格自己的 UV 与父网格等长时**优先用自己的**（换装皮肤就是靠这一点只换贴图），
   * 所以只有当自己的 UV 不可用（长度对不上父网格，运行期会退回父 UV）时，页才必须同步成父的。
   * 早先这里无条件按父覆盖，多页图集 + 异名链接时会出现「UV 是自己的、页却是父的」→ 取错图。
   *
   * 找父也要按 `linkedMeshSkin`（可能在别的皮肤里），不能只看当前皮肤。
   */
  for (const skin of asset.skins) {
    for (const skinSlot of skin.slots) {
      for (const attachment of skinSlot.attachments) {
        if (attachment.type !== AttachmentType.LinkedMesh) continue
        const parent = findLinkedMeshParent(asset.skins, attachment, skinSlot.slotName, attachment.linkedMeshSkin)
        if (!parent) continue
        const ownUvsValid = attachment.uvs.length > 0 && attachment.uvs.length === parent.uvs.length
        if (ownUvsValid) continue
        attachment.textureName = parent.textureName
        attachment.regionName = parent.regionName
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
  /** 被本骨架嵌套引用的子骨架（运行时 ske v2 的 `nested`） */
  nested: RuntimeSkeNested[]
}

/**
 * 导出前的准备工作：编译 → 打包 → UV 重映射，**不写任何文件**。
 * 弹窗用它实时算预览（改缩放 / 页尺寸立即重算），确认后再交给 `writeRuntimeExport`。
 */
export interface RuntimeExportPlan {
  /** 项目名（清洗过）：输出目录、图集名与页名都用它 */
  stem: string
  atlasName: string
  /** 页名（新），与 `pageSources` / `atlas.pages` 逐项对齐 */
  pageFiles: string[]
  atlas: RuntimeAtlasJson
  /**
   * 每页怎么产出：碎图打包出来的页（要编码）或本来就是图集的页（复制源文件）。
   * png 编码、写盘与弹窗预览共用同一份。
   */
  pageSources: PageSource[]
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
  /*
   * 项目名 → 输出目录 / 图集名 / 页名，**不跟骨架名走**。
   * 兜底顺序：工程里记的项目名 → 工程文件名（老工程没有 projectName 字段）→ 当前骨架名（连工程都没存过）。
   */
  const stem = sanitize(
    stripExtension(store.projectName || projectNameFromPath(store.projectPath ?? '') || store.document.armatureName) ||
      'project'
  )

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
    skeletons.push({
      name: doc.armatureName,
      stem: name,
      fileName: `${name}_ske.json`,
      asset: compiled.asset,
      nested: []
    })
  }

  /*
   * 递归收录被嵌套引用的骨架 —— **即使它没被勾选**。
   *
   * 父骨架里的 armature display 只存了骨架名，运行时按名去 `nested` 里找对应文件；
   * 少导一个子骨架，游戏里那个部件就是空的（编辑器里看得见、导出后没了）。
   */
  const indexByName = new Map(list.map((doc, i) => [doc.armatureName, i] as const))
  const exportedByName = new Map(skeletons.map((entry) => [entry.name, entry] as const))
  const queue = skeletons.map((entry) => entry.asset)
  while (queue.length > 0) {
    const asset = queue.pop() as RuntimeAsset
    for (const skin of asset.skins) {
      for (const skinSlot of skin.slots) {
        for (const attachment of skinSlot.attachments) {
          if (attachment.type !== AttachmentType.Armature) continue
          const target = attachment.subArmature
          if (!target || exportedByName.has(target)) continue
          const index = indexByName.get(target)
          if (index === undefined) {
            warnings.push(t('骨架「{0}」引用了工程里不存在的骨架「{1}」，导出时会是一个空 display', [asset.armatureName, target]))
            continue
          }
          const doc = list[index]
          const compiled = compileDocument(doc)
          for (const warning of compiled.warnings) warnings.push(`[${doc.armatureName}] ${warning}`)
          let name = sanitize(stripExtension(doc.armatureName) || `skeleton-${index + 1}`) || `skeleton-${index + 1}`
          while (usedNames.has(name)) name = `${name}_2`
          usedNames.add(name)
          const entry: ExportedSkeleton = {
            name: doc.armatureName,
            stem: name,
            fileName: `${name}_ske.json`,
            asset: compiled.asset,
            nested: []
          }
          skeletons.push(entry)
          exportedByName.set(entry.name, entry)
          queue.push(entry.asset)
        }
      }
    }
  }

  // 文件名都定下来之后再填 `nested`（引用的 file 就是被引用骨架自己的输出文件名）
  for (const entry of skeletons) {
    const names = new Set<string>()
    for (const skin of entry.asset.skins) {
      for (const skinSlot of skin.slots) {
        for (const attachment of skinSlot.attachments) {
          if (attachment.type === AttachmentType.Armature && attachment.subArmature && exportedByName.has(attachment.subArmature)) {
            names.add(attachment.subArmature)
          }
        }
      }
    }
    entry.nested = [...names].map((name) => ({ armatureName: name, file: exportedByName.get(name)?.fileName ?? '' }))
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
    warnings.push(t('本次导出的骨架没有使用任何图片，导出的图集将为空（角色会以纯色块渲染）'))
  }

  // 导出会带上「编辑器当前皮肤」作为叠加皮肤（基底 default 仍永远生效），这里明确告知
  const activeSkin = list[0]?.editorMeta.activeSkin ?? ''
  if (activeSkin && activeSkin !== 'default') {
    warnings.push(
      t('当前皮肤：{0}（作为叠加皮肤导出：基底 default + {0}；运行期仍可切换）', activeSkin)
    )
  }

  const nestedNames = [...new Set(skeletons.flatMap((entry) => entry.nested.map((item) => item.armatureName)))]
  if (nestedNames.length > 0) {
    warnings.push(
      t('包含嵌套子骨架：{0}（已一并导出；运行时按 ske 的 nested 清单加载）', nestedNames.join('、'))
    )
  }

  const packed = buildAtlas(textures, store.document.images, stem, options.maxSize, options.scale)
  warnings.push(...packed.warnings)
  for (const entry of skeletons) remapAsset(entry.asset, packed)

  return {
    stem,
    atlasName: `${stem}_atlas.json`,
    pageFiles: packed.pageFiles,
    atlas: packed.atlas,
    pageSources: packed.pageSources,
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
  // 只有打包页需要编码；复制页（本来就是图集）在下面直接读源文件
  const pngs = await encodeAtlasPages(
    plan.pageSources.map((source) => (source.kind === 'packed' ? source.plan : null)),
    async (name) => {
      if (bitmaps.has(name)) return bitmaps.get(name) ?? null
      const image = doc.images.find((entry) => entry.name === name)
      // imageUrl：Electron 下是同源 blob:，fetch / createImageBitmap 都不会被 CSP 拦
      const bitmap = image ? await loadImageBitmap(await platform.imageUrl(image.path)) : null
      bitmaps.set(name, bitmap)
      return bitmap
    }
  )

  const pageBytes = await readPageBytes(plan, pngs)
  if (pageBytes.failed.length > 0) {
    warnings.push(t('图集页 {0} 读不出内容（源图缺失或无法读取）', pageBytes.failed.join(' / ')))
  }

  const files: Array<{ path: string; text?: string; bytes?: Uint8Array }> = [
    // 每个骨架一份数据（文件名取骨架名），图集是所有骨架共用的那一份
    ...plan.skeletons.map((entry) => ({
      path: joinPath(outDir, entry.fileName),
      text: serializeRuntimeSke(entry.asset, {
        atlasFileName: plan.atlasName,
        ppu: RUNTIME_PPU,
        nested: entry.nested
      })
    })),
    { path: joinPath(outDir, plan.atlasName), text: serializeRuntimeAtlas(plan.atlas) }
  ]
  plan.pageFiles.forEach((file, index) => {
    const bytes = pageBytes.bytes[index]
    if (!bytes || bytes.length === 0) return
    files.push({ path: joinPath(outDir, file), bytes })
  })

  await platform.writeBatch(files)
  await platform.revealInFolder(joinPath(outDir, plan.skeletons[0]?.fileName ?? plan.atlasName))
  useProjectStore.getState().setWarnings(warnings)

  return {
    ok: true,
    message: t('已导出到 {0}/：{1} / {2} / {3} 张图集页', [
      baseName(outDir),
      listFiles(plan.skeletons.map((entry) => entry.fileName)),
      plan.atlasName,
      plan.pageFiles.length
    ]),
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
  const dir = await pickOutputDir(t('选择导出目录（.hao2d）'))
  if (!dir) return { ok: false, message: t('已取消'), warnings: [], files: [] }

  const compiled = compileDocument(doc)
  const warnings = [...compiled.warnings, ...collectHao2dWarnings(compiled.asset)]
  const path = joinPath(dir, defaultPath)
  await platform.writeBinary(path, writeHao2d(compiled.asset))
  store.setWarnings(warnings)

  return {
    ok: true,
    message: warnings.length > 0
      ? t('已导出 {0}（有 {1} 条与 Unity 运行时的差异提示）', [defaultPath, warnings.length])
      : t('已导出 {0}', defaultPath),
    warnings,
    files: [defaultPath]
  }
}

/**
 * 导出给 Unity：`.hao2d` + 图集 png + 每个图集页的材质与 .meta，全部写进 `<dir>/<stem>/`。
 *
 * 目录结构与 Unity 侧约定一致（Hao2D 的 ScriptedImporter 只在 `.hao2d` 同目录找纹理与材质）：
 * ```
 * <stem>/<骨架名>.hao2d        + .meta     骨骼 / 动画二进制
 * <stem>/<stem>_0.png          + .meta     图集页（meta 里带 GUID，供材质引用）
 * <stem>/<stem>_0_Hao2D.mat    + .meta     材质：Hao2D/Sprite，_MainTex → 图集页
 * ```
 * `<stem>` 是**项目名**：图集页名一律跟项目名走；已经是图集的页（导入资源带进来的）
 * 按原图 1:1 复制（扩展名沿用源文件），只有碎图才会被重新打包成 png。
 *
 * 复用与「导出运行时」同一份打包计划（同样的页、缩放与 UV 重映射），
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
    // 运行时那条「按 ske 的 nested 清单加载」提示不适用于 Unity：.hao2d 走同目录资源关联，
    // 具体提示由 collectHao2dWarnings 给出（点名需要一起导出的子骨架）
    ...plan.warnings.filter((warning) => !warning.includes('嵌套子骨架')),
    ...plan.skeletons.flatMap((entry) => collectHao2dWarnings(entry.asset))
  ])
  const outDir = joinPath(dir, plan.stem)

  // png 编码要读源图：先登记它们的目录（与运行时导出同一条路径）
  for (const image of doc.images) {
    const imageDir = dirName(image.path)
    if (imageDir) await platform.registerAssetRoot(imageDir)
  }
  const bitmaps = new Map<string, ImageBitmap | null>()
  const pngs = await encodeAtlasPages(
    plan.pageSources.map((source) => (source.kind === 'packed' ? source.plan : null)),
    async (name) => {
      if (bitmaps.has(name)) return bitmaps.get(name) ?? null
      const image = doc.images.find((entry) => entry.name === name)
      const bitmap = image ? await loadImageBitmap(await platform.imageUrl(image.path)) : null
      bitmaps.set(name, bitmap)
      return bitmap
    }
  )
  const pageBytes = await readPageBytes(plan, pngs)
  if (pageBytes.failed.length > 0) {
    warnings.push(t('图集页 {0} 读不出内容（源图缺失或无法读取），对应的材质也未生成', pageBytes.failed.join(' / ')))
  }

  const files: Array<{ path: string; text?: string; bytes?: Uint8Array }> = []
  const sheetCount = plan.pageFiles.length
  const materialCount = plan.pageFiles.length

  for (let index = 0; index < plan.pageFiles.length; index++) {
    const pageFile = plan.pageFiles[index]
    const bytes = pageBytes.bytes[index]
    if (!bytes || bytes.length === 0) continue
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

  const parts = [
    listFiles(hao2dFiles),
    t('{0} 张图集页', sheetCount),
    t('{0} 个材质（Hao2D/Sprite）', materialCount)
  ]
  let message = t('已导出到 {0}/：{1}', [baseName(outDir), parts.join(' / ')])
  if (warnings.length > 0) message += t('；{0} 条与 Unity 运行时的差异提示', warnings.length)
  if (warnings.length > 0) console.warn('[hao2d] Unity 导出告警：', warnings)
  return {
    ok: true,
    message,
    warnings,
    files: files.map((file) => baseName(file.path))
  }
}

/**
 * 取每一页的最终字节，与 `plan.pageFiles` 逐项对齐：
 *
 * - 打包页：用 `encodeAtlasPages` 编出来的 PNG；
 * - 复制页（本来就是图集）：**直接读源文件的原始字节** —— 不做任何重编码，
 *   美术给的图集页原样落盘（也省掉一次解码 + 编码）。
 *
 * 读不到的页只记名字，由调用方合并成一条告警（免得一张图报一次）。
 */
export async function readPageBytes(
  plan: RuntimeExportPlan,
  encoded: readonly Uint8Array[]
): Promise<{ bytes: Uint8Array[]; failed: string[] }> {
  const platform = getPlatform()
  const bytes: Uint8Array[] = []
  const failed: string[] = []
  for (let index = 0; index < plan.pageFiles.length; index++) {
    const source = plan.pageSources[index]
    if (!source) {
      bytes.push(new Uint8Array())
      continue
    }
    const data = source.kind === 'copy' ? await platform.readBinary(source.path) : encoded[index]
    if (!data || data.length === 0) {
      failed.push(plan.pageFiles[index] ?? `#${index}`)
      bytes.push(new Uint8Array())
      continue
    }
    bytes.push(data)
  }
  return { bytes, failed }
}

/** 「导出运行时」预览包：不写任何文件，只把资源编进内存，交给主进程的本地网页服务 */
export interface Hao2dPreviewPack {
  pages: Array<{ name: string; bytes: Uint8Array }>
  skeletons: Array<{
    id: string
    name: string
    skeText: string
    atlasText: string
    animations: string[]
    skins: string[]
    defaultAnimation: string
    defaultSkin: string
    /** 被嵌套引用的子骨架（按 id 从同一预览包里取） */
    nested: Array<{ armatureName: string; id: string }>
  }>
  warnings: string[]
}

/**
 * 从「导出运行时」计划生成预览包（内存）。
 *
 * 复用与 `writeRuntimeExport` 完全相同的编码 / 序列化路径，只是不落盘：
 * 图集页编成 PNG 字节（复制页直接读源文件），每个骨架序列化出 ske/atlas 文本。
 * 预览页用项目里的 hao2d 计算方式（`loadRuntime`）解码，再用 pixi.js 渲染。
 */
export async function buildHao2dPreviewBundles(plan: RuntimeExportPlan): Promise<Hao2dPreviewPack> {
  const platform = getPlatform()
  const doc = useProjectStore.getState().document
  for (const image of doc.images) {
    const imageDir = dirName(image.path)
    if (imageDir) await platform.registerAssetRoot(imageDir)
  }
  const bitmaps = new Map<string, ImageBitmap | null>()
  const pngs = await encodeAtlasPages(
    plan.pageSources.map((source) => (source.kind === 'packed' ? source.plan : null)),
    async (name) => {
      if (bitmaps.has(name)) return bitmaps.get(name) ?? null
      const image = doc.images.find((entry) => entry.name === name)
      const bitmap = image ? await loadImageBitmap(await platform.imageUrl(image.path)) : null
      bitmaps.set(name, bitmap)
      return bitmap
    }
  )
  const pageBytes = await readPageBytes(plan, pngs)
  // pageFiles 与 pageBytes 严格同序（readPageBytes 按 plan.pageFiles 对齐），且与 atlas.pages[].image 同名，纹理才能对上
  const pages = plan.pageFiles
    .map((name, index) => ({ name, bytes: pageBytes.bytes[index] ?? new Uint8Array() }))
    .filter((page) => page.bytes && page.bytes.length > 0)
  const idByFile = new Map(plan.skeletons.map((entry, index) => [entry.fileName, `s${index}`] as const))
  const skeletons = plan.skeletons.map((entry, index) => ({
    id: `s${index}`,
    name: entry.name,
    skeText: serializeRuntimeSke(entry.asset, {
      atlasFileName: plan.atlasName,
      ppu: RUNTIME_PPU,
      nested: entry.nested
    }),
    atlasText: serializeRuntimeAtlas(plan.atlas),
    animations: entry.asset.animations.map((animation) => animation.name),
    skins: entry.asset.skins.map((skin) => skin.name),
    defaultAnimation: entry.asset.animations[0]?.name ?? '',
    // 叠加皮肤 = 导出时编辑器正在编辑的皮肤（基底皮肤由 asset.defaultSkinIndex 决定）
    defaultSkin: entry.asset.defaultSkin,
    nested: entry.nested
      .map((item) => ({ armatureName: item.armatureName, id: idByFile.get(item.file) ?? '' }))
      .filter((item) => item.id.length > 0)
  }))
  return { pages, skeletons, warnings: pageBytes.failed }
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
  return t('{0} 等 {1} 个', [names.slice(0, 3).join(' / '), names.length])
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

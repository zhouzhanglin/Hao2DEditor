import { getPlatform, baseName, dirName, joinPath, stripExtension } from '../platform'
import { parseDocument, serializeDocument, PROJECT_EXTENSION } from '@core/codec/projectJson'
import { decompileAsset } from '@core/codec/decompile'
import { createEmptyDocument } from '@core/model/authoring'
import type { EditorDocument } from '@core/model/authoring'
import { createSampleDocument } from '@core/sample'
import { importSpine } from '@importers/spine'
import { importDragonBones } from '@importers/dragonBones'
import { parseSpineAtlas } from '@importers/atlasSpine'
import { dbTextureNames, parseDbTextureJson } from '@importers/dragonBonesAtlas'
import { detectSkeletonFormat, isDbTextureJson } from '@importers/detect'
import { registerLooseImages } from '@importers/looseImages'
import type { AtlasRegion, PageSizes } from '@importers/uv'
import { useProjectStore } from '../store/projectStore'

export interface IoResult {
  ok: boolean
  message: string
  warnings?: string[]
}

const PROJECT_FILTER = [{ name: 'Hao2D 工程', extensions: [PROJECT_EXTENSION, 'json'] }]

function fail(message: string): IoResult {
  console.error(`[hao2d] ${message}`)
  return { ok: false, message }
}

/** 读取同名图集页的实际像素尺寸与绝对路径 */
async function resolvePageImages(
  pageNames: readonly string[],
  dir: string,
  entries: Awaited<ReturnType<ReturnType<typeof getPlatform>['listDir']>>
): Promise<{ pageSizes: PageSizes; pageImages: Record<string, string> }> {
  const platform = getPlatform()
  const pageSizes: PageSizes = {}
  const pageImages: Record<string, string> = {}
  const candidates = entries.filter((entry) => !entry.isDirectory)
  const paths: string[] = []
  const nameOf = new Map<string, string>()

  for (const page of pageNames) {
    const stem = stripExtension(page).toLowerCase()
    const hit =
      candidates.find((e) => e.name.toLowerCase() === page.toLowerCase()) ??
      candidates.find((e) => stripExtension(e.name).toLowerCase() === stem)
    if (!hit) continue
    const path = joinPath(dir, hit.name)
    paths.push(path)
    nameOf.set(path, page)
  }

  if (paths.length > 0) {
    const infos = await platform.imageInfo(paths)
    for (const info of infos) {
      const page = nameOf.get(info.path) ?? baseName(info.path)
      pageSizes[page] = { width: info.width, height: info.height }
      pageImages[page] = info.path
    }
  }
  return { pageSizes, pageImages }
}

export function newProject(): IoResult {
  useProjectStore.getState().setDocument(createEmptyDocument(), null, false)
  useProjectStore.getState().setWarnings([])
  return { ok: true, message: '已新建空白工程' }
}

export function loadSample(): IoResult {
  useProjectStore.getState().setDocument(createSampleDocument(), null, true)
  return { ok: true, message: '已载入内置示例角色' }
}

export async function openProject(): Promise<IoResult> {
  const platform = getPlatform()
  const picked = await platform.pickFiles({ filters: PROJECT_FILTER, multi: false })
  if (picked.length === 0) return { ok: false, message: '已取消' }
  return openProjectAt(picked[0])
}

/**
 * 打开指定路径的工程（最近打开列表也用这个入口）。
 *
 * 失败时**不会**动当前文档：先完整读取 + 解析成功，再替换 store，
 * 因此不需要回滚逻辑，也不会出现「打开失败但工程已被清空」的情况。
 */
export async function openProjectAt(path: string): Promise<IoResult> {
  const platform = getPlatform()
  const text = await platform.readText(path)
  if (!text) return fail(`无法读取工程文件：${path}`)

  const parsed = parseDocument(text)
  useProjectStore.getState().setDocument(parsed.document, path, false)
  useProjectStore.getState().setWarnings(parsed.warnings)
  await platform.recentAdd(path)
  return { ok: true, message: `已打开 ${baseName(path)}`, warnings: parsed.warnings }
}

/** 最近打开的工程列表（含存在性提示由主进程负责） */
export async function recentProjects(): Promise<string[]> {
  return getPlatform().recentList()
}

export async function saveProject(saveAs: boolean): Promise<IoResult> {
  const platform = getPlatform()
  const store = useProjectStore.getState()
  let path = saveAs ? null : store.projectPath
  if (!path) {
    path = await platform.pickSavePath({
      defaultPath: `${store.document.armatureName}.${PROJECT_EXTENSION}`,
      filters: PROJECT_FILTER
    })
  }
  if (!path) return { ok: false, message: '已取消' }

  await platform.writeText(path, serializeDocument(store.document))
  store.markSaved(path)
  await platform.recentAdd(path)
  return { ok: true, message: `已保存到 ${baseName(path)}` }
}

export async function importSpineFlow(): Promise<IoResult> {
  const platform = getPlatform()
  const picked = await platform.pickFiles({
    filters: [{ name: 'Spine 骨骼 JSON', extensions: ['json'] }],
    multi: false
  })
  if (picked.length === 0) return { ok: false, message: '已取消' }

  const jsonPath = picked[0]
  const text = await platform.readText(jsonPath)
  if (!text) return fail(`无法读取 ${baseName(jsonPath)}`)

  const json = JSON.parse(text) as unknown
  const format = detectSkeletonFormat(json)
  if (format !== 'spine') {
    return fail(`不是 Spine 骨骼文件（检测到 ${format}），请选择含 "skeleton" 段的 JSON`)
  }

  const dir = dirName(jsonPath)
  const entries = await platform.listDir(dir, false)
  const atlasEntry = entries.find((entry) => /\.atlas(\.txt)?$/i.test(entry.name))
  if (!atlasEntry) return fail(`同目录下没有找到 .atlas 图集文件：${dir}`)

  const atlasText = await platform.readText(atlasEntry.path)
  const parsed = parseSpineAtlas(atlasText)
  const pageNames = Object.keys(parsed.pageSizes)
  const { pageSizes, pageImages } = await resolvePageImages(pageNames, dir, entries)

  const result = importSpine({
    json: json as never,
    regions: parsed.regions,
    pageSizes,
    pageImages
  })
  const document = finishImport(result.asset, pageImages, pageSizes)
  const warnings = [...parsed.warnings, ...result.warnings]
  useProjectStore.getState().setWarnings(warnings)
  return {
    ok: true,
    message: `已导入 Spine：${document.bones.length} 骨骼 / ${document.slots.length} 插槽 / ${document.animations.length} 动画`,
    warnings
  }
}

export async function importDragonBonesFlow(): Promise<IoResult> {
  const platform = getPlatform()
  const picked = await platform.pickFiles({
    filters: [{ name: 'DragonBones 骨骼 JSON', extensions: ['json'] }],
    multi: false
  })
  if (picked.length === 0) return { ok: false, message: '已取消' }

  const jsonPath = picked[0]
  const text = await platform.readText(jsonPath)
  if (!text) return fail(`无法读取 ${baseName(jsonPath)}`)

  const json = JSON.parse(text) as unknown
  const format = detectSkeletonFormat(json)
  if (format === 'dbTexture') return fail('这是图集文件，请选择含 "armature" 段的骨骼 JSON')
  if (format !== 'dragonbones') return fail(`不是 DragonBones 骨骼文件（检测到 ${format}）`)

  const dir = dirName(jsonPath)
  const entries = await platform.listDir(dir, false)
  const warnings: string[] = []
  const armatureName = (json as { name?: string }).name ?? ''
  const subTextures = []
  const textureJsons: Record<string, { width: number; height: number }> = {}

  const jsonEntries = entries.filter((entry) => !entry.isDirectory && /\.json$/i.test(entry.name))
  const collected: Array<{ name: string; priority: number }> = []
  for (const entry of jsonEntries) {
    if (entry.path === jsonPath) continue
    const content = await platform.readText(entry.path)
    if (!content) continue
    const parsed = JSON.parse(content) as unknown
    if (!isDbTextureJson(parsed)) continue
    collected.push({ name: entry.name, priority: armatureName && stripExtension(entry.name) === armatureName ? 0 : 1 })
  }
  collected.sort((a, b) => a.priority - b.priority)

  const pageSizes: PageSizes = {}
  const pageImages: Record<string, string> = {}
  for (const entry of collected) {
    const content = await platform.readText(joinPath(dir, entry.name))
    if (!content) continue
    const parsed = JSON.parse(content) as never
    const page = (parsed as { imagePath?: string }).imagePath ?? stripExtension(entry.name)
    const info = await platform.imageInfo([joinPath(dir, page)])
    if (info[0]) {
      pageSizes[page] = { width: info[0].width, height: info[0].height }
      pageImages[page] = info[0].path
    }
    subTextures.push(...parseDbTextureJson(parsed, pageSizes))
    void textureJsons
  }
  if (subTextures.length === 0) return fail(`同目录下没有找到图集（texture_*.json）：${dir}`)

  const result = importDragonBones({
    json: json as never,
    subTextures,
    pageSizes,
    pageImages
  })
  const document = finishImport(result.asset, pageImages, pageSizes)
  warnings.push(...result.warnings)
  warnings.push(`合并 ${dbTextureNames(subTextures).length} 张图集页`)
  useProjectStore.getState().setWarnings(warnings)
  return {
    ok: true,
    message: `已导入 DragonBones：${document.bones.length} 骨骼 / ${document.slots.length} 插槽 / ${document.animations.length} 动画`,
    warnings
  }
}

/** Runtime → Authoring，并把图集页的真实路径写进图片清单 */
function finishImport(
  asset: ReturnType<typeof importSpine>['asset'],
  pageImages: Record<string, string>,
  pageSizes: PageSizes
): EditorDocument {
  const document = decompileAsset(asset)
  document.images = document.images.map((image) => ({
    ...image,
    path: pageImages[image.name] ?? image.path,
    width: pageSizes[image.name]?.width ?? image.width,
    height: pageSizes[image.name]?.height ?? image.height,
    loose: false
  }))
  useProjectStore.getState().setDocument(document, null, true)
  return document
}

export async function importImagesFlow(paths?: readonly string[]): Promise<IoResult> {
  const platform = getPlatform()
  const picked = paths && paths.length > 0
    ? [...paths]
    : await platform.pickFiles({
        filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
        multi: true
      })
  if (picked.length === 0) return { ok: false, message: '已取消' }

  const infos = await platform.imageInfo(picked)
  const inputs = infos.length > 0
    ? infos.map((info) => ({ path: info.path, name: baseName(info.path), width: info.width, height: info.height }))
    : picked.map((path) => ({ path, name: baseName(path), width: 0, height: 0 }))

  const existing = useProjectStore.getState().document.images
  const { images, warnings } = registerLooseImages(inputs, existing)
  useProjectStore.getState().update('导入图片', (draft) => {
    draft.images = images.map((image) => ({
      name: image.name,
      path: image.path,
      width: image.width,
      height: image.height,
      loose: image.loose ?? true
    }))
  })
  useProjectStore.getState().setWarnings(warnings)
  const added = images.length - existing.length
  return {
    ok: true,
    message: added > 0 ? `已导入 ${added} 张图片` : '没有新增图片（可能已存在）',
    warnings
  }
}

/** 拖入窗口的文件：按内容分派到对应导入流程 */
export async function importDroppedPaths(paths: readonly string[]): Promise<IoResult> {
  const platform = getPlatform()
  const images = paths.filter((p) => /\.(png|jpg|jpeg|webp|gif|bmp)$/i.test(p))
  const jsons = paths.filter((p) => /\.json$/i.test(p))
  const atlases = paths.filter((p) => /\.atlas(\.txt)?$/i.test(p))

  if (images.length > 0 && jsons.length === 0) {
    return importImagesFlow(images)
  }

  if (jsons.length > 0) {
    const text = await platform.readText(jsons[0])
    const parsed = JSON.parse(text) as unknown
    const format = detectSkeletonFormat(parsed)
    if (format === 'spine') {
      if (atlases.length > 0) {
        // 同时拖入了 atlas：直接按 Spine 处理
        const dir = dirName(jsons[0])
        const entries = await platform.listDir(dir, false)
        const atlasText = await platform.readText(atlases[0])
        const atlas = parseSpineAtlas(atlasText)
        const pageNames = Object.keys(atlas.pageSizes)
        const resolved = await resolvePageImages(pageNames, dir, entries)
        const result = importSpine({
          json: parsed as never,
          regions: atlas.regions,
          pageSizes: resolved.pageSizes,
          pageImages: resolved.pageImages
        })
        const document = finishImport(result.asset, resolved.pageImages, resolved.pageSizes)
        return {
          ok: true,
          message: `已导入 Spine（拖入）：${document.bones.length} 骨骼 / ${document.animations.length} 动画`,
          warnings: [...atlas.warnings, ...result.warnings]
        }
      }
      useProjectStore.getState().setWarnings([`请同时拖入同目录的 .atlas 图集文件（或使用「导入 Spine」菜单）`])
      return importSpineFlow()
    }
    if (format === 'dragonbones') return importDragonBonesFlow()
  }

  const loose = await importImagesFlow(imageLeaves(paths))
  return loose
}

/** 兜底：把无法识别的路径按图片尝试导入 */
function imageLeaves(paths: readonly string[]): string[] {
  return paths.filter((p) => /\.(png|jpg|jpeg|webp|gif|bmp)$/i.test(p))
}

export type { AtlasRegion }

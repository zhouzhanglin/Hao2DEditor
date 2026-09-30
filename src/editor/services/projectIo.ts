import { getPlatform, baseName, dirName, joinPath, stripExtension } from '../platform'
import type { Platform } from '../platform'
import { parseDocument, serializeDocument, PROJECT_EXTENSION } from '@core/codec/projectJson'
import { decompileAsset } from '@core/codec/decompile'
import { createAuthoringBone, createEmptyDocument } from '@core/model/authoring'
import type { EditorDocument } from '@core/model/authoring'
import { importSpine } from '@importers/spine'
import { importDragonBones } from '@importers/dragonBones'
import { parseSpineAtlas } from '@importers/atlasSpine'
import { dbTextureNames, parseDbTextureJson } from '@importers/dragonBonesAtlas'
import { detectSkeletonFormat, isDbTextureJson } from '@importers/detect'
import { registerLooseImages } from '@importers/looseImages'
import { ASSET_DIR, copyAssets, planAssetCopies, resolveImagePaths } from './projectAssets'
import type { AtlasRegion, PageSizes } from '@importers/uv'
import { useProjectStore } from '../store/projectStore'

export interface IoResult {
  ok: boolean
  message: string
  warnings?: string[]
}

/**
 * 工程文件过滤器。除了新后缀 `.hao2d.proj`，也放开旧的 `.hao2dproj` 与 `.json`，
 * 这样早期存下来的工程仍然能在文件对话框里选到（解析只看内容，不看后缀）。
 */
const PROJECT_FILTER = [{ name: 'Hao2D 工程', extensions: [PROJECT_EXTENSION, 'hao2dproj', 'json'] }]

/** 保存对话框里的默认文件名：优先用骨架名，为空时用 project */
function defaultFileName(armatureName: string): string {
  const name = armatureName.trim()
  return `${name.length > 0 ? name : 'project'}.${PROJECT_EXTENSION}`
}

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
  const doc = createEmptyDocument()
  // 新工程默认给一根根骨骼：插槽必须挂在骨骼上，有个 root 拖图 / 建插槽都能直接开工
  doc.bones.push({ ...createAuthoringBone({ name: 'root', length: 0.4 }) })
  useProjectStore.getState().setDocument(doc, null, false)
  useProjectStore.getState().setWarnings([])
  return { ok: true, message: '已新建工程（含根骨骼 root）' }
}

/**
 * 上次打开的工程：取最近列表第一条，并确认文件仍然存在。
 * 返回 null 表示没有历史记录、或文件已被移动 / 删除（此时保持空白工程）。
 */
export async function lastProject(): Promise<string | null> {
  const platform = getPlatform()
  const [latest] = await platform.recentList()
  if (!latest) return null
  return (await platform.exists(latest)) ? latest : null
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

  // 解析失败也要走 fail 分支：启动时自动打开上次工程，坏文件不能把启动流程带崩
  let parsed: ReturnType<typeof parseDocument>
  try {
    parsed = parseDocument(text)
  } catch (error) {
    return fail(`工程文件解析失败：${error instanceof Error ? error.message : String(error)}`)
  }
  // 工程自带的图片存的是相对路径（images/xxx）：按工程文件所在目录解析成绝对路径，
  // 之后预览 / 渲染 / 导出都按绝对路径读文件，不用再关心工程被移到哪里
  parsed.document.images = resolveImagePaths(parsed.document.images, dirName(path))
  useProjectStore.getState().setDocument(parsed.document, path, false)
  useProjectStore.getState().setWarnings(parsed.warnings)
  await platform.recentAdd(path)
  return { ok: true, message: `已打开 ${baseName(path)}`, warnings: parsed.warnings }
}

/** 最近打开的工程列表（含存在性提示由主进程负责） */
export async function recentProjects(): Promise<string[]> {
  return getPlatform().recentList()
}

/**
 * 保存工程。
 *
 * 用到的图片会一并复制到 `<工程目录>/images/`，工程文件里改存相对路径 ——
 * 整个工程文件夹可以随意搬走 / 打包，不再依赖图片原来的位置。
 * 图片复制失败不阻塞保存（工程本身照常写出，问题在提示里说明）。
 */
export async function saveProject(saveAs: boolean): Promise<IoResult> {
  const platform = getPlatform()
  const store = useProjectStore.getState()
  let path = saveAs ? null : store.projectPath
  if (!path) {
    path = await platform.pickSavePath({
      defaultPath: defaultFileName(store.document.armatureName),
      filters: PROJECT_FILTER
    })
  }
  if (!path) return { ok: false, message: '已取消' }
  // 统一成 .hao2d.proj：没写后缀就补上，写了别的后缀（.json 除外，兼容老工程）就替换掉。
  // 复合后缀必须整串判断——`path.extname('a.hao2d.proj')` 只会给出 `.proj`。
  if (!new RegExp(`\\.(${PROJECT_EXTENSION.replace(/\./g, '\\.')}|json)$`, 'i').test(path)) {
    path = `${path.replace(/\.[^./\\]+$/, '')}.${PROJECT_EXTENSION}`
  }

  // 图片随工程走：先复制到 images/，工程文件里用相对路径写入
  const plan = planAssetCopies(store.document.images, dirName(path))
  const copied = await copyAssets(plan.copies, platform, platform)

  await platform.writeText(path, serializeDocument({ ...store.document, images: plan.images }))
  store.markSaved(path)
  await platform.recentAdd(path)

  const total = store.document.images.length
  const parts: string[] = []
  if (copied.copied > 0) parts.push(`${copied.copied} 张图片已复制到 ${ASSET_DIR}/`)
  // 没有复制任务：图片本来就随工程（上次已复制过，或本身就是工程内联数据）
  else if (total > 0 && copied.warnings.length === 0) parts.push(`${total} 张图片已在工程内`)
  let message = `已保存到 ${baseName(path)}`
  if (parts.length > 0) message += `（${parts.join('，')}）`
  if (copied.warnings.length > 0) message += `；${copied.warnings[0]}`
  if (copied.warnings.length > 0) console.warn('[hao2d] 图片复制告警：', copied.warnings)
  return { ok: true, message, warnings: copied.warnings.length > 0 ? copied.warnings : undefined }
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

const IMAGE_EXT_RE = /\.(png|jpg|jpeg|webp|gif|bmp)$/i

/**
 * 展开拖入的路径：**文件夹会递归取出里面的所有图片**（其余类型忽略），文件原样保留。
 *
 * Electron 下靠 platform.listDir 判断（对文件返回空列表）；浏览器内存模式也返回空列表，
 * 等价于「都不是文件夹」，行为退化成原来的按文件分派。
 */
async function expandDroppedPaths(
  platform: Platform,
  paths: readonly string[]
): Promise<{ list: string[]; folderImages: number }> {
  const list: string[] = []
  let folderImages = 0
  for (const path of paths) {
    const entries = await platform.listDir(path, true)
    if (entries.length === 0) {
      list.push(path)
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory) continue
      if (!IMAGE_EXT_RE.test(entry.path)) continue
      list.push(entry.path)
      folderImages++
    }
  }
  return { list, folderImages }
}

/** 拖入窗口的文件：按内容分派到对应导入流程（文件夹会展开成里面的图片） */
export async function importDroppedPaths(paths: readonly string[]): Promise<IoResult> {
  const platform = getPlatform()

  const { list, folderImages } = await expandDroppedPaths(platform, paths)
  if (list.length === 0) {
    return {
      ok: false,
      message: '拖入的文件夹里没有可导入的图片（支持 png / jpg / webp / gif / bmp）'
    }
  }

  // 拖入工程文件 = 打开工程
  const project = list.find((p) => /\.(hao2d\.proj|hao2dproj)$/i.test(p))
  if (project) return openProjectAt(project)

  const images = list.filter((p) => IMAGE_EXT_RE.test(p))
  const jsons = list.filter((p) => /\.json$/i.test(p))
  const atlases = list.filter((p) => /\.atlas(\.txt)?$/i.test(p))

  if (images.length > 0 && jsons.length === 0) {
    const result = await importImagesFlow(images)
    return folderImages > 0
      ? { ...result, message: `${result.message}（文件夹里找到 ${folderImages} 张图片）` }
      : result
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

  const leaves = imageLeaves(list)
  if (leaves.length === 0) {
    return {
      ok: false,
      message: '拖入的内容里没有可导入的图片（支持 png / jpg / webp / gif / bmp；文件夹会递归查找）'
    }
  }
  const loose = await importImagesFlow(leaves)
  return folderImages > 0
    ? { ...loose, message: `${loose.message}（文件夹里找到 ${folderImages} 张图片）` }
    : loose
}

/** 兜底：把无法识别的路径按图片尝试导入 */
function imageLeaves(paths: readonly string[]): string[] {
  return paths.filter((p) => /\.(png|jpg|jpeg|webp|gif|bmp)$/i.test(p))
}

export type { AtlasRegion }

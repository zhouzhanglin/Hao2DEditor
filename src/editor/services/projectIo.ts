import { getPlatform, baseName, dirName, joinPath, stripExtension } from '../platform'
import { AI_TRANSPORT_NOTICE } from '@shared/commandTypes'
import type { Platform } from '../platform'
import { parseProject, projectNameFromPath, serializeProject, PROJECT_EXTENSION } from '@core/codec/projectJson'
import { decompileAsset } from '@core/codec/decompile'
import type { EditorDocument } from '@core/model/authoring'
import { importSpine } from '@importers/spine'
import { importDragonBones } from '@importers/dragonBones'
import { parseSpineAtlas } from '@importers/atlasSpine'
import { dbTextureNames, parseDbTextureJson } from '@importers/dragonBonesAtlas'
import { detectSkeletonFormat, isDbTextureJson } from '@importers/detect'
import { registerLooseImages } from '@importers/looseImages'
import { ASSET_DIR, copyAssets, planAssetCopies, resolveImagePaths } from './projectAssets'
import { openPsdDialog, parsePsdAt } from './psdImport'
import type { AtlasRegion, PageSizes } from '@importers/uv'
import { DEFAULT_PROJECT_NAME, useProjectStore } from '../store/projectStore'
import { useModeStore } from '../store/modeStore'
import { useTimelineStore } from '../store/timelineStore'
import { getActiveScene } from '../activeScene'
import { releaseDocumentAssets } from './assetCache'

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

/**
 * 无弹窗的快捷新建（浏览器预览 / 测试用）：走 store 的 `reset()` ——
 * 默认项目名 `hao2dProject` + 一根 root，与「新建项目」弹窗的结果完全一致。
 */
export function newProject(): IoResult {
  // 先丢掉上个项目的图片 / 图集内存，再换文档（顺序原因见 releaseDocumentAssets）
  releaseDocumentAssets()
  useProjectStore.getState().reset()
  return { ok: true, message: '已新建项目（含根骨骼 root）' }
}

/**
 * 上次打开的工程：取最近列表第一条，并确认文件仍然存在。
 * 返回 null 表示没有历史记录、或文件已被移动 / 删除（此时保持空白工程）。
 */
/** 文件名里不能出现的字符替换掉（项目名会直接当文件名用） */
function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim()
}

/**
 * 新建项目（「新建项目」弹窗确认后调用）：重置工程 → 记住项目名与保存位置 → **立刻写出**工程文件。
 *
 * 新项目的图片池是空的：图片留给后面的「导入图片 / 导入 Spine / 导入 DragonBones」。
 */
export async function createProjectAt(name: string, dir: string, frameRate?: number): Promise<IoResult> {
  const platform = getPlatform()
  const trimmed = name.trim()
  if (trimmed.length === 0) return fail('项目名不能为空')
  if (!dir) return fail('请先选择保存位置')
  const path = joinPath(dir, `${safeFileName(trimmed)}.${PROJECT_EXTENSION}`)

  // 新项目的图片池是空的：先把上个项目占着的图片 / 图集内存放掉，再换文档
  releaseDocumentAssets()
  const store = useProjectStore.getState()
  store.reset()
  // 帧率：用户选的（24/30/60）优先，否则退回默认的 30（与 createEmptyDocument 一致）
  const fps = frameRate && frameRate > 0 ? frameRate : 30
  if (fps !== useProjectStore.getState().document.frameRate) {
    useProjectStore.setState((s) => ({
      document: { ...s.document, frameRate: fps },
      skeletons: s.skeletons.map((skeleton) => ({ ...skeleton, frameRate: fps }))
    }))
  }
  store.setProjectInfo({ projectName: trimmed, projectPath: path })
  const saved = await saveProject(false)
  if (!saved.ok) return saved
  return { ok: true, message: `已新建项目「${trimmed}」：${baseName(path)}`, warnings: saved.warnings }
}

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
/**
 * 把 AI 接入所需的「说明书 + 连接信息」写出到工程目录：
 * - hao2d-ai-command-api.md：命令接口文档（让 AI 工具开箱即用地知道怎么调，免配置、免 MCP）
 * - hao2d-ai-server.json：当前命令服务的 url + token（每次保存/打开刷新，因为 token 每次启动重新生成）
 *
 * 这样 Codex / CodeBuddy 这类在本工程目录里干活的 AI 工具，打开文件夹就能直接上手，
 * 不用配 MCP、也不用手粘提示词。文档本身已说明「优先读工程目录下的 hao2d-ai-server.json」。
 */
const AI_API_DOC_NAME = 'hao2d-ai-command-api.md'
const AI_SERVER_INFO_NAME = 'hao2d-ai-server.json'

async function exportAiCompanionFiles(projectDir: string): Promise<void> {
  if (!projectDir) return
  const platform = getPlatform()
  // 文档：原样拷贝（文档第 7 节已说明优先读工程目录下的 hao2d-ai-server.json）
  const doc = await platform.aiCommandApiDoc()
  if (doc.ok && doc.data.text.length > 0) {
    await platform.writeText(joinPath(projectDir, AI_API_DOC_NAME), doc.data.text)
  }
  // 连接信息：命令服务在跑才写（拿得到当前有效、没过期的 url + token）
  const mcp = await platform.aiMcpInfo()
  if (mcp.ok && mcp.data.running) {
    const payload = {
      url: mcp.data.url,
      token: mcp.data.token,
      updatedAt: new Date().toISOString(),
      // 通信指引：AI 读连接信息时同步读到「别用 curl」（与 MCP instructions、GET /commands 顶层一致）
      instructions: AI_TRANSPORT_NOTICE,
      note: '由 Hao2DEditor 在保存/打开工程时自动生成。编辑器关闭后命令服务停止、token 失效；重新打开编辑器并保存/打开工程即可刷新本文件。'
    }
    await platform.writeText(joinPath(projectDir, AI_SERVER_INFO_NAME), `${JSON.stringify(payload, null, 2)}\n`)
  }
}

export async function openProjectAt(path: string): Promise<IoResult> {
  const platform = getPlatform()
  const text = await platform.readText(path)
  if (!text) return fail(`无法读取工程文件：${path}`)

  // 解析失败也要走 fail 分支：启动时自动打开上次工程，坏文件不能把启动流程带崩
  let parsed: ReturnType<typeof parseProject>
  try {
    parsed = parseProject(text)
  } catch (error) {
    return fail(`工程文件解析失败：${error instanceof Error ? error.message : String(error)}`)
  }
  // 工程自带的图片存的是相对路径（images/xxx）：按工程文件所在目录解析成绝对路径，
  // 之后预览 / 渲染 / 导出都按绝对路径读文件，不用再关心工程被移到哪里
  // 图片池由全部骨架共享：解析一次，再把同一份指给每个骨架
  const pool = resolveImagePaths(parsed.skeletons[parsed.activeSkeleton]?.images ?? [], dirName(path))
  // 资源面板的缩略图走 hao2d-file:// 协议，主进程只允许读**已登记资源根**以内的文件；
  // 打开工程只读了 JSON，从不登记图片目录 → 缩略图全部被 403 拒绝，变成破图
  //（视口不受影响：那边走 readBinary → blob:，不经过协议）。
  // 这里把工程目录与每张图片所在目录补登记：图片在工程目录内时是同一个根，
  // 老工程引用外部目录的图片也能正常显示。
  const roots = new Set<string>()
  const projectDir = dirName(path)
  if (projectDir) roots.add(projectDir)
  for (const image of pool) {
    const dir = dirName(image.path)
    if (dir) roots.add(dir)
  }
  for (const dir of roots) await platform.registerAssetRoot(dir)
  useProjectStore
    .getState()
    .setProject(
      parsed.skeletons.map((skeleton) => ({ ...skeleton, images: pool })),
      parsed.activeSkeleton,
      path,
      false
    )
  useProjectStore.getState().setWarnings(parsed.warnings)
  // 项目名随文件走：老工程没有 projectName 字段 → 用**工程文件名**兜底
  //（导出目录 / 图集名 / 图集页名都跟项目名走，别退化成骨架名）
  useProjectStore.getState().setProjectInfo({
    projectName: parsed.projectName || projectNameFromPath(path)
  })
  await platform.recentAdd(path)
  const suffix = parsed.skeletons.length > 1 ? `（${parsed.skeletons.length} 个骨架）` : ''
  // 命令服务的 token 可能已变：刷新工程目录里的连接信息，让 AI 工具拿到有效凭证
  await exportAiCompanionFiles(projectDir)
  return { ok: true, message: `已打开 ${baseName(path)}${suffix}`, warnings: parsed.warnings }
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
      defaultPath: defaultFileName(store.projectName || store.document.armatureName),
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

  // 一个项目可以有多个骨架：全部写进去；图片池只写顶层那一份（工程内相对路径）
  const skeletons = store.skeletons.map((skeleton) => ({ ...skeleton, images: plan.images }))
  await platform.writeText(path, serializeProject(skeletons, store.activeSkeleton, store.projectName))
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
  // 把 AI 接入的说明书 + 连接信息写到工程目录（免配置、免 MCP 让 AI 工具上手）
  await exportAiCompanionFiles(dirName(path))
  return { ok: true, message, warnings: copied.warnings.length > 0 ? copied.warnings : undefined }
}

export async function importSpineFlow(sourcePath?: string): Promise<IoResult> {
  const platform = getPlatform()
  // 调用方（AI 命令）直接给路径时不弹对话框；同目录的 .atlas 仍需存在（下面会找）
  const picked = sourcePath ? [sourcePath] : await platform.pickFiles({
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
    pageImages,
    atlasText
  })
  const document = finishImport(result.asset, pageImages, pageSizes, jsonPath)
  const warnings = [...parsed.warnings, ...result.warnings]
  useProjectStore.getState().setWarnings(warnings)
  return {
    ok: true,
    message: `已导入 Spine：${document.bones.length} 骨骼 / ${document.slots.length} 插槽 / ${document.animations.length} 动画`,
    warnings
  }
}

export async function importDragonBonesFlow(sourcePath?: string): Promise<IoResult> {
  const platform = getPlatform()
  // 调用方（AI 命令）直接给路径时不弹对话框；同目录的 texture_*.json 图集仍会被自动收集
  const picked = sourcePath ? [sourcePath] : await platform.pickFiles({
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
  const document = finishImport(result.asset, pageImages, pageSizes, jsonPath)
  warnings.push(...result.warnings)
  warnings.push(`合并 ${dbTextureNames(subTextures).length} 张图集页`)
  useProjectStore.getState().setWarnings(warnings)
  return {
    ok: true,
    message: `已导入 DragonBones：${document.bones.length} 骨骼 / ${document.slots.length} 插槽 / ${document.animations.length} 动画`,
    warnings
  }
}

/**
 * 导入的资源名 → 项目名：`Rooster_Ani_ske.json` → `Rooster_Ani`（图集文件常见的 `_tex` 也去掉）。
 *
 * 只在**还没起过名**的会话里采用（默认名 + 从未保存）：导出的图集名 / 目录名 / 页名都跟项目名走，
 * 直接拿编辑器默认的 `hao2dProject` 当名字太不具体；已有名字（新建项目填的、打开的工程）绝不动。
 */
function adoptProjectNameFromImport(sourcePath: string | undefined): void {
  if (!sourcePath) return
  const store = useProjectStore.getState()
  if (store.projectPath !== null || store.projectName !== DEFAULT_PROJECT_NAME) return
  const stem = stripExtension(baseName(sourcePath)).replace(/_(ske|tex)$/i, '')
  if (stem.length > 0) store.setProjectInfo({ projectName: stem })
}

/**
 * Runtime → Authoring，并把图集页的真实路径写进图片清单。
 *
 * 导入（Spine / DragonBones、菜单与拖入两条路）都是**整份替换**文档：先把上个资源占着的
 * 图片 / 图集内存放掉，再换 —— 否则旧图集页会一直留着，且同名图集页还会被继续复用。
 */
function finishImport(
  asset: ReturnType<typeof importSpine>['asset'],
  pageImages: Record<string, string>,
  pageSizes: PageSizes,
  sourcePath?: string
): EditorDocument {
  releaseDocumentAssets()
  const document = decompileAsset(asset)
  document.images = document.images.map((image) => ({
    ...image,
    path: pageImages[image.name] ?? image.path,
    width: pageSizes[image.name]?.width ?? image.width,
    height: pageSizes[image.name]?.height ?? image.height,
    loose: false
  }))
  useProjectStore.getState().setDocument(document, null, true)
  // 一上来就导入、工程还没名字：用被导入文件的名字当项目名（导出产物都跟它走）
  adoptProjectNameFromImport(sourcePath)
  // 导入（整份替换骨架）后：回到 Pose（绑定）态、清空时间轴选中的动画，
  // 并把视口复位到「原点居中」——空场景默认缩放 100%，有内容时按包围盒适配到合适大小。
  // 菜单与拖入两条导入路都汇聚到这里，统一处理，避免各入口行为不一致。
  useTimelineStore.getState().setAnimation(null)
  useModeStore.getState().setMode('pose')
  // 先 refresh 让新骨架的网格几何（meshResult.bounds）建好，否则 fit 读到的是旧/空包围盒，
  // 缩放会退化成默认值而非适配内容
  const scene = getActiveScene()
  if (scene) {
    scene.refresh()
    scene.fit()
  }
  return document
}

export async function importImagesFlow(paths?: readonly string[]): Promise<IoResult> {
  const platform = getPlatform()
  const picked = paths && paths.length > 0
    ? [...paths]
    : await platform.pickFiles({
        // psd 也放进可选范围：选到它转入「导入 PSD」弹窗（按图层拆图），不走碎图登记
        filters: [{ name: '图片 / PSD', extensions: ['png', 'jpg', 'jpeg', 'webp', 'psd'] }],
        multi: true
      })
  if (picked.length === 0) return { ok: false, message: '已取消' }

  // PSD 与碎图分开处理：PSD 要经弹窗勾选图层，碎图直接登记（见 parsePsdAt / openPsdDialog）
  const psdPaths = picked.filter((path) => /\.psd$/i.test(path))
  const imagePaths = picked.filter((path) => !/\.psd$/i.test(path))
  let psdNote = ''
  if (psdPaths.length > 0) {
    const parsed = await parsePsdAt(psdPaths[0])
    if (parsed.parsed) {
      openPsdDialog(parsed.parsed)
      psdNote =
        psdPaths.length > 1
          ? `（选了 ${psdPaths.length} 个 PSD，已打开第一个的导入窗口）`
          : '（PSD 已打开导入窗口，勾选要导入的图层）'
    } else {
      psdNote = `（${parsed.message}）`
    }
    if (imagePaths.length === 0) {
      return parsed.parsed ? { ok: true, message: 'PSD 已打开导入窗口，勾选要导入的图层' } : parsed
    }
  }

  const infos = await platform.imageInfo(imagePaths)
  const inputs = infos.length > 0
    ? infos.map((info) => ({ path: info.path, name: baseName(info.path), width: info.width, height: info.height }))
    : imagePaths.map((path) => ({ path, name: baseName(path), width: 0, height: 0 }))

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
  const message = added > 0 ? `已导入 ${added} 张图片` : '没有新增图片（可能已存在）'
  return {
    ok: true,
    message: psdNote ? `${message}${psdNote}` : message,
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

  // 拖入 PSD：解析并打开「导入 PSD」弹窗（其余文件照常按下面的规则分派，两边互不干扰）
  const psdPath = paths.find((path) => /\.psd$/i.test(path))
  const rest = psdPath ? paths.filter((path) => path !== psdPath) : [...paths]
  let psdNote = ''
  if (psdPath) {
    const parsed = await parsePsdAt(psdPath)
    if (parsed.parsed) {
      openPsdDialog(parsed.parsed)
      psdNote = 'PSD 已打开导入窗口，勾选要导入的图层'
    } else {
      psdNote = parsed.message
    }
    if (rest.length === 0) {
      return parsed.parsed
        ? { ok: true, message: psdNote }
        : { ok: false, message: psdNote }
    }
  }

  const { list, folderImages } = await expandDroppedPaths(platform, rest)
  if (list.length === 0) {
    return {
      ok: false,
      message: psdNote
        ? psdNote
        : '拖入的文件夹里没有可导入的图片（支持 png / jpg / webp / gif / bmp / psd）'
    }
  }

  // 拖入工程文件 = 打开工程
  const project = list.find((p) => /\.(hao2d\.proj|hao2dproj)$/i.test(p))
  if (project) return openProjectAt(project)

  const images = list.filter((p) => IMAGE_EXT_RE.test(p))
  const jsons = list.filter((p) => /\.json$/i.test(p))
  const atlases = list.filter((p) => /\.atlas(\.txt)?$/i.test(p))

  // 有 PSD 时把「已打开导入窗口」拼进结果提示（弹窗本身已经打开，这里只补一句说明）
  const withPsdNote = (result: IoResult): IoResult =>
    psdNote ? { ...result, message: `${result.message}（${psdNote}）` } : result

  if (images.length > 0 && jsons.length === 0) {
    const result = await importImagesFlow(images)
    return withPsdNote(
      folderImages > 0
        ? { ...result, message: `${result.message}（文件夹里找到 ${folderImages} 张图片）` }
        : result
    )
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
          pageImages: resolved.pageImages,
          atlasText
        })
        const document = finishImport(result.asset, resolved.pageImages, resolved.pageSizes, jsons[0])
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
  return withPsdNote(
    folderImages > 0
      ? { ...loose, message: `${loose.message}（文件夹里找到 ${folderImages} 张图片）` }
      : loose
  )
}

/** 兜底：把无法识别的路径按图片尝试导入 */
function imageLeaves(paths: readonly string[]): string[] {
  return paths.filter((p) => /\.(png|jpg|jpeg|webp|gif|bmp)$/i.test(p))
}

export type { AtlasRegion }

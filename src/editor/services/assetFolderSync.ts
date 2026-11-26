import { getActiveScene } from '../activeScene'
import { getPlatform } from '../platform'
import { useProjectStore } from '../store/projectStore'
import { useSelectionStore } from '../store/selectionStore'
import { joinPath, dirName } from '../platform'
import { ASSET_DIR } from './projectAssets'
import { imageSources } from '@render/imageSourceRegistry'
import { t } from '@i18n'
import type { AuthoringImage } from '@core/model/authoring'
import type { DirEntry, ImageInfo } from '@shared/ipcTypes'

/**
 * 磁盘 `images/` → 资源池的**对账计划**（纯函数，便于单测）。
 *
 * 输入是「上次快照」与「这次 listDir 结果」：
 * - 新出现的路径 → 新增图片；
 * - 快照里有、这次没了 → 删除图片；
 * - 都在但 mtime / size 变了 → 修改（尺寸重读 + 缓存失效）。
 *
 * 注意**按路径而不是名字**匹配：图片名可能被用户改过（工程内唯一，但磁盘文件名可以不同），
 * 只有资源目录里的文件路径才是稳定的身份。
 */
export interface AssetSnapshotEntry {
  path: string
  name: string
  mtimeMs: number
  size: number
}

export interface AssetFolderChanges {
  added: ImageInfo[]
  removed: AuthoringImage[]
  modified: Array<{ image: AuthoringImage; info: ImageInfo }>
}

const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp)$/i

export function planAssetFolderSync(
  images: readonly AuthoringImage[],
  previous: ReadonlyMap<string, AssetSnapshotEntry>,
  current: readonly DirEntry[]
): AssetFolderChanges {
  const currentByPath = new Map<string, AssetSnapshotEntry>()
  for (const entry of current) {
    if (entry.isDirectory || !IMAGE_EXT_RE.test(entry.name)) continue
    currentByPath.set(entry.path, {
      path: entry.path,
      name: entry.name,
      mtimeMs: entry.mtimeMs,
      size: entry.size
    })
  }
  const imageByPath = new Map(images.map((image) => [image.path, image]))
  const imageByName = new Map(images.map((image) => [image.name, image]))
  const added: ImageInfo[] = []
  const removed: AuthoringImage[] = []
  const modified: AssetFolderChanges['modified'] = []

  /*
   * 身份按**图片名**：`assetRelativePath` 就是把 `image.name` 写成 images/ 下的文件名，
   * 所以名字稳定、路径会变（保存时从外部路径换成工程内路径）。
   */
  const targetFor = (entry: AssetSnapshotEntry): AuthoringImage | undefined =>
    imageByName.get(entry.name) ?? imageByPath.get(entry.path)
  const used = new Set<AuthoringImage>()

  for (const [path, entry] of currentByPath) {
    const before = previous.get(path)
    const target = targetFor(entry)
    if (target) used.add(target)
    if (!before) {
      // 刚开watch / 目录刚建出来：工程里已有同名图就只同步路径，别当成新增
      if (target) modified.push({ image: target, info: { path, name: entry.name, width: 0, height: 0 } })
      else added.push({ path, name: entry.name, width: 0, height: 0 })
      continue
    }
    if (before.mtimeMs === entry.mtimeMs && before.size === entry.size) continue
    if (target) modified.push({ image: target, info: { path, name: entry.name, width: 0, height: 0 } })
    else added.push({ path, name: entry.name, width: 0, height: 0 })
  }
  for (const [path, before] of previous) {
    if (currentByPath.has(path)) continue
    const image = imageByPath.get(path) ?? imageByName.get(before.name)
    // 刚换过路径的同名图（info 里已是新路径）不能当作「被删除」
    if (image && !used.has(image)) removed.push(image)
  }
  return { added, removed, modified }
}

/** 给计划里的路径补 imageInfo（宽高）；读不到的直接丢弃，不让坏图进资源池 */
async function fillImageInfos(infos: readonly ImageInfo[]): Promise<ImageInfo[]> {
  if (infos.length === 0) return []
  const platform = getPlatform()
  const filled = await platform.imageInfo(infos.map((info) => info.path))
  return filled.filter((info) => info.width > 0 && info.height > 0)
}

/** 修改过的图片：清掉纹理 / 像素缓存 / blob URL 与来源记账，否则看到的还是旧像素 */
function invalidateImages(images: readonly AuthoringImage[]): void {
  if (images.length === 0) return
  const scene = getActiveScene()
  // 平台层的 blob URL 按路径缓存，不清掉下次 loadTextures 还会拿到旧字节
  getPlatform().releaseImageCache()
  for (const image of images) {
    scene?.textures.delete(image.name)
    scene?.imageAlpha.delete(image.name)
    imageSources.forget(image.name)
  }
}

const revisions = new Map<string, number>()
const revisionListeners = new Set<() => void>()
/** 上次对账时的磁盘快照（模块级：编辑器自己写盘后也要能刷新） */
let baseline = new Map<string, AssetSnapshotEntry>()

/** 缩略图组件订阅：路径 + revision 一起作为 <img src> 的缓存键 */
export function imageRevision(path: string): number {
  return revisions.get(path) ?? 0
}

export function subscribeImageRevisions(listener: () => void): () => void {
  revisionListeners.add(listener)
  return () => revisionListeners.delete(listener)
}

function notifyRevision(path: string): void {
  revisions.set(path, imageRevision(path) + 1)
  for (const listener of revisionListeners) listener()
}

/** 编辑器**自己**往 images/ 写完文件后刷新基线：别把自己写盘当成外部修改 */
export async function rebaseAssetFolderSnapshot(dir: string): Promise<void> {
  const platform = getPlatform()
  // 测试里的桩平台只实现部分接口；没有目录枚举能力时跳过基线刷新即可
  if (typeof platform.listDir !== 'function') return
  const entries = await platform.listDir(dir, false)
  baseline = new Map(
    entries
      .filter((entry) => !entry.isDirectory && IMAGE_EXT_RE.test(entry.name))
      .map((entry) => [entry.path, { path: entry.path, name: entry.name, mtimeMs: entry.mtimeMs, size: entry.size }])
  )
}

/**
 * 安装资源目录同步：订阅 projectPath，切工程时重新挂 watcher；收到事件后对账并更新资源池。
 *
 * 一次事件 = 一次撤销记录（新增 / 删除 / 修改合在一起），避免出现「撤销十次才回到原样」。
 * 外部改文件属于显式编辑，因此会标脏（下次保存时写回工程）。
 */
export function installAssetFolderSync(onStatus?: (text: string) => void): () => void {
  let generation = 0
  let lastProjectPath: string | null = null
  let syncing = false
  let pending = false
  let baselineReady = false

  const resync = async (): Promise<void> => {
    // 换工程时基线还没拍完：这时候收到旧 watcher 的事件，宁可丢掉也不能把整批图判成「新增」
    if (!baselineReady) return
    if (syncing) {
      pending = true
      return
    }
    syncing = true
    try {
      const projectPath = useProjectStore.getState().projectPath
      if (!projectPath) return
      const dir = joinPath(dirName(projectPath), ASSET_DIR)
      const entries = await getPlatform().listDir(dir, false)
      const changes = planAssetFolderSync(useProjectStore.getState().document.images, baseline, entries)

      const added = await fillImageInfos(changes.added)
      const modified = await fillImageInfos(changes.modified.map((item) => item.info))
      const modifiedPairs = changes.modified.filter((item) =>
        modified.some((info) => info.path === item.info.path)
      )
      if (added.length > 0 || modifiedPairs.length > 0 || changes.removed.length > 0) {
        invalidateImages([...modifiedPairs.map((item) => item.image), ...changes.removed])
        /*
         * revision 要打在**更新后真正使用的路径**上：同步时会把 image.path 从外部导入路径
         * 换成工程 images/ 里的路径，旧路径加 revision 对缩略图毫无作用（URL 用的是新路径）。
         */
        const bumpPaths = new Set<string>([
          ...added.map((info) => info.path),
          ...modifiedPairs.map((item) => item.info.path),
          ...changes.removed.map((image) => image.path)
        ])
        for (const image of modifiedPairs.map((item) => item.image)) bumpPaths.add(image.path)
        for (const path of bumpPaths) notifyRevision(path)
        useProjectStore.getState().syncImagesFromFolder({
          added: added.map((info) => ({
            name: info.name,
            path: info.path,
            width: info.width,
            height: info.height,
            loose: true
          })),
          modified: modifiedPairs.map((item) => ({
            name: item.image.name,
            info: {
              path: item.info.path,
              width: item.info.width,
              height: item.info.height
            }
          })),
          removed: changes.removed.map((image) => image.name)
        })
        // 磁盘上删掉的图片别留在资源面板的选中集合里
        if (changes.removed.length > 0) {
          const selection = useSelectionStore.getState()
          const gone = new Set(changes.removed.map((image) => image.name))
          selection.setPickedImages(selection.pickedImages.filter((name) => !gone.has(name)))
        }
        onStatus?.(
          t('images/ 已同步：新增 {0} 张、修改 {1} 张、删除 {2} 张', [
            added.length,
            modifiedPairs.length,
            changes.removed.length
          ])
        )
      }
      // 不管有没有变化都刷新快照：下一次事件只比对增量
      baseline = new Map(
        entries
          .filter((entry) => !entry.isDirectory && IMAGE_EXT_RE.test(entry.name))
          .map((entry) => [entry.path, { path: entry.path, name: entry.name, mtimeMs: entry.mtimeMs, size: entry.size }])
      )
      getActiveScene()?.refresh()
    } catch (error) {
      console.warn('[hao2d] images/ 同步失败：', error)
    } finally {
      syncing = false
      if (pending) {
        pending = false
        void resync()
      }
    }
  }

  const rebase = async (projectPath: string | null): Promise<void> => {
    const mine = ++generation
    baselineReady = false
    const platform = getPlatform()
    if (typeof platform.watchAssetsDir !== 'function' || typeof platform.listDir !== 'function') return
    if (!projectPath) {
      baseline = new Map()
      baselineReady = true
      await platform.watchAssetsDir(null)
      return
    }
    const dir = joinPath(dirName(projectPath), ASSET_DIR)
    await platform.watchAssetsDir(dir)
    const entries = await platform.listDir(dir, false)
    if (mine !== generation) return
    baseline = new Map(
      entries
        .filter((entry) => !entry.isDirectory && IMAGE_EXT_RE.test(entry.name))
        .map((entry) => [entry.path, { path: entry.path, name: entry.name, mtimeMs: entry.mtimeMs, size: entry.size }])
    )
    baselineReady = true
  }

  const platform = getPlatform()
  const unsubscribeEvents =
    typeof platform.onAssetsChanged === 'function'
      ? platform.onAssetsChanged(({ dir }) => {
          const projectPath = useProjectStore.getState().projectPath
          if (!projectPath) return
          if (dir !== joinPath(dirName(projectPath), ASSET_DIR)) return
          void resync()
        })
      : () => undefined
  const unsubscribeStore = useProjectStore.subscribe((state, prev) => {
    if (state.projectPath === prev.projectPath) return
    lastProjectPath = state.projectPath
    void rebase(lastProjectPath)
  })

  lastProjectPath = useProjectStore.getState().projectPath
  void rebase(lastProjectPath)
  return () => {
    generation++
    unsubscribeEvents()
    unsubscribeStore()
    if (typeof platform.watchAssetsDir === 'function') void platform.watchAssetsDir(null)
    revisions.clear()
  }
}

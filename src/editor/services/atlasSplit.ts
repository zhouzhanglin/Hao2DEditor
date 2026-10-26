import type { AuthoringImage } from '@core/model/authoring'
import type { BatchFile } from '@shared/ipcTypes'
import type { AtlasSplitEntry, AtlasSplitPlan } from '../commands/authoringCommands'
import { t } from '@i18n'
import { baseName, dirName, getPlatform, joinPath, stripExtension } from '../platform'
import { useProjectStore } from '../store/projectStore'
import { cropRegionPngs, loadImageBitmap } from './pngEncoder'
import type { RegionCrop } from './pngEncoder'
import { isRealFilePath } from './projectAssets'

/** 拆图集的结果：给界面提示用的一行话 */
export interface AtlasSplitResult {
  ok: boolean
  message: string
}

/** 碎图落盘的目录后缀：图集 `foo.png` → 碎图放 `foo_split/` */
const SPLIT_DIR_SUFFIX = '_split'

/**
 * 图集 → 碎图。
 *
 * 1. 读图集页，按 `image.regions` 把每块子图裁出来（被旋转存放的转回原朝向）编码成 PNG；
 * 2. 写到图集旁边的 `<图集名>_split/` 目录（目录已存在就换名，绝不覆盖用户已有的文件）；
 * 3. 碎图进图片池，**所有骨架**里引用图集的附件改指到碎图（UV 换算见 `applyAtlasSplit`）；
 * 4. 图集条目从工程里移除 —— 磁盘上的原文件保留，只是工程不再用它。
 *
 * 整件事只记一条撤销：拆错了 Ctrl+Z 就回去（磁盘上的碎图文件会留着，不影响工程）。
 */
export async function splitAtlasImage(name: string): Promise<AtlasSplitResult> {
  const store = useProjectStore.getState()
  const image = store.document.images.find((item) => item.name === name)
  if (!image) return { ok: false, message: t('图片「{0}」不存在', name) }
  if (image.loose) return { ok: false, message: t('「{0}」已经是碎图，不用再拆', name) }
  if (!isRealFilePath(image.path)) {
    return { ok: false, message: t('「{0}」不是磁盘文件，拆出来的碎图没地方写', name) }
  }

  const platform = getPlatform()
  const bitmap = await loadImageBitmap(await platform.imageUrl(image.path))
  if (!bitmap) return { ok: false, message: t('读取「{0}」失败，无法拆分', name) }

  try {
    // 页尺寸以**实际像素**为准：UV 是按它归一化的，导入时记的宽高万一对不上，以图为准
    const pageWidth = bitmap.width
    const pageHeight = bitmap.height
    const regions = (image.regions ?? []).filter((region) => region.width > 0 && region.height > 0)
    const skipped = (image.regions?.length ?? 0) - regions.length

    /*
     * 区域名对不上的引用（老工程、或当初按「整页」建的附件）需要一张「整页」兜底：
     * 它就是原页的拷贝，UV 换算之后与原样一致，画面不变。
     */
    const known = new Set(regions.map((region) => region.name))
    const needWholePage = store.skeletons.some((skeleton) =>
      skeleton.skins.some((skin) =>
        skin.slots.some((slot) =>
          slot.attachments.some(
            (attachment) =>
              attachment.image === name && (!attachment.regionName || !known.has(attachment.regionName))
          )
        )
      )
    )

    if (regions.length === 0 && !needWholePage) {
      return { ok: false, message: t('「{0}」里没有记录任何子区域，拆不出碎图', name) }
    }

    const dir = await allocateOutputDir(image.path)
    // 图集条目会被移除，它的名字可以复用
    const taken = new Set(store.document.images.map((item) => item.name).filter((item) => item !== name))
    const crops: RegionCrop[] = []
    const entries: AtlasSplitEntry[] = []
    const images: AuthoringImage[] = []

    const plan = (entry: Omit<AtlasSplitEntry, 'image'>): void => {
      const fileName = allocateName(entry.region, taken)
      entries.push({ ...entry, image: fileName })
      crops.push({ x: entry.x, y: entry.y, width: entry.width, height: entry.height, rotate: entry.rotate })
      images.push({
        name: fileName,
        path: joinPath(dir, fileName),
        width: Math.max(1, Math.round(entry.width)),
        height: Math.max(1, Math.round(entry.height)),
        // 碎图：导出时按需重新打包
        loose: true
      })
    }

    for (const region of regions) {
      plan({
        region: region.name,
        x: region.x,
        y: region.y,
        width: region.width,
        height: region.height,
        rotate: region.rotate ?? 0
      })
    }
    if (needWholePage) {
      plan({ region: name, x: 0, y: 0, width: pageWidth, height: pageHeight, rotate: 0 })
    }

    const encoded = await cropRegionPngs(bitmap, crops)
    if (encoded.some((bytes) => bytes.length === 0)) {
      return { ok: false, message: t('碎图编码失败（当前环境没有可用的画布）') }
    }

    // 先落盘再改文档：写失败时工程保持原样，不会留下指向空文件的碎图
    const batch: BatchFile[] = encoded.map((bytes, index) => ({ path: images[index].path, bytes }))
    try {
      await platform.writeBatch(batch)
    } catch (error) {
      return { ok: false, message: t('写入碎图失败：{0}', describe(error)) }
    }

    // 异步期间工程可能被改过（换了图 / 拆了图集）：对不上就放弃，避免把新数据按旧区域改坏
    const latest = useProjectStore.getState().document.images.find((item) => item.name === name)
    if (!latest || latest.loose || latest.path !== image.path) {
      return { ok: false, message: t('「{0}」在拆分过程中被改动，已放弃（磁盘上的碎图文件可自行删除）', name) }
    }

    const splitPlan: AtlasSplitPlan = { atlas: name, pageWidth, pageHeight, entries }
    useProjectStore.getState().splitAtlas(splitPlan, images)
    return { ok: true, message: describeResult(name, images.length, dir, skipped, needWholePage) }
  } finally {
    if ('close' in bitmap) bitmap.close()
  }
}

/** 碎图目录：图集旁边的 `<图集名>_split/`；同名目录已存在就换名，避免覆盖上一次的成果 */
async function allocateOutputDir(atlasPath: string): Promise<string> {
  const platform = getPlatform()
  const parent = dirName(atlasPath)
  const stem = stripExtension(baseName(atlasPath)) || 'atlas'
  let candidate = joinPath(parent, `${stem}${SPLIT_DIR_SUFFIX}`)
  let index = 2
  while (await platform.exists(candidate)) {
    candidate = joinPath(parent, `${stem}${SPLIT_DIR_SUFFIX}${index}`)
    index++
  }
  return candidate
}

/** 碎图名 / 文件名：区域名洗一遍 + `.png`，与工程里已有的图重名时加序号 */
function allocateName(regionName: string, taken: Set<string>): string {
  const stem = sanitizeStem(stripExtension(regionName)) || 'sprite'
  let candidate = `${stem}.png`
  let index = 2
  while (taken.has(candidate)) {
    candidate = `${stem}_${index}.png`
    index++
  }
  taken.add(candidate)
  return candidate
}

/**
 * 区域名 → 文件名主干。
 * 图集区域名允许 `goblin/head` 这种带皮肤前缀的写法，落盘前拍平成 `goblin_head`
 * （顺带清掉文件系统不认的字符，Windows 上还不允许尾部空格与点）。
 */
function sanitizeStem(name: string): string {
  return name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
}

function describeResult(
  atlas: string,
  count: number,
  dir: string,
  skipped: number,
  needWholePage: boolean
): string {
  const parts = [t('「{0}」已拆成 {1} 张碎图（{2}），图集已从工程移除', [atlas, count, dir])]
  if (needWholePage) parts.push(t('有附件对不上区域名，另拆了一张整页兜底'))
  if (skipped > 0) parts.push(t('跳过 {0} 个空区域', skipped))
  return parts.join(t('；'))
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

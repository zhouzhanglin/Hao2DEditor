import { t } from '@i18n'
import { baseName, dirName, getPlatform, joinPath } from '../platform'
import { useProjectStore } from '../store/projectStore'
import { createAuthoringBone, ROOT_BONE_NAME, rootBoneName } from '@core/model/authoring'
import { createRegionFromImage, PPU, uniqueName } from '../commands/authoringCommands'
import { ASSET_DIR } from './projectAssets'
import type { IoResult } from './projectIo'
import {
  collectSelectedLayers,
  layerPngBytes,
  parsePsd,
  sanitizeLayerName
} from '@importers/psdImport'
import type { ParsedPsd, PsdLayerNode } from '@importers/psdImport'

/**
 * PSD 导入流程：
 *
 * 1. 选文件 / 拖入 / 「导入图片」选到 .psd → 解析出图层树 → 打开「导入 PSD」弹窗
 * 2. 弹窗确认：按勾选把每层导出成 PNG 写进 `<工程目录>/images/`，再登记进图片池；
 *    勾了「直接添加到场景」还会按 PSD 里的位置生成插槽（一次撤销，整步可 Ctrl+Z）
 *
 * 没勾选的层**不进工程也不落盘**（用户勾选弹窗里就已经决定好了）。
 *
 * 弹窗本体是 App 里的 React 状态，服务层拿不到 —— 用 `setPsdDialogOpener` 注册一个
 * 打开回调：菜单 / 导入图片选到 psd / 拖入 psd 三条路都经由它打开同一个弹窗。
 */
let dialogOpener: ((parsed: ParsedPsd) => void) | null = null

/** App 挂载时注册（传 null 注销）：收到解析结果就打开「导入 PSD」弹窗 */
export function setPsdDialogOpener(opener: ((parsed: ParsedPsd) => void) | null): void {
  dialogOpener = opener
}

/** 打开「导入 PSD」弹窗（App 已通过 setPsdDialogOpener 注册；没注册时静默跳过） */
export function openPsdDialog(parsed: ParsedPsd): void {
  dialogOpener?.(parsed)
}

/** 读磁盘上的 PSD 并解析（「导入图片」选到 psd / 拖入 psd 也走这里） */
export async function parsePsdAt(path: string): Promise<IoResult & { parsed?: ParsedPsd }> {
  const platform = getPlatform()
  try {
    const bytes = await platform.readBinary(path)
    const parsed = parsePsd(bytes, baseName(path))
    if (parsed.pixelCount === 0) {
      return { ok: false, message: t('「{0}」里没有带像素的图层（文本 / 调整层无法导入）', parsed.fileName) }
    }
    return { ok: true, message: '', parsed }
  } catch (error) {
    return { ok: false, message: t('解析 PSD 失败：{0}', describe(error)) }
  }
}

/** 菜单「导入 PSD…」：选文件 → 解析 → 打开弹窗（结果提示交给弹窗本身，不再闪状态栏） */
export async function pickAndParsePsd(): Promise<IoResult> {
  const platform = getPlatform()
  const picked = await platform.pickFiles({
    filters: [{ name: t('Photoshop 文档'), extensions: ['psd'] }],
    multi: false
  })
  if (picked.length === 0) return { ok: false, message: t('已取消') }
  const result = await parsePsdAt(picked[0])
  if (result.parsed) openPsdDialog(result.parsed)
  return result.parsed ? { ok: true, message: '' } : { ok: false, message: result.message }
}

/** 弹窗确认：写图层图片 + 登记图片池 +（可选）按 PSD 位置建插槽 */
export async function importPsdLayers(
  parsed: ParsedPsd,
  selectedIds: ReadonlySet<string>,
  addToScene: boolean
): Promise<IoResult> {
  const store = useProjectStore.getState()
  const projectPath = store.projectPath
  if (!projectPath) {
    return {
      ok: false,
      message: t('请先保存或创建工程：PSD 的图层图片要落到工程目录的 images/ 下（与「导入图片」同一规则）')
    }
  }

  const selected = collectSelectedLayers(parsed.root, selectedIds)
  if (selected.length === 0) return { ok: false, message: t('没有勾选任何带像素的图层') }

  // ---- ① 逐层导出 PNG 并写盘（先全部写成功，再动文档：中途失败不留半截工程状态） ----
  const platform = getPlatform()
  const dir = joinPath(dirName(projectPath), ASSET_DIR)
  const used = new Set(store.document.images.map((image) => image.name))
  const written: Array<{ node: PsdLayerNode; name: string; path: string }> = []
  try {
    for (const node of selected) {
      const layer = parsed.layers.get(node.id)
      if (!layer?.canvas) continue
      const bytes = await layerPngBytes(layer)
      const fileName = uniqueImageFileName(sanitizeLayerName(node.name), used)
      const target = joinPath(dir, fileName)
      await platform.writeBinary(target, bytes)
      used.add(fileName)
      written.push({ node, name: fileName, path: target })
    }
  } catch (error) {
    return { ok: false, message: t('写入图层图片失败：{0}', describe(error)) }
  }
  if (written.length === 0) return { ok: false, message: t('没有可导出的图层（选中项都没有像素）') }

  // ---- ② 一个撤销事务：登记图片 +（可选）按 PSD 位置建插槽 ----
  let slotCount = 0
  store.update('导入 PSD', (draft) => {
    for (const item of written) {
      draft.images.push({
        name: item.name,
        path: item.path,
        width: item.node.width,
        height: item.node.height,
        loose: true
      })
    }
    if (!addToScene) return

    /*
     * 全部挂到**根骨骼**上，position = 图层中心相对「PSD 画布中心」的偏移：
     * - PSD 画布中心对齐根骨骼原点，整张设计稿的原样构图就落进了场景
     * - 同一个父骨骼下相对位置不变，之后想拆骨骼再在层级树里拖，导入本身保持简单
     * - PSD 坐标系 y 向下、场景 y 轴向上，所以 y 取负；像素 → 骨架单位除以 PPU
     */
    let host = rootBoneName(draft.bones)
    if (!host) {
      const bone = createAuthoringBone({
        name: uniqueName(
          draft.bones.map((item) => item.name),
          ROOT_BONE_NAME
        )
      })
      draft.bones.push(bone)
      host = bone.name
    }
    for (const item of written) {
      const centerPsdX = item.node.left + item.node.width / 2
      const centerPsdY = item.node.top + item.node.height / 2
      const position = {
        x: (centerPsdX - parsed.width / 2) / PPU,
        y: -(centerPsdY - parsed.height / 2) / PPU
      }
      const created = createRegionFromImage(draft, {
        image: item.name,
        bone: host,
        width: item.node.width,
        height: item.node.height,
        slotName: sanitizeLayerName(item.node.name),
        position
      })
      if (created) slotCount++
    }
  })

  const parts = [t('已导入 {0} 层图片', written.length)]
  if (addToScene) parts.push(t('按 PSD 位置添加了 {0} 个插槽（画布中心对齐根骨骼）', slotCount))
  return { ok: true, message: t('PSD「{0}」导入完成：{1}', [parsed.fileName, parts.join(t('，'))]) }
}

/** 图片文件名去重（同一批里图层重名 / 与已有图片重名都算），candidate.png → candidate_2.png */
function uniqueImageFileName(base: string, used: ReadonlySet<string>): string {
  const candidate = `${base}.png`
  if (!used.has(candidate)) return candidate
  let index = 2
  while (used.has(`${base}_${index}.png`)) index++
  return `${base}_${index}.png`
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

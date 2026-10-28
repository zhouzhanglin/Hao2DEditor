import { mapRegionRelativeUvs, pageUvsToRegionRelative } from '../../importers/uv'
import type { AtlasRegion, PageSizes } from '../../importers/uv'
import type {
  AuthoringAttachment,
  AuthoringImage,
  AuthoringSkin,
  AuthoringVertex,
  EditorDocument
} from '../model/authoring'
import type { Vec2 } from '../math/matrix'
import { AttachmentType } from '../model/types'
import type { SkinData } from '../model/types'

/**
 * 创作期的 linkedmesh 解析（**只读**）。
 *
 * 与运行期 `resolveLinkedMesh`（core/model/asset.ts）是同一套规则，区别只在数据源：
 * 那边读编译后的 `RuntimeAsset`，这边读工程的 Authoring 模型，给编辑器工具算点数 / 画提示用。
 *
 * 为什么 authoring 侧**不复制几何**：源网格改形状后链接网格必须自动跟随（Spine 语义），
 * 复制一份就要再维护一套同步逻辑，而且导出的 .hao2d 里几何本来也只存父附件一份。
 */
export interface LinkedMeshView {
  parent: AuthoringAttachment
  /** 只读几何：顶点 / 三角面 / 尺寸一律来自父附件 */
  vertices: readonly AuthoringVertex[]
  triangles: readonly number[]
  size: Vec2
  /** 有效 UV：自带长度等于父顶点数 × 2 就用自己的，否则用父的（与运行期同口径） */
  uvs: readonly number[]
}

/** 与 `core/model/asset.ts` 的 `pickSkinByName` 同一口径：指定名 → default → 第一个 */
function pickSkin(skins: readonly AuthoringSkin[], name: string): AuthoringSkin | null {
  if (skins.length === 0) return null
  if (name) {
    const found = skins.find((item) => item.name === name)
    if (found) return found
  }
  return skins.find((item) => item.name === 'default') ?? skins[0]
}

/**
 * 找链接网格的源网格（创作期）。
 *
 * 规则与运行期 `findLinkedMeshParent` 一致：源名空串 = 自身同名；源皮肤空 = 默认皮肤；
 * **只在同一个插槽**里找；父附件不能再是 linkedmesh（禁止链式）。
 *
 * 这里不额外要求父必须是 `mesh`：解析器要能读历史数据（父是 Region 时几何为空，
 * 由调用方决定怎么提示）；「新建时必须选一个真正的 mesh」由创建命令把关。
 */
export function findAuthoringLinkedMeshParent(
  doc: EditorDocument,
  lm: { name: string; linkedMeshAttachment: string },
  slotName: string,
  fallbackSkinName = ''
): AuthoringAttachment | null {
  const sourceName = lm.linkedMeshAttachment || lm.name
  if (!sourceName) return null
  const skin = pickSkin(doc.skins, fallbackSkinName)
  const slot = skin?.slots.find((item) => item.slot === slotName)
  const parent = slot?.attachments.find((item) => item.name === sourceName)
  if (!parent || parent.type === 'linkedmesh') return null
  return parent
}

/**
 * 把一条 linkedmesh 解析成「可用的几何视图」。
 *
 * 源皮肤按附件自己的 `linkedMeshSkin` 走（空串 = 默认皮肤）——**不是**「附件所在皮肤」：
 * 换装皮肤里那条链接网格自己就在 goblin 皮肤里，但它的源几乎总在默认皮肤。
 * `sourceSkinOverride` 只在「改源预览 / 修正导入数据」时用来覆盖这个字段。
 *
 * 父附件找不到时返回 null（运行期同样不绘制），调用方据此给出提示。
 */
export function resolveAuthoringLinkedMesh(
  doc: EditorDocument,
  attachment: AuthoringAttachment,
  slotName: string,
  sourceSkinOverride?: string
): LinkedMeshView | null {
  if (attachment.type !== 'linkedmesh') return null
  const skinField = sourceSkinOverride ?? attachment.linkedMeshSkin
  const parent = findAuthoringLinkedMeshParent(doc, attachment, slotName, skinField)
  if (!parent) return null
  const uvs = attachment.uvs.length === parent.uvs.length && attachment.uvs.length > 0 ? attachment.uvs : parent.uvs
  return {
    parent,
    vertices: parent.vertices,
    triangles: parent.triangles,
    size: { ...parent.size },
    uvs
  }
}

/**
 * 某条附件**实际归属**的皮肤名。
 *
 * 运行期皮肤是「默认皮肤 + 当前皮肤叠加（同名覆盖）」，所以「当前激活皮肤」不等于
 * 「这条附件来自哪个皮肤」：goblin 皮肤里没有 `spear` 时，画面上的 `spear` 其实来自默认皮肤。
 * FFD 轨道的 `skin` 归属按这条规则算 —— 标错了会导致切皮肤后变形帧失效或串到别的网格上。
 */
export function attachmentSkinOf(
  doc: EditorDocument,
  slotName: string,
  attachmentName: string,
  activeSkin = ''
): string {
  const active = pickSkin(doc.skins, activeSkin)
  const inActive = active?.slots
    .find((item) => item.slot === slotName)
    ?.attachments.some((item) => item.name === attachmentName)
  if (active && inActive) return active.name
  return pickSkin(doc.skins, '')?.name ?? ''
}

/**
 * 图集页里的一块区域 → `AtlasRegion`。
 *
 * 没有 `regions` 的散图（loose）把整页当一块区域：编辑器里「导入图片」进来的图就是这个形态，
 * UV 铺满整张图，与 `regionAttachmentFromImage` 的约定一致。
 */
export function regionOf(doc: EditorDocument, imageName: string, regionName?: string): AtlasRegion | null {
  const image: AuthoringImage | undefined = doc.images.find((item) => item.name === imageName)
  if (!image) return null
  const region = regionName ? image.regions?.find((item) => item.name === regionName) : undefined
  if (region) {
    return {
      name: region.name,
      page: image.name,
      x: region.x,
      y: region.y,
      width: region.width,
      height: region.height,
      rotate: region.rotate ?? 0,
      origWidth: region.origWidth ?? region.width,
      origHeight: region.origHeight ?? region.height,
      offsetX: region.offsetX ?? 0,
      offsetY: region.offsetY ?? 0
    }
  }
  return {
    name: image.name,
    page: image.name,
    x: 0,
    y: 0,
    width: image.width,
    height: image.height,
    rotate: 0,
    origWidth: image.width,
    origHeight: image.height,
    offsetX: 0,
    offsetY: 0
  }
}

function pageSizesOf(doc: EditorDocument): PageSizes {
  const sizes: PageSizes = {}
  for (const image of doc.images) sizes[image.name] = { width: image.width, height: image.height }
  return sizes
}

/**
 * 换图后该用图里的哪块区域。
 *
 * 顺序：同名 → 去掉「皮肤/」前缀后的同名 → 图里唯一的区域 → undefined（整页）。
 *
 * 换装皮肤的区域名通常带皮肤前缀（`default/arm` → `goblin/arm`），直接沿用旧名字在新图里
 * 一定找不到 —— 那样 UV 会退化成整页，画出来是「整张图缩进网格里」。按裸名匹配能覆盖
 * Goblins / Spine 示例工程的绝大多数情况；有歧义时（多块区域同名梗）宁可退回整页也不猜。
 */
export function regionNameForImage(
  doc: EditorDocument,
  imageName: string,
  preferred?: string
): string | undefined {
  const regions = doc.images.find((item) => item.name === imageName)?.regions
  if (!regions || regions.length === 0) return undefined
  const wanted = (preferred ?? '').trim()
  if (wanted) {
    if (regions.some((item) => item.name === wanted)) return wanted
    const bare = wanted.slice(wanted.lastIndexOf('/') + 1)
    const byBare = regions.find((item) => item.name.slice(item.name.lastIndexOf('/') + 1) === bare)
    if (byBare) return byBare.name
  }
  if (regions.length === 1) return regions[0].name
  return undefined
}

/**
 * 按「链接网格自己的区域」重算 UV。
 *
 * Spine 的 linkedmesh 自己不存 uvs：几何取自源网格，UV 取源网格的**区域相对** UV、
 * 再乘它自己的区域矩形（官方 `MeshAttachment.ComputeUVs`）。编辑器模型只存整页 UV，
 * 所以要先反解成区域相对、再映射进自己的区域 —— 否则换装皮肤会画出源皮肤那块贴图。
 *
 * 拿不到区域（没有图集信息 / regionName 对不上）时返回 null：调用方留空 UV，
 * 运行期会退回父网格的 UV（能画，但内容是源皮肤那块），并由调用方给出提示。
 */
export function linkedMeshUvs(
  doc: EditorDocument,
  lm: Pick<AuthoringAttachment, 'image' | 'regionName'>,
  parent: Pick<AuthoringAttachment, 'image' | 'regionName' | 'uvs'>
): number[] | null {
  const own = regionOf(doc, lm.image, lm.regionName)
  const source = regionOf(doc, parent.image, parent.regionName)
  if (!own || !source || parent.uvs.length === 0) return null
  const pageSizes = pageSizesOf(doc)
  const relative = pageUvsToRegionRelative(parent.uvs, source, pageSizes)
  return Array.from(mapRegionRelativeUvs(relative, own, pageSizes))
}

/**
 * 补齐编译产物里 linkedmesh 缺失的 UV（长度必须等于父网格 UV 长度）。
 *
 * 为什么必须在编译期做：导出（`exportService.remapAsset`）会把所有 UV 重新映射到打包后的图集页，
 * 而**运行期只有「自己的 UV 与父网格等长」时才会用自己的**。旧工程 / 碎图导入的 linkedmesh
 * 往往只剩 8 个占位 UV —— 导出时会被判成「UV 不可用」，页与区域退回源皮肤，
 * 于是切换到换装皮肤后画出来还是**源皮肤那块贴图**（Goblins 的脚 / 袖子就是这样出错的）。
 *
 * 没有图集矩形信息时只能「沿用父 UV」：碎图（整页 = 区域）下这一步是精确的；
 * 图集页场景下它与运行期原本的回退行为一致（画成源皮肤那块），不会更差。
 *
 * 顺带把空的 `linkedMeshAttachment` 补成父附件名 —— Unity 端 `MeshBuilder.ResolveLinkedMesh`
 * 只认这个字段，空串会直接判定「没有父网格」而不绘制（编辑器 / Spine 侧另有同名兜底）。
 *
 * @returns 修好的附件数量
 */
export function fillLinkedMeshUvs(
  skins: readonly SkinData[],
  defaultSkinName = 'default'
): number {
  if (skins.length === 0) return 0
  const defaultSkin = skins.find((skin) => skin.name === defaultSkinName) ?? skins[0]
  let fixed = 0

  for (const skin of skins) {
    for (const skinSlot of skin.slots) {
      for (const attachment of skinSlot.attachments) {
        if (attachment.type !== AttachmentType.LinkedMesh) continue
        const sourceSkin = attachment.linkedMeshSkin
          ? skins.find((item) => item.name === attachment.linkedMeshSkin) ?? defaultSkin
          : defaultSkin
        const sourceSlot = sourceSkin.slots.find((item) => item.slotName === skinSlot.slotName)
        if (!sourceSlot) continue
        const sourceName = attachment.linkedMeshAttachment || attachment.name
        const parent = sourceSlot.attachments.find(
          (item) => item.name === sourceName && item.type !== AttachmentType.LinkedMesh
        )
        if (!parent) continue

        let touched = false
        if (!attachment.linkedMeshAttachment) {
          attachment.linkedMeshAttachment = parent.name
          touched = true
        }
        if (parent.uvs.length > 0 && attachment.uvs.length !== parent.uvs.length) {
          attachment.uvs = Float32Array.from(parent.uvs)
          touched = true
        }
        if (touched) fixed++
      }
    }
  }
  return fixed
}

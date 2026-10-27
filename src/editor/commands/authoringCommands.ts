import { createAuthoringAttachment, createAuthoringSlot, rootBoneName } from '@core/model/authoring'
import type {
  AuthoringAttachment,
  AuthoringConstraint,
  AuthoringImage,
  AuthoringSkin,
  AuthoringSkinSlot,
  AuthoringVertex,
  AuthoringWeight,
  EditorDocument
} from '@core/model/authoring'
import { mulPoint, trs } from '@core/math/matrix'
import type { Vec2 } from '@core/math/matrix'
import { pageUvsToRegionRelative } from '@importers/uv'
import type { AtlasRegion, PageSizes } from '@importers/uv'
import { convexHull, createGridMesh, refineAroundVertex, triangulatePolygon } from '@core/mesh/triangulate'
import type { MeshGeometry } from '@core/mesh/triangulate'
import { buildAutoMesh } from '@core/mesh/autoMesh'
import type { AlphaMask } from '@core/mesh/autoMesh'

/** 骨架单位 ↔ 像素（与导入 / 导出保持一致的 PPU） */
export const PPU = 100

/**
 * 权重刷的模式。前三个是本工程原有的方向/覆盖语义，后两个对齐 Unity 2D Animation 的
 * Weight Brush「Mode」：
 *
 * - `add` / `subtract` / `replace`：增加 / 减少 / 覆盖（等价于 Unity 的 **Add and Subtract**）
 * - `grow`：**只在已经受这根骨骼影响的顶点**上加权重（Unity 的 **Grow and Shrink** 的"生长"侧；
 *   收缩侧就是 `subtract` —— 权重已经 0 的顶点本来就不会再被减）
 * - `smooth`：把刷到的顶点权重朝**邻居的平均值**靠拢（Unity 的 **Smooth**，与刷哪根骨骼无关）
 */
export type BrushMode = 'add' | 'subtract' | 'replace' | 'grow' | 'smooth'

export interface VertexSample {
  slot: string
  attachment: string
  /** 附件内顶点下标 */
  vertex: number
  /** 当前世界坐标（Pose 态下即 setup 世界坐标） */
  x: number
  y: number
}

export function uniqueName(existing: readonly string[], base: string): string {
  if (!existing.includes(base)) return base
  let index = 2
  while (existing.includes(`${base}_${index}`)) index++
  return `${base}_${index}`
}

export function findSkinSlot(skin: { slots: AuthoringSkinSlot[] }, slotName: string): AuthoringSkinSlot | null {
  return skin.slots.find((item) => item.slot === slotName) ?? null
}

export function findAttachment(
  doc: EditorDocument,
  slotName: string,
  attachmentName: string
): AuthoringAttachment | null {
  for (const skin of doc.skins) {
    const skinSlot = findSkinSlot(skin, slotName)
    const found = skinSlot?.attachments.find((item) => item.name === attachmentName)
    if (found) return found
  }
  return null
}

/**
 * 按选中状态解析附件：**先按当前皮肤找，找不到再跨皮肤兜底**。
 *
 * 为什么不能只按当前皮肤找：皮肤是用户切出来的，选中的附件完全可能在别的皮肤里
 * （Spine 多皮肤资源很常见，比如 default 里是 `spear`、goblingirl 里是另一套手部）。
 *
 * 早先各处写的是「按当前皮肤找，找不到就退回 `skins[0]`」—— 当当前皮肤**存在但里面
 * 没有这个附件**时，`??` 兜底根本不生效，于是附件操作器、权重骨骼高亮、检查器一起失效
 * （实测：皮肤切到 goblingirl 后再选 default 皮肤里的 spear，权重骨骼高亮整段消失）。
 */
export function resolveAttachment(
  doc: EditorDocument,
  slotName: string,
  attachmentName: string,
  skinName = ''
): AuthoringAttachment | null {
  if (skinName) {
    const skin = doc.skins.find((item) => item.name === skinName)
    const scoped = skin?.slots
      .find((item) => item.slot === slotName)
      ?.attachments.find((item) => item.name === attachmentName)
    if (scoped) return scoped
  }
  // 当前皮肤里没有（或没指定皮肤）→ 跨皮肤找，保证「切过皮肤」不会让已选中的对象失效
  return findAttachment(doc, slotName, attachmentName)
}

/** 附件清单要落到哪个皮肤：优先指定皮肤，找不到就退回第一个（default） */
function targetSkin(doc: EditorDocument, name?: string): AuthoringSkin {
  if (doc.skins.length === 0) doc.skins.push({ name: 'default', slots: [] })
  if (name) {
    const found = doc.skins.find((item) => item.name === name)
    if (found) return found
  }
  return doc.skins[0]
}

/** 取（不存在则新建）皮肤里某个插槽的附件清单 */
function ensureSkinSlot(skin: AuthoringSkin, slotName: string): AuthoringSkinSlot {
  let skinSlot = findSkinSlot(skin, slotName)
  if (!skinSlot) {
    skinSlot = { slot: slotName, attachments: [] }
    skin.slots.push(skinSlot)
  }
  return skinSlot
}

/** 图片 → Region 附件：尺寸按 PPU 折算，UV 铺满整张图，位置为附件显示空间偏移 */
function regionAttachmentFromImage(
  image: string,
  name: string,
  width: number,
  height: number,
  position?: Vec2
): AuthoringAttachment {
  return createAuthoringAttachment({
    name,
    type: 'region',
    image,
    size: { x: width, y: height },
    position: position ? { x: position.x, y: position.y } : { x: 0, y: 0 },
    uvs: [0, 0, 1, 0, 1, 1, 0, 1]
  })
}

/**
 * 用一张图片创建「插槽 + Region 附件」（拖进场景 / 面板里的「+」都走这里）。
 * 尺寸按 PPU 折算到骨架单位；`position` 是附件显示空间（骨骼局部）的偏移，
 * 空着就落在骨骼原点，拖放时由落点换算后传入。
 */
export function createRegionFromImage(
  doc: EditorDocument,
  options: {
    image: string
    bone: string
    width: number
    height: number
    slotName?: string
    attachmentName?: string
    /** 附件位置（骨骼局部），拖放到场景时用落点换算 */
    position?: Vec2
    /** 目标皮肤，默认 default */
    skin?: string
  }
): { slot: string; attachment: string } | null {
  if (!options.bone) return null
  const imageName = options.image
  if (!imageName) return null

  const slotName = uniqueName(
    doc.slots.map((slot) => slot.name),
    options.slotName ?? stripExtension(imageName)
  )
  const attachmentName = options.attachmentName ?? slotName
  const width = Math.max(1, options.width) / PPU
  const height = Math.max(1, options.height) / PPU

  doc.slots.push(
    createAuthoringSlot({
      name: slotName,
      bone: options.bone,
      zOrder: doc.slots.length,
      attachment: attachmentName
    })
  )
  ensureSkinSlot(targetSkin(doc, options.skin), slotName).attachments.push(
    regionAttachmentFromImage(imageName, attachmentName, width, height, options.position)
  )
  return { slot: slotName, attachment: attachmentName }
}

/**
 * 往**已有插槽**追加一个 display（附件），并把它切换为当前显示的项。
 *
 * 一个插槽可以挂多个 display，但同一时刻只显示 `slot.attachment` 指向的那一个，
 * 所以在追加时把 slot.attachment 指过去，符合「加进去就能看到」的直觉。
 * 原来的 display 仍然留在附件清单里，随时可以在层级树 / 属性面板里切回来。
 */
export function addImageDisplay(
  doc: EditorDocument,
  options: { image: string; slot: string; width: number; height: number; position?: Vec2; name?: string; skin?: string }
): { slot: string; attachment: string } | null {
  const slot = doc.slots.find((item) => item.name === options.slot)
  if (!slot || !options.image) return null

  const skinSlot = ensureSkinSlot(targetSkin(doc, options.skin), slot.name)
  const name = uniqueName(
    skinSlot.attachments.map((item) => item.name),
    options.name ?? stripExtension(options.image)
  )
  skinSlot.attachments.push(
    regionAttachmentFromImage(
      options.image,
      name,
      Math.max(1, options.width) / PPU,
      Math.max(1, options.height) / PPU,
      options.position
    )
  )
  slot.attachment = name
  return { slot: slot.name, attachment: name }
}

/**
 * 往**已有插槽**追加一个「嵌套骨架」display，并切换为当前显示项。
 *
 * 同工程按名字引用（不复制子骨架数据），子骨架改动在父骨架里实时体现。
 * 自引用 / 环 / 超深由调用方先用 `checkNestDrop` 校验 —— 这里只兜底空名与重复。
 */
export function addArmatureDisplay(
  doc: EditorDocument,
  options: { slot: string; armature: string; skin?: string; name?: string; position?: Vec2 }
): { slot: string; attachment: string } | null {
  const slot = doc.slots.find((item) => item.name === options.slot)
  const armature = options.armature.trim()
  if (!slot || !armature) return null

  const skinSlot = ensureSkinSlot(targetSkin(doc, options.skin), slot.name)
  // 同一骨架在同一插槽里只留一份：重复添加既看不出效果，也会让「显示」通道多出同名项
  const existing = skinSlot.attachments.find(
    (item) => item.type === 'armature' && item.subArmature === armature
  )
  if (existing) {
    slot.attachment = existing.name
    return { slot: slot.name, attachment: existing.name }
  }

  const name = uniqueName(skinSlot.attachments.map((item) => item.name), options.name ?? armature)
  skinSlot.attachments.push(
    createAuthoringAttachment({
      name,
      type: 'armature',
      subArmature: armature,
      // 骨架 display 没有几何尺寸：位置 / 旋转 / 缩放照常可编辑，size 保持 0
      position: options.position ? { x: options.position.x, y: options.position.y } : { x: 0, y: 0 },
      size: { x: 0, y: 0 }
    })
  )
  slot.attachment = name
  return { slot: slot.name, attachment: name }
}

/**
 * 删除图片：从图片池移除该条目。
 * 所有引用它的附件（`attachment.image`）会被清空（退化为「纯色」，附件本身保留），
 * 避免留下悬挂引用导致导出裂图。
 * 返回受影响的附件数（用于状态栏提示 / 删除前确认）。
 */
export function deleteImage(doc: EditorDocument, name: string): number {
  if (!doc.images.some((image) => image.name === name)) return 0
  doc.images = doc.images.filter((image) => image.name !== name)
  let touched = 0
  for (const skin of doc.skins) {
    for (const skinSlot of skin.slots) {
      for (const attachment of skinSlot.attachments) {
        if (attachment.image === name) {
          attachment.image = ''
          touched++
        }
      }
    }
  }
  return touched
}

/**
 * 替换图片：保持 `name` 不变（附件引用自动跟随新像素），只更新来源与尺寸。
 * `regions` / `loose` 沿用原条目（图集页替换整页 png 时 regions 仍有效）。
 */
export function replaceImage(
  doc: EditorDocument,
  name: string,
  next: { path: string; width: number; height: number }
): boolean {
  const image = doc.images.find((item) => item.name === name)
  if (!image) return false
  image.path = next.path
  image.width = next.width
  image.height = next.height
  return true
}

/** 统计某个图片被多少附件引用（跨全部皮肤） */
export function countImageReferences(doc: EditorDocument, name: string): number {
  let count = 0
  for (const skin of doc.skins) {
    for (const skinSlot of skin.slots) {
      for (const attachment of skinSlot.attachments) {
        if (attachment.image === name) count++
      }
    }
  }
  return count
}

/** 图集拆碎图：一条「图集区域 → 碎图」的对应关系 */
export interface AtlasSplitEntry {
  /** 原图集里的区域名；「整页」兜底那一条用图集页名 */
  region: string
  /** 拆出来的碎图名（会替掉图片池里的图集条目） */
  image: string
  /** 区域在图集页里的矩形（像素，左上角为原点） */
  x: number
  y: number
  width: number
  height: number
  /** 区域在图集页里的旋转角度（0/90/180/270） */
  rotate: number
}

export interface AtlasSplitPlan {
  /** 被拆掉的原图集页名（`doc.images` 里那条记录的名字） */
  atlas: string
  /** 图集页尺寸（整页 UV 归一化的分母，取实际像素） */
  pageWidth: number
  pageHeight: number
  entries: AtlasSplitEntry[]
}

/**
 * 图集拆碎图的**文档侧**改动：把引用原图集的附件改指到碎图（UV 从整页坐标换算成碎图坐标），
 * 再用碎图替换图片池里的图集条目。剪裁 / 编码 / 写盘由 `services/atlasSplit.ts` 负责，
 * 这里只碰数据，方便单测。
 *
 * 区域名对不上的附件（老数据、或是当初按「整页」建的附件）落到「整页」那条兜底上：
 * 那张碎图是整页的拷贝，UV 换算之后与原样完全一致，画面不变。
 *
 * 返回被改写的附件数。
 */
export function applyAtlasSplit(
  doc: EditorDocument,
  plan: AtlasSplitPlan,
  images: readonly AuthoringImage[]
): number {
  const byRegion = new Map(plan.entries.map((entry) => [entry.region, entry]))
  const fallback = byRegion.get(plan.atlas)
  const pageSizes: PageSizes = { [plan.atlas]: { width: plan.pageWidth, height: plan.pageHeight } }
  let repointed = 0
  for (const skin of doc.skins) {
    for (const skinSlot of skin.slots) {
      for (const attachment of skinSlot.attachments) {
        if (attachment.image !== plan.atlas) continue
        const entry = (attachment.regionName ? byRegion.get(attachment.regionName) : undefined) ?? fallback
        if (!entry) continue
        attachment.image = entry.image
        attachment.uvs = splitAtlasUvs(attachment.uvs, plan, entry, pageSizes)
        /*
         * 区域名跟着换：碎图导出时会被重新打包，图集里的 sprite 名就是图名
         * （导出侧也会按图名重写一次，这里同步是为了编辑器内部数据自洽）。
         */
        attachment.regionName = entry.image
        repointed++
      }
    }
  }
  doc.images = [
    ...doc.images.filter((image) => image.name !== plan.atlas),
    ...images.map((image) => ({ ...image }))
  ]
  return repointed
}

/**
 * 整页 UV → 碎图 UV：先按原区域矩形解出「区域相对 UV」（右 / 下为正，见 `pageUvsToRegionRelative`），
 * 再按碎图归一化（碎图就是这块区域本身，v 是左下原点所以翻一次）。
 */
function splitAtlasUvs(
  uvs: readonly number[],
  plan: AtlasSplitPlan,
  entry: AtlasSplitEntry,
  pageSizes: PageSizes
): number[] {
  const region: AtlasRegion = {
    name: entry.region,
    page: plan.atlas,
    x: entry.x,
    y: entry.y,
    width: entry.width,
    height: entry.height,
    rotate: entry.rotate,
    // 裁剪信息不影响 UV 换算（只解「页里的哪一块」），给中性值即可
    origWidth: entry.width,
    origHeight: entry.height,
    offsetX: 0,
    offsetY: 0
  }
  const relative = pageUvsToRegionRelative(uvs, region, pageSizes)
  const out: number[] = []
  for (let i = 0; i + 1 < relative.length; i += 2) {
    out.push(relative[i], 1 - relative[i + 1])
  }
  return out
}

/**
 * 切换插槽当前显示的 display：传入**当前正在显示的那一个**则隐藏（空串 = 一个都不显示），
 * 否则切到它 —— 插槽只有这两种状态，空串在运行期解析成 displayIndex = -1，是合法值。
 *
 * 层级树里「再点一次当前显示的 display」就走这里。
 */
export function toggleSlotDisplay(doc: EditorDocument, slotName: string, attachmentName: string): boolean {
  const slot = doc.slots.find((item) => item.name === slotName)
  if (!slot) return false
  slot.attachment = slot.attachment === attachmentName ? '' : attachmentName
  return true
}

/**
 * Region → 网格：按栅格切分顶点并把 UV 映射进原 Region 的 UV 矩形。
 * 顶点权重默认全部绑到插槽所在骨骼（权重可在权重工具里继续刷）。
 */
export function convertRegionToMesh(
  doc: EditorDocument,
  slotName: string,
  attachmentName: string,
  divisions: number
): { vertices: number; triangles: number } | null {
  const attachment = findAttachment(doc, slotName, attachmentName)
  if (!attachment || attachment.type !== 'region') return null

  const slot = doc.slots.find((item) => item.name === slotName)
  const bone = slot?.bone ?? ''
  const grid: MeshGeometry = createGridMesh(attachment.size, divisions)

  const rect = uvRect(attachment.uvs)
  const uvs = grid.uvs.map((value, index) =>
    index % 2 === 0 ? rect.u0 + value * (rect.u1 - rect.u0) : rect.v0 + value * (rect.v1 - rect.v0)
  )

  // 先存下源 Region 的尺寸与 UV，之后可以一键还原回去
  attachment.regionSnapshot = { size: { ...attachment.size }, uvs: [...attachment.uvs] }
  attachment.type = 'mesh'
  attachment.vertices = grid.vertices.map((point) => ({
    x: point.x,
    y: point.y,
    weights: bone ? [{ bone, weight: 1 }] : []
  }))
  attachment.uvs = uvs
  attachment.triangles = grid.triangles
  attachment.edges = grid.edges
  attachment.hull = grid.vertices.length

  return { vertices: grid.vertices.length, triangles: Math.floor(grid.triangles.length / 3) }
}

/**
 * Region → **轮廓网格**（自动生成）：沿图片不透明像素的边界生成贴合的多边形网格，
 * 透明区域不占三角形；内部孔洞会被忽略（只取面积最大的连通区域，与 hull 单外环的
 * 数据结构一致）。顶点数量级由 `divisions`（工具选项里的细分数）控制。
 *
 * 可以重复执行：已经是网格、但带有 `regionSnapshot` 的附件也能再次自动生成
 * （用快照里的 UV 矩形定位图片区域）。
 */
export function autoGenerateRegionMesh(
  doc: EditorDocument,
  slotName: string,
  attachmentName: string,
  mask: AlphaMask,
  divisions: number
): { vertices: number; triangles: number; coverage: number } | null {
  const attachment = findAttachment(doc, slotName, attachmentName)
  if (!attachment) return null
  // 有快照的网格可以重算；纯图片附件直接算
  const isMesh = attachment.type === 'mesh' && Boolean(attachment.regionSnapshot)
  if (attachment.type !== 'region' && !isMesh) return null

  const slot = doc.slots.find((item) => item.name === slotName)
  const bone = slot?.bone ?? ''
  // UV 矩形取「原 Region 的 UV」：网格用快照里的，避免被上一次的网格 UV 带偏
  const sourceUvs = attachment.regionSnapshot?.uvs ?? attachment.uvs
  const rect = uvRect(sourceUvs)

  const mesh = buildAutoMesh(mask, {
    size: attachment.size,
    uvRect: rect,
    divisions
  })
  if (!mesh) return null

  // 首次转换时留一份原 Region 数据，之后可以一键还原
  if (!attachment.regionSnapshot) {
    attachment.regionSnapshot = { size: { ...attachment.size }, uvs: [...attachment.uvs] }
  }
  attachment.type = 'mesh'
  attachment.vertices = mesh.vertices.map((point) => ({
    x: point.x,
    y: point.y,
    weights: bone ? [{ bone, weight: 1 }] : []
  }))
  attachment.uvs = mesh.uvs
  attachment.triangles = mesh.triangles
  attachment.edges = mesh.edges
  attachment.hull = mesh.hull

  // 顶点数变了，旧的 FFD 关键帧（按满顶点长度存 offsets）会整体错位 —— 直接清掉，
  // 与 convertMeshToRegion 的处理一致；重新编辑 FFD 时会按新顶点数重建。
  for (const animation of doc.animations) {
    animation.deforms = animation.deforms.filter(
      (track) => !(track.slot === slotName && track.attachment === attachmentName)
    )
  }

  return {
    vertices: mesh.vertices.length,
    triangles: Math.floor(mesh.triangles.length / 3),
    coverage: mesh.mask.coverage
  }
}

/**
 * Mesh → Region：把网格退回成一张图片显示。
 *
 * 有 `regionSnapshot`（由本编辑器转出来的网格都有）就精确还原原尺寸与 UV；
 * 没有快照（例如 Spine 导入的网格）就按顶点包围盒估一个矩形、UV 用整图。
 * 顶点/三角面会被清空，对应的 FFD 关键帧也一并移除，避免顶点数对不上越界。
 */
export function convertMeshToRegion(doc: EditorDocument, slotName: string, attachmentName: string): boolean {
  const attachment = findAttachment(doc, slotName, attachmentName)
  if (!attachment || (attachment.type !== 'mesh' && attachment.type !== 'linkedmesh')) return false

  const snapshot = attachment.regionSnapshot
  attachment.type = 'region'
  if (snapshot) {
    attachment.size = { ...snapshot.size }
    attachment.uvs = [...snapshot.uvs]
  } else {
    const box = vertexBounds(attachment.vertices)
    if (box) attachment.size = box
    attachment.uvs = [0, 0, 1, 0, 1, 1, 0, 1]
  }
  attachment.vertices = []
  attachment.triangles = []
  attachment.edges = []
  attachment.hull = 0
  delete attachment.regionSnapshot

  for (const animation of doc.animations) {
    animation.deforms = animation.deforms.filter(
      (track) => !(track.slot === slotName && track.attachment === attachmentName)
    )
  }
  return true
}

/** 附件局部坐标 → 插槽骨骼局部坐标（遮罩顶点统一存后者，与 Spine 一致） */
function attachmentToBone(attachment: AuthoringAttachment, point: Vec2): Vec2 {
  const matrix = trs(
    attachment.position.x,
    attachment.position.y,
    attachment.rotation,
    attachment.scale.x,
    attachment.scale.y
  )
  return mulPoint(matrix, point)
}

export interface CreateClippingOptions {
  /** 遮罩名（缺省自动取 mask / mask2…） */
  name?: string
  /** 多边形控制点（**插槽骨骼局部坐标**） */
  points: readonly Vec2[]
  /** 结束插槽名，空串 = 裁到绘制顺序末尾 */
  endSlot?: string
  inverse?: boolean
  convex?: boolean
  /** 是否把该插槽的 setup 附件切成这个遮罩（默认 true） */
  display?: boolean
  /** 目标皮肤；不传 = 当前激活皮肤（再回退第一个皮肤） */
  skin?: string
}

/**
 * 在指定插槽上创建遮罩附件。
 *
 * 遮罩本身不渲染，只对绘制顺序中它之后的附件生效；`points` 必须是**骨骼局部坐标**，
 * 这样导出 Spine / .hao2d 时不需要再叠加附件 TRS。
 */
export function createClippingAttachment(
  doc: EditorDocument,
  slotName: string,
  options: CreateClippingOptions
): AuthoringAttachment | null {
  const slot = doc.slots.find((item) => item.name === slotName)
  if (!slot) return null
  const points = options.points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
  if (points.length < 3) return null

  const skinName = options.skin ?? doc.editorMeta.activeSkin
  const skin = (skinName ? doc.skins.find((item) => item.name === skinName) : undefined) ?? doc.skins[0]
  if (!skin) return null
  let skinSlot = findSkinSlot(skin, slotName)
  if (!skinSlot) {
    skinSlot = { slot: slotName, attachments: [] }
    skin.slots.push(skinSlot)
  }
  const existing = skinSlot.attachments.map((item) => item.name)
  const name = uniqueName(existing, options.name?.trim() || 'mask')
  const attachment = createAuthoringAttachment({
    name,
    type: 'clipping',
    image: '',
    position: { x: 0, y: 0 },
    rotation: 0,
    scale: { x: 1, y: 1 },
    size: { x: 0, y: 0 },
    frameSize: { x: 0, y: 0 },
    contentOffset: { x: 0, y: 0 },
    vertices: points.map((point) => ({ x: point.x, y: point.y, weights: [] })),
    uvs: [],
    triangles: [],
    edges: [],
    hull: points.length,
    clipEndSlot: options.endSlot ?? '',
    clipInverse: options.inverse ?? false,
    clipConvex: options.convex ?? false
  })
  skinSlot.attachments.push(attachment)
  if (options.display !== false) slot.attachment = name
  return attachment
}

/**
 * 把 Region / Mesh 转成遮罩（保留附件名，动画里的 attachment 轨道继续有效）。
 *
 * - Region：用内容矩形四角（含裁剪偏移）换算到骨骼局部；
 * - Mesh：取顶点凸包（加权网格依赖 bindpose，第一版不自动转换，返回 false）。
 */
export function convertAttachmentToClipping(
  doc: EditorDocument,
  slotName: string,
  attachmentName: string,
  skinName?: string
): boolean {
  const attachment = skinName
    ? doc.skins
        .find((skin) => skin.name === skinName)
        ?.slots.find((skinSlot) => skinSlot.slot === slotName)
        ?.attachments.find((item) => item.name === attachmentName) ?? null
    : findAttachment(doc, slotName, attachmentName)
  if (!attachment || attachment.type === 'clipping') return false

  let points: Vec2[] = []
  if (attachment.type === 'region') {
    const halfWidth = attachment.size.x * 0.5
    const halfHeight = attachment.size.y * 0.5
    const ox = attachment.contentOffset.x
    const oy = attachment.contentOffset.y
    points = [
      { x: -halfWidth + ox, y: -halfHeight + oy },
      { x: halfWidth + ox, y: -halfHeight + oy },
      { x: halfWidth + ox, y: halfHeight + oy },
      { x: -halfWidth + ox, y: halfHeight + oy }
    ].map((point) => attachmentToBone(attachment, point))
  } else if (attachment.type === 'mesh' || attachment.type === 'linkedmesh') {
    if (attachment.vertices.some((vertex) => vertex.weights.length > 0)) return false
    const source = attachment.vertices.map((vertex) => attachmentToBone(attachment, { x: vertex.x, y: vertex.y }))
    if (source.length < 3) return false
    points = convexHull(source).map((index) => source[index])
  }
  if (points.length < 3) return false

  attachment.type = 'clipping'
  attachment.image = ''
  attachment.regionName = undefined
  attachment.position = { x: 0, y: 0 }
  attachment.rotation = 0
  attachment.scale = { x: 1, y: 1 }
  attachment.size = { x: 0, y: 0 }
  attachment.frameSize = { x: 0, y: 0 }
  attachment.contentOffset = { x: 0, y: 0 }
  attachment.vertices = points.map((point) => ({ x: point.x, y: point.y, weights: [] }))
  attachment.uvs = []
  attachment.triangles = []
  attachment.edges = []
  attachment.hull = points.length
  attachment.ffdInBoneSpace = false
  attachment.clipEndSlot = ''
  attachment.clipInverse = false
  attachment.clipConvex = true
  delete attachment.regionSnapshot
  delete attachment.bones

  // 转成遮罩后点数和原来的网格不同：清掉旧的 deform 轨道，避免 offsets 错位
  for (const animation of doc.animations) {
    animation.deforms = animation.deforms.filter(
      (track) => !(track.slot === slotName && track.attachment === attachmentName)
    )
  }
  return true
}

/** 在指定皮肤（不传 = 跨皮肤）里找遮罩附件 */
function findClippingAttachment(
  doc: EditorDocument,
  slotName: string,
  attachmentName: string,
  skinName?: string
): AuthoringAttachment | null {
  if (!skinName) {
    const found = findAttachment(doc, slotName, attachmentName)
    return found?.type === 'clipping' ? found : null
  }
  const found = doc.skins
    .find((skin) => skin.name === skinName)
    ?.slots.find((skinSlot) => skinSlot.slot === slotName)
    ?.attachments.find((item) => item.name === attachmentName)
  return found?.type === 'clipping' ? found : null
}

/** 整体替换遮罩多边形（绘制工具闭合时用）；少于 3 点返回 false */
export function setClippingVertices(
  doc: EditorDocument,
  slotName: string,
  attachmentName: string,
  points: readonly Vec2[],
  skinName?: string
): boolean {
  const attachment = findClippingAttachment(doc, slotName, attachmentName, skinName)
  if (!attachment || points.length < 3) return false
  const countChanged = attachment.vertices.length !== points.length
  attachment.vertices = points.map((point) => ({ x: point.x, y: point.y, weights: [] }))
  attachment.hull = points.length
  if (countChanged) clearClippingDeformTracks(doc, slotName, attachmentName)
  return true
}

/** 更新遮罩控制点（拖点工具用）；index 越界返回 false */
export function setClippingPoint(
  doc: EditorDocument,
  slotName: string,
  attachmentName: string,
  index: number,
  point: Vec2,
  skinName?: string
): boolean {
  const attachment = findClippingAttachment(doc, slotName, attachmentName, skinName)
  if (!attachment) return false
  if (index < 0 || index >= attachment.vertices.length) return false
  attachment.vertices[index] = { x: point.x, y: point.y, weights: [] }
  return true
}

/**
 * 遮罩控制点数量变化时清掉对应的 FFD 轨道。
 * deform 偏移按顶点下标对齐，点一插一删，旧 offsets 会整体错位（表现是遮罩越播越歪）。
 */
function clearClippingDeformTracks(doc: EditorDocument, slotName: string, attachmentName: string): void {
  for (const animation of doc.animations) {
    animation.deforms = animation.deforms.filter(
      (track) => !(track.slot === slotName && track.attachment === attachmentName)
    )
  }
}

/** 在第 index 个点之后插入一个控制点（index = -1 表示插到最前） */
export function insertClippingPoint(
  doc: EditorDocument,
  slotName: string,
  attachmentName: string,
  index: number,
  point: Vec2,
  skinName?: string
): boolean {
  const attachment = findClippingAttachment(doc, slotName, attachmentName, skinName)
  if (!attachment) return false
  const at = Math.max(0, Math.min(attachment.vertices.length, index + 1))
  attachment.vertices.splice(at, 0, { x: point.x, y: point.y, weights: [] })
  attachment.hull = attachment.vertices.length
  clearClippingDeformTracks(doc, slotName, attachmentName)
  return true
}

/** 删除一个控制点；少于 3 个点时不删（遮罩会退化） */
export function deleteClippingPoint(
  doc: EditorDocument,
  slotName: string,
  attachmentName: string,
  index: number,
  skinName?: string
): boolean {
  const attachment = findClippingAttachment(doc, slotName, attachmentName, skinName)
  if (!attachment) return false
  if (attachment.vertices.length <= 3) return false
  if (index < 0 || index >= attachment.vertices.length) return false
  attachment.vertices.splice(index, 1)
  attachment.hull = attachment.vertices.length
  clearClippingDeformTracks(doc, slotName, attachmentName)
  return true
}

/** 点在三角形内（含边界） */
function pointInTriangle(px: number, py: number, a: Vec2, b: Vec2, c: Vec2): boolean {
  const d1 = (b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x)
  const d2 = (c.x - b.x) * (py - b.y) - (c.y - b.y) * (px - b.x)
  const d3 = (a.x - c.x) * (py - c.y) - (a.y - c.y) * (px - c.x)
  const hasNegative = d1 < 0 || d2 < 0 || d3 < 0
  const hasPositive = d1 > 0 || d2 > 0 || d3 > 0
  return !(hasNegative && hasPositive)
}

/** 重心坐标：用来把新顶点的 UV / 蒙皮权重按位置比例插值出来 */
function barycentric(a: Vec2, b: Vec2, c: Vec2, x: number, y: number): { u: number; v: number; w: number } | null {
  const det = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y)
  if (Math.abs(det) < 1e-9) return null
  const u = ((b.y - c.y) * (x - c.x) + (c.x - b.x) * (y - c.y)) / det
  const v = ((c.y - a.y) * (x - c.x) + (a.x - c.x) * (y - c.y)) / det
  return { u, v, w: 1 - u - v }
}

/** 按比例合并若干顶点的权重（结果按骨骼名聚合、归一化） */
function blendWeights(parts: Array<[AuthoringVertex, number]>): AuthoringWeight[] {
  const merged = new Map<string, number>()
  for (const [vertex, factor] of parts) {
    if (factor <= 1e-4) continue
    for (const weight of vertex.weights) {
      merged.set(weight.bone, (merged.get(weight.bone) ?? 0) + weight.weight * factor)
    }
  }
  const entries = [...merged.entries()].filter(([, value]) => value > 1e-4)
  if (entries.length === 0) return parts[0] ? [...parts[0][0].weights] : []
  const total = entries.reduce((sum, [, value]) => sum + value, 0)
  return entries.map(([bone, value]) => ({ bone, weight: total > 0 ? value / total : value }))
}

/** 命中哪个三角形（返回三角形序号，-1 = 没命中） */
function triangleAtPoint(attachment: AuthoringAttachment, x: number, y: number): number {
  const { vertices, triangles } = attachment
  for (let t = 0; t + 2 < triangles.length; t += 3) {
    const a = vertices[triangles[t]]
    const b = vertices[triangles[t + 1]]
    const c = vertices[triangles[t + 2]]
    if (!a || !b || !c) continue
    if (pointInTriangle(x, y, a, b, c)) return t
  }
  return -1
}

/**
 * 在网格里插入一个顶点。
 *
 * - 点落在**已有网格线上**（吸附容差内、且不在端点附近）→ 把这条边一分为二：
 *   新顶点插在边线上（UV / 权重按边上的比例插值），相邻的 1~2 个三角形各自拆成两个
 * - 点落在三角形内部 → 把命中的三角形拆成 3 个（UV 与权重按重心坐标插值）
 *
 * 返回新顶点的下标；两处都不命中时返回 null。
 */
export function insertMeshVertex(
  doc: EditorDocument,
  slotName: string,
  attachmentName: string,
  point: Vec2
): number | null {
  const attachment = findAttachment(doc, slotName, attachmentName)
  if (!attachment || attachment.type !== 'mesh') return null

  // 先看是不是「点在网格线上」：容差内取最近的一条边。
  // 端点附近（t ≈ 0 / 1）不算 —— 那里本来就有顶点，插进去只会得到退化三角形
  const edge = nearestEdgeOf(attachment, point.x, point.y)
  if (edge && edge.distance <= edgeInsertTolerance(attachment) && edge.t >= 0.05 && edge.t <= 0.95) {
    return insertVertexOnEdge(attachment, edge)
  }

  const triangleIndex = triangleAtPoint(attachment, point.x, point.y)
  if (triangleIndex < 0) return null
  const [i0, i1, i2] = [
    attachment.triangles[triangleIndex],
    attachment.triangles[triangleIndex + 1],
    attachment.triangles[triangleIndex + 2]
  ]
  const a = attachment.vertices[i0]
  const b = attachment.vertices[i1]
  const c = attachment.vertices[i2]
  const bary = barycentric(a, b, c, point.x, point.y)
  if (!bary) return null

  const index = attachment.vertices.length
  attachment.vertices.push({
    x: point.x,
    y: point.y,
    weights: blendWeights([
      [a, bary.u],
      [b, bary.v],
      [c, bary.w]
    ])
  })
  attachment.uvs.push(
    attachment.uvs[i0 * 2] * bary.u + attachment.uvs[i1 * 2] * bary.v + attachment.uvs[i2 * 2] * bary.w,
    attachment.uvs[i0 * 2 + 1] * bary.u + attachment.uvs[i1 * 2 + 1] * bary.v + attachment.uvs[i2 * 2 + 1] * bary.w
  )
  // 原三角形 → 三个新三角形（共享新顶点）
  attachment.triangles.splice(triangleIndex, 3, i0, i1, index, i1, i2, index, i2, i0, index)
  // 贴着已有边插入时会立刻带出细长三角形：就地做一轮局部 Delaunay 翻转换掉它们
  //（只动新点周围的连线，其余区域不变）
  attachment.triangles = refineAroundVertex(attachment.vertices, attachment.triangles, index)
  attachment.hull = attachment.vertices.length
  return index
}

/**
 * 点到线段的距离与投影参数：遍历所有三角形的三条边，返回最近的一条。
 * 同一条边会被相邻两个三角形各算一次，这里不去重（网格规模很小，代价可以忽略）。
 */
function nearestEdgeOf(
  attachment: AuthoringAttachment,
  x: number,
  y: number
): { a: number; b: number; t: number; distance: number } | null {
  const { vertices, triangles } = attachment
  let best: { a: number; b: number; t: number; distance: number } | null = null
  for (let i = 0; i + 2 < triangles.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const ia = triangles[i + k]
      const ib = triangles[i + ((k + 1) % 3)]
      const a = vertices[ia]
      const b = vertices[ib]
      if (!a || !b) continue
      const dx = b.x - a.x
      const dy = b.y - a.y
      const lengthSq = dx * dx + dy * dy
      const t = lengthSq < 1e-12 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / lengthSq))
      const distance = Math.hypot(x - (a.x + dx * t), y - (a.y + dy * t))
      if (!best || distance < best.distance) best = { a: ia, b: ib, t, distance }
    }
  }
  return best
}

/** 「点在网格线上」的吸附容差：按网格包围盒对角线取 1.5%（与视口缩放无关，行为可预期） */
function edgeInsertTolerance(attachment: AuthoringAttachment): number {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const vertex of attachment.vertices) {
    if (vertex.x < minX) minX = vertex.x
    if (vertex.y < minY) minY = vertex.y
    if (vertex.x > maxX) maxX = vertex.x
    if (vertex.y > maxY) maxY = vertex.y
  }
  return Math.max(Math.hypot(maxX - minX, maxY - minY) * 0.015, 1e-4)
}

/** 在一条边上插点：边一分为二，相邻的 1~2 个三角形各自拆成两个 */
function insertVertexOnEdge(
  attachment: AuthoringAttachment,
  edge: { a: number; b: number; t: number }
): number {
  const { a: ia, b: ib, t } = edge
  const va = attachment.vertices[ia]
  const vb = attachment.vertices[ib]
  const index = attachment.vertices.length
  // 新顶点落在**投影点**上（不用原始点击位置：那会让新顶点略微偏离这条边）
  attachment.vertices.push({
    x: va.x + (vb.x - va.x) * t,
    y: va.y + (vb.y - va.y) * t,
    weights: blendWeights([
      [va, 1 - t],
      [vb, t]
    ])
  })
  attachment.uvs.push(
    attachment.uvs[ia * 2] * (1 - t) + attachment.uvs[ib * 2] * t,
    attachment.uvs[ia * 2 + 1] * (1 - t) + attachment.uvs[ib * 2 + 1] * t
  )

  const next: number[] = []
  for (let i = 0; i + 2 < attachment.triangles.length; i += 3) {
    const p = attachment.triangles[i]
    const q = attachment.triangles[i + 1]
    const r = attachment.triangles[i + 2]
    const split = splitTriangleAtEdge(p, q, r, ia, ib, index)
    if (split) next.push(split[0], split[1], split[2], split[3], split[4], split[5])
    else next.push(p, q, r)
  }
  // 边上插点同样可能夹出细长三角形（吸附位置偏向某一端时）：局部翻转一次
  attachment.triangles = refineAroundVertex(attachment.vertices, next, index)
  attachment.hull = attachment.vertices.length
  return index
}

/**
 * 三角形含这条边时，按边的**原有方向**拆成两个（保持绕向，避免三角形翻面）。
 * 相邻的两个三角形里这条边的方向相反，所以两个方向都要匹配。
 */
function splitTriangleAtEdge(
  p: number,
  q: number,
  r: number,
  ia: number,
  ib: number,
  index: number
): number[] | null {
  const tri = [p, q, r]
  for (let k = 0; k < 3; k++) {
    const from = tri[k]
    const to = tri[(k + 1) % 3]
    if ((from === ia && to === ib) || (from === ib && to === ia)) {
      const rest = tri[(k + 2) % 3]
      return [from, index, rest, index, to, rest]
    }
  }
  return null
}

/**
 * 删除一个网格顶点：丢掉引用它的三角形，再用「一环邻域」重新三角化把洞填上。
 * 至少要剩一个三角形，否则直接拒绝。
 */
export function deleteMeshVertex(
  doc: EditorDocument,
  slotName: string,
  attachmentName: string,
  vertexIndex: number
): boolean {
  const attachment = findAttachment(doc, slotName, attachmentName)
  if (!attachment || attachment.type !== 'mesh') return false
  if (vertexIndex < 0 || vertexIndex >= attachment.vertices.length) return false
  if (attachment.vertices.length <= 3) return false

  const neighbours = new Set<number>()
  const kept: number[] = []
  for (let t = 0; t + 2 < attachment.triangles.length; t += 3) {
    const triangle = [attachment.triangles[t], attachment.triangles[t + 1], attachment.triangles[t + 2]]
    if (!triangle.includes(vertexIndex)) {
      kept.push(triangle[0], triangle[1], triangle[2])
      continue
    }
    for (const index of triangle) if (index !== vertexIndex) neighbours.add(index)
  }

  const victim = attachment.vertices[vertexIndex]
  const ring = [...neighbours].sort(
    (left, right) =>
      Math.atan2(attachment.vertices[left].y - victim.y, attachment.vertices[left].x - victim.x) -
      Math.atan2(attachment.vertices[right].y - victim.y, attachment.vertices[right].x - victim.x)
  )
  const ringPoints = ring.map((index) => ({
    x: attachment.vertices[index].x,
    y: attachment.vertices[index].y
  }))
  const patch = triangulatePolygon(ringPoints).map((index) => ring[index])

  // 删顶点后所有更大的下标都要前移一位
  const remap = (index: number): number => (index > vertexIndex ? index - 1 : index)
  attachment.vertices.splice(vertexIndex, 1)
  attachment.uvs.splice(vertexIndex * 2, 2)
  attachment.triangles = [...kept, ...patch].map(remap)
  attachment.edges = attachment.edges.filter((index) => index !== vertexIndex).map(remap)
  attachment.hull = attachment.vertices.length

  for (const animation of doc.animations) {
    for (const track of animation.deforms) {
      if (track.slot !== slotName || track.attachment !== attachmentName) continue
      // FFD 帧按「满顶点长度」的 (x,y) 偏移存放，删掉顶点就要同步删它的两个数
      for (const frame of track.frames) {
        const start = Math.max(0, (vertexIndex - frame.vertexOffset) * 2)
        if (start < frame.offsets.length) frame.offsets.splice(start, 2)
      }
    }
  }
  return true
}

/** 顶点包围盒（还原 Region 时估尺寸用） */
function vertexBounds(vertices: readonly { x: number; y: number }[]): { x: number; y: number } | null {
  if (vertices.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const vertex of vertices) {
    if (vertex.x < minX) minX = vertex.x
    if (vertex.x > maxX) maxX = vertex.x
    if (vertex.y < minY) minY = vertex.y
    if (vertex.y > maxY) maxY = vertex.y
  }
  return { x: maxX - minX, y: maxY - minY }
}

/**
 * 对（所有皮肤里的）同名附件做就地修改：位置 / 旋转 / 缩放 / 颜色等编辑的统一入口。
 * draft 必须是 immer 的可变文档。
 */
export function patchAttachment(
  doc: EditorDocument,
  slotName: string,
  attachmentName: string,
  patch: (attachment: AuthoringAttachment) => void
): void {
  for (const skin of doc.skins) {
    const skinSlot = findSkinSlot(skin, slotName)
    if (!skinSlot) continue
    const attachment = skinSlot.attachments.find((item) => item.name === attachmentName)
    if (attachment) patch(attachment)
  }
}

export function deleteAttachment(doc: EditorDocument, slotName: string, attachmentName: string): void {
  for (const skin of doc.skins) {
    const skinSlot = findSkinSlot(skin, slotName)
    if (!skinSlot) continue
    skinSlot.attachments = skinSlot.attachments.filter((item) => item.name !== attachmentName)
  }
  const slot = doc.slots.find((item) => item.name === slotName)
  if (slot && slot.attachment === attachmentName) {
    slot.attachment = ''
  }
  for (const animation of doc.animations) {
    const track = animation.deforms.find((item) => item.slot === slotName && item.attachment === attachmentName)
    if (track) animation.deforms = animation.deforms.filter((item) => item !== track)
  }
}

/**
 * 权重刷：以世界坐标为中心、radius 为半径，对目标附件顶点刷权重的权重（模式见 BrushMode）。
 *
 * 笔刷手感按 **Spine Weights 工具**：
 * - `strength`（0..1）= **一笔内能刷到的权重上限**。add / grow 只朝目标值靠近、不越过它，
 *   所以来回刷不会越刷越浓（旧实现是每帧增量叠加，很容易刷过头）；
 * - `feather`（0..1）= 边缘衰减占半径的百分比。内圈满强度、外圈线性衰减到 0：
 *   0 = 硬边，1 = 从中心就开始衰减。
 *
 * 模式语义：
 * - add / grow：朝目标值增长（grow 跳过还没受这根骨骼影响的顶点）
 * - subtract：按目标值衰减；replace：直接覆盖成目标值
 * - smooth：朝邻居的平均权重靠拢（与刷哪根骨骼无关）
 * - `normalize`（Unity 的 Normalize，默认开）：把其它骨骼按比例缩放，让权重和回到 1；
 *   关掉时只改目标骨骼，权重和可以 ≠ 1 —— 渲染按相对比例算（见 meshBuilder），
 *   导出也会重新归一化（见 compile.normalizeWeights），所以那是合法的编辑期状态。
 *
 * 返回被影响的顶点数。
 */
export function paintWeights(
  doc: EditorDocument,
  samples: readonly VertexSample[],
  bone: string,
  center: { x: number; y: number },
  radius: number,
  strength: number,
  mode: BrushMode,
  normalize = true,
  /** 边缘衰减占半径的比例（0..1，0 = 硬边；对齐 Spine 的 Feather） */
  feather = 0.5
): number {
  // 只有 smooth 不需要目标骨骼（它平均的是全部骨骼的权重）
  if ((mode !== 'smooth' && !bone) || radius <= 0) return 0
  let touched = 0
  /** 邻接表按附件懒建：只有真正刷到 smooth 时才需要邻居 */
  const adjacency = new Map<string, Map<number, number[]>>()
  const cap = Math.min(1, Math.max(0, strength))
  const soft = Math.min(1, Math.max(0, feather))

  for (const sample of samples) {
    if (sample.slot === '' || sample.attachment === '') continue
    const attachment = findAttachment(doc, sample.slot, sample.attachment)
    if (!attachment) continue
    const vertex = attachment.vertices[sample.vertex]
    if (!vertex) continue

    const dx = sample.x - center.x
    const dy = sample.y - center.y
    const distance = Math.sqrt(dx * dx + dy * dy)
    if (distance > radius) continue

    /*
     * 内圈满强度、外圈线性衰减（Spine 的 Feather）：
     * feather = 0 → 整圈满强度（硬边）；feather = 1 → 从中心衰减到边缘 0。
     */
    const t = distance / radius
    const falloff = soft <= 0 || t <= 1 - soft ? 1 : (1 - t) / soft
    if (falloff <= 0) continue
    /** 这一笔在该顶点上的目标值：中心 = Strength，边缘按 Feather 递减 */
    const goal = cap * falloff

    if (mode === 'smooth') {
      const neighbors = adjacencyFor(adjacency, attachment, sample.slot, sample.attachment).get(sample.vertex)
      if (!neighbors || neighbors.length === 0) continue
      if (smoothVertex(attachment, sample.vertex, neighbors, Math.min(1, goal), normalize)) touched++
      continue
    }

    const before = vertex.weights.find((item) => item.bone === bone)?.weight ?? 0
    // grow（Unity 的 Grow and Shrink）：只在**已经受这根骨骼影响**的顶点上生长
    if (mode === 'grow' && before <= 1e-6) continue
    let current = before
    if (mode === 'add' || mode === 'grow') {
      // 一笔封顶：只朝 goal 靠近、不越过它 —— 来回刷不会越来越浓（旧实现是 current + delta）
      if (goal > current) current = goal
    } else if (mode === 'subtract') {
      current = Math.max(0, current - goal)
    } else {
      current = goal
    }
    if (Math.abs(current - before) <= 1e-6) continue

    applyVertexWeight(vertex.weights, bone, current, normalize)
    touched++
  }
  return touched
}

/** 附件内顶点 → 邻居顶点（只从三角面取；按 `slot\0attachment` 缓存，一次刷权重只建一次） */
function adjacencyFor(
  cache: Map<string, Map<number, number[]>>,
  attachment: AuthoringAttachment,
  slot: string,
  name: string
): Map<number, number[]> {
  const key = `${slot}\u0000${name}`
  const cached = cache.get(key)
  if (cached) return cached

  const map = new Map<number, number[]>()
  const link = (a: number, b: number): void => {
    let list = map.get(a)
    if (!list) {
      list = []
      map.set(a, list)
    }
    if (!list.includes(b)) list.push(b)
  }
  const triangles = attachment.triangles
  for (let i = 0; i + 2 < triangles.length; i += 3) {
    const a = triangles[i]
    const b = triangles[i + 1]
    const c = triangles[i + 2]
    link(a, b)
    link(b, a)
    link(b, c)
    link(c, b)
    link(a, c)
    link(c, a)
  }
  cache.set(key, map)
  return map
}

/**
 * 把一个顶点的权重朝**邻居的平均权重**靠拢（Unity 的 Smooth 模式）。
 *
 * 权重是每顶点一张稀疏表，所以按「本顶点 + 邻居」的骨骼并集逐根算：取邻居的平均值，
 * 再按 `t` 混合，最后归一化回 1（空表仍然保持空表）。返回权重是否真的变了。
 */
function smoothVertex(
  attachment: AuthoringAttachment,
  index: number,
  neighbors: readonly number[],
  t: number,
  normalize: boolean
): boolean {
  const vertex = attachment.vertices[index]
  if (!vertex) return false
  const bones = new Set<string>()
  for (const item of vertex.weights) bones.add(item.bone)
  for (const neighbor of neighbors) {
    const other = attachment.vertices[neighbor]
    if (!other) continue
    for (const item of other.weights) bones.add(item.bone)
  }
  if (bones.size === 0) return false

  const weightOf = (list: readonly AuthoringWeight[], bone: string): number =>
    list.find((item) => item.bone === bone)?.weight ?? 0

  const next: AuthoringWeight[] = []
  let total = 0
  for (const bone of bones) {
    let sum = 0
    for (const neighbor of neighbors) {
      const other = attachment.vertices[neighbor]
      if (other) sum += weightOf(other.weights, bone)
    }
    const average = sum / neighbors.length
    const blended = weightOf(vertex.weights, bone) * (1 - t) + average * t
    if (blended > 1e-6) {
      next.push({ bone, weight: blended })
      total += blended
    }
  }
  if (total <= 1e-6) return false
  if (normalize && Math.abs(total - 1) > 1e-6) for (const item of next) item.weight /= total
  if (sameWeights(vertex.weights, next)) return false
  vertex.weights = next
  return true
}

/**
 * 把某个骨骼的权重写进稀疏权重表。
 *
 * `normalize = true`（默认）会把其它骨骼按比例缩放，让这张表总和回到 1；
 * **`normalize = false`** 就是 Unity Weight Brush 里关掉 **Normalize** 的样子 ——
 * 只改这根骨骼，别的原样不动，权重和可能 ≠ 1（导出时照原样写出去）。
 */
export function applyVertexWeight(
  weights: Array<{ bone: string; weight: number }>,
  bone: string,
  value: number,
  normalize = true
): void {
  const clamped = Math.max(0, Math.min(1, value))
  if (!normalize) {
    const item = weights.find((entry) => entry.bone === bone)
    if (clamped <= 1e-6) {
      if (item) weights.splice(weights.indexOf(item), 1)
      return
    }
    if (item) item.weight = clamped
    else weights.push({ bone, weight: clamped })
    return
  }
  const others = weights.filter((item) => item.bone !== bone)
  const otherTotal = others.reduce((sum, item) => sum + item.weight, 0)

  const next: Array<{ bone: string; weight: number }> = []
  if (clamped >= 1 - 1e-6) {
    // 独占权重：丢掉其它骨骼，避免归一化后出现极小残留
    next.push({ bone, weight: 1 })
  } else {
    if (clamped > 1e-6) next.push({ bone, weight: clamped })
    const remainder = 1 - clamped
    for (const item of others) {
      const scaled = otherTotal > 1e-6 ? (item.weight / otherTotal) * remainder : 0
      if (scaled > 1e-6) next.push({ bone: item.bone, weight: scaled })
    }
    /*
     * 走到这里 next 为空 = 这根骨骼被刷到 0、且没有别的骨骼接手 —— 结果就是**空权重表**：
     * 该顶点不受任何骨骼影响（留在原地、不塌陷，见 meshBuilder 的零权重保护）。
     *
     * 这里**不能**把权重塞回 1：那会让「一直减到底」在最后一刻突然跳回 100%
     *（实测就是这个现象：某根骨骼减到 0 又变成 100%）。空表是合法状态 ——
     * 与 Spine 里「该顶点 0 根骨骼」一致，也正是「擦掉这根骨骼的影响」应有的结果。
     */
  }

  weights.length = 0
  weights.push(...next)
}

/**
 * 自动权重：按顶点到骨骼线段的距离衰减分配（距离越近权重越大），取最近的若干根骨骼。
 * setup 世界坐标由调用方传入（Pose 态下取自当前网格结果）。
 */
export function autoWeights(
  doc: EditorDocument,
  samples: readonly VertexSample[],
  bones: ReadonlyArray<{ name: string; ax: number; ay: number; bx: number; by: number }>,
  options: { falloff?: number; maxBones?: number } = {}
): number {
  if (bones.length === 0) return 0
  const falloff = Math.max(1, options.falloff ?? 2)
  const maxBones = Math.max(1, Math.min(4, options.maxBones ?? 4))

  let touched = 0
  for (const sample of samples) {
    const attachment = findAttachment(doc, sample.slot, sample.attachment)
    const vertex = attachment?.vertices[sample.vertex]
    if (!vertex) continue

    const scored = bones.map((bone) => {
      const distance = distanceToSegment(sample.x, sample.y, bone.ax, bone.ay, bone.bx, bone.by)
      return { bone: bone.name, score: 1 / Math.pow(Math.max(1e-4, distance), falloff) }
    })
    scored.sort((a, b) => b.score - a.score)
    const top = scored.slice(0, maxBones).filter((item) => item.score > 0)
    const total = top.reduce((sum, item) => sum + item.score, 0)
    if (total <= 0) continue

    const next = top.map((item) => ({ bone: item.bone, weight: item.score / total }))
    // 只在结果**确实变了**时才计数：调用方据此区分「重算完成」和「本来就是这个结果」
    //（比如列表里只有宿主骨骼一根时，顶点权重必然是它 100%，点了也看不出变化）
    if (!sameWeights(vertex.weights, next)) {
      vertex.weights = next
      touched++
    }
  }
  return touched
}

/**
 * 设置某个顶点在某根骨骼上的权重，其余骨骼**按比例**分享剩下的部分。
 *
 * 这里维持「权重和 = 1」只是编辑期的整洁约定（面板滑块与画笔在 Normalize 打开时都这么改）；
 * 渲染并不要求它 —— 网格构建按**相对比例**归一化（Σw ≠ 1 时除以 Σw，见 meshBuilder），
 * 导出也会按 top-4 重新归一化（见 compile.normalizeWeights）。规则：
 * - 目标骨骼设成 1 → 清空其它骨骼（不留 0 权重残渣）
 * - 其它骨骼本来有权重 → 按原比例缩放到剩余的 `1 - v`
 * - 其它骨骼全是 0（这个顶点第一次拿到第二根骨骼）→ 剩余量交给**列表里的另一根**
 * - 列表里只有这一根骨骼 → 它只能是 1（否则配不平）
 *
 * 返回是否真的改了（没变化就不该产生撤销记录）。
 */
export function setVertexWeight(
  doc: EditorDocument,
  slotName: string,
  attachmentName: string,
  vertexIndex: number,
  bone: string,
  value: number
): boolean {
  const attachment = findAttachment(doc, slotName, attachmentName)
  if (!attachment || attachment.type !== 'mesh') return false
  const vertex = attachment.vertices[vertexIndex]
  if (!vertex) return false
  if (!doc.bones.some((item) => item.name === bone)) return false
  const bound = weightBonesOf(attachment)
  if (!bound.includes(bone)) return false

  const before = vertex.weights.map((entry) => ({ ...entry }))
  // 只绑了一根骨骼时它只能是 1：没有别的骨骼来配平剩下的部分（UI 那边也会禁用滑块）
  const target = bound.length < 2 ? 1 : Math.min(1, Math.max(0, value))
  /*
   * `applyVertexWeight` 只在**已有**的其它骨骼之间按比例分配剩余量；这个顶点的其余骨骼
   * 全是 0 时（第一次给它加上第二根骨骼）没东西可分，权和会停在 target < 1 —— 于是先把
   * 剩余量挂到列表里的另一根上，再交给它归一化（与画笔同样的「列表优先」口径）。
   */
  const hasOther = vertex.weights.some((entry) => entry.bone !== bone && entry.weight > 1e-6)
  if (!hasOther && target < 1 - 1e-6) {
    const fallback = bound.find((name) => name !== bone)
    if (fallback) vertex.weights.push({ bone: fallback, weight: 1 - target })
  }
  applyVertexWeight(vertex.weights, bone, target)
  return !sameWeights(before, vertex.weights)
}

/** 两组权重是否等价（骨骼一一对应且各自权重差在容差内） */
function sameWeights(
  a: readonly { bone: string; weight: number }[],
  b: readonly { bone: string; weight: number }[]
): boolean {
  if (a.length !== b.length) return false
  for (const item of a) {
    const other = b.find((entry) => entry.bone === item.bone)
    if (!other || Math.abs(other.weight - item.weight) > 1e-4) return false
  }
  return true
}

/**
 * 网格**绑定的骨骼列表**（检查器「权重骨骼列表」用）：
 * 优先用附件上的显式列表；老数据没有这个字段时退回「顶点权重里出现过的骨骼」
 * —— 手动刷过权重的网格因此也能显示出绑定关系。
 */
export function weightBonesOf(attachment: AuthoringAttachment): string[] {
  if (attachment.bones && attachment.bones.length > 0) {
    // 去重（保序）：列表里混进重名会让检查器显示出两行同样的骨骼
    return [...new Set(attachment.bones)]
  }
  const seen = new Set<string>()
  for (const vertex of attachment.vertices) {
    for (const weight of vertex.weights) {
      if (weight.weight > 1e-6) seen.add(weight.bone)
    }
  }
  return [...seen]
}

/** 把一根骨骼加进网格的权重骨骼列表（已在列表里 / 骨骼不存在时返回 false，调用方据此提示） */
export function addWeightBone(
  doc: EditorDocument,
  slotName: string,
  attachmentName: string,
  bone: string
): boolean {
  const attachment = findAttachment(doc, slotName, attachmentName)
  if (!attachment || attachment.type !== 'mesh') return false
  if (!doc.bones.some((item) => item.name === bone)) return false
  const current = weightBonesOf(attachment)
  if (current.includes(bone)) return false
  attachment.bones = [...current, bone]
  return true
}

/**
 * 从权重骨骼列表移除一根骨骼，并清掉它在所有顶点上的权重。
 *
 * 剩下的权重会**重新归一化**（只按比例放大、方向不变）。渲染其实按相对比例算
 *（见 meshBuilder），但归一化有两个实际好处：一是导出只带 **top-4** 骨骼，
 * 权和大于 1 时截断再归一化会改变比例；二是面板里的百分比加起来正好 100%。
 */
export function removeWeightBone(
  doc: EditorDocument,
  slotName: string,
  attachmentName: string,
  bone: string
): boolean {
  const attachment = findAttachment(doc, slotName, attachmentName)
  if (!attachment || attachment.type !== 'mesh') return false
  const current = weightBonesOf(attachment)
  if (!current.includes(bone)) return false
  attachment.bones = current.filter((item) => item !== bone)

  for (const vertex of attachment.vertices) {
    const kept = vertex.weights.filter((weight) => weight.bone !== bone)
    const total = kept.reduce((sum, weight) => sum + weight.weight, 0)
    if (total > 1e-6) {
      vertex.weights = kept.map((weight) => ({ bone: weight.bone, weight: weight.weight / total }))
      continue
    }
    // 删完一根不剩：顶点会失去蒙皮、塌到原点。退回列表里的第一根骨骼（权重 1）兜底，
    // 列表也空了才留空 —— 用户重新绑定并点「自动计算权重」即可恢复。
    const fallback = attachment.bones?.[0]
    vertex.weights = fallback ? [{ bone: fallback, weight: 1 }] : []
  }
  return true
}

/**
 * 从当前网格结果里取出「共享顶点 → 附件顶点」的对应关系与 setup 世界坐标。
 * `resolve` 由调用方提供（把 slotIndex + 附件内下标解析成 插槽名 / 附件名）。
 */
export function meshVertexSamples(
  mesh: { positions: Float32Array; vertexCount: number; sourceSlot: Int32Array; sourceVertex: Int32Array },
  resolve: (slotIndex: number, vertex: number) => { slot: string; attachment: string; vertex: number } | null
): VertexSample[] {
  const samples: VertexSample[] = []
  for (let i = 0; i < mesh.vertexCount; i++) {
    const slotIndex = mesh.sourceSlot[i]
    if (slotIndex < 0) continue
    const resolved = resolve(slotIndex, mesh.sourceVertex[i])
    if (!resolved || resolved.vertex < 0) continue
    samples.push({
      slot: resolved.slot,
      attachment: resolved.attachment,
      vertex: resolved.vertex,
      x: mesh.positions[i * 2],
      y: mesh.positions[i * 2 + 1]
    })
  }
  return samples
}

export function uvRect(uvs: readonly number[]): { u0: number; u1: number; v0: number; v1: number } {
  if (uvs.length < 4) return { u0: 0, u1: 1, v0: 0, v1: 1 }
  let u0 = Number.POSITIVE_INFINITY
  let u1 = Number.NEGATIVE_INFINITY
  let v0 = Number.POSITIVE_INFINITY
  let v1 = Number.NEGATIVE_INFINITY
  for (let i = 0; i + 1 < uvs.length; i += 2) {
    u0 = Math.min(u0, uvs[i])
    u1 = Math.max(u1, uvs[i])
    v0 = Math.min(v0, uvs[i + 1])
    v1 = Math.max(v1, uvs[i + 1])
  }
  return { u0, u1, v0, v1 }
}

/**
 * 笔刷衰减的**采样点**：`[距圆心的比例, 相对强度]`，从圆心到边缘等距取样（9 档，中间由 GPU 插值）。
 *
 * 与 `paintWeights` 用的是同一条曲线（Feather：内圈满强度、外圈线性衰减到 0），
 * 所以视口里那团软边的明暗就是真正刷出来的强度分布 —— 调 Feather 时两边一起变。
 * 用途：权重刷那团软边圆的填充渐变（见 Scene.drawOverlays / brushGradient）。
 */
export function brushFalloffStops(feather: number): Array<readonly [number, number]> {
  const soft = Math.min(1, Math.max(0, feather))
  return Array.from({ length: 9 }, (_, index) => {
    const t = index / 8
    const strength = soft <= 0 || t <= 1 - soft ? 1 : (1 - t) / soft
    return [t, strength] as const
  })
}

function distanceToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  const dx = bx - ax
  const dy = by - ay
  const lengthSq = dx * dx + dy * dy
  if (lengthSq < 1e-9) return Math.hypot(px - ax, py - ay)
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

function stripExtension(name: string): string {
  const index = name.lastIndexOf('.')
  return index > 0 ? name.slice(0, index) : name
}

// ---------------- 重命名（引用级联） ----------------

export type RenameKind = 'bone' | 'slot' | 'attachment' | 'constraint'

export interface RenameTarget {
  kind: RenameKind
  /** 骨骼 / 插槽 / 约束 = 自身名字；附件 = 所在插槽名 */
  slot?: string
  /** 附件改名时的当前附件名 */
  attachment?: string
}

/**
 * 重命名预检：名字为空 / 与集合内其它项重名时给出原因，通过则返回 null。
 * 在 update() 之前调用，避免产生无效的撤销记录。
 */
export function checkRename(
  doc: EditorDocument,
  target: RenameTarget,
  oldName: string,
  nextName: string
): string | null {
  const next = nextName.trim()
  if (!next) return '名字不能为空'
  if (next === oldName) return null
  const taken = (name: string): boolean => {
    switch (target.kind) {
      case 'bone':
        return doc.bones.some((item) => item.name === name)
      case 'slot':
        return doc.slots.some((item) => item.name === name)
      case 'attachment': {
        const skinSlot = doc.skins.find((skin) => skin.slots.some((item) => item.slot === target.slot))
        return !!skinSlot?.slots.find((item) => item.slot === target.slot)?.attachments.some((item) => item.name === name)
      }
      case 'constraint':
        return doc.constraints.some((item) => item.name === name)
    }
  }
  if (taken(next)) return `已经有一个叫「${next}」的${target.kind === 'bone' ? '骨骼' : target.kind === 'slot' ? '插槽' : target.kind === 'attachment' ? '附件' : '约束'}了`
  return null
}

/** 把整个文档里的 `old` 引用换成 `next`（骨骼名出现在插槽宿主、动画轨道等处） */
function renameBoneRefs(doc: EditorDocument, oldName: string, next: string): void {
  for (const bone of doc.bones) if (bone.parent === oldName) bone.parent = next
  for (const slot of doc.slots) if (slot.bone === oldName) slot.bone = next
  for (const anim of doc.animations) for (const track of anim.bones) if (track.bone === oldName) track.bone = next
}

/** 插槽名出现在皮肤清单、动画轨道、deform、绘制顺序帧里 */
/**
 * 删除插槽：连同皮肤里的附件、动画里的轨道、以及绘制顺序帧里的名字一起清理。
 *
 * 绘制顺序帧里必须摘掉被删的名字 —— 缺项的 order 会让运行期只覆盖前 N 个槽，
 * 尾部留着上一次的顺序（同一插槽画两次、有的插槽不画）。编译期还会再归一化一次兜底。
 */
export function deleteSlot(doc: EditorDocument, slotName: string): boolean {
  const before = doc.slots.length
  doc.slots = doc.slots.filter((slot) => slot.name !== slotName)
  if (doc.slots.length === before) return false

  for (const skin of doc.skins) skin.slots = skin.slots.filter((skinSlot) => skinSlot.slot !== slotName)
  // 指向被删插槽的遮罩结束边界：清空 = 裁到绘制顺序末尾（比留下悬挂名字安全）
  for (const skin of doc.skins) {
    for (const skinSlot of skin.slots) {
      for (const attachment of skinSlot.attachments) {
        if (attachment.type === 'clipping' && attachment.clipEndSlot === slotName) attachment.clipEndSlot = ''
      }
    }
  }
  for (const anim of doc.animations) {
    anim.slots = anim.slots.filter((track) => track.slot !== slotName)
    anim.deforms = anim.deforms.filter((track) => track.slot !== slotName)
    for (const key of anim.drawOrder) {
      if (key.order.includes(slotName)) key.order = key.order.filter((name) => name !== slotName)
    }
  }
  return true
}

/**
 * 删除骨骼并连带删除整棵子树：目标骨骼 + 所有子孙骨骼（传递闭包）+ 这些骨骼上挂载的全部
 * 插槽，以及引用了被删骨骼的约束（避免悬挂引用）。动画里的骨骼轨、约束轨随骨骼 / 约束清理，
 * 插槽轨 / deform / drawOrder 由 deleteSlot 一并清掉。
 *
 * 与层级树右键「删除骨骼」、行尾删除按钮共用：取代原来「只删单骨 + 把直接子骨挂到根层」的
 * 行为，满足「删除节点时连同它的子节点一起删除」。
 *
 * **层级根骨骼（见 `rootBoneName`）一律拒绝**：它是整棵层级树的唯一根，删了其他节点就失去共同
 * 祖先（连带整棵子树一起消失）。层级树的行尾按钮 / 右键菜单已经在 UI 层拦了一道，这里再兜一层，
 * 保证任何调用方（含后续新增入口）都删不掉它。
 */
export function deleteBone(doc: EditorDocument, boneName: string): boolean {
  if (!doc.bones.some((b) => b.name === boneName)) return false
  if (boneName === rootBoneName(doc.bones)) return false

  // 传递闭包收集要删的骨骼（含目标本身）
  const toDelete = new Set<string>()
  const stack = [boneName]
  while (stack.length) {
    const cur = stack.pop()!
    if (toDelete.has(cur)) continue
    toDelete.add(cur)
    for (const child of doc.bones) if (child.parent === cur) stack.push(child.name)
  }

  // 这些骨骼挂载的插槽（deleteSlot 会顺带清掉动画里的插槽轨 / deform / drawOrder）
  const slotNames = doc.slots.filter((s) => toDelete.has(s.bone)).map((s) => s.name)

  // 引用了被删骨骼的约束：IK 的 target，或 constraints.bones 任一
  const isDangling = (c: AuthoringConstraint): boolean => {
    if (c.type === 'ik' && toDelete.has(c.target)) return true
    return c.bones.some((b) => toDelete.has(b))
  }
  const constraintNames = new Set(doc.constraints.filter(isDangling).map((c) => c.name))

  doc.bones = doc.bones.filter((b) => !toDelete.has(b.name))
  for (const slotName of slotNames) deleteSlot(doc, slotName)
  doc.constraints = doc.constraints.filter((c) => !constraintNames.has(c.name))
  for (const anim of doc.animations) {
    anim.bones = anim.bones.filter((t) => !toDelete.has(t.bone))
    anim.constraints = anim.constraints.filter((t) => !constraintNames.has(t.constraint))
  }
  return true
}

function renameSlotRefs(doc: EditorDocument, oldName: string, next: string): void {
  for (const skin of doc.skins) {
    for (const skinSlot of skin.slots) {
      if (skinSlot.slot === oldName) skinSlot.slot = next
      for (const attachment of skinSlot.attachments) {
        if (attachment.type === 'clipping' && attachment.clipEndSlot === oldName) attachment.clipEndSlot = next
      }
    }
  }
  for (const anim of doc.animations) {
    for (const track of anim.slots) if (track.slot === oldName) track.slot = next
    for (const deform of anim.deforms) if (deform.slot === oldName) deform.slot = next
    for (const key of anim.drawOrder) {
      if (key.order.includes(oldName)) key.order = key.order.map((name) => (name === oldName ? next : name))
    }
  }
}

/** 附件名出现在插槽当前显示、动画 displayAttachment 关键帧、deform 轨道里 */
function renameAttachmentRefs(doc: EditorDocument, slotName: string, oldName: string, next: string): void {
  for (const skin of doc.skins) {
    const skinSlot = findSkinSlot(skin, slotName)
    if (!skinSlot) continue
    for (const attachment of skinSlot.attachments) if (attachment.name === oldName) attachment.name = next
  }
  const slot = doc.slots.find((item) => item.name === slotName)
  if (slot && slot.attachment === oldName) slot.attachment = next
  for (const anim of doc.animations) {
    for (const track of anim.slots) {
      if (track.slot !== slotName) continue
      if (track.displayAttachment.includes(oldName)) {
        track.displayAttachment = track.displayAttachment.map((name) => (name === oldName ? next : name))
      }
    }
    for (const deform of anim.deforms) if (deform.slot === slotName && deform.attachment === oldName) deform.attachment = next
  }
}

/** 约束名出现在动画的 mix 轨道里 */
function renameConstraintRefs(doc: EditorDocument, oldName: string, next: string): void {
  for (const anim of doc.animations) {
    for (const track of anim.constraints) if (track.constraint === oldName) track.constraint = next
  }
}

/**
 * 在 draft 上执行重命名（所有引用同步级联）。名字校验交给 checkRename，这里只在通不过时返回 false。
 * 约束按骨骼下标引用，骨骼重命名 / 重排不影响它们；这里的级联只处理按名字引用的场合。
 */
export function applyRename(
  doc: EditorDocument,
  target: RenameTarget,
  oldName: string,
  nextName: string
): boolean {
  const next = nextName.trim()
  if (!next || next === oldName) return false
  if (checkRename(doc, target, oldName, next)) return false

  switch (target.kind) {
    case 'bone': {
      const bone = doc.bones.find((item) => item.name === oldName)
      if (!bone) return false
      bone.name = next
      renameBoneRefs(doc, oldName, next)
      return true
    }
    case 'slot': {
      const slot = doc.slots.find((item) => item.name === oldName)
      if (!slot) return false
      slot.name = next
      renameSlotRefs(doc, oldName, next)
      return true
    }
    case 'attachment': {
      if (!target.slot) return false
      const skinSlot = doc.skins.find((skin) => skin.slots.some((item) => item.slot === target.slot))
      const attachment = skinSlot?.slots.find((item) => item.slot === target.slot)?.attachments.find((item) => item.name === oldName)
      if (!attachment) return false
      renameAttachmentRefs(doc, target.slot, oldName, next)
      return true
    }
    case 'constraint': {
      const constraint = doc.constraints.find((item) => item.name === oldName)
      if (!constraint) return false
      constraint.name = next
      renameConstraintRefs(doc, oldName, next)
      return true
    }
  }
}

import { createAttachmentData, createBoneData, AttachmentType, AnimType, BlendMode } from '@core/model/types'
import { t } from '@i18n'
import type { AttachmentData, BoneData, ImageRef, SkinData, SkinSlotData, SlotData, VertexWeight } from '@core/model/types'
import { createRuntimeAsset } from '@core/model/asset'
import type { RuntimeAsset } from '@core/model/asset'
import { computeBindposes, createSetupPose } from '@core/model/setup'
import {
  createIkConstraint,
  createPathConstraint,
  createPhysicsConstraint,
  createTransformConstraint
} from '@core/model/constraints'
import type { Constraint } from '@core/model/constraints'
import { emptyIkAnim } from '@core/model/animation'
import type { AnimData } from '@core/model/animation'
import type { AtlasRegion, PageSizes } from './uv'
import {
  mapRegionRelativeUvs,
  pageUvsToRegionRelative,
  parseHexColor,
  pxToUnit,
  regionGeometry,
  regionUvs
} from './uv'
import { indexRegions } from './atlasSpine'
import { deformBaseKey, importSpineAnimations, slotDeformBaseKey } from './spineAnims'
import type { SpineDeformBase, SpineDeformInfluence } from './spineAnims'
import type {
  SpineAttachmentJson,
  SpineBoneJson,
  SpineIkJson,
  SpineJson,
  SpineSlotJson
} from './spineTypes'
import { bakeSetupLocals, bakeSpineAnimations } from './spineBake'
import type { BakedAnimation, SetupBoneLocal } from './spineBake'
import { Easing, emptySlotAnim } from '@core/model/animation'

export interface SpineImportInput {
  json: SpineJson
  regions: readonly AtlasRegion[]
  pageSizes: PageSizes
  /**
   * 图集原始文本。提供时动画轨道会交给**官方 Spine 运行库**烘焙
   * （缓动两种写法 / mix / IK 与约束 / 版本差异全由它处理），失败则回退内置解析。
   */
  atlasText?: string
  /** 图集页名 → 图片绝对路径 */
  pageImages?: Record<string, string>
}

export interface SpineImportResult {
  asset: RuntimeAsset
  warnings: string[]
}

interface AttachmentContext {
  /** 原始骨骼下标 → 新下标（权重里的骨骼下标用它重映射） */
  origToNew: number[]
  bindposes: Float32Array
  setupWorld: Float32Array
  regions: Map<string, AtlasRegion>
  pageSizes: PageSizes
  warnings: string[]
}

/** 拓扑排序骨骼（父在前），产出新序、名字映射与「原始下标 → 新下标」表 */
function orderBones(bones: readonly SpineBoneJson[], warnings: string[]): {
  ordered: SpineBoneJson[]
  index: Map<string, number>
  origToNew: number[]
} {
  const byName = new Map<string, SpineBoneJson>()
  for (const bone of bones) {
    if (byName.has(bone.name)) warnings.push(t('存在重名骨骼「{0}」，仅保留第一个', bone.name))
    else byName.set(bone.name, bone)
  }

  const ordered: SpineBoneJson[] = []
  const visited = new Set<string>()
  const visit = (bone: SpineBoneJson, depth: number): void => {
    if (visited.has(bone.name)) return
    if (depth > 512) {
      warnings.push(t('骨骼「{0}」父链过深或存在环，已截断', bone.name))
      return
    }
    if (bone.parent) {
      const parent = byName.get(bone.parent)
      if (!parent) warnings.push(t('骨骼「{0}」的父骨骼「{1}」不存在，已作为根骨骼', [bone.name, bone.parent]))
      else visit(parent, depth + 1)
    }
    if (!visited.has(bone.name)) {
      visited.add(bone.name)
      ordered.push(bone)
    }
  }
  for (const bone of bones) visit(bone, 0)

  const index = new Map<string, number>()
  ordered.forEach((bone, i) => index.set(bone.name, i))

  const origToNew = bones.map((bone) => index.get(bone.name) ?? 0)
  return { ordered, index, origToNew }
}

/**
 * 骨骼的继承语义。
 *
 * - **4.2+** 用 `inherit` 字段（Normal / OnlyTranslation / NoRotationOrReflection / NoScale / NoScaleOrReflection）
 * - **3.8–4.1** 用 `transform` 字段（取值相同），更早用 `inheritRotation` / `inheritScale` 两个布尔
 *
 * 早先只读 `transform`，4.2+ 资源里的 `inherit` 全被忽略 —— 典型表现就是
 * 脚（`noRotationOrReflection`）跟着小腿一起转，而它本该保持自身朝向。
 */
function inheritOf(bone: SpineBoneJson): { rotation: boolean; scale: boolean } {
  const transform = (bone.inherit ?? bone.transform ?? '').toLowerCase()
  if (transform === 'onlytranslation') return { rotation: false, scale: false }
  if (transform === 'norotationorreflection') return { rotation: false, scale: true }
  if (transform === 'noscale') return { rotation: true, scale: false }
  if (transform === 'noscalereflection') return { rotation: true, scale: false }
  if (transform === 'normal') return { rotation: true, scale: true }
  return {
    rotation: bone.inheritRotation !== false,
    scale: bone.inheritScale !== false
  }
}

function toBoneData(ordered: readonly SpineBoneJson[], index: Map<string, number>): BoneData[] {
  return ordered.map((bone) => {
    const inherit = inheritOf(bone)
    return createBoneData({
      name: bone.name,
      parentIndex: bone.parent ? (index.get(bone.parent) ?? -1) : -1,
      localPosition: { x: pxToUnit(bone.x ?? 0), y: pxToUnit(bone.y ?? 0) },
      rotation: bone.rotation ?? 0,
      localScale: { x: bone.scaleX ?? 1, y: bone.scaleY ?? 1 },
      localShear: { x: bone.shearX ?? 0, y: bone.shearY ?? 0 },
      inheritRotation: inherit.rotation,
      inheritScale: inherit.scale,
      length: pxToUnit(bone.length ?? 0)
    })
  })
}

/**
 * 统一 3.3/3.4（对象）与 3.8+（数组带 name）两代皮肤格式。
 *
 * 名字是**空串**时按「没有名字」处理（首个回落成 `default`）：3.8+ 的 JSON 里默认皮肤
 * 常写成 `"name": ""`，直接带进来皮肤面板上就是一个空白标签。与 DB 导入同一口径，
 * 也和 createEmptyDocument / 编译器查找默认皮肤的名字一致。
 */
function normalizeSkins(json: SpineJson): Array<{ name: string; attachments: Record<string, Record<string, SpineAttachmentJson>> }> {
  const fallbackName = (name: string | undefined, index: number): string =>
    (name ?? '').trim() || (index === 0 ? 'default' : `skin${index}`)
  const skins = json.skins
  if (!skins) return []
  if (Array.isArray(skins)) {
    return skins.map((skin, i) => ({
      name: fallbackName(skin.name, i),
      attachments: skin.attachments ?? {}
    }))
  }
  return Object.entries(skins).map(([name, attachments], index) => ({
    name: fallbackName(name, index),
    attachments
  }))
}

/** 骨骼局部变换是否与给定值几乎一致（容差内视为「约束没改过它」） */
function sameBoneLocal(bone: BoneData, local: SetupBoneLocal): boolean {
  return (
    Math.abs(bone.localPosition.x - local.x) < 1e-3 &&
    Math.abs(bone.localPosition.y - local.y) < 1e-3 &&
    Math.abs(bone.rotation - local.rotation) < 1e-2 &&
    Math.abs(bone.localScale.x - local.scaleX) < 1e-3 &&
    Math.abs(bone.localScale.y - local.scaleY) < 1e-3 &&
    Math.abs(bone.localShear.x - local.shearX) < 1e-2 &&
    Math.abs(bone.localShear.y - local.shearY) < 1e-2
  )
}

/**
 * 给 linkedmesh 补上「按自己区域」的 UV。
 *
 * Spine 的 linkedmesh **自己不存 uvs**：几何（顶点 / 三角形 / 权重）取自源网格，UV 则取源网格的
 * **区域相对** UV、再乘它自己的区域矩形（官方 `MeshAttachment.ComputeUVs`）。编辑器模型只存
 * 整页 UV，所以导入时要把源网格的整页 UV 反解成区域相对、再映射进自己的区域 ——
 * 换装皮肤（Goblins 的 goblingirl）直接沿用源皮肤那块 UV 的话，画出来是源皮肤的贴图；
 * 而完全不补时附件只剩 `createAttachmentData` 的 8 个占位 UV，跟源网格的顶点数对不上，
 * 整块网格直接不画（运行期见 `resolveLinkedMesh` 的长度校验）。
 */
function remapLinkedMeshUvs(
  skins: readonly SkinData[],
  defaultSkin: SkinData | undefined,
  ctx: AttachmentContext
): void {
  const byName = new Map(skins.map((skin) => [skin.name, skin]))
  for (const skin of skins) {
    for (const skinSlot of skin.slots) {
      for (const attachment of skinSlot.attachments) {
        if (attachment.type !== AttachmentType.LinkedMesh) continue
        // 源皮肤缺省 = 默认皮肤；源网格名缺省 = 自身名字（与 resolveLinkedMesh 同一口径）
        const sourceSkin = (attachment.linkedMeshSkin ? byName.get(attachment.linkedMeshSkin) : undefined) ?? defaultSkin
        const sourceSlot = sourceSkin?.slots.find((item) => item.slotName === skinSlot.slotName)
        const sourceName = attachment.linkedMeshAttachment || attachment.name
        const parent = sourceSlot?.attachments.find(
          (item) => item.name === sourceName && item.type !== AttachmentType.LinkedMesh
        )
        if (!parent || parent.uvs.length === 0) continue
        const own = attachment.regionName ? ctx.regions.get(attachment.regionName) : undefined
        const source = parent.regionName ? ctx.regions.get(parent.regionName) : undefined
        // 拿不到区域矩形（没有 .atlas）就保持原样，运行期会退回源网格的 UV
        if (!own || !source) continue
        attachment.uvs = mapRegionRelativeUvs(
          pageUvsToRegionRelative(parent.uvs, source, ctx.pageSizes),
          own,
          ctx.pageSizes
        )
      }
    }
  }
}

function blendOf(blend: string | undefined, slotName: string, warnings: string[]): BlendMode {
  switch ((blend ?? '').toLowerCase()) {
    case 'add':
    case 'additive':
      return BlendMode.Additive
    case 'multiply':
      return BlendMode.Multiply
    case 'screen':
      return BlendMode.Screen
    case 'erase':
      return BlendMode.Erase
    case 'mask':
      // Spine 4.3 运行库没有 Mask 混合模式；遮罩由 clipping 附件承担
      warnings.push(
        t('插槽「{0}」的混合模式 mask 不受支持，已按 Normal 导入（遮罩请用 clipping 附件）', slotName)
      )
      return BlendMode.Normal
    case 'below':
      return BlendMode.Below
    case 'none':
      return BlendMode.None
    default:
      return BlendMode.Normal
  }
}

/**
 * 加权网格的骨骼权重（Spine 的 `vertices` 字段，加权时才会是这个形状）：
 * `[boneCount, (boneIdx, lx, ly, weight) × boneCount] × 顶点数`
 *
 * `lx / ly` 是**骨骼局部坐标**（像素）——与 rigid 顶点同一坐标系：官方运行期是
 * `world = Σ w × (boneWorld × (lx, ly))`（见 spine-core 4.3 的 `computeWorldVertices`，加权与
 * rigid 分支共用骨骼世界矩阵；顶点是编辑器按权重反解出的局部坐标，多骨骼共享一份）。
 * 这里只做像素 → 世界单位换算，然后下标重映射 + top-4 归并 + 归一化。
 */
function parseWeights(weights: readonly number[], vertexCount: number, ctx: AttachmentContext): VertexWeight[] {
  const out: VertexWeight[] = []
  const boneCount = ctx.origToNew.length
  let cursor = 0
  for (let v = 0; v < vertexCount; v++) {
    const count = weights[cursor] ?? 0
    cursor += 1
    const entries: Array<{ bone: number; lx: number; ly: number; w: number }> = []
    for (let k = 0; k < count; k++) {
      const rawBone = weights[cursor] ?? 0
      const lx = weights[cursor + 1] ?? 0
      const ly = weights[cursor + 2] ?? 0
      const w = weights[cursor + 3] ?? 0
      cursor += 4
      const mapped = rawBone >= 0 && rawBone < boneCount ? ctx.origToNew[rawBone] : 0
      entries.push({ bone: mapped, lx, ly, w })
    }
    const sorted = entries
      .filter((e) => e.w > 1e-6)
      .sort((a, b) => b.w - a.w)
      .slice(0, 4)
    const total = sorted.reduce((sum, e) => sum + e.w, 0)
    out.push(packVertexWeight(sorted.map((e) => ({ ...e, w: total > 0 ? e.w / total : 0 }))))
  }
  return out
}

function packVertexWeight(entries: Array<{ bone: number; lx: number; ly: number; w: number }>): VertexWeight {
  const result: VertexWeight = {
    b0: 0,
    b1: 0,
    b2: 0,
    b3: 0,
    lx0: 0,
    ly0: 0,
    lx1: 0,
    ly1: 0,
    lx2: 0,
    ly2: 0,
    lx3: 0,
    ly3: 0,
    w0: 0,
    w1: 0,
    w2: 0,
    w3: 0
  }
  const bones = [0, 0, 0, 0]
  const lxs = [0, 0, 0, 0]
  const lys = [0, 0, 0, 0]
  const ws = [0, 0, 0, 0]
  for (let k = 0; k < entries.length && k < 4; k++) {
    bones[k] = entries[k].bone
    // lx/ly 是骨骼局部坐标（像素）→ 世界单位
    lxs[k] = pxToUnit(entries[k].lx)
    lys[k] = pxToUnit(entries[k].ly)
    ws[k] = entries[k].w
  }
  result.b0 = bones[0]
  result.b1 = bones[1]
  result.b2 = bones[2]
  result.b3 = bones[3]
  result.lx0 = lxs[0]
  result.ly0 = lys[0]
  result.lx1 = lxs[1]
  result.ly1 = lys[1]
  result.lx2 = lxs[2]
  result.ly2 = lys[2]
  result.lx3 = lxs[3]
  result.ly3 = lys[3]
  result.w0 = ws[0]
  result.w1 = ws[1]
  result.w2 = ws[2]
  result.w3 = ws[3]
  return result
}

/**
 * 加权网格的「Spine deform 下标 → 编辑器顶点槽」映射。
 *
 * Spine 的 deform 数组逐**影响点**排布（`count` 个影响，每个一份骨内 (dx,dy)），
 * 而编辑器每个顶点只存一份显示空间位移（最多 4 根影响，见 `parseWeights`）。
 * 这里从原始 JSON 的 `vertices` 段取回：每顶点原始影响数 + 编辑器 4 个槽各自对应的原始下标。
 *
 * 筛选规则必须与 `parseWeights` 完全一致（丢掉 `w <= 1e-6` 的影响、按权重降序取前 4），
 * 否则槽位与下标会错开，FFD 会落到别的骨骼上。
 */
function buildDeformInfluence(
  raw: SpineAttachmentJson | undefined,
  vertexCount: number
): SpineDeformInfluence | undefined {
  const values = raw?.vertices
  if (!Array.isArray(values) || vertexCount <= 0) return undefined
  // 未加权网格的 `vertices` 就是顶点坐标本身（与 uvs 等长），没有影响段
  if (values.length === vertexCount * 2) return undefined
  const counts = new Int32Array(vertexCount)
  const slots = new Int8Array(vertexCount * 4).fill(-1)
  let cursor = 0
  for (let v = 0; v < vertexCount; v++) {
    const count = Math.max(0, Math.trunc(values[cursor] ?? 0))
    cursor += 1
    if (count === 0) continue
    counts[v] = count
    const kept: Array<{ k: number; w: number }> = []
    for (let k = 0; k < count; k++) {
      const w = values[cursor + 3] ?? 0
      cursor += 4
      if (w > 1e-6) kept.push({ k, w })
    }
    kept.sort((a, b) => b.w - a.w)
    for (let s = 0; s < 4 && s < kept.length; s++) slots[v * 4 + s] = kept[s].k
  }
  return { counts, slots }
}

function resolveRegion(
  attachment: SpineAttachmentJson,
  ctx: AttachmentContext,
  skinName?: string
): AtlasRegion | null {
  const key = attachment.path ?? attachment.name ?? ''
  // Spine 的换装皮肤把图集区域名带上**皮肤前缀**（`goblin/head`、`goblingirl/head`），
  // 而皮肤里的附件名保持裸名（`head`）且不带 path —— 官方运行库的做法正是给附件补上
  // 「皮肤名/」前缀（解析后附件名直接变成 `goblin/head`）。
  //
  // 只按裸名查的话，Goblins 这类换装角色两个皮肤的区域都找不到，附件全无贴图 ——
  // 表现就是「切换皮肤完全没变化」。
  const candidates: string[] = []
  if (attachment.path) candidates.push(attachment.path)
  if (skinName) candidates.push(`${skinName}/${key}`)
  candidates.push(key)
  for (const candidate of candidates) {
    const region = ctx.regions.get(candidate)
    if (region) return region
  }
  ctx.warnings.push(t('附件的图集区域「{0}」不存在，贴图可能显示异常', candidates[0]))
  return null
}

function convertAttachment(
  attachment: SpineAttachmentJson,
  ctx: AttachmentContext,
  /** 所属皮肤名：换装皮肤的区域名带「皮肤名/」前缀（见 resolveRegion） */
  skinName?: string
): AttachmentData {
  const type = (attachment.type ?? '').toLowerCase()
  const base = {
    name: attachment.name ?? '',
    position: { x: pxToUnit(attachment.x ?? 0), y: pxToUnit(attachment.y ?? 0) },
    rotation: attachment.rotation ?? 0,
    scale: { x: attachment.scaleX ?? 1, y: attachment.scaleY ?? 1 },
    color: parseHexColor(attachment.color)
  }

  if (type === 'linkedmesh') {
    const region = resolveRegion(attachment, ctx, skinName)
    /*
     * 源网格名：**4.x 用 `source`，3.8 用 `parent`**（官方 SkeletonJson 读的就是 `source`）。
     * 两个都缺时退回自身名字 —— 换装皮肤里的 linkedmesh 通常就是「同名附件、换一张图」，
     * 早先只读 `parent` 会得到空串，`resolveLinkedMesh` 直接判定为「没有父网格」，
     * 结果 Goblins 这类 4.x 资源的脚/袖子整块不画（几何为空）。
     */
    const linked = attachment as { source?: string; parent?: string; slot?: string }
    if (linked.slot) {
      ctx.warnings.push(
        t('linkedmesh「{0}」的源网格在另一个槽位（Spine 4.x 的 slot 字段），当前只支持同槽位查找', base.name)
      )
    }
    return createAttachmentData({
      ...base,
      type: AttachmentType.LinkedMesh,
      textureName: region ? region.page : '',
      regionName: region ? region.name : undefined,
      size: { x: pxToUnit(attachment.width ?? 0), y: pxToUnit(attachment.height ?? 0) },
      linkedMeshSkin: (attachment as { skin?: string }).skin ?? '',
      linkedMeshAttachment: linked.source ?? linked.parent ?? base.name
    })
  }

  if (type === 'clipping') {
    const rawVertices = attachment.vertices ?? []
    const vertexCount = Math.max(0, Math.round(attachment.vertexCount ?? rawVertices.length / 2))
    // 与官方一致：vertices 长度等于 vertexCount*2 才是非加权；否则是 packed 权重
    const weighted = rawVertices.length !== vertexCount * 2
    const vertices = new Float32Array(vertexCount * 2)
    if (!weighted) {
      for (let i = 0; i < vertexCount * 2; i++) vertices[i] = pxToUnit(rawVertices[i] ?? 0)
    }
    return createAttachmentData({
      ...base,
      type: AttachmentType.Clipping,
      /*
       * 遮罩顶点与 Spine 一致，是**插槽骨骼局部坐标**；附件自身的 TRS 不参与
       * （Spine 的 ClippingAttachment 也不读 x/y/rotation/scale）。
       */
      position: { x: 0, y: 0 },
      rotation: 0,
      scale: { x: 1, y: 1 },
      vertices,
      weights: weighted ? parseWeights(rawVertices, vertexCount, ctx) : [],
      hull: vertexCount,
      clipEndSlot: attachment.end ?? '',
      clipInverse: attachment.inverse === true,
      clipConvex: attachment.convex === true,
      // Spine 的 deform 偏移是骨内坐标（不经 bindpose 方向变换）
      ffdInBoneSpace: true
    })
  }

  if (type === 'mesh') {
    const region = resolveRegion(attachment, ctx, skinName)
    const meshUvs = attachment.uvs ?? []
    const vertexCount = Math.floor(meshUvs.length / 2)
    const rawVertices = attachment.vertices ?? []
    // Spine 把加权网格的骨骼与权重**一并编码在 `vertices` 里**：长度与 uvs 不等即加权
    //（spine-core 4.3 `readVertices`：只有 `verticesLength == vertices.Length` 才是非加权）。
    // 早先读的是不存在的 `weights` 字段，加权网格全被当成了 rigid。
    const weighted = rawVertices.length !== meshUvs.length
    const vertices = new Float32Array(vertexCount * 2)
    if (!weighted) {
      // 非加权：顶点是「相对骨骼」的局部坐标（官方运行期只乘骨骼矩阵，不含附件 TRS）
      for (let i = 0; i < vertexCount; i++) {
        vertices[i * 2] = pxToUnit(rawVertices[i * 2] ?? 0)
        vertices[i * 2 + 1] = pxToUnit(rawVertices[i * 2 + 1] ?? 0)
      }
    }
    // Spine 的 mesh `uvs` 是区域相对坐标（relU 向右、relV **向下**，v=0 指向区域顶边），
    // 与 DragonBones 的 mesh uvs 同款，`mapRegionRelativeUvs` 正好按这个方向转成整页 UV，
    // 这里**不能**再翻一次 v —— 多翻会让导入进来的网格贴图上下颠倒，而导出侧
    // `pageUvsToRegionRelative` 又按 relV 向下反算，两边错误互相抵消，只有往返测试看不出来。
    const uvs = region
      ? mapRegionRelativeUvs(meshUvs, region, ctx.pageSizes)
      : Float32Array.from(meshUvs)
    const weights = weighted ? parseWeights(rawVertices, vertexCount, ctx) : []
    return createAttachmentData({
      ...base,
      type: AttachmentType.Mesh,
      regionName: region ? region.name : undefined,
      // 顶点自带完整位置（相对骨骼）：附件 TRS 必须保持单位阵，否则会被叠加两次
      position: { x: 0, y: 0 },
      rotation: 0,
      scale: { x: 1, y: 1 },
      textureName: region ? region.page : '',
      size: { x: pxToUnit(attachment.width ?? 0), y: pxToUnit(attachment.height ?? 0) },
      uvs,
      vertices,
      triangles: attachment.triangles ?? [],
      edges: attachment.edges ?? [],
      hull: attachment.hull ?? 0,
      weights,
      // FFD 偏移是「setup pose 世界空间」的位移，加权路径由运行期按 bindpose 转到骨内
      ffdInBoneSpace: false
    })
  }

  if (type === 'boundingbox' || type === 'point' || type === 'path') {
    const rawVertices = attachment.vertices ?? []
    const vertices = new Float32Array(rawVertices.length)
    for (let i = 0; i < rawVertices.length; i++) vertices[i] = pxToUnit(rawVertices[i])
    return createAttachmentData({
      ...base,
      type: AttachmentType.BoundingBox,
      vertices,
      triangles: attachment.polygons ?? [],
      hull: attachment.hull ?? 0
    })
  }

  // region
  const region = resolveRegion(attachment, ctx, skinName)
  const geometry = region ? regionGeometry(region, attachment.width, attachment.height) : null
  return createAttachmentData({
    ...base,
    type: AttachmentType.Region,
    textureName: region ? region.page : '',
    regionName: region ? region.name : undefined,
    // position = 附件声明的显示位置（= 原图中心）；裁剪块的位置交给 contentOffset（附件局部坐标）
    position: { x: base.position.x, y: base.position.y },
    size: geometry
      ? { x: geometry.contentWidth, y: geometry.contentHeight }
      : { x: pxToUnit(attachment.width ?? 0), y: pxToUnit(attachment.height ?? 0) },
    // 原图（含留白）尺寸给编辑器画框；内容偏移是「裁剪块中心相对原图中心」，随附件旋转走。
    // 未裁剪时 frameSize.x 为 0（框退回 size）、contentOffset 为 0，行为与以前一致。
    frameSize: geometry ? { x: geometry.width, y: geometry.height } : { x: 0, y: 0 },
    contentOffset: geometry ? { x: geometry.offsetX, y: geometry.offsetY } : { x: 0, y: 0 },
    uvs: region ? regionUvs(region, ctx.pageSizes) : Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1])
  })
}

/**
 * Spine（骨骼 JSON + .atlas）→ Runtime 模型。
 *
 * 要点：
 * - 骨骼拓扑排序后重映射下标（权重里的骨骼下标也一并重映射）
 * - 动画关键帧是**相对 setup 的增量**，转换期叠加成绝对值
 * - mesh 的 uvs 是区域相对坐标，按图集页归一化并 v 翻转
 * - bindposes 由 setup pose 的矩阵式 FK（含 shear）求逆得到
 */
export function importSpine(input: SpineImportInput): SpineImportResult {
  const warnings: string[] = []
  const json = input.json
  const { ordered, index: boneIndex, origToNew } = orderBones(json.bones ?? [], warnings)
  const bones = toBoneData(ordered, boneIndex)

  const slotJsons = json.slots ?? []
  const slots: SlotData[] = []
  const slotIndexByName = new Map<string, number>()
  slotJsons.forEach((slot: SpineSlotJson, i) => {
    const bone = boneIndex.get(slot.bone)
    if (bone === undefined) warnings.push(t('插槽「{0}」挂载的骨骼「{1}」不存在，已挂到根骨骼', [slot.name, slot.bone]))
    slotIndexByName.set(slot.name, i)
    slots.push({
      name: slot.name,
      boneIndex: bone ?? 0,
      color: parseHexColor(slot.color),
      blendMode: blendOf(slot.blend, slot.name, warnings),
      defaultDisplayIndex: -1,
      defaultZOrder: i,
      z: 0,
      setupAttachment: slot.attachment ?? '',
      // Spine 没有插槽级可见性概念，全部按可见导入（隐藏靠动画 drawOrder / attachment 缺失表达）
      visible: true
    })
  })

  /*
   * setup 姿态要先按**官方运行库求解过的结果**校正一遍局部变换。
   *
   * 导入后不再跑约束（`runtimeIK = false`，路径约束更是没有对应模型），而 IK / 变换约束改的是局部姿态、
   * 路径约束只改**世界**姿态 —— 于是这类骨架的 setup 会和 Spine 对不上：mix-and-match 的腿链
   *（`leg-front-1..8` 铺在曲线上）整条偏掉，网格按骨骼蒙皮后脚部贴图错位（缩略图对、视口错）。
   * 必须在 `createSetupPose` / `computeBindposes` 之前校正，蒙皮绑定才跟着一致。
   */
  if (input.atlasText) {
    const baked = bakeSetupLocals({
      json,
      atlasText: input.atlasText,
      boneNames: bones.map((bone) => bone.name),
      slotNames: slots.map((slot) => slot.name)
    })
    for (const [at, local] of baked ?? []) {
      const bone = bones[at]
      // 没被约束改过的骨骼差异只在浮点末位：保留 JSON 原值，别把噪声写进工程
      if (!bone || sameBoneLocal(bone, local)) continue
      bone.localPosition = { x: local.x, y: local.y }
      bone.rotation = local.rotation
      bone.localScale = { x: local.scaleX, y: local.scaleY }
      bone.localShear = { x: local.shearX, y: local.shearY }
    }
  }

  const skeletonOnly = createRuntimeAsset({
    dataType: AnimType.Spine,
    armatureName: json.skeleton?.spine ? 'spine' : 'spine',
    frameRate: json.skeleton?.fps && json.skeleton.fps > 0 ? json.skeleton.fps : 30,
    bones,
    slots,
    skins: [],
    constraints: [],
    animations: [],
    textureNames: [],
    defaultSkinIndex: 0,
    runtimeIK: true,
    images: []
  })
  const setup = createSetupPose(skeletonOnly)
  const bindposes = computeBindposes(skeletonOnly)

  const ctx: AttachmentContext = {
    origToNew,
    bindposes,
    setupWorld: setup.world,
    regions: indexRegions(input.regions),
    pageSizes: input.pageSizes,
    warnings
  }

  const rawSkins = normalizeSkins(json)
  const skins: SkinData[] = rawSkins.map((skin) => ({
    name: skin.name,
    slots: Object.entries(skin.attachments).map<SkinSlotData>(([slotName, attachments]) => ({
      slotName,
      attachments: Object.entries(attachments).map(([key, attachment]) =>
        /*
         * 附件名取 **json 键**，与官方运行库一致（`SkeletonJson` 读皮肤时
         * `skin.setAttachment(slot.index, entryName, ...)` 用的就是键）。
         *
         * 插槽的 setup 附件（`slots[].attachment`）与动画里的显示帧引用的都是键；早先这里
         * 用 `name ?? 键`（键只在没有 name 字段时才生效），于是 `head 1` / `arm` 这类带 name
         * 的附件跟引用 `Head` / `Arm` 对不上 —— 整根插槽解析不到 setup display，什么都不画
         *（FootSoldier 的 13 根插槽里有 8 根是空的）。
         *
         * `name` 字段不能丢：官方用它推导区域路径（`path = map.path ?? name`），所以这里把它
         * 并进 `path`，区域查找仍按「path → 皮肤名/键 → 键」的顺序（见 resolveRegion）。
         */
        convertAttachment(
          { ...attachment, name: key, path: attachment.path ?? attachment.name },
          ctx,
          skin.name
        )
      )
    }))
  }))

  // setup 显示的附件：在默认皮肤里按名解析出真正的显示下标
  const defaultSkinIndex = Math.max(0, skins.findIndex((s) => s.name === 'default'))
  const defaultSkin = skins[defaultSkinIndex]

  // linkedmesh 的 UV 要按它**自己的区域**重算（源网格的 UV 只提供形状），见 remapLinkedMeshUvs
  remapLinkedMeshUvs(skins, defaultSkin, ctx)

  for (const slot of slots) {
    if (!slot.setupAttachment) continue
    const skinSlot = defaultSkin?.slots.find((s) => s.slotName === slot.name)
    if (!skinSlot) continue
    const found = skinSlot.attachments.findIndex((a) => a.name === slot.setupAttachment)
    if (found >= 0) slot.defaultDisplayIndex = found
  }

  const textureNames: string[] = []
  for (const skin of skins) {
    for (const slot of skin.slots) {
      for (const attachment of slot.attachments) {
        if (attachment.textureName && !textureNames.includes(attachment.textureName)) {
          textureNames.push(attachment.textureName)
        }
      }
    }
  }

  const constraints = buildConstraints(json, boneIndex, warnings)

  // 网格附件的绑定顶点表：deform 轨道的「长度对齐 + 逐影响点折叠」换算要用
  const deformBase = new Map<string, SpineDeformBase>()
  // 原始 JSON 的附件：加权网格的「影响点 → 顶点」映射只能从原始 `vertices` 段反推
  //（`parseWeights` 会按权重排序 + 截断到 4 根，原始顺序信息在那里就丢了）
  const rawAttachment = new Map<string, SpineAttachmentJson>()
  for (const skin of rawSkins) {
    for (const [slotName, attachments] of Object.entries(skin.attachments ?? {})) {
      for (const [key, raw] of Object.entries(attachments ?? {})) {
        rawAttachment.set(deformBaseKey(skin.name, slotName, key), raw)
      }
    }
  }
  const deformBaseOf = (
    attachment: AttachmentData,
    skinName: string,
    slotName: string
  ): SpineDeformBase | null => {
    // 遮罩的 deform 轨道同样需要按多边形点数对齐；否则短数组会让后续帧错位
    if (attachment.type !== AttachmentType.Mesh && attachment.type !== AttachmentType.Clipping) return null
    const count = Math.floor(attachment.vertices.length / 2)
    const weighted = count > 0 && attachment.weights.length === count
    const raw = rawAttachment.get(deformBaseKey(skinName, slotName, attachment.name))
    return {
      vertices: attachment.vertices,
      weights: attachment.weights,
      weighted,
      influence: weighted ? buildDeformInfluence(raw, count) : undefined
    }
  }
  // 精确项：key = 皮肤 \u0000 插槽 \u0000 附件。同名附件在不同皮肤里顶点数可能不同，
  // 只按「插槽 + 附件」存会被后一个皮肤覆盖，deform 的长度对齐随之取错顶点表。
  for (const skin of skins) {
    for (const skinSlot of skin.slots) {
      for (const attachment of skinSlot.attachments) {
        const base = deformBaseOf(attachment, skin.name, skinSlot.slotName)
        if (base) deformBase.set(deformBaseKey(skin.name, skinSlot.slotName, attachment.name), base)
      }
    }
  }
  // 兜底项：key = 插槽 \u0000 附件，只登记默认皮肤。
  // 3.x 的插槽层 deform 没有皮肤维度，必须回退到默认皮肤这套顶点表（不是「谁先谁赢」）。
  for (const skinSlot of defaultSkin?.slots ?? []) {
    for (const attachment of skinSlot.attachments) {
      const base = deformBaseOf(attachment, defaultSkin?.name ?? 'default', skinSlot.slotName)
      if (!base) continue
      const key = slotDeformBaseKey(skinSlot.slotName, attachment.name)
      if (!deformBase.has(key)) deformBase.set(key, base)
    }
  }

  /*
   * 每根骨骼 setup 世界矩阵的**线性部分**（bindpose 的逆的 2×2）。
   * 加权网格的 deform 是骨内偏移，折叠成编辑器「逐顶点显示空间位移」时要用
   * `W_k_setup · d_k`（见 spineAnims 的 collapseInfluenceOffsets）。
   */
  const setupWorldLin = new Float32Array(bones.length * 4)
  for (let i = 0; i < bones.length; i++) {
    const o = i * 16
    const a = bindposes[o]
    const b = bindposes[o + 4]
    const c = bindposes[o + 1]
    const d = bindposes[o + 5]
    const det = a * d - b * c
    if (!Number.isFinite(det) || Math.abs(det) < 1e-9) {
      setupWorldLin[i * 4] = 1
      setupWorldLin[i * 4 + 3] = 1
      continue
    }
    setupWorldLin[i * 4] = d / det
    setupWorldLin[i * 4 + 1] = -b / det
    setupWorldLin[i * 4 + 2] = -c / det
    setupWorldLin[i * 4 + 3] = a / det
  }

  // 默认皮肤下「插槽 → 附件名 → 下标」，供 attachment 轨道把名字解析成烘焙下标
  const attIndexBySlot = new Map<string, Map<string, number>>()
  for (const skinSlot of defaultSkin?.slots ?? []) {
    const map = new Map<string, number>()
    skinSlot.attachments.forEach((attachment, i) => map.set(attachment.name, i))
    attIndexBySlot.set(skinSlot.slotName, map)
  }

  /**
   * spine 4.2 起贝塞尔 `curve` 从「归一化 0..1 控制点」改成「(时间, 值) 绝对坐标」，
   * 两者只能靠**版本**区分 —— 数值上会撞车：scale 通道的值本来就在 1 附近，绝对控制点
   * 很容易整组落进 [0,1]（spineboy-pro 的 `idle-turn/front-fist.scale` 就是），
   * 只看数值会把它们当成已归一化，实测带来 1.5% 的缩放偏差。
   * 版本缺失（老工程 / 手写 JSON）时给 null，让解析侧回退到数值启发式。
   */
  const curveVersion = /^(\d+)\.(\d+)/.exec(String((json as { skeleton?: { spine?: unknown } }).skeleton?.spine ?? ''))
  const absoluteCurve = curveVersion
    ? Number(curveVersion[1]) > 4 || (Number(curveVersion[1]) === 4 && Number(curveVersion[2]) >= 2)
    : null

  const animations: AnimData[] = Object.entries(json.animations ?? {}).map(([name, animation]) =>
    importSpineAnimations(name, animation, {
      boneIndex,
      slotIndex: slotIndexByName,
      bones,
      constraints,
      attIndexBySlot,
      regions: ctx.regions,
      pageSizes: ctx.pageSizes,
      deformBase,
      setupWorldLin,
      absoluteCurve,
      fps: skeletonOnly.frameRate,
      warnings
    })
  )

  // 动画的骨骼 / 插槽轨道优先用**官方运行库烘焙**：缓动的两种写法、mix、IK 与其它
  // 约束、各版本差异全部由官方算好，我们只是按帧采样最终局部姿态。失败则回退内置解析。
  const baked = input.atlasText
    ? bakeSpineAnimations({
        json,
        atlasText: input.atlasText,
        boneNames: bones.map((bone) => bone.name),
        slotNames: slots.map((slot) => slot.name),
        fps: skeletonOnly.frameRate
      })
    : null
  const bakedApplied = baked ? applyBakedAnimations(animations, baked, slots, attIndexBySlot) : false
  if (input.atlasText && !baked) {
    // 原因见控制台（官方运行库读不了 / 采样出 NaN）；多为 3.3 及更早的老格式
    warnings.push(
        t('官方运行库烘焙失败，动画改用内置解析（老版本格式常见：3.3 及更早；缓动 / IK 可能与官方有差异）')
      )
  }

  const regionsByPage = new Map<string, AtlasRegion[]>()
  for (const region of input.regions ?? []) {
    const list = regionsByPage.get(region.page) ?? []
    list.push(region)
    regionsByPage.set(region.page, list)
  }
  const images: ImageRef[] = textureNames.map((name) => {
    const pageRegions = regionsByPage.get(name)
    return {
      name,
      path: input.pageImages?.[name] ?? name,
      width: input.pageSizes[name]?.width ?? 0,
      height: input.pageSizes[name]?.height ?? 0,
      // 带进来的图集页：整页复制、不重打包；并保留页里每个 sprite 的子区域，导出时还原
      loose: pageRegions ? false : undefined,
      regions: pageRegions
        ? pageRegions.map((r) => ({
            name: r.name,
            x: r.x,
            y: r.y,
            width: r.width,
            height: r.height,
            rotate: r.rotate,
            origWidth: r.origWidth,
            origHeight: r.origHeight,
            offsetX: r.offsetX,
            offsetY: r.offsetY
          }))
        : undefined
    }
  })

  const asset = createRuntimeAsset({
    dataType: AnimType.Spine,
    armatureName: 'armature',
    frameRate: skeletonOnly.frameRate,
    bones,
    slots,
    skins,
    constraints,
    animations,
    textureNames,
    defaultSkinIndex,
    /*
     * `runtimeIK === false` 的含义是「约束结果已烘焙进骨骼轨道，运行期一条都不要再解」。
     *
     * 但**老格式（3.x / 4.0 / 4.1）的约束写在顶层 `ik` / `transform` / `path` 数组里**，
     * 官方 4.3 运行库只认 4.2 起的 `constraints` 数组（见 `SkeletonJson` 的 `root.constraints`）
     * —— 也就是说烘焙时这些约束**根本没生效**，轨道里也没有它们的结果。
     * 这类文件必须由运行期自己解，标成 false 会让约束整体失效（Spineunitygirl 的 `main`
     * 就会像四肢脱位）；只有确认官方读到了约束（`json.constraints` 存在）才敢全部关掉。
     */
    runtimeIK: !bakedApplied || hasLegacyConstraintArrays(json),
    images
  })
  asset.bindposes = bindposes

  return { asset, warnings }
}

/**
 * 用官方运行库烘焙出的轨道**替换**内置解析的骨骼 / 插槽轨道。
 *
 * 采样密度足够，所以基本都是线性缓动；只有烘焙时检出「瞬间切换」的关键帧带
 * `stepped` 标记（还原官方的阶跃语义，如 head-turn 的镜像切换），换成 Stepped。
 * 采样后的帧已经过简化（删掉能用直线近似替代的中间帧，见 `spineBake.ts`）。
 * 换装按**附件名**解析成显示下标（换皮肤后按名解析才正确）。
 * FFD / drawOrder / 事件 / 约束仍沿用内置解析的结果。
 */
function applyBakedAnimations(
  animations: AnimData[],
  baked: readonly BakedAnimation[],
  slots: readonly SlotData[],
  attIndexBySlot: Map<string, Map<string, number>>
): boolean {
  let applied = false
  const easingOf = (stepped?: boolean): Easing => (stepped ? Easing.Stepped : Easing.Linear)
  const byName = new Map(animations.map((animation) => [animation.name, animation]))
  for (const item of baked) {
    const target = byName.get(item.name)
    if (!target) continue
    applied = true
    if (item.duration > 0) target.duration = item.duration
    target.bones = item.bones.map((track) => ({
      boneIndex: track.bone,
      translate: track.translate.map((key) => ({
        time: key.time,
        value: { x: key.x, y: key.y },
        easing: easingOf(key.stepped),
        curve: null
      })),
      rotate: track.rotate.map((key) => ({
        time: key.time,
        value: key.value,
        easing: easingOf(key.stepped),
        curve: null
      })),
      scale: track.scale.map((key) => ({
        time: key.time,
        value: { x: key.x, y: key.y },
        easing: easingOf(key.stepped),
        curve: null
      })),
      shear: track.shear.map((key) => ({
        time: key.time,
        value: { x: key.x, y: key.y },
        easing: easingOf(key.stepped),
        curve: null
      }))
    }))
    // slot 轨道为空时**不要覆盖**：这只有一种来源 —— 官方运行库没读到皮肤
    // （如 3.3 的对象式 skins），此时采样值全是 null，覆盖会把所有槽位隐藏、
    // 角色整个消失。骨骼数据与皮肤无关，照常采用烘焙结果。
    if (item.slots.length === 0) continue
    target.slots = item.slots.map((track) => {
      const anim = emptySlotAnim(track.slot)
      const index = attIndexBySlot.get(slots[track.slot]?.name ?? '')
      for (const key of track.display) {
        const found = key.name ? (index?.get(key.name) ?? -1) : -1
        anim.displayIndex.push({ time: key.time, value: found, easing: Easing.Stepped, curve: null })
        anim.displayAttachment.push(key.name)
      }
      for (const key of track.color) {
        anim.color.push({
          time: key.time,
          value: { r: key.r, g: key.g, b: key.b, a: key.a },
          easing: Easing.Linear,
          curve: null
        })
      }
      return anim
    })
  }
  return applied
}

/**
 * 约束是否写在**老格式**的顶层数组里（3.x / 4.0 / 4.1 的 `ik` / `transform` / `path`）。
 *
 * 官方 4.3 运行库只读 4.2 起的 `constraints` 数组，老数组它完全不看 ——
 * 所以这类文件的烘焙结果里**不含约束效果**，运行期必须自己解（见 `runtimeIK` 的赋值处）。
 */
function hasLegacyConstraintArrays(json: SpineJson): boolean {
  return (json.ik?.length ?? 0) > 0 || (json.transform?.length ?? 0) > 0 || (json.path?.length ?? 0) > 0
}

function buildConstraints(
  json: SpineJson,
  boneIndex: Map<string, number>,
  warnings: string[]
): Constraint[] {
  const constraints: Constraint[] = []

  // 4.2+ 把约束统一放顶层 `constraints`（每项带 type），旧版按类型分在 ik / transform / path。
  // 早先只读旧字段，4.2+ 的资源（如 raptor 4.3）**一个约束都读不到** —— IK 完全不生效，
  // 动画里的 ik 轨道还会报「约束不存在」。
  const legacyIk = [...(json.ik ?? [])]
  const legacyTransform = [...(json.transform ?? [])]
  const legacyPath = [...(json.path ?? [])]
  for (const item of json.constraints ?? []) {
    const type = (item.type ?? '').toLowerCase()
    if (type === 'ik') legacyIk.push(item)
    else if (type === 'transform') legacyTransform.push(item)
    else if (type === 'path') legacyPath.push(item)
  }

  for (const ik of legacyIk) {
    const bones = remapBones(ik.bones, boneIndex)
    const target = boneIndex.get(ik.target)
    if (bones.length === 0 || target === undefined) {
      warnings.push(t('IK「{0}」的目标或骨骼链无效，已跳过', ik.name))
      continue
    }
    constraints.push(
      createIkConstraint({
        name: ik.name,
        order: ik.order ?? 0,
        enabled: true,
        boneIndices: bones,
        targetBoneIndex: target,
        mix: ik.mix ?? 1,
        // 与 Unity 端 Hao2D 运行时一致：bendPositive(true) → -1。解算器把它当旋转方向符号用
        // （`kneeDir = Rotate(u, a1 * bendSign)`），符号反了膝盖会朝另一侧弯
        bendSign: ik.bendPositive === false ? 1 : -1,
        useBoneLength: false,
        compress: ik.compress ?? false,
        stretch: ik.stretch ?? false,
        softness: ik.softness ?? 0
      })
    )
  }

  for (const transform of legacyTransform) {
    const bones = remapBones(transform.bones, boneIndex)
    // 4.3 起 transform 约束把 target 改名成 source（同一含义：提供变换的源骨骼）
    const sourceName = transform.target ?? transform.source
    const target = sourceName === undefined ? undefined : boneIndex.get(sourceName)
    if (bones.length === 0 || target === undefined) {
      warnings.push(t('变换约束「{0}」的目标或骨骼链无效，已跳过', transform.name))
      continue
    }
    constraints.push(
      createTransformConstraint({
        name: transform.name,
        order: transform.order ?? 0,
        enabled: true,
        boneIndices: bones,
        targetBoneIndex: target,
        /*
         * 字段名两套都要认：Spine 4.0 把 transform 约束的混合与偏移改名了 ——
         *   mix:  rotateMix / translateMix / scaleMix / shearMix  →  mixRotate / mixX+Y / mixScaleX+Y / mixShearY
         *   offset: rotation / x / y / scaleX / scaleY / shearY  →  offsetRotation / offsetX / offsetY / …
         * 只读旧名会让 4.x 资源里的偏移整段丢成 0（导出侧写的是新名，所以两边也曾不对称）；
         * 而 3.8 的旋转偏移叫 `rotation`，只认 `rotate` 时老资源的旋转偏移同样是 0。
         */
        mixRotate: transform.mixRotate ?? transform.rotateMix ?? 1,
        mixX: transform.mixX ?? transform.translateMix ?? 1,
        mixY: transform.mixY ?? transform.translateMix ?? 1,
        mixScaleX: transform.mixScaleX ?? transform.scaleMix ?? 1,
        mixScaleY: transform.mixScaleY ?? transform.scaleMix ?? 1,
        mixShearY: transform.mixShearY ?? transform.shearMix ?? 1,
        // 3.8 的旋转偏移叫 `rotation`（3.8 SkeletonJson 读的就是这个名字）
        offsetRotate: transform.offsetRotation ?? transform.rotate ?? transform.rotation ?? 0,
        offsetX: pxToUnit(transform.offsetX ?? transform.x ?? 0),
        offsetY: pxToUnit(transform.offsetY ?? transform.y ?? 0),
        offsetScaleX: transform.offsetScaleX ?? transform.scaleX ?? 0,
        offsetScaleY: transform.offsetScaleY ?? transform.scaleY ?? 0,
        offsetShearY: transform.offsetShearY ?? transform.shearY ?? 0,
        relative: transform.relative ?? false,
        local: transform.local ?? false,
        inherit: 'normal'
      })
    )
  }

  for (const path of legacyPath) {
    const bones = remapBones(path.bones, boneIndex)
    if (bones.length === 0 || path.target === undefined) {
      // 4.3 的路径约束挂在插槽的 path 附件上（本项目模型没有对应类型）。
      // 姿态本身已经由官方运行库烘焙补偿，这里只是提示「约束对象没有导进来」
      warnings.push(t('路径约束「{0}」不支持编辑，求解结果已烘进骨骼姿态', path.name))
      continue
    }
    constraints.push(
      createPathConstraint({
        name: path.name,
        order: path.order ?? 0,
        enabled: true,
        boneIndices: bones,
        targetBoneIndex: boneIndex.get(path.target) ?? -1,
        position: path.position ?? 0,
        spacing: path.spacing ?? 0,
        rotateMix: path.rotateMix ?? 1,
        translateMix: path.translateMix ?? 1,
        positionMode: path.positionMode === 'fixed' ? 'fixed' : 'percent',
        spacingMode:
          path.spacingMode === 'fixed' || path.spacingMode === 'percent' ? path.spacingMode : 'length',
        rotateMode:
          path.rotateMode === 'chainScale' || path.rotateMode === 'tangent' ? path.rotateMode : 'chain'
      })
    )
  }

  for (const physics of json.physics ?? []) {
    constraints.push(
      createPhysicsConstraint({
        name: physics.name,
        order: physics.order ?? 0,
        enabled: true,
        boneIndices: Array.isArray(physics.bones) ? remapBones(physics.bones as string[], boneIndex) : [],
        targetBoneIndex: -1,
        raw: { ...physics }
      })
    )
  }

  return constraints
}

function remapBones(names: readonly string[], boneIndex: Map<string, number>): number[] {
  return names.map((name) => boneIndex.get(name)).filter((v): v is number => v !== undefined)
}

export { emptyIkAnim }
export type { SpineJson }

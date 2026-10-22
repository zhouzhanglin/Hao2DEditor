import { createAttachmentData, createBoneData, AttachmentType, AnimType, BlendMode } from '@core/model/types'
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
import { mapRegionRelativeUvs, parseHexColor, pxToUnit, regionGeometry, regionUvs } from './uv'
import { indexRegions } from './atlasSpine'
import { importSpineAnimations } from './spineAnims'
import type {
  SpineAttachmentJson,
  SpineBoneJson,
  SpineIkJson,
  SpineJson,
  SpineSlotJson
} from './spineTypes'
import { bakeSpineAnimations } from './spineBake'
import type { BakedAnimation } from './spineBake'
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
    if (byName.has(bone.name)) warnings.push(`存在重名骨骼「${bone.name}」，仅保留第一个`)
    else byName.set(bone.name, bone)
  }

  const ordered: SpineBoneJson[] = []
  const visited = new Set<string>()
  const visit = (bone: SpineBoneJson, depth: number): void => {
    if (visited.has(bone.name)) return
    if (depth > 512) {
      warnings.push(`骨骼「${bone.name}」父链过深或存在环，已截断`)
      return
    }
    if (bone.parent) {
      const parent = byName.get(bone.parent)
      if (!parent) warnings.push(`骨骼「${bone.name}」的父骨骼「${bone.parent}」不存在，已作为根骨骼`)
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
      warnings.push(`插槽「${slotName}」的混合模式 mask 不受支持，已按 Normal 导入（遮罩请用 clipping 附件）`)
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
 * `world = Σ w × (boneWorld × (lx, ly))`（见参考库 ComputeWorldVertices，加权与
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
  ctx.warnings.push(`附件的图集区域「${candidates[0]}」不存在，贴图可能显示异常`)
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
    return createAttachmentData({
      ...base,
      type: AttachmentType.LinkedMesh,
      textureName: region ? region.page : '',
      regionName: region ? region.name : undefined,
      size: { x: pxToUnit(attachment.width ?? 0), y: pxToUnit(attachment.height ?? 0) },
      linkedMeshSkin: (attachment as { skin?: string }).skin ?? '',
      linkedMeshAttachment: (attachment as { parent?: string }).parent ?? ''
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
    //（参考库 ReadVertices：只有 `verticesLength == vertices.Length` 才是非加权）。
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
    if (bone === undefined) warnings.push(`插槽「${slot.name}」挂载的骨骼「${slot.bone}」不存在，已挂到根骨骼`)
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

  const skins: SkinData[] = normalizeSkins(json).map((skin) => ({
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

  // 网格附件的绑定顶点表：deform 轨道的「长度对齐 + 绝对坐标→纯位移」换算要用
  //（key = spot\u0000attachment；加权网格给等长零占位，只用于长度对齐）
  const deformBase = new Map<string, { vertices: Float32Array; weighted: boolean }>()
  for (const skin of skins) {
    for (const skinSlot of skin.slots) {
      for (const attachment of skinSlot.attachments) {
        if (attachment.type !== AttachmentType.Mesh) continue
        const count = Math.floor(attachment.vertices.length / 2)
        deformBase.set(`${skinSlot.slotName}\u0000${attachment.name}`, {
          vertices: attachment.vertices,
          weighted: count > 0 && attachment.weights.length === count
        })
      }
    }
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
      absoluteCurve,
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
    warnings.push('官方运行库烘焙失败，动画改用内置解析（老版本格式常见：3.3 及更早；缓动 / IK 可能与官方有差异）')
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
    // IK 已经被官方运行库烘焙进骨骼轨道（含约束修正），运行期不再重复求解 ——
    // 否则会出现「Pose 态的脚不对」「膝盖朝反」这类问题
    runtimeIK: !bakedApplied,
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
      warnings.push(`IK「${ik.name}」的目标或骨骼链无效，已跳过`)
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
        // 与参考库一致：bendPositive(true) → -1。解算器把它当旋转方向符号用
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
    const target = boneIndex.get(transform.target)
    if (bones.length === 0 || target === undefined) {
      warnings.push(`变换约束「${transform.name}」的目标或骨骼链无效，已跳过`)
      continue
    }
    constraints.push(
      createTransformConstraint({
        name: transform.name,
        order: transform.order ?? 0,
        enabled: true,
        boneIndices: bones,
        targetBoneIndex: target,
        mixRotate: transform.mixRotate ?? 1,
        mixX: transform.mixX ?? 1,
        mixY: transform.mixY ?? 1,
        mixScaleX: transform.mixScaleX ?? 1,
        mixScaleY: transform.mixScaleY ?? 1,
        mixShearY: transform.mixShearY ?? 1,
        offsetRotate: transform.rotate ?? 0,
        offsetX: pxToUnit(transform.x ?? 0),
        offsetY: pxToUnit(transform.y ?? 0),
        offsetScaleX: transform.scaleX ?? 0,
        offsetScaleY: transform.scaleY ?? 0,
        offsetShearY: transform.shearY ?? 0,
        relative: transform.relative ?? false,
        local: transform.local ?? false,
        inherit: 'normal'
      })
    )
  }

  for (const path of legacyPath) {
    const bones = remapBones(path.bones, boneIndex)
    if (bones.length === 0 || path.target === undefined) {
      warnings.push(`路径约束「${path.name}」信息不完整，已跳过`)
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

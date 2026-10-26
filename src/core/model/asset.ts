import { AttachmentType, AnimType, BlendMode } from './types'
import type { AttachmentData, BoneData, ImageRef, SkinData, SkinSlotData, SlotData } from './types'
import type { AnimData } from './animation'
import type { Constraint, IkConstraint } from './constraints'

/**
 * 编辑器运行期模型 = 参考库 `Hao2DAsset` 的**超集**：
 * 骨骼 / 插槽 / 皮肤 / 附件 / 动画沿用其结构，另新增 `constraints`（四类约束）
 * 与约束动画轨道、图集页元数据。
 *
 * 导出 `.hao2d` 时只取子集（约束仅保留 ik），导出 `*_ske.json` 时完整导出。
 */
export interface RuntimeAsset {
  dataType: AnimType
  armatureName: string
  frameRate: number
  /** 已按拓扑序（parentIndex < 自身下标） */
  bones: BoneData[]
  slots: SlotData[]
  skins: SkinData[]
  constraints: Constraint[]
  animations: AnimData[]
  /** 每骨骼的逆绑定矩阵，长度 16n，列主序 */
  bindposes: Float32Array
  /** 图集页 png 名，顺序 = 材质槽顺序 */
  textureNames: string[]
  /** 合并基底皮肤（通常是名为 default 的那套） */
  defaultSkinIndex: number
  /**
   * 运行期默认**叠加**皮肤（= 导出时编辑器当前皮肤；空串 = 只显示基底皮肤）。
   * 与 `defaultSkinIndex` 是两件事：基底永远生效，这个皮肤叠加在它上面（同名覆盖）。
   */
  defaultSkin: string
  runtimeIK: boolean
  /** 编辑器扩展：图集页尺寸与来源路径 */
  images: ImageRef[]
}

export function createRuntimeAsset(partial?: Partial<RuntimeAsset>): RuntimeAsset {
  return {
    dataType: AnimType.Spine,
    armatureName: 'armature',
    frameRate: 30,
    bones: [],
    slots: [],
    skins: [],
    constraints: [],
    animations: [],
    bindposes: new Float32Array(0),
    textureNames: [],
    defaultSkinIndex: 0,
    defaultSkin: '',
    runtimeIK: true,
    images: [],
    ...partial
  }
}

export function ikConstraints(asset: RuntimeAsset): IkConstraint[] {
  return asset.constraints.filter((c): c is IkConstraint => c.type === 'ik')
}

export function findBoneIndex(asset: RuntimeAsset, name: string): number {
  for (let i = 0; i < asset.bones.length; i++) if (asset.bones[i].name === name) return i
  return -1
}

export function findSlotIndex(asset: RuntimeAsset, name: string): number {
  for (let i = 0; i < asset.slots.length; i++) if (asset.slots[i].name === name) return i
  return -1
}

export function findSkinIndex(skins: readonly SkinData[], name: string): number {
  if (skins.length === 0) return -1
  if (!name) return 0
  for (let i = 0; i < skins.length; i++) if (skins[i].name === name) return i
  return -1
}

export function skinNames(asset: RuntimeAsset): string[] {
  return asset.skins.map((s) => s.name)
}

export function findConstraintIndex(asset: RuntimeAsset, name: string): number {
  for (let i = 0; i < asset.constraints.length; i++) {
    if (asset.constraints[i].name === name) return i
  }
  return -1
}

export function imageRefByName(asset: RuntimeAsset, name: string): ImageRef | null {
  for (const image of asset.images) if (image.name === name) return image
  return null
}

/**
 * 运行期预解析结果（与参考库 `MeshBuilder.Init` 一一对应），
 * 避免每帧按字符串查字典。
 */
export interface RuntimeMaps {
  /** 合并后的「插槽名 → 皮肤插槽」 */
  slotSkin: Map<string, SkinSlotData>
  /** 合并后的皮肤插槽数组（紧凑，仅含有附件的插槽） */
  skinArr: SkinSlotData[]
  /** 插槽下标 → skinArr 下标，-1 表示无 */
  skinOfSlot: Int32Array
  /** 每插槽 setup 显示下标（按 setup 附件名 + 当前合并皮肤解析） */
  setupDisplayIndex: Int32Array
  /** 每插槽「附件名 → 合并皮肤里的下标」 */
  slotAttIndex: Array<Map<string, number> | null>
  /** 每插槽 linkedmesh 合并结果（下标与附件表一致，无覆盖处为 null） */
  resolved: Array<Array<AttachmentData | null> | null>
}

/**
 * 按官方 Skin.AddSkin 语义合并皮肤：
 * 默认皮肤永远生效；选中皮肤叠加在其上（同名附件**覆盖原下标**、新附件**追加到末尾**）。
 * 覆盖而非重排可保证默认皮肤附件下标不变，转换期烘焙好的 displayIndex 继续有效。
 */
export function mergeSkinIntoSlotMap(target: Map<string, SkinSlotData>, skin: SkinData, merge: boolean): void {
  for (const src of skin.slots) {
    if (!src.attachments || src.attachments.length === 0) continue
    if (!merge) {
      target.set(src.slotName, src)
      continue
    }
    const existing = target.get(src.slotName)
    const list: AttachmentData[] = existing?.attachments ? [...existing.attachments] : []
    for (const attachment of src.attachments) {
      const at = list.findIndex((a) => a.name === attachment.name)
      if (at >= 0) list[at] = attachment
      else list.push(attachment)
    }
    target.set(src.slotName, { slotName: src.slotName, attachments: list })
  }
}

function findSkinAttachments(asset: RuntimeAsset, skinName: string, slotName: string): AttachmentData[] | null {
  let skin: SkinData | null = null
  if (skinName) {
    skin = asset.skins.find((s) => s.name === skinName) ?? null
  }
  if (!skin) skin = asset.skins[0] ?? null
  if (!skin) return null
  const slot = skin.slots.find((s) => s.slotName === slotName)
  return slot ? slot.attachments : null
}

/**
 * 解析 Spine 的 linkedmesh：
 * 几何（顶点 / 权重 / UV / 三角形 / 尺寸）取自父附件，变换 / 颜色 / 贴图 / 名字用 linkedmesh 自己的。
 * 查找规则与官方一致：在 `linkedMeshSkin` 指定皮肤、**同一个槽位**下按名字找父附件。
 */
export function resolveLinkedMesh(asset: RuntimeAsset, lm: AttachmentData, slotName: string): AttachmentData | null {
  if (asset.skins.length === 0 || !lm.linkedMeshAttachment) return null
  const parents = findSkinAttachments(asset, lm.linkedMeshSkin, slotName)
  if (!parents) return null

  for (const parent of parents) {
    if (parent.name !== lm.linkedMeshAttachment) continue
    if (parent.type === AttachmentType.LinkedMesh) return null

    const merged: AttachmentData = {
      ...lm,
      type: parent.type === AttachmentType.Mesh ? AttachmentType.Mesh : AttachmentType.Region,
      vertices: parent.vertices,
      weights: parent.weights,
      triangles: parent.triangles,
      edges: parent.edges,
      hull: parent.hull,
      size: { ...parent.size },
      uvs: lm.uvs.length > 0 ? lm.uvs : parent.uvs,
      ffdInBoneSpace: parent.ffdInBoneSpace,
      position: { ...lm.position },
      scale: { ...lm.scale },
      color: { ...lm.color }
    }
    if (!merged.textureName) merged.textureName = parent.textureName
    return merged
  }
  return null
}

/**
 * 在「附件名 → 下标」表里查找，**兼容换装皮肤的「皮肤名/」前缀**。
 *
 * Spine 的换装皮肤把附件名写成 `goblin/head`（区域名同理），而 slot 的 setup 附件名
 * 与动画里的附件轨道用的是**裸名**（`head`）—— 直接 `map.get('head')` 会落空，
 * 表现就是「切换皮肤后角色整个消失 / 只有零星部件」（Goblins 这类换装角色）。
 */
export function findAttachmentIndex(map: ReadonlyMap<string, number>, name: string): number | undefined {
  const exact = map.get(name)
  if (exact !== undefined) return exact
  for (const [key, index] of map) {
    const slash = key.lastIndexOf('/')
    if (slash >= 0 && key.slice(slash + 1) === name) return index
  }
  return undefined
}

/** 构建运行期预解析映射（对齐参考库 MeshBuilder.Init）。 */
export function buildRuntimeMaps(asset: RuntimeAsset, skinName = ''): RuntimeMaps {
  const slotSkin = new Map<string, SkinSlotData>()
  if (asset.skins.length > 0) {
    let def = asset.defaultSkinIndex
    if (def < 0 || def >= asset.skins.length) def = 0
    mergeSkinIntoSlotMap(slotSkin, asset.skins[def], false)
    if (skinName) {
      const idx = findSkinIndex(asset.skins, skinName)
      if (idx >= 0 && idx !== def) mergeSkinIntoSlotMap(slotSkin, asset.skins[idx], true)
    }
  }

  const slotCount = asset.slots.length
  const skinOfSlot = new Int32Array(slotCount).fill(-1)
  const skinArr: SkinSlotData[] = []
  for (let i = 0; i < slotCount; i++) {
    const found = slotSkin.get(asset.slots[i].name)
    if (found) {
      skinOfSlot[i] = skinArr.length
      skinArr.push(found)
    }
  }

  const setupDisplayIndex = new Int32Array(slotCount)
  const slotAttIndex: Array<Map<string, number> | null> = new Array(slotCount).fill(null)
  const resolved: Array<Array<AttachmentData | null> | null> = new Array(slotCount).fill(null)

  for (let i = 0; i < slotCount; i++) {
    const k = skinOfSlot[i]
    if (k < 0) continue
    const attachments = skinArr[k].attachments
    const count = attachments.length
    if (count === 0) continue

    const map = new Map<string, number>()
    for (let a = 0; a < count; a++) {
      const name = attachments[a].name
      if (name) map.set(name, a)
    }
    slotAttIndex[i] = map

    let display = asset.slots[i].defaultDisplayIndex
    const want = asset.slots[i].setupAttachment
    if (want) {
      // 换装皮肤的附件名带「皮肤名/」前缀，而 slot.attachment 是裸名 → 用兼容查找
      const byName = findAttachmentIndex(map, want)
      if (byName !== undefined) display = byName
    }
    // -1 是「setup 时不显示任何附件」的合法值，必须保留；只有越界才退化为第一个附件
    if (display >= count) display = 0
    setupDisplayIndex[i] = display

    let override: Array<AttachmentData | null> | null = null
    for (let d = 0; d < count; d++) {
      const attachment = attachments[d]
      if (attachment.type !== AttachmentType.LinkedMesh) continue
      const merged = resolveLinkedMesh(asset, attachment, skinArr[k].slotName)
      if (merged) {
        if (!override) override = new Array<AttachmentData | null>(count).fill(null)
        override[d] = merged
      }
    }
    resolved[i] = override
  }

  return { slotSkin, skinArr, skinOfSlot, setupDisplayIndex, slotAttIndex, resolved }
}

/** 图集页下标：textureNames 里的位置；找不到返回 0 */
export function materialIndexOf(asset: RuntimeAsset, textureName: string): number {
  if (!textureName) return 0
  const idx = asset.textureNames.indexOf(textureName)
  return idx < 0 ? 0 : idx
}

export const DEFAULT_BLEND = BlendMode.Normal

/** 统计信息（状态栏用），只统计当前皮肤可见的部分 */
export function assetStats(asset: RuntimeAsset): {
  bones: number
  slots: number
  constraints: number
  animations: number
  attachments: number
  vertices: number
  triangles: number
} {
  let attachments = 0
  let vertices = 0
  let triangles = 0
  for (const skin of asset.skins) {
    for (const slot of skin.slots) {
      for (const attachment of slot.attachments) {
        attachments++
        vertices += Math.floor(attachment.vertices.length / 2)
        triangles += Math.floor(attachment.triangles.length / 3)
      }
    }
  }
  return {
    bones: asset.bones.length,
    slots: asset.slots.length,
    constraints: asset.constraints.length,
    animations: asset.animations.length,
    attachments,
    vertices,
    triangles
  }
}

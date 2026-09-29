import { createAuthoringAttachment, createAuthoringSlot } from '@core/model/authoring'
import type {
  AuthoringAttachment,
  AuthoringSkin,
  AuthoringSkinSlot,
  EditorDocument
} from '@core/model/authoring'
import type { Vec2 } from '@core/math/matrix'
import { createGridMesh } from '@core/mesh/triangulate'
import type { MeshGeometry } from '@core/mesh/triangulate'

/** 骨架单位 ↔ 像素（与导入 / 导出保持一致的 PPU） */
export const PPU = 100

export type BrushMode = 'add' | 'subtract' | 'replace'

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
 * 权重刷：以世界坐标为中心、radius 为半径，对目标附件顶点刷指定骨骼的权重。
 *
 * - add：在现有权重上叠加；subtract：衰减；replace：直接覆盖
 * - 刷完统一归一化到 1（目标骨骼权重为 1 时清空其它骨骼，避免出现 0 权重残留）
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
  mode: BrushMode
): number {
  if (!bone || radius <= 0) return 0
  let touched = 0
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

    // 平滑衰减：中心为 1，边缘为 0
    const falloff = smoothStep(1 - distance / radius)
    const delta = strength * falloff
    if (delta <= 0) continue

    let current = vertex.weights.find((item) => item.bone === bone)?.weight ?? 0
    if (mode === 'add') current = Math.min(1, current + delta)
    else if (mode === 'subtract') current = Math.max(0, current - delta)
    else current = delta

    applyVertexWeight(vertex.weights, bone, current)
    touched++
  }
  return touched
}

/** 把某个骨骼的权重写进稀疏权重表并归一化 */
export function applyVertexWeight(
  weights: Array<{ bone: string; weight: number }>,
  bone: string,
  value: number
): void {
  const clamped = Math.max(0, Math.min(1, value))
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
    if (next.length === 0) next.push({ bone, weight: 1 })
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

    vertex.weights = top.map((item) => ({ bone: item.bone, weight: item.score / total }))
    touched++
  }
  return touched
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

function smoothStep(t: number): number {
  const x = Math.max(0, Math.min(1, t))
  return x * x * (3 - 2 * x)
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

import { createAuthoringAttachment, createAuthoringSlot } from '@core/model/authoring'
import type {
  AuthoringAttachment,
  AuthoringSkin,
  AuthoringSkinSlot,
  AuthoringVertex,
  AuthoringWeight,
  EditorDocument
} from '@core/model/authoring'
import type { Vec2 } from '@core/math/matrix'
import { createGridMesh, triangulatePolygon } from '@core/mesh/triangulate'
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
 * 在网格里插入一个顶点：把命中的三角形拆成 3 个（UV 与蒙皮权重按重心坐标插值）。
 * 返回新顶点的下标，未命中任何三角形时返回 null。
 */
export function insertMeshVertex(
  doc: EditorDocument,
  slotName: string,
  attachmentName: string,
  point: Vec2
): number | null {
  const attachment = findAttachment(doc, slotName, attachmentName)
  if (!attachment || attachment.type !== 'mesh') return null

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
  attachment.hull = attachment.vertices.length
  return index
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
function renameSlotRefs(doc: EditorDocument, oldName: string, next: string): void {
  for (const skin of doc.skins) for (const skinSlot of skin.slots) if (skinSlot.slot === oldName) skinSlot.slot = next
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

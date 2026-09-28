import { Graphics } from 'pixi.js'
import type { MeshBuildResult } from '@core/skin/meshBuilder'
import type { AttachmentData } from '@core/model/types'
import type { Skeleton } from '@core/model/skeleton'
import { DOT_SEGMENTS, circlePolygon } from './shapes'

export interface MeshOverlayOptions {
  unitsPerPixel: number
  showWireframe: boolean
  showVertices: boolean
  /** 按骨骼显示权重热力图；-1 = 关闭 */
  weightBone: number
  /** 选中的顶点下标集合（全局顶点缓冲下标） */
  selectedVertices: ReadonlySet<number>
  hoveredVertex: number
}

const COLOR_WIRE = 0x22d3ee
const COLOR_VERTEX = 0xa0a0b8
const COLOR_VERTEX_SELECTED = 0x22d3ee
const COLOR_VERTEX_HOVERED = 0xfbbf24
const COLOR_FFD = 0x8b5cf6
const COLOR_FFD_BASE = 0x6b6b82

/**
 * 网格线框 + 顶点手柄 + 权重热力图 + FFD 偏移可视化。
 * 同样把描边与填充拆到两个 Graphics（见 boneOverlay 的说明）。
 */
export function drawMeshOverlay(
  strokes: Graphics,
  fills: Graphics,
  skeleton: Skeleton,
  result: MeshBuildResult | null,
  attachmentOf: (slotIndex: number, displayIndex: number) => AttachmentData | null,
  options: MeshOverlayOptions
): void {
  strokes.clear()
  fills.clear()
  if (!result || result.vertexCount === 0) return
  const g = strokes
  const w = options.unitsPerPixel

  if (options.showWireframe) {
    for (const group of result.groups) {
      const indices = group.indices
      const count = group.indexCount
      for (let i = 0; i + 2 < count; i += 3) {
        const a = indices[i] * 2
        const b = indices[i + 1] * 2
        const c = indices[i + 2] * 2
        g.moveTo(result.positions[a], result.positions[a + 1]).lineTo(result.positions[b], result.positions[b + 1])
        g.moveTo(result.positions[b], result.positions[b + 1]).lineTo(result.positions[c], result.positions[c + 1])
        g.moveTo(result.positions[c], result.positions[c + 1]).lineTo(result.positions[a], result.positions[a + 1])
      }
    }
    g.stroke({ width: w, color: COLOR_WIRE, alpha: 0.45 })
  }

  if (options.showVertices) {
    const weightColors = options.weightBone >= 0
    const normal: number[] = []
    const selected: number[] = []
    const hovered: number[] = []
    for (let i = 0; i < result.vertexCount; i++) {
      const x = result.positions[i * 2]
      const y = result.positions[i * 2 + 1]
      if (i === options.hoveredVertex) hovered.push(x, y)
      else if (options.selectedVertices.has(i)) selected.push(x, y)
      else normal.push(x, y)
    }

    if (weightColors) {
      drawWeightPoints(fills, skeleton, result, attachmentOf, options.weightBone, w)
    } else {
      fillPoints(fills, normal, 2.2 * w, COLOR_VERTEX, 0.85)
      fillPoints(fills, selected, 3.4 * w, COLOR_VERTEX_SELECTED, 1)
      fillPoints(fills, hovered, 3.4 * w, COLOR_VERTEX_HOVERED, 1)
    }
  }

  drawFfdOffsets(strokes, fills, skeleton, result, w)
}

/** 权重热力图：0 → 蓝，0.5 → 青绿，1 → 红 */
function drawWeightPoints(
  g: Graphics,
  skeleton: Skeleton,
  result: MeshBuildResult,
  attachmentOf: (slotIndex: number, displayIndex: number) => AttachmentData | null,
  boneIndex: number,
  w: number
): void {
  for (let i = 0; i < result.vertexCount; i++) {
    const slotIndex = result.sourceSlot[i]
    const vertexIndex = result.sourceVertex[i]
    const attachment = attachmentOf(slotIndex, skeleton.slotDisplayIndex[slotIndex])
    if (!attachment) continue
    const weight = attachment.weights.length > vertexIndex ? weightOf(attachment.weights[vertexIndex], boneIndex) : 0
    if (weight <= 0.001) continue
    g.poly(circlePolygon(result.positions[i * 2], result.positions[i * 2 + 1], 3.2 * w, DOT_SEGMENTS))
    g.fill({ color: heatColor(weight), alpha: 0.95 })
  }
}

function weightOf(entry: { b0: number; b1: number; b2: number; b3: number; w0: number; w1: number; w2: number; w3: number }, boneIndex: number): number {
  if (entry.b0 === boneIndex && entry.w0 > 0) return entry.w0
  if (entry.b1 === boneIndex && entry.w1 > 0) return entry.w1
  if (entry.b2 === boneIndex && entry.w2 > 0) return entry.w2
  if (entry.b3 === boneIndex && entry.w3 > 0) return entry.w3
  return 0
}

/** 权重热力色：0 → 蓝，0.5 → 青绿，1 → 红 */
function heatColor(weight: number): number {
  const t = Math.max(0, Math.min(1, weight))
  const from = t < 0.5 ? [34, 102, 238] : [52, 211, 153]
  const to = t < 0.5 ? [52, 211, 153] : [248, 113, 113]
  const k = t < 0.5 ? t * 2 : (t - 0.5) * 2
  const r = Math.round(from[0] + (to[0] - from[0]) * k)
  const g = Math.round(from[1] + (to[1] - from[1]) * k)
  const b = Math.round(from[2] + (to[2] - from[2]) * k)
  return (r << 16) | (g << 8) | b
}

/** FFD 偏移：从基准顶点画虚线到偏移后的位置，并画一个菱形手柄 */
function drawFfdOffsets(
  strokes: Graphics,
  fills: Graphics,
  skeleton: Skeleton,
  result: MeshBuildResult,
  w: number
): void {
  const handles: number[] = []
  for (let slotIndex = 0; slotIndex < skeleton.slotCount; slotIndex++) {
    const deform = skeleton.deformOffsets[slotIndex]
    const base = skeleton.deformOffsetBase[slotIndex]
    if (!deform || base < 0) continue

    for (let i = 0; i < result.vertexCount; i++) {
      if (result.sourceSlot[i] !== slotIndex) continue
      const vertexIndex = result.sourceVertex[i]
      const li = vertexIndex - base
      const idx = li * 2
      if (li < 0 || idx + 1 >= deform.length) continue
      const dx = deform[idx]
      const dy = deform[idx + 1]
      if (dx === 0 && dy === 0) continue
      const x = result.positions[i * 2]
      const y = result.positions[i * 2 + 1]
      strokes.moveTo(x - dx, y - dy).lineTo(x, y)
      handles.push(x, y)
    }
  }

  if (handles.length > 0) {
    strokes.stroke({ width: w, color: COLOR_FFD_BASE, alpha: 0.6 })
    const s = 4 * w
    for (let i = 0; i < handles.length; i += 2) {
      const x = handles[i]
      const y = handles[i + 1]
      fills.moveTo(x - s, y).lineTo(x, y + s).lineTo(x + s, y).lineTo(x, y - s).lineTo(x - s, y)
      fills.fill({ color: COLOR_FFD, alpha: 0.9 })
    }
  }
}

function fillPoints(
  g: Graphics,
  points: number[],
  radius: number,
  color: number,
  alpha: number
): void {
  if (points.length === 0) return
  for (let i = 0; i < points.length; i += 2) {
    // 自己画多边形：Pixi 的 circle 在缩放的容器里会变成明显的多边形
    g.poly(circlePolygon(points[i], points[i + 1], radius, DOT_SEGMENTS))
  }
  g.fill({ color, alpha })
}

import type { AuthoringAttachment, EditorDocument } from '@core/model/authoring'
import { MAT4_LENGTH, mul, trs } from '@core/math/matrix'
import { getActiveScene } from './activeScene'

/**
 * 层级树里双击节点时的「视口聚焦」。
 *
 * 各类节点的聚焦目标：
 * - **骨骼**：它自己的世界原点，框取骨骼长度的两倍（短骨骼设下限，免得缩放到极限）
 * - **display**：宿主骨骼世界矩阵 × 附件在文档里的 TRS —— 不用运行期矩阵，是因为
 *   点的那一行可能**不是**当前显示的那个附件（displayIndex 会在动画里切换）
 * - **插槽**：当前**真正显示**的附件世界矩阵（看的见什么就框什么），空插槽退回宿主骨骼
 * - **约束**：把它驱动的整条骨骼链（含 target）全部框进来 —— 约束没有自己的「位置」，
 *   它的意义就是这串骨骼
 *
 * 放在编辑器层而不是树组件里：插槽顺序面板等其它入口能复用，
 * 而且 `frameOf` 只依赖注入的 `FocusScene` 接口，脱离浏览器就能单测。
 */

/** 骨骼 / 约束聚焦框的下限（世界单位；1 单位 = 100px） */
const MIN_SPAN = 0.6
/** 拿不到尺寸时的默认框 */
const DEFAULT_SPAN = 1.6
/** 约束链两侧的余量系数（链长 × 该系数 = 框） */
const CONSTRAINT_PADDING = 1.4

export type FocusTarget =
  | { kind: 'bone'; name: string }
  | { kind: 'slot'; name: string }
  | { kind: 'display'; slot: string; name: string }
  | { kind: 'constraint'; name: string }

export interface FocusFrame {
  x: number
  y: number
  width: number
  height: number
}

/** 聚焦只需要场景的这两个查询，注入假实现即可单测 */
export interface FocusScene {
  /** 骨骼世界矩阵（4×4 列主序，平移在 [12] / [13]） */
  worldMatrixOf(boneName: string): Float32Array | null
  /** 插槽当前显示附件的世界矩阵；空插槽返回 null */
  attachmentWorldByName(slotName: string): Float32Array | null
}

function originOf(matrix: Float32Array | null | undefined): { x: number; y: number } | null {
  if (!matrix || matrix.length < MAT4_LENGTH) return null
  return { x: matrix[12], y: matrix[13] }
}

/** 某个插槽下所有皮肤里的附件（同名附件只取第一份声明，够用且稳定） */
function attachmentsOfSlot(doc: EditorDocument, slotName: string): AuthoringAttachment[] {
  const result: AuthoringAttachment[] = []
  for (const skin of doc.skins) {
    for (const skinSlot of skin.slots) {
      if (skinSlot.slot !== slotName) continue
      for (const attachment of skinSlot.attachments) {
        if (!result.some((item) => item.name === attachment.name)) result.push(attachment)
      }
    }
  }
  return result
}

/** 附件在文档里的显示尺寸（Mesh 顶点范围也能算，但顶点可能为空，故留兜底） */
function spanOfAttachment(attachment: AuthoringAttachment | undefined): { width: number; height: number } | null {
  if (!attachment) return null
  const size = attachment.size
  if (size && size.x > 1e-4 && size.y > 1e-4) return { width: size.x, height: size.y }
  const vertices = attachment.vertices
  if (vertices.length > 0) {
    let minX = Number.POSITIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    let maxX = Number.NEGATIVE_INFINITY
    let maxY = Number.NEGATIVE_INFINITY
    for (const vertex of vertices) {
      minX = Math.min(minX, vertex.x)
      minY = Math.min(minY, vertex.y)
      maxX = Math.max(maxX, vertex.x)
      maxY = Math.max(maxY, vertex.y)
    }
    const width = maxX - minX
    const height = maxY - minY
    if (width > 1e-4 && height > 1e-4) return { width, height }
  }
  return null
}

/** 算出某节点在世界里的聚焦框；取不到位置（场景无该骨骼 / 数据缺失）时返回 null */
export function frameOf(scene: FocusScene, doc: EditorDocument, target: FocusTarget): FocusFrame | null {
  if (target.kind === 'bone') {
    const origin = originOf(scene.worldMatrixOf(target.name))
    if (!origin) return null
    const bone = doc.bones.find((item) => item.name === target.name)
    const span = Math.max((bone?.length ?? 0) * 2, MIN_SPAN)
    return { x: origin.x, y: origin.y, width: span, height: span }
  }

  if (target.kind === 'constraint') {
    const constraint = doc.constraints.find((item) => item.name === target.name)
    if (!constraint) return null
    const names = [...constraint.bones, constraint.target]
    const points: Array<{ x: number; y: number }> = []
    for (const name of names) {
      const origin = originOf(scene.worldMatrixOf(name))
      if (origin) points.push(origin)
    }
    if (points.length === 0) return null
    const xs = points.map((point) => point.x)
    const ys = points.map((point) => point.y)
    const minX = Math.min(...xs)
    const maxX = Math.max(...xs)
    const minY = Math.min(...ys)
    const maxY = Math.max(...ys)
    return {
      x: (minX + maxX) / 2,
      y: (minY + maxY) / 2,
      width: Math.max((maxX - minX) * CONSTRAINT_PADDING, MIN_SPAN),
      height: Math.max((maxY - minY) * CONSTRAINT_PADDING, MIN_SPAN)
    }
  }

  const slotName = target.kind === 'slot' ? target.name : target.slot
  const slot = doc.slots.find((item) => item.name === slotName)
  const attachments = attachmentsOfSlot(doc, slotName)

  if (target.kind === 'display') {
    // 点的那一行可能不是当前显示的附件，所以按「宿主骨骼 × 附件 TRS」自己算
    const boneWorld = slot ? scene.worldMatrixOf(slot.bone) : null
    const attachment = attachments.find((item) => item.name === target.name)
    if (!boneWorld || !attachment) return null
    const local = trs(
      attachment.position.x,
      attachment.position.y,
      attachment.rotation,
      attachment.scale.x,
      attachment.scale.y
    )
    const origin = originOf(mul(boneWorld, local))
    if (!origin) return null
    const span = spanOfAttachment(attachment) ?? { width: DEFAULT_SPAN, height: DEFAULT_SPAN }
    return { x: origin.x, y: origin.y, width: span.width, height: span.height }
  }

  const origin =
    originOf(scene.attachmentWorldByName(slotName)) ?? originOf(slot ? scene.worldMatrixOf(slot.bone) : null)
  if (!origin) return null
  // 尺寸只是「框多大」：优先 setup 显示的附件，其次该插槽的第一个附件
  const shown = slot?.attachment ? attachments.find((item) => item.name === slot.attachment) : undefined
  const span = spanOfAttachment(shown ?? attachments[0]) ?? { width: DEFAULT_SPAN, height: DEFAULT_SPAN }
  return { x: origin.x, y: origin.y, width: span.width, height: span.height }
}

/** 双击节点聚焦视口；返回是否真的聚焦（场景未就绪 / 取不到位置时为 false） */
export function focusNode(doc: EditorDocument, target: FocusTarget): boolean {
  const scene = getActiveScene()
  if (!scene) return false
  const frame = frameOf(scene, doc, target)
  if (!frame) return false
  scene.frameContent(frame.x, frame.y, frame.width, frame.height)
  return true
}

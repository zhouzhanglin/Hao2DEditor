/**
 * 面板内拖拽协议（资源面板 → 视口 / 层级树）。
 *
 * 用自定义 MIME 而不是 text/plain：既能和「拖入文件导入」那条路径区分开
 * （内部拖拽时 dataTransfer.files 为空），也不会被浏览器当成普通文本
 * 塞进别的输入框。
 */
export const IMAGE_MIME = 'application/x-hao2d-image'

export function setImageDragData(transfer: DataTransfer, name: string): void {
  transfer.setData(IMAGE_MIME, name)
  transfer.effectAllowed = 'copy'
}

/** dragover 阶段读不到数据（浏览器限制），只能靠 types 判断这次拖的是不是图片 */
export function hasImageDrag(transfer: DataTransfer | null): boolean {
  if (!transfer) return false
  return Array.from(transfer.types).includes(IMAGE_MIME)
}

export function readImageDrag(transfer: DataTransfer): string {
  const value = transfer.getData(IMAGE_MIME)
  return typeof value === 'string' ? value : ''
}

/**
 * 层级树内部的树节点拖拽（骨骼 / 插槽 / display）。
 *
 * 与「资源面板拖图片」用不同的 MIME 分开：前者是移动已有节点、后者是新建，
 * 落到同一行上时按类型走不同分支。
 */
export const TREE_MIME = 'application/x-hao2d-tree'

export type TreeDragPayload =
  | { kind: 'bone'; name: string }
  | { kind: 'slot'; name: string }
  | { kind: 'display'; slot: string; name: string }

/** 放置位置：行内部（成为子节点）/ 行的上沿 / 下沿（同级排序） */
export type TreeDropPosition = 'inside' | 'above' | 'below'

export function setTreeDragData(transfer: DataTransfer, payload: TreeDragPayload): void {
  transfer.setData(TREE_MIME, JSON.stringify(payload))
  transfer.effectAllowed = 'move'
}

export function hasTreeDrag(transfer: DataTransfer | null): boolean {
  if (!transfer) return false
  return Array.from(transfer.types).includes(TREE_MIME)
}

export function readTreeDrag(transfer: DataTransfer): TreeDragPayload | null {
  const raw = transfer.getData(TREE_MIME)
  if (!raw) return null
  try {
    return JSON.parse(raw) as TreeDragPayload
  } catch {
    return null
  }
}

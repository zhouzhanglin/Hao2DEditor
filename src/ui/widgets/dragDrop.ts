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

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

/**
 * 自定义拖影：让拖影**严格以光标为中心**。
 *
 * 默认拖影是「整行元素的快照」，热点取决于按下时刻光标在行内的位置 ——
 * 用户按拖影中心对准目标松手时，实际落点（= 光标位置）会偏掉「快照中心到光标」那段距离，
 * 表现为「图片没落在我拖到的位置」。
 *
 * 这里自绘一张固定尺寸的 canvas（按短边裁成正方形 + 白框），并把热点设为几何中心：
 * 看到哪对准哪，落点就在哪。
 */
export function setDraggingImage(transfer: DataTransfer, source: HTMLImageElement | null): void {
  const SIZE = 32
  const canvas = document.createElement('canvas')
  canvas.width = SIZE
  canvas.height = SIZE
  const ctx = canvas.getContext('2d')
  if (ctx) {
    ctx.globalAlpha = 0.92
    if (source && source.naturalWidth > 0 && source.naturalHeight > 0) {
      const side = Math.min(source.naturalWidth, source.naturalHeight)
      ctx.drawImage(
        source,
        (source.naturalWidth - side) / 2,
        (source.naturalHeight - side) / 2,
        side,
        side,
        0,
        0,
        SIZE,
        SIZE
      )
    } else {
      ctx.fillStyle = '#3b82f6'
      ctx.beginPath()
      ctx.arc(SIZE / 2, SIZE / 2, 10, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalAlpha = 1
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)'
    ctx.lineWidth = 2
    ctx.strokeRect(1, 1, SIZE - 2, SIZE - 2)
  }

  // 规范要求 drag image 的元素已在文档中渲染：临时挂到屏幕外，拖拽结束摘掉
  canvas.style.position = 'fixed'
  canvas.style.left = '-1000px'
  canvas.style.top = '-1000px'
  document.body.appendChild(canvas)
  try {
    transfer.setDragImage(canvas, SIZE / 2, SIZE / 2)
  } catch {
    // 少数环境不支持自定义拖影时退回默认行为
    canvas.remove()
    return
  }
  const cleanup = (): void => canvas.remove()
  window.addEventListener('dragend', cleanup, { once: true })
  // 兜底：异常路径（拖拽被取消且没派发 dragend）下避免节点残留
  window.setTimeout(() => window.removeEventListener('dragend', cleanup), 30000)
  window.setTimeout(cleanup, 30000)
}

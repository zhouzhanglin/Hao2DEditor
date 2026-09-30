/**
 * 面板内拖拽协议（资源面板 → 视口 / 层级树）。
 *
 * 用自定义 MIME 而不是 text/plain：既能和「从系统拖入文件」区分开
 * （内部拖拽时 dataTransfer.files 为空），也不会被浏览器当成普通文本
 * 塞进别的输入框。
 */
export const IMAGE_MIME = 'application/x-hao2d-image'

/**
 * 写入拖拽数据：资源面板里**多选**后可以一次拖多张，所以内容是 JSON 数组
 * （单张也走数组，读取端统一按列表处理）。
 */
export function setImageDragData(transfer: DataTransfer, names: string | readonly string[]): void {
  const list = (typeof names === 'string' ? [names] : names).filter((name) => name.length > 0)
  if (list.length === 0) return
  transfer.setData(IMAGE_MIME, JSON.stringify(list))
  transfer.effectAllowed = 'copy'
}

/** dragover 阶段读不到数据（浏览器限制），只能靠 types 判断这次拖的是不是图片 */
export function hasImageDrag(transfer: DataTransfer | null): boolean {
  if (!transfer) return false
  return Array.from(transfer.types).includes(IMAGE_MIME)
}

/**
 * 从系统拖入的文件（Electron / 浏览器）。dragover 阶段就能从 types 认出来，
 * 用它和内部拖拽区分开：内部拖拽（图片 / 树节点）不会带 `Files`。
 */
export function hasExternalFiles(transfer: DataTransfer | null): boolean {
  if (!transfer) return false
  return Array.from(transfer.types).includes('Files')
}

/** 读取拖拽的图片名列表（顺序 = 资源面板里的选择顺序）；空数组表示没读到 */
export function readImageDrag(transfer: DataTransfer): string[] {
  const raw = transfer.getData(IMAGE_MIME)
  if (typeof raw !== 'string' || raw.length === 0) return []
  if (raw.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is string => typeof item === 'string' && item.length > 0)
      }
    } catch {
      // 解析失败时按下面的单个名字处理
    }
  }
  // 兼容早期的「裸图片名」格式
  return [raw]
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
 *
 * `count > 1`（多选成组拖动）时右下角带数量角标，拖的时候就知道带了几张。
 */
export function setDraggingImage(
  transfer: DataTransfer,
  source: HTMLImageElement | null,
  count = 1
): void {
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

    if (count > 1) {
      const label = count > 99 ? '99+' : String(count)
      ctx.font = 'bold 9px system-ui, sans-serif'
      const badgeW = Math.max(14, ctx.measureText(label).width + 7)
      const x = SIZE - badgeW + 1
      const y = SIZE - 13
      ctx.beginPath()
      // roundRect 在少数老环境缺失，退回直角
      if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, badgeW, 12, 6)
      else ctx.rect(x, y, badgeW, 12)
      ctx.fillStyle = '#3b82f6'
      ctx.fill()
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)'
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.fillStyle = '#ffffff'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(label, x + badgeW / 2, y + 6.5)
    }
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

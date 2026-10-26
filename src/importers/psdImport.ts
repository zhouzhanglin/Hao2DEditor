import { readPsd } from 'ag-psd'
import type { Layer } from 'ag-psd'
import { t } from '@i18n'

/**
 * PSD 导入的**解析层**（不碰工程 / 文件系统）：把 PSD 二进制解成「图层树 + 每层的像素画布」。
 *
 * - `children[0]` 是 Photoshop 图层面板里**最上层**的图层（ag-psd 解析时逐个 unshift，与面板一致）
 * - 只有带像素的图层有 `canvas`（编组 / 文本 / 调整层没有），弹窗里标「无像素」且不可勾选
 * - 文本图层不会被栅格化（ag-psd 不渲染文字），导入后是空的 —— 一并按「无像素」处理
 */

/** 弹窗展示用的图层节点（与 ag-psd 的 Layer 解耦，可安全放进 React 状态） */
export interface PsdLayerNode {
  /** 稳定 id：在图层树里的路径（"0.2.1"），勾选集合用它当键 */
  id: string
  name: string
  /** 树深度（0 = 顶层），弹窗按它缩进 */
  depth: number
  /** 编组（文件夹）：本身没有像素，勾选它 = 全选/全不选里面的图层 */
  isGroup: boolean
  /** 在 PSD 里的可见性（只用于弹窗标记，不阻止导入） */
  hidden: boolean
  /** 有像素可导出（编组与文本 / 调整层为 false） */
  hasPixels: boolean
  /** 图层在 PSD 画布上的包围盒（像素，PSD 坐标系 y 向下） */
  left: number
  top: number
  width: number
  height: number
  children: PsdLayerNode[]
}

export interface ParsedPsd {
  /** 文件名（不含目录），弹窗标题用 */
  fileName: string
  /** PSD 画布尺寸（像素） */
  width: number
  height: number
  /** 图层树（ag-psd 语义：children[0] = 面板最底层 / 最先绘制，最后一个 = 面板最上层） */
  root: PsdLayerNode[]
  /** 有像素的图层 id → 原始 Layer（拿 `canvas` 导出 PNG 用） */
  layers: Map<string, Layer>
  /** 有像素的图层总数 */
  pixelCount: number
}

/** 解析 PSD：失败（损坏 / 不是 PSD）抛错，由调用方提示 */
export function parsePsd(buffer: ArrayBuffer | Uint8Array, fileName: string): ParsedPsd {
  // 合成图与缩略图都不要：我们只要图层树与每层的 canvas，省内存也快
  const psd = readPsd(buffer, { skipCompositeImageData: true, skipThumbnail: true })
  const layers = new Map<string, Layer>()
  let pixelCount = 0

  const walk = (children: readonly Layer[], depth: number, prefix: string): PsdLayerNode[] => {
    const nodes: PsdLayerNode[] = []
    children.forEach((layer, index) => {
      const id = prefix ? `${prefix}.${index}` : String(index)
      const isGroup = Array.isArray(layer.children)
      const left = layer.left ?? 0
      const top = layer.top ?? 0
      const width = Math.max(0, (layer.right ?? left) - left)
      const height = Math.max(0, (layer.bottom ?? top) - top)
      const hasPixels = !isGroup && !!layer.canvas && width > 0 && height > 0
      if (hasPixels) {
        layers.set(id, layer)
        pixelCount++
      }
      nodes.push({
        id,
        name: layer.name || (isGroup ? t('编组') : t('图层')),
        depth,
        isGroup,
        hidden: !!layer.hidden,
        hasPixels,
        left,
        top,
        width,
        height,
        children: isGroup ? walk(layer.children ?? [], depth + 1, id) : []
      })
    })
    return nodes
  }

  const root = walk(psd.children ?? [], 0, '')
  return { fileName, width: psd.width, height: psd.height, root, layers, pixelCount }
}

/**
 * 收集勾选的**有像素**图层，按**从后到前**（back-to-front）的绘制顺序输出。
 *
 * ag-psd 的 `children[0]` 是 Photoshop 面板**最底层**（最先绘制）的图层，最后一个才是最上层
 * —— 依据：PSD 文件的层记录按面板自底向上存储（编组头记录必须出现在成员之后，
 * 读取端的分组栈才能工作），而 children 恰好保持文件记录顺序。编辑器里后追加的插槽
 * zOrder 更大、画在上面（见 compile.toSlotData），所以**正序**遍历收集、正序追加，
 * 叠放次序与 PSD 一致。
 *
 * （早先误以为 children[0] 是最上层还做了反转，导入出来的层级正好颠倒。）
 */
export function collectSelectedLayers(
  root: readonly PsdLayerNode[],
  selected: ReadonlySet<string>
): PsdLayerNode[] {
  const out: PsdLayerNode[] = []
  const walk = (nodes: readonly PsdLayerNode[]): void => {
    for (const node of nodes) {
      if (!node.isGroup && node.hasPixels && selected.has(node.id)) out.push(node)
      walk(node.children)
    }
  }
  walk(root)
  return out
}

/** 弹窗展示用：把树反转成 Photoshop 面板顺序（最上层在前），浅拷贝不改动原节点 */
export function toPanelOrder(nodes: readonly PsdLayerNode[]): PsdLayerNode[] {
  return [...nodes]
    .reverse()
    .map((node) => (node.children.length > 0 ? { ...node, children: toPanelOrder(node.children) } : node))
}

/** 图层 canvas → PNG 字节（写进工程 images/ 用） */
export async function layerPngBytes(layer: Layer): Promise<Uint8Array> {
  const canvas = layer.canvas
  if (!canvas) throw new Error(t('图层「{0}」没有像素数据', layer.name || t('未命名')))
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error(t('图层「{0}」导出 PNG 失败', layer.name || t('未命名')))
  return new Uint8Array(await blob.arrayBuffer())
}

/** 图层名 → 合法文件名：去掉文件系统非法字符与首尾空白 / 点，空了兜底成 layer */
export function sanitizeLayerName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .trim()
  return cleaned.length > 0 ? cleaned : 'layer'
}

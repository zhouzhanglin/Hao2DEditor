import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { EyeOff, Folder, Image as ImageIcon, Layers, X } from 'lucide-react'
import { toPanelOrder } from '@importers/psdImport'
import type { PsdLayerNode, ParsedPsd } from '@importers/psdImport'
import { useDialogDrag } from './dialogDrag'

export interface PsdImportDialogProps {
  parsed: ParsedPsd
  /** 确认导入：ids = 勾选的图层 id；addToScene = 是否按 PSD 位置直接添加到场景 */
  onConfirm: (selectedIds: ReadonlySet<string>, addToScene: boolean) => void
  onClose: () => void
}

/** 收集整棵树的全部节点 id（编组也算：它承担「全选子层」的开关） */
function allIds(nodes: readonly PsdLayerNode[], into: Set<string>): Set<string> {
  for (const node of nodes) {
    into.add(node.id)
    allIds(node.children, into)
  }
  return into
}

/** 某节点子树下「带像素的叶子」 */
function pixelLeaves(node: PsdLayerNode): PsdLayerNode[] {
  if (node.isGroup) return node.children.flatMap((child) => pixelLeaves(child))
  return node.hasPixels ? [node] : []
}

/**
 * 「导入 PSD」弹窗：与 ConfirmDialog / ExportDialog 同一套工具风格
 *（portal 到 body、z-[900] 遮罩、30px 标题栏 + 页脚按钮）。
 *
 * - 图层树全部列出、**默认全选**；编组行的勾选框 = 全选 / 全不选它的子图层
 * - 没有像素的图层（文本 / 调整层）置灰不可选 —— 导不出图片
 * - 页脚的「按 PSD 位置直接添加到场景」决定导入后要不要自动生成插槽
 * - Esc = 取消；弹窗内按键不冒泡（别触发视口的全局快捷键）
 */
export default function PsdImportDialog({ parsed, onConfirm, onClose }: PsdImportDialogProps) {
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => allIds(parsed.root, new Set()))
  const [addToScene, setAddToScene] = useState(true)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const confirmRef = useRef<HTMLButtonElement | null>(null)
  /** 标题栏拖动弹窗（见 dialogDrag） */
  const { panelStyle, handleProps } = useDialogDrag()
  // 展示用反转成 Photoshop 面板顺序（最上层在前）；勾选集合用的是节点 id，与展示顺序无关
  const displayRoot = useMemo(() => toPanelOrder(parsed.root), [parsed])

  useEffect(() => {
    confirmRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
        return
      }
      if (rootRef.current?.contains(event.target as Node)) event.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  /** 勾选数量只统计带像素的图层（编组 / 无像素层不算） */
  const selectedCount = useMemo(() => {
    let count = 0
    const walk = (nodes: readonly PsdLayerNode[]): void => {
      for (const node of nodes) {
        if (node.isGroup) walk(node.children)
        else if (node.hasPixels && checked.has(node.id)) count++
      }
    }
    walk(parsed.root)
    return count
  }, [parsed, checked])

  const toggle = (node: PsdLayerNode): void => {
    const targets = node.isGroup ? pixelLeaves(node) : node.hasPixels ? [node] : []
    if (targets.length === 0) return
    // 全选中 → 全不选；否则 → 全选（点编组时对「部分选中」的组是补齐，符合直觉）
    const allOn = targets.every((item) => checked.has(item.id))
    const next = new Set(checked)
    for (const item of targets) {
      if (allOn) next.delete(item.id)
      else next.add(item.id)
    }
    setChecked(next)
  }

  const renderNode = (node: PsdLayerNode): React.ReactNode => {
    const pixelTargets = node.isGroup ? pixelLeaves(node) : node.hasPixels ? [node] : []
    const allOn = pixelTargets.length > 0 && pixelTargets.every((item) => checked.has(item.id))
    return (
      <div key={node.id}>
        <label
          className={[
            'flex h-[22px] cursor-pointer items-center gap-1.5 rounded px-1 text-3xs select-none hover:bg-ink-700/70',
            pixelTargets.length === 0 ? 'cursor-not-allowed opacity-45 hover:bg-transparent' : ''
          ].join(' ')}
          style={{ paddingLeft: 4 + node.depth * 14 }}
          onClick={(event) => {
            // label 里自带 checkbox，这里拦下文字区域点击统一走 toggle（避免双触发）
            event.preventDefault()
            toggle(node)
          }}
        >
          <input
            type="checkbox"
            className="h-3 w-3 shrink-0 accent-accent"
            checked={allOn}
            disabled={pixelTargets.length === 0}
            onChange={() => toggle(node)}
            onClick={(event) => event.stopPropagation()}
          />
          {node.isGroup ? (
            <Folder size={11} className="shrink-0 text-content-lo" />
          ) : node.hasPixels ? (
            <ImageIcon size={11} className="shrink-0 text-content-lo" />
          ) : (
            <span className="h-[11px] w-[11px] shrink-0" />
          )}
          <span className={['min-w-0 flex-1 truncate', node.isGroup ? 'font-semibold text-content-mid' : 'text-content-mid'].join(' ')}>
            {node.name}
          </span>
          {node.hidden ? <EyeOff size={10} className="shrink-0 text-warn/80" title="在 PSD 中隐藏" /> : null}
          <span className="shrink-0 font-mono text-content-lo/80">
            {node.isGroup ? '组' : node.hasPixels ? `${node.width}×${node.height}` : '无像素'}
          </span>
        </label>
        {node.children.map((child) => renderNode(child))}
      </div>
    )
  }

  return createPortal(
    <div className="fixed inset-0 z-[900] flex items-center justify-center bg-black/55">
      <div
        ref={rootRef}
        className="flex w-[480px] max-w-[94vw] flex-col rounded border border-line bg-ink-800 shadow-2xl shadow-black/60"
        style={panelStyle}
      >
        <div className="flex h-[30px] shrink-0 items-center gap-2 border-b border-line bg-ink-700 px-2.5" {...handleProps}>
          <Layers size={13} className="text-accent" />
          <span className="text-panel font-semibold text-content-hi">导入 PSD</span>
          <span className="truncate text-3xs text-content-lo" title={parsed.fileName}>
            {parsed.fileName} · {parsed.width}×{parsed.height}
          </span>
          <button type="button" title="关闭（Esc）" className="hao-tool-button ml-auto" onClick={onClose}>
            <X size={13} />
          </button>
        </div>

        <div className="flex flex-col gap-1.5 px-2.5 py-2">
          <div className="flex items-center justify-between text-3xs text-content-lo">
            <span>图层（勾选要导入的层，编组可整组勾选）</span>
            <span className="font-mono">
              已选 {selectedCount} / {parsed.pixelCount} 层
            </span>
          </div>
          <div className="hao-scroll max-h-[300px] min-h-[80px] overflow-auto rounded border border-line/60 bg-ink-900/40 p-1">
            {displayRoot.map((node) => renderNode(node))}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2 border-t border-line bg-ink-700/60 px-2.5 py-2">
          <label className="mr-auto flex cursor-pointer items-center gap-1.5 text-3xs text-content-mid select-none">
            <input
              type="checkbox"
              className="h-3 w-3 accent-accent"
              checked={addToScene}
              onChange={(event) => setAddToScene(event.target.checked)}
            />
            按 PSD 位置直接添加到场景
          </label>
          <button type="button" className="hao-btn" onClick={onClose}>
            取消
          </button>
          <button
            ref={confirmRef}
            type="button"
            className="hao-btn hao-btn-accent"
            disabled={selectedCount === 0}
            onClick={() => onConfirm(checked, addToScene)}
          >
            导入
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

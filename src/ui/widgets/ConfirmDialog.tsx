import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { LucideIcon } from 'lucide-react'
import { X } from 'lucide-react'
import { useDialogDrag } from './dialogDrag'

export interface ConfirmDialogProps {
  title: string
  /** 标题左侧的小图标（一般用触发这个弹窗的工具图标） */
  icon?: LucideIcon
  /** 正文：这次操作会做什么、代价是什么（多段用 `\n\n` 分隔，按原样换行） */
  message: ReactNode
  /** 明细（可选）：具体到「这次会丢多少」的补充信息，装在一个小框里 */
  details?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  /** 页脚左侧的提示文案（可选），例如「可撤销」这类补充说明 */
  hint?: ReactNode
  /** 破坏性操作：确定按钮改成红色描边（与检查器里的删除按钮同一套，见 index.css） */
  danger?: boolean
  onConfirm: () => void
  onClose: () => void
}

/**
 * 通用**确认弹窗**：做法与 `NewProjectDialog` / `SettingsDialog` 完全一致
 *（portal 到 body、`z-[900]` 遮罩、30px 标题栏 + 页脚按钮），只是内容全由调用方给。
 *
 * 为什么不用 `window.confirm`：系统弹窗没法带样式，也塞不下明细（例如「将删除 42 个网格点」）；
 * 这里与「新建工程 / 导出」长成同一个样子。**要拦住的按键与主界面一致**：Esc = 取消，
 * 弹窗内的按键不冒泡出去（否则会触发视口的全局快捷键）。
 */
export default function ConfirmDialog({
  title,
  icon: Icon,
  message,
  details,
  confirmLabel = '确定',
  cancelLabel = '取消',
  hint,
  danger = false,
  onConfirm,
  onClose
}: ConfirmDialogProps) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const confirmRef = useRef<HTMLButtonElement | null>(null)
  /** 标题栏拖动弹窗（见 dialogDrag） */
  const { panelStyle, handleProps } = useDialogDrag()

  // 默认焦点落在「确定」上：Enter 即确认（与系统确认框的习惯一致）
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

  return createPortal(
    <div className="fixed inset-0 z-[900] flex items-center justify-center bg-black/55">
      <div
        ref={rootRef}
        className="flex w-[420px] max-w-[94vw] flex-col rounded border border-line bg-ink-800 shadow-2xl shadow-black/60"
        style={panelStyle}
      >
        <div className="flex h-[30px] shrink-0 items-center gap-2 border-b border-line bg-ink-700 px-2.5" {...handleProps}>
          {Icon ? <Icon size={13} className="text-accent" /> : null}
          <span className="text-panel font-semibold text-content-hi">{title}</span>
          <button type="button" title="关闭（Esc）" className="hao-tool-button ml-auto" onClick={onClose}>
            <X size={13} />
          </button>
        </div>

        <div className="flex flex-col gap-2 px-2.5 py-2.5">
          <p className="whitespace-pre-line text-panel leading-[18px] text-content-mid">{message}</p>
          {details ? (
            <div className="flex flex-col gap-0.5 rounded border border-line/60 bg-ink-900/40 px-2 py-1.5 text-3xs leading-[16px] text-content-lo">
              {details}
            </div>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-2 border-t border-line bg-ink-700/60 px-2.5 py-2">
          <span className="hao-label mr-auto">{hint}</span>
          <button type="button" className="hao-btn" onClick={onClose}>
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={
              danger
                ? 'hao-btn border-danger/40 text-danger/90 hover:border-danger hover:bg-danger/10'
                : 'hao-btn hao-btn-accent'
            }
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

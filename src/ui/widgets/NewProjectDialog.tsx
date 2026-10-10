import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { FilePlus2, FolderOpen, Loader2, X } from 'lucide-react'
import { getPlatform, joinPath } from '@editor/platform'
import { DEFAULT_PROJECT_NAME } from '@editor/store/projectStore'
import { PROJECT_EXTENSION } from '@core/codec/projectJson'

export interface NewProjectDialogProps {
  onClose: () => void
  /** 确认：项目名（非空）+ 保存位置（目录） */
  onConfirm: (name: string, dir: string) => Promise<void> | void
}

/**
 * 「新建项目」弹窗：填**项目名** + 选**保存位置**，两个都不能空。
 *
 * 项目名会直接当文件名用（`<目录>/<项目名>.hao2d.proj`），也是导出的图集名与输出目录名；
 * 与骨架名无关（一个项目里可以有多个骨架）。
 */
export default function NewProjectDialog({ onClose, onConfirm }: NewProjectDialogProps) {
  /** 预填默认项目名（`hao2dProject`）：直接输入即替换，不改也可以直接建 */
  const [name, setName] = useState(DEFAULT_PROJECT_NAME)
  const [dir, setDir] = useState('')
  const [busy, setBusy] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  /** Esc 关闭；弹窗内的按键不冒泡出去（否则会触发视口 / 工具的全局快捷键） */
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

  const trimmed = name.trim()
  const ready = trimmed.length > 0 && dir.length > 0 && !busy
  /** 预览最终文件路径（非法字符替换成下划线，与落盘时一致） */
  const filePath = dir.length > 0 && trimmed.length > 0 ? joinPath(dir, `${trimmed.replace(/[\\/:*?"<>|]/g, '_')}.${PROJECT_EXTENSION}`) : ''

  const pickDir = async (): Promise<void> => {
    const picked = await getPlatform().pickFiles({
      directory: true,
      multi: false,
      title: '选择项目的保存位置（会在里面建一个 <项目名>.hao2d.proj）'
    })
    const next = picked[0]
    if (!next) return
    setDir(next)
  }

  const confirm = async (): Promise<void> => {
    if (!ready) return
    setBusy(true)
    try {
      await onConfirm(trimmed, dir)
    } finally {
      setBusy(false)
      onClose()
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[900] flex items-center justify-center bg-black/55">
      <div
        ref={rootRef}
        className="flex w-[460px] max-w-[94vw] flex-col rounded border border-line bg-ink-800 shadow-2xl shadow-black/60"
      >
        <div className="flex h-[30px] shrink-0 items-center gap-2 border-b border-line bg-ink-700 px-2.5">
          <FilePlus2 size={13} className="text-accent" />
          <span className="text-panel font-semibold text-content-hi">新建项目</span>
          <button type="button" title="关闭（Esc）" className="hao-tool-button ml-auto" onClick={onClose}>
            <X size={13} />
          </button>
        </div>

        <div className="flex flex-col gap-2 px-2.5 py-2.5">
          <div className="flex items-center gap-2">
            <span className="hao-label w-[54px] shrink-0">项目名</span>
            <input
              ref={inputRef}
              value={name}
              placeholder="必填，例如 dragon"
              className="hao-field min-w-0 flex-1 text-panel text-content-hi"
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void confirm()
              }}
            />
          </div>

          <div className="flex items-center gap-2">
            <span className="hao-label w-[54px] shrink-0">保存位置</span>
            <div className="hao-field min-w-0 flex-1 truncate text-content-mid" title={dir || '尚未选择'}>
              {dir || '尚未选择（点右侧按钮选一个目录）'}
            </div>
            <button type="button" className="hao-btn shrink-0" onClick={() => void pickDir()}>
              <FolderOpen size={12} /> 选择…
            </button>
          </div>

          <div className="hao-label leading-[16px]">
            项目文件：<span className="text-content-mid">{filePath || '（填项目名并选好目录后显示）'}</span>
          </div>
          <div className="hao-label leading-[16px] text-content-lo">
            项目名也是导出时的图集名与输出目录名；骨架名在骨架那一栏单独改。
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2 border-t border-line bg-ink-700/60 px-2.5 py-2">
          <span className="hao-label mr-auto">
            {trimmed.length === 0 ? '项目名不能为空' : dir.length === 0 ? '请选择保存位置' : ''}
          </span>
          <button type="button" className="hao-btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            type="button"
            className="hao-btn hao-btn-accent"
            disabled={!ready}
            title={ready ? '创建项目并立刻写出工程文件' : '项目名与保存位置都不能为空'}
            onClick={() => void confirm()}
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : null}
            {busy ? '正在创建…' : '创建'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

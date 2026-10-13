import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useSettingsStore } from '@editor/store/settingsStore'

export interface SettingsDialogProps {
  onClose: () => void
}

/**
 * 软件级全局设置（与工程无关，跨「新建 / 打开 / 导入」一直保留，落盘在 localStorage）。
 *
 * 目前只有一项：Spine 导出时图集文件名追加 `.txt`。以后加全局开关直接往这里堆即可。
 */
export default function SettingsDialog({ onClose }: SettingsDialogProps) {
  const spineAtlasTxt = useSettingsStore((s) => s.spineAtlasTxt)
  const setSpineAtlasTxt = useSettingsStore((s) => s.setSpineAtlasTxt)
  const rootRef = useRef<HTMLDivElement | null>(null)

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
        className="flex h-auto w-[420px] flex-col rounded-[6px] border border-line bg-ink-800 shadow-2xl"
      >
        <div className="flex h-[28px] shrink-0 items-center justify-between border-b border-line px-3">
          <span className="hao-panel-title">全局设置</span>
          <button
            type="button"
            className="text-content-lo hover:text-content-hi"
            title="关闭"
            onClick={onClose}
          >
            <X size={14} />
          </button>
        </div>

        <div className="flex flex-col gap-3 px-4 py-4">
          {/* Spine 导出：图集名追加 .txt */}
          <label
            className="flex cursor-pointer items-start gap-2 rounded-[4px] border border-line/60 px-2.5 py-2 hover:bg-ink-700"
            title="在 atlas 文件名后追加 .txt，写成 xxx.atlas.txt（Spine 编辑器默认导出的形态，spine-unity 也认）"
          >
            <input
              type="checkbox"
              className="mt-[2px] h-[13px] w-[13px] accent-cyan-400"
              checked={spineAtlasTxt}
              onChange={(event) => setSpineAtlasTxt(event.target.checked)}
            />
            <span className="flex flex-col gap-0.5">
              <span className="text-xs text-content-hi">Spine 导出：atlas 名追加 .txt</span>
              <span className="text-3xs leading-[15px] text-content-lo">
                勾选后所有 Spine 导出都写成 <span className="text-content-mid">xxx.atlas.txt</span>（全局生效，跨工程保留）
              </span>
            </span>
          </label>
        </div>

        <div className="flex h-[40px] shrink-0 items-center justify-end border-t border-line px-4">
          <button type="button" className="hao-btn h-[24px] px-3 text-3xs" onClick={onClose}>
            完成
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

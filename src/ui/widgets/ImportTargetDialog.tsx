import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { FolderPlus, Layers, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ImportTarget } from '@editor/services/projectIo'
import { useDialogDrag } from './dialogDrag'
import { t } from '@i18n'

export interface ImportTargetDialogProps {
  /** 正在导入的资源类型（`Spine` / `DragonBones`），只用于文案 */
  kind: string
  /** 当前工程有未保存的改动：选「新建工程」会整份替换，这里要把代价说出来 */
  dirty?: boolean
  onChoose: (target: ImportTarget) => void
  onClose: () => void
}

/** 两个选项的图标 / 文案（随语言切换，故做成函数而非模块级常量表） */
function options(): Array<{ id: ImportTarget; icon: LucideIcon; title: string; hint: string }> {
  return [
    {
      id: 'newProject',
      icon: FolderPlus,
      title: t('创建新工程'),
      hint: t('用导入的资源替换当前工程，适合把一个 Spine / DragonBones 资源单独做成工程')
    },
    {
      id: 'currentProject',
      icon: Layers,
      title: t('导入当前工程'),
      hint: t('把导入的骨架加进当前工程，成为工程里的新骨架；图片池共享，可在顶部骨架栏切换')
    }
  ]
}

/**
 * 「导入到哪儿」确认弹窗：把 `importSpineFlow` / `importDragonBonesFlow` 的落点选择交回用户。
 *
 * 与 `NewProjectDialog` 同一套外壳（portal 到 body、`z-[900]` 遮罩、30px 标题栏可拖动、Esc 取消、
 * 弹窗内按键不冒泡到视口的全局快捷键），只是内容换成一个二选一。
 *
 * 选择只是**告诉服务层怎么做**：确认后弹窗自己关闭，真正的导入由调用方跑（进度 / 结果走状态栏）。
 */
export default function ImportTargetDialog({ kind, dirty = false, onChoose, onClose }: ImportTargetDialogProps) {
  const [target, setTarget] = useState<ImportTarget>('newProject')
  const rootRef = useRef<HTMLDivElement | null>(null)
  const confirmRef = useRef<HTMLButtonElement | null>(null)
  /** 标题栏拖动弹窗（见 dialogDrag） */
  const { panelStyle, handleProps } = useDialogDrag()

  useEffect(() => {
    confirmRef.current?.focus()
  }, [])

  // Esc 关闭；弹窗内的按键不冒泡出去（否则会触发视口 / 工具的全局快捷键）
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

  const items = options()

  return createPortal(
    <div className="fixed inset-0 z-[900] flex items-center justify-center bg-black/55">
      <div
        ref={rootRef}
        className="flex w-[460px] max-w-[94vw] flex-col rounded border border-line bg-ink-800 shadow-2xl shadow-black/60"
        style={panelStyle}
      >
        <div
          className="flex h-[30px] shrink-0 items-center gap-2 border-b border-line bg-ink-700 px-2.5"
          {...handleProps}
        >
          <Layers size={13} className="text-accent" />
          <span className="text-panel font-semibold text-content-hi">{t('导入 {0}', kind)}</span>
          <button type="button" title={t('关闭（Esc）')} className="hao-tool-button ml-auto" onClick={onClose}>
            <X size={13} />
          </button>
        </div>

        <div className="flex flex-col gap-2 px-2.5 py-2.5">
          <p className="text-panel leading-[18px] text-content-mid">
            {t('请选择这份资源要导入到哪里：')}
          </p>

          <div className="flex flex-col gap-1">
            {items.map(({ id, icon: Icon, title, hint }) => {
              const active = target === id
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setTarget(id)}
                  className={[
                    'flex w-full items-start gap-2 rounded border px-2 py-1.5 text-left transition-colors duration-panel cursor-pointer',
                    active
                      ? 'border-accent/70 bg-accent/10'
                      : 'border-line bg-ink-900/40 hover:border-line hover:bg-ink-900/70'
                  ].join(' ')}
                >
                  <Icon size={14} className={active ? 'mt-0.5 shrink-0 text-accent' : 'mt-0.5 shrink-0 text-content-lo'} />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className={active ? 'text-panel font-semibold text-content-hi' : 'text-panel text-content-mid'}>
                      {title}
                    </span>
                    <span className="text-3xs leading-[15px] text-content-lo">{hint}</span>
                  </span>
                </button>
              )
            })}
          </div>

          {dirty && target === 'newProject' ? (
            <div className="rounded border border-danger/30 bg-danger/5 px-2 py-1.5 text-3xs leading-[16px] text-danger/90">
              {t('当前工程有未保存的改动：创建新工程会整份替换当前文档，这些改动不会保留。')}
            </div>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-2 border-t border-line bg-ink-700/60 px-2.5 py-2">
          <span className="hao-label mr-auto">{t('导入后仍可 Ctrl+Z 撤销')}</span>
          <button type="button" className="hao-btn" onClick={onClose}>
            {t('取消')}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className="hao-btn hao-btn-accent"
            onClick={() => onChoose(target)}
          >
            {t('导入')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

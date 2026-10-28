import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link2, X } from 'lucide-react'
import { useProjectStore } from '@editor/store/projectStore'
import { createLinkedMesh, setLinkedMeshSource } from '@editor/commands/authoringCommands'
import { SelectField, TextField } from './fields'
import { useDialogDrag } from './dialogDrag'
import { t } from '@i18n'

export interface LinkedMeshDialogProps {
  /** 在哪个插槽里创建（源网格也必须来自同一插槽） */
  slot: string
  /** 目标皮肤（空 = 默认皮肤） */
  skin: string
  /** 预填源网格：从某条 display 派生时用它 */
  defaultSource?: string
  /** 改源模式：编辑已有链接网格的源（此时不新建、不改图片） */
  editing?: { attachment: string; sourceSkin: string; source: string }
  onStatus: (text: string) => void
  onClose: () => void
}

/**
 * 「新建 / 修改链接网格」弹窗。
 *
 * 与 `ImportTargetDialog` 同一套外壳（portal 到 body、`z-[900]` 遮罩、30px 标题栏可拖动、
 * Esc 取消、弹窗内按键不冒泡到视口的全局快捷键），只是内容换成「源皮肤 / 源网格 / 图片 / 附件名」。
 *
 * 链接网格自己不存几何：顶点 / 三角面 / 权重永远跟随源网格，这里只决定贴图与 UV。
 */
export default function LinkedMeshDialog({
  slot,
  skin,
  defaultSource,
  editing,
  onStatus,
  onClose
}: LinkedMeshDialogProps) {
  const doc = useProjectStore((state) => state.document)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const confirmRef = useRef<HTMLButtonElement | null>(null)
  const { panelStyle, handleProps } = useDialogDrag()

  const defaultSkin = useMemo(() => {
    const named = doc.skins.find((item) => item.name === 'default')
    return named?.name ?? doc.skins[0]?.name ?? ''
  }, [doc.skins])

  /** 源皮肤下拉：默认皮肤排第一（链接源绝大多数就是默认皮肤里的网格） */
  const skinOptions = useMemo(() => {
    const others = doc.skins
      .filter((item) => item.name !== defaultSkin)
      .map((item) => ({ value: item.name, label: item.name }))
    const base = defaultSkin ? [{ value: defaultSkin, label: t('默认皮肤（{0}）', defaultSkin) }] : []
    return [...base, ...others]
  }, [doc.skins, defaultSkin])

  const [sourceSkin, setSourceSkin] = useState(
    () => editing?.sourceSkin || defaultSkin || doc.skins[0]?.name || ''
  )

  /** 源皮肤里、同一个插槽下的网格附件（链接的几何只能来自 Mesh） */
  const sourceMeshes = useMemo(() => {
    const skinSlot = doc.skins.find((item) => item.name === sourceSkin)?.slots.find((item) => item.slot === slot)
    return (skinSlot?.attachments ?? []).filter((item) => item.type === 'mesh')
  }, [doc.skins, sourceSkin, slot])

  const [source, setSource] = useState(() => {
    const wanted = editing?.source ?? defaultSource ?? ''
    return sourceMeshes.some((item) => item.name === wanted) ? wanted : sourceMeshes[0]?.name ?? ''
  })
  const [image, setImage] = useState('')
  const [name, setName] = useState(() => editing?.attachment ?? '')
  const [error, setError] = useState('')

  // 换源皮肤后原来的源不在列表里了：落到该皮肤的第一个网格（没有就清空，「确定」会随之禁用）
  useEffect(() => {
    if (sourceMeshes.some((item) => item.name === source)) return
    setSource(sourceMeshes[0]?.name ?? '')
  }, [sourceMeshes, source])

  // 源网格变化时把图片跟着换成它的图（避免「链接到 A 却显示 B 的图」）
  useEffect(() => {
    const parent = sourceMeshes.find((item) => item.name === source)
    if (parent) setImage(parent.image)
  }, [sourceMeshes, source])

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

  const imageOptions = useMemo(
    () => [
      { value: '', label: t('（沿用源网格的图）') },
      ...doc.images.map((item) => ({ value: item.name, label: item.name }))
    ],
    [doc.images]
  )

  const canSubmit = Boolean(source) && sourceMeshes.length > 0

  const submit = (): void => {
    let outcome: { ok: boolean; message: string } = { ok: false, message: '' }
    if (editing) {
      useProjectStore.getState().update(t('修改链接源'), (draft) => {
        const result = setLinkedMeshSource(draft, {
          slot,
          attachment: editing.attachment,
          skin,
          sourceSkin,
          source
        })
        outcome = result.ok
          ? { ok: true, message: result.warning ?? t('已把「{0}」的源网格改成「{1}」', [editing.attachment, source]) }
          : { ok: false, message: result.reason }
      })
    } else {
      useProjectStore.getState().update(t('新建链接网格'), (draft) => {
        const result = createLinkedMesh(draft, {
          slot,
          skin,
          sourceSkin,
          source,
          ...(name.trim() ? { name: name.trim() } : {}),
          ...(image ? { image } : {})
        })
        outcome = result.ok
          ? { ok: true, message: result.warning ?? t('已创建链接网格：{0} / {1}', [result.slot, result.attachment]) }
          : { ok: false, message: result.reason }
      })
    }

    if (!outcome.ok) {
      setError(outcome.message)
      return
    }
    onStatus(outcome.message)
    onClose()
  }

  return createPortal(
    <div className="fixed inset-0 z-[900] flex items-center justify-center bg-black/55">
      <div
        ref={rootRef}
        className="flex w-[460px] max-w-[94vw] flex-col rounded border border-line bg-ink-800 shadow-2xl shadow-black/60"
        style={panelStyle}
      >
        <div className="flex h-[30px] shrink-0 items-center gap-2 border-b border-line bg-ink-700 px-2.5" {...handleProps}>
          <Link2 size={13} className="text-accent" />
          <span className="text-panel font-semibold text-content-hi">
            {editing ? t('改链接网格的源') : t('新建链接网格')}
          </span>
          <span className="hao-label ml-1 truncate">{t('插槽「{0}」', slot)}</span>
          <button type="button" title={t('关闭（Esc）')} className="hao-tool-button ml-auto" onClick={onClose}>
            <X size={13} />
          </button>
        </div>

        <div className="flex flex-col gap-2 px-2.5 py-2.5">
          <div className="grid grid-cols-2 gap-2">
            <SelectField label={t('源皮肤')} value={sourceSkin} options={skinOptions} onChange={setSourceSkin} />
            <SelectField
              label={t('源网格')}
              value={source}
              options={sourceMeshes.map((item) => ({ value: item.name, label: item.name }))}
              onChange={setSource}
              disabled={sourceMeshes.length === 0}
            />
          </div>

          {editing ? null : (
            <div className="grid grid-cols-2 gap-2">
              <SelectField label={t('图片')} value={image} options={imageOptions} onChange={setImage} />
              <TextField
                label={t('附件名')}
                value={name}
                onChange={setName}
                commitOnBlur
                placeholder={source || t('与源网格同名')}
              />
            </div>
          )}

          <p className="text-3xs leading-[16px] text-content-lo">
            {sourceMeshes.length === 0
              ? t('源皮肤的这个插槽里没有网格：先在源皮肤里把图片转成网格，或换一个皮肤')
              : editing
                ? t('改源只换几何来源，贴图与 UV 会按新源重算')
                : t('几何（顶点 / 三角面 / 权重）来自源网格，这里只决定贴图与 UV。附件名与源同名 = 覆盖该插槽的显示')}
          </p>

          {error ? (
            <div className="rounded border border-danger/30 bg-danger/5 px-2 py-1.5 text-3xs leading-[16px] text-danger/90">
              {error}
            </div>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-2 border-t border-line bg-ink-700/60 px-2.5 py-2">
          <span className="hao-label mr-auto">{t('创建后可 Ctrl+Z 撤销')}</span>
          <button type="button" className="hao-btn" onClick={onClose}>
            {t('取消')}
          </button>
          <button ref={confirmRef} type="button" className="hao-btn hao-btn-accent" disabled={!canSubmit} onClick={submit}>
            {editing ? t('确定') : t('创建')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

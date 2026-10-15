import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useSettingsStore } from '@editor/store/settingsStore'
import { format } from '@ui/widgets/fields'
import { DEFAULT_BONE_STYLE, normalizeBoneHex } from '@render/overlays/boneStyle'
import { useDialogDrag } from './dialogDrag'

export interface SettingsDialogProps {
  onClose: () => void
}

/**
 * 软件级全局设置（与工程无关，跨「新建 / 打开 / 导入」一直保留，落盘在 localStorage）。
 *
 * 目前两项：Spine 导出的图集文件名、骨骼叠加层样式（视口里骨骼的长相）。
 * 以后加全局开关 / 偏好直接往这里堆即可。
 *
 * 注意这里**不接 `NumberField`**：它的中键拖动会走 `projectStore.beginTransaction`
 * （那是给文档编辑用的），改全局偏好会白留一条撤销记录、还会把工程标成未保存。
 */
export default function SettingsDialog({ onClose }: SettingsDialogProps) {
  const spineAtlasTxt = useSettingsStore((s) => s.spineAtlasTxt)
  const setSpineAtlasTxt = useSettingsStore((s) => s.setSpineAtlasTxt)
  const boneStyle = useSettingsStore((s) => s.boneStyle)
  const setBoneStyle = useSettingsStore((s) => s.setBoneStyle)
  const resetBoneStyle = useSettingsStore((s) => s.resetBoneStyle)
  const rootRef = useRef<HTMLDivElement | null>(null)
  /** 标题栏拖动弹窗（见 dialogDrag） */
  const { panelStyle, handleProps } = useDialogDrag()

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
        className="flex max-h-[86vh] w-[440px] flex-col rounded-[6px] border border-line bg-ink-800 shadow-2xl"
        style={panelStyle}
      >
        <div className="flex h-[28px] shrink-0 items-center justify-between border-b border-line px-3" {...handleProps}>
          <span className="hao-panel-title">全局设置</span>
          <button
            type="button"
            // 标题栏的 `cursor: grab` 会被继承下来，按钮自己声明 pointer 盖掉它
            className="cursor-pointer text-content-lo hover:text-content-hi"
            title="关闭"
            onClick={onClose}
          >
            <X size={14} />
          </button>
        </div>

        <div className="flex flex-col gap-3 overflow-y-auto px-4 py-4">
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

          {/* 骨骼样式：只改视口里骨骼的长相，不写进工程、不影响导出 */}
          <section className="flex flex-col gap-2 rounded-[4px] border border-line/60 px-2.5 py-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-content-hi">骨骼样式</span>
              <button
                type="button"
                className="text-3xs text-content-lo hover:text-content-hi"
                title="恢复成默认长相（改之前项目里用的那一档）"
                onClick={resetBoneStyle}
              >
                恢复默认
              </button>
            </div>
            <span className="text-3xs leading-[15px] text-content-lo">
              只影响视口里骨骼叠加层的长相（不写进工程、不影响导出）；改完立刻生效。
            </span>

            <div className="flex flex-col gap-1.5">
              <NumberRow
                label="宽"
                suffix="% 长度"
                hint="骨骼本体的半宽占骨骼长度的比例（原来固定 5%）"
                value={boneStyle.widthPercent}
                min={0.5}
                max={60}
                step={0.5}
                onChange={(widthPercent) => setBoneStyle({ widthPercent })}
              />
              <NumberRow
                label="原点圈"
                suffix="px"
                hint="骨骼原点那个圆圈的大小（屏幕像素）；拾取它靠的也是这个大小"
                value={boneStyle.jointRadius}
                min={2}
                max={40}
                step={1}
                onChange={(jointRadius) => setBoneStyle({ jointRadius })}
              />
              <ColorRow
                label="骨骼颜色"
                hint="骨骼本体的填充色（默认 #CCD2D8）"
                hex={boneStyle.fillColor}
                alpha={boneStyle.fillAlpha}
                onHex={(fillColor) => setBoneStyle({ fillColor })}
                onAlpha={(fillAlpha) => setBoneStyle({ fillAlpha })}
              />
              <ColorRow
                label="描边颜色"
                hint="骨骼轮廓与原点圆圈的描边色"
                hex={boneStyle.strokeColor}
                alpha={boneStyle.strokeAlpha}
                onHex={(strokeColor) => setBoneStyle({ strokeColor })}
                onAlpha={(strokeAlpha) => setBoneStyle({ strokeAlpha })}
              />
              <ColorRow
                label="选中颜色"
                hint="选中骨骼后整根（本体 + 原点圈）换成这个色"
                hex={boneStyle.selectedColor}
                onHex={(selectedColor) => setBoneStyle({ selectedColor })}
              />
            </div>
          </section>
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

/** 数值行：本地留编辑中的原文，失焦 / 回车 / 上下键才提交（边打字边回写会吃掉小数点） */
function NumberRow({
  label,
  suffix,
  hint,
  value,
  min,
  max,
  step,
  onChange
}: {
  label: string
  suffix: string
  hint?: string
  value: number
  min: number
  max: number
  step: number
  onChange: (value: number) => void
}) {
  const [text, setText] = useState(() => format(value))
  const editing = useRef(false)
  // 外部改动（「恢复默认」/ 另一个入口改同一项）时同步显示；打字期间不覆盖
  useEffect(() => {
    if (!editing.current) setText(format(value))
  }, [value])

  const commit = (raw: string): void => {
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) {
      setText(format(value))
      return
    }
    const next = Math.min(max, Math.max(min, parsed))
    onChange(next)
    setText(format(next))
  }

  return (
    <label className="flex items-center gap-1.5" title={hint}>
      <span className="hao-label w-[52px] shrink-0">{label}</span>
      <input
        className="hao-field font-mono"
        type="text"
        inputMode="decimal"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onFocus={() => {
          editing.current = true
        }}
        onBlur={(event) => {
          editing.current = false
          commit(event.target.value)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            commit((event.target as HTMLInputElement).value)
            ;(event.target as HTMLInputElement).blur()
          } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault()
            const delta = (event.key === 'ArrowUp' ? step : -step) * (event.shiftKey ? 10 : 1)
            commit(String(value + delta))
          }
        }}
      />
      <span className="w-[46px] shrink-0 text-3xs text-content-lo">{suffix}</span>
    </label>
  )
}

/**
 * 颜色行：色块（系统拾色器）+ 透明度滑杆。
 *
 * 颜色与 alpha 在设置里是**两个字段**（`#RRGGBB` + 0..1），与 `ColorField` 的
 * `#RRGGBBAA` 单串不同 —— 这里不拖动文档值，没必要引入整套拖动事务。
 */
function ColorRow({
  label,
  hint,
  hex,
  alpha,
  onHex,
  onAlpha
}: {
  label: string
  hint?: string
  hex: string
  /** 给了才显示透明度滑杆（「选中颜色」不需要：选中态的透明度是写死的高亮档） */
  alpha?: number
  onHex: (hex: string) => void
  onAlpha?: (alpha: number) => void
}) {
  return (
    <div className="flex items-center gap-1.5" title={hint}>
      <span className="hao-label w-[52px] shrink-0">{label}</span>
      <input
        type="color"
        className="h-[18px] w-[36px] shrink-0 cursor-pointer rounded-[3px] border border-line bg-ink-900 p-0"
        value={normalizeHex(hex)}
        onChange={(event) => onHex(event.target.value.toUpperCase())}
      />
      {alpha !== undefined && onAlpha ? (
        <>
          <input
            type="range"
            className="h-[14px] min-w-0 flex-1 cursor-pointer accent-cyan-400"
            min={0}
            max={1}
            step={0.01}
            value={alpha}
            onChange={(event) => onAlpha(Number(event.target.value))}
          />
          <span className="w-[30px] shrink-0 text-right font-mono text-3xs text-content-lo">
            {Math.round(alpha * 100)}%
          </span>
        </>
      ) : (
        <span className="font-mono text-3xs text-content-lo">{normalizeHex(hex)}</span>
      )}
    </div>
  )
}

/** `<input type="color">` 只吃 6 位 hex；设置里存坏值（手改 localStorage）时退回默认色 */
function normalizeHex(hex: string): string {
  return normalizeBoneHex(hex, DEFAULT_BONE_STYLE.fillColor).toLowerCase()
}

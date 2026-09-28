import { Trash2 } from 'lucide-react'
import { Easing } from '@core/model/animation'
import { hexToRgba, rgbaToHex } from '@core/util/color'
import type { RGBA } from '@core/model/types'
import { useProjectStore } from '@editor/store/projectStore'
import { useTimelineStore } from '@editor/store/timelineStore'
import { deleteKeys, findKeyframe, setKeyEasing } from '@editor/timeline/model'
import type { AnyKeyframe, KeySelector } from '@editor/timeline/model'
import { ColorField, FieldGroup, NumberField, SelectField, TextField, ToggleField, Vector2Field } from '@ui/widgets/fields'

export interface KeyframeCardProps {
  onStatus?: (text: string) => void
}

const KIND_LABEL: Record<KeySelector['kind'], string> = {
  bone: '骨骼',
  slot: '插槽',
  deform: 'FFD 变形',
  constraint: '约束',
  event: '事件'
}

const CHANNEL_LABEL: Record<string, string> = {
  rotate: '旋转',
  translate: '位移',
  scale: '缩放',
  shear: '错切',
  color: '颜色',
  display: '显示附件',
  displayIndex: '显示附件',
  visible: '可见性',
  offsets: 'FFD 偏移',
  mix: '混合权重',
  position: '位置',
  spacing: '间距'
}

const EASING_OPTIONS = [
  { value: String(Easing.Linear), label: '线性' },
  { value: String(Easing.Stepped), label: '阶跃（保持）' },
  { value: String(Easing.Bezier), label: '贝塞尔曲线' }
]

/**
 * 关键帧属性卡片：时间轴上选中关键帧后就显示在属性检查器最上方。
 *
 * - 普通关键帧：显示目标 / 通道 / 时间（可改）/ 缓动（可改）/ 值（按值类型自动分派控件）
 * - 事件帧：显示并可编辑 事件名 / 字符串参数 / 整数参数 / 浮点参数
 * - 多选：显示数量与清单，可批量改缓动或删除
 */
export default function KeyframeCard({ onStatus = () => undefined }: KeyframeCardProps) {
  const document = useProjectStore((s) => s.document)
  const update = useProjectStore((s) => s.update)
  const animationName = useTimelineStore((s) => s.currentAnimation)
  const selectedKeys = useTimelineStore((s) => s.selectedKeys)
  const setSelectedKeys = useTimelineStore((s) => s.setSelectedKeys)

  if (selectedKeys.length === 0) return null
  const animation = document.animations.find((item) => item.name === animationName) ?? null
  if (!animation) return null

  const single = selectedKeys.length === 1 ? selectedKeys[0] : null
  const frame = single ? findKeyframe(animation, single) : null
  const easing = frame?.easing ?? Easing.Linear

  /** 在选中帧上做原地改动（值 / 缓动 / 事件参数） */
  const editFrames = (label: string, mutate: (frame: AnyKeyframe) => void): void => {
    update(label, (draft) => {
      const target = draft.animations.find((item) => item.name === animationName)
      for (const selector of selectedKeys) {
        const hit = findKeyframe(target, selector)
        if (hit) mutate(hit)
      }
    })
  }

  const remove = (): void => {
    let removed = 0
    update('删除关键帧', (draft) => {
      removed = deleteKeys(draft, animationName, selectedKeys)
    })
    setSelectedKeys([])
    onStatus(`已删除 ${removed} 个关键帧`)
  }

  const applyEasing = (value: string): void => {
    const next = Number(value) as Easing
    editFrames('修改缓动', (item) => {
      item.easing = next
      item.curve = next === Easing.Bezier ? (item.curve ?? [0.25, 0.25, 0.75, 0.75]) : null
    })
  }

  const channels = selectedKeys.map((key) => CHANNEL_LABEL[key.channel] ?? key.channel).join('、')
  const frameIndex = single ? Math.round(single.time * document.frameRate) : 0

  return (
    // sticky：面板内容滚动时关键帧信息始终可见（外层要有不透明底色，否则会透出下方内容）
    <div className="sticky top-0 z-10 border-b border-accent/30 bg-ink-800">
      <div className="bg-accent/[0.07]">
      <div className="flex h-[22px] items-center gap-1 border-b border-accent/20 px-2">
        <span className="hao-panel-title text-accent">关键帧</span>
        <span className="truncate text-3xs text-content-lo">
          {single
            ? single.kind === 'event'
              ? KIND_LABEL.event
              : `${KIND_LABEL[single.kind]} · ${single.target || single.channel}`
            : `已选中 ${selectedKeys.length} 个`}
        </span>
        <button
          type="button"
          title="删除选中的关键帧（Delete）"
          className="ml-auto flex h-[16px] w-[16px] items-center justify-center rounded text-danger/80 hover:bg-danger/15 cursor-pointer"
          onClick={remove}
        >
          <Trash2 size={11} />
        </button>
      </div>

      {single ? (
        <FieldGroup title={`${KIND_LABEL[single.kind]}关键帧`}>
          {single.kind === 'event' ? (
            <>
              {/* 事件帧只需要这几项：时间只读（改时间在时间轴上拖），其余参数可编辑 */}
              <ReadonlyRow label="时间" value={`${single.time.toFixed(3)}s（第 ${frameIndex} 帧）`} />
              <TextField
                label="事件名"
                value={frame?.name ?? ''}
                commitOnBlur
                placeholder="事件名（如 hit / footstep）"
                onChange={(value) => editFrames('修改事件名', (item) => { item.name = value })}
              />
              <TextField
                label="字符串参数"
                value={frame?.stringParam ?? ''}
                commitOnBlur
                placeholder="可空"
                onChange={(value) => editFrames('修改事件字符串参数', (item) => { item.stringParam = value })}
              />
              <NumberField
                label="整数参数"
                value={frame?.intParam ?? 0}
                precision={0}
                step={1}
                onChange={(value) => editFrames('修改事件整数参数', (item) => { item.intParam = Math.round(value) })}
              />
              <NumberField
                label="浮点参数"
                value={frame?.floatParam ?? 0}
                step={0.1}
                precision={3}
                onChange={(value) => editFrames('修改事件浮点参数', (item) => { item.floatParam = value })}
              />
            </>
          ) : (
            <>
              <TextField label="目标" value={single.target || '（无）'} onChange={() => undefined} />
              <TextField label="通道" value={channels || single.channel} onChange={() => undefined} />
              {/* 时间只读：改时间统一在时间轴上拖关键帧，避免两处入口 */}
              <ReadonlyRow label="时间" value={`${single.time.toFixed(3)}s（第 ${frameIndex} 帧）`} />
              <SelectField label="缓动" value={String(easing)} options={EASING_OPTIONS} onChange={applyEasing} />
              {easing === Easing.Bezier ? (
                <p className="text-3xs text-content-lo">
                  曲线控制点：
                  {frame?.curve ? frame.curve.map((v) => v.toFixed(2)).join(', ') : '默认 0.25, 0.25, 0.75, 0.75'}
                  （可在时间轴底部曲线编辑器里拖手柄微调）
                </p>
              ) : null}
              <FrameValueEditor frame={frame} onEdit={(label, mutate) => editFrames(label, mutate)} />
            </>
          )}
        </FieldGroup>
      ) : (
        <FieldGroup title="批量编辑">
          <SelectField
            label="缓动"
            value={String(easing)}
            options={EASING_OPTIONS}
            onChange={applyEasing}
          />
          <ul className="flex flex-col gap-0.5">
            {selectedKeys.slice(0, 8).map((key, index) => (
              <li key={`${key.target}-${key.channel}-${index}`} className="flex items-center gap-1 text-3xs text-content-lo">
                <span className="truncate">
                  {KIND_LABEL[key.kind]} · {key.target || key.channel} · {CHANNEL_LABEL[key.channel] ?? key.channel}
                </span>
                <span className="ml-auto font-mono">{key.time.toFixed(3)}s</span>
              </li>
            ))}
            {selectedKeys.length > 8 ? (
              <li className="text-3xs text-content-lo">…还有 {selectedKeys.length - 8} 个</li>
            ) : null}
          </ul>
        </FieldGroup>
      )}
      </div>
    </div>
  )
}

/** 只读信息行（用于事件帧的时间等不可编辑字段） */
function ReadonlyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="hao-label w-[52px] shrink-0">{label}</span>
      <span className="hao-field flex items-center border-transparent bg-transparent px-0 font-mono text-content-mid">
        {value}
      </span>
    </div>
  )
}

/** 按关键帧值的实际形状分派编辑控件（数值 / 二维 / 颜色 / 布尔 / FFD 数组） */
function FrameValueEditor({
  frame,
  onEdit
}: {
  frame: AnyKeyframe | null
  onEdit: (label: string, mutate: (frame: AnyKeyframe) => void) => void
}) {
  const value = frame?.value

  if (typeof value === 'number') {
    return (
      <NumberField
        label="值"
        value={value}
        step={1}
        precision={3}
        onChange={(next) => onEdit('修改关键帧值', (item) => { item.value = next })}
      />
    )
  }

  if (typeof value === 'boolean') {
    return (
      <ToggleField
        label="值"
        value={value}
        onChange={(next) => onEdit('修改关键帧值', (item) => { item.value = next })}
      />
    )
  }

  if (value && typeof value === 'object' && 'x' in value && 'y' in value) {
    const vec = value as { x: number; y: number }
    return (
      <Vector2Field
        label="值"
        value={vec}
        step={0.01}
        onChange={(next) => onEdit('修改关键帧值', (item) => { item.value = { x: next.x, y: next.y } })}
      />
    )
  }

  if (value && typeof value === 'object' && 'r' in value) {
    const color = value as RGBA
    return (
      <ColorField
        label="颜色"
        value={rgbaToHex(color)}
        onChange={(hex) => onEdit('修改关键帧颜色', (item) => { item.value = hexToRgba(hex, color) })}
      />
    )
  }

  if (frame && Array.isArray(frame.offsets)) {
    const count = Math.floor(frame.offsets.length / 2)
    return (
      <p className="text-3xs text-content-lo">
        FFD 偏移：{count} 个顶点（顶点偏移量 = {count}）。在视口用 FFD 工具拖动顶点即可修改该帧。
      </p>
    )
  }

  return <p className="text-3xs text-content-lo">该通道没有可直接编辑的值。</p>
}

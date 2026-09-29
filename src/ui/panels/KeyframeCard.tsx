import { Trash2 } from 'lucide-react'
import { Easing } from '@core/model/animation'
import { hexToRgba, rgbaToHex } from '@core/util/color'
import type { RGBA } from '@core/model/types'
import { useProjectStore } from '@editor/store/projectStore'
import { useTimelineStore } from '@editor/store/timelineStore'
import { deleteKeys, findKeyframe, setKeyEasing } from '@editor/timeline/model'
import type { AnyKeyframe, KeySelector } from '@editor/timeline/model'
import { ColorField, NumberField, SelectField, TextField, ToggleField, Vector2Field } from '@ui/widgets/fields'

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
  shear: '斜切',
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

/** 字段固定宽度：横排时按窗口宽度自动换行，输入框宽度稳定 */
const SLOT = 'w-[212px] shrink-0'

/**
 * 关键帧属性卡片：显示在**曲线编辑器右侧**（时间轴底部工具条里）。
 *
 * - 普通关键帧：目标 / 通道 / 时间（只读）/ 缓动（可改）/ 值（按值类型自动分派控件）
 * - 事件帧：事件名 / 字符串参数 / 整数参数 / 浮点参数
 * - 多选：数量 + 清单，可批量改缓动或删除
 */
export default function KeyframeCard({ onStatus = () => undefined }: KeyframeCardProps) {
  const document = useProjectStore((s) => s.document)
  const update = useProjectStore((s) => s.update)
  const animationName = useTimelineStore((s) => s.currentAnimation)
  const selectedKeys = useTimelineStore((s) => s.selectedKeys)
  const setSelectedKeys = useTimelineStore((s) => s.setSelectedKeys)

  const animation = document.animations.find((item) => item.name === animationName) ?? null
  const single = selectedKeys.length === 1 ? selectedKeys[0] : null
  const frame = single && animation ? findKeyframe(animation, single) : null
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
    // 切到贝塞尔时保留已有的控制点，没有才用默认值（setKeyEasing 内部兜底）
    update('修改缓动', (draft) => {
      setKeyEasing(draft, animationName, selectedKeys, next, frame?.curve ?? null)
    })
    onStatus(`已把 ${selectedKeys.length} 个关键帧改为${EASING_OPTIONS.find((o) => o.value === value)?.label ?? ''}`)
  }

  const channels = selectedKeys.map((key) => CHANNEL_LABEL[key.channel] ?? key.channel).join('、')
  const frameIndex = single ? Math.round(single.time * document.frameRate) : 0

  return (
    <div className="flex min-w-0 flex-1 flex-col border-l border-line pl-2">
      <div className="flex h-[18px] shrink-0 items-center gap-1.5">
        <span className="hao-panel-title">关键帧属性</span>
        <span className="min-w-0 flex-1 truncate text-3xs text-content-lo">
          {single
            ? single.kind === 'event'
              ? `${KIND_LABEL.event} · 第 ${frameIndex} 帧`
              : `${KIND_LABEL[single.kind]} · ${single.target || single.channel} · ${
                  CHANNEL_LABEL[single.channel] ?? single.channel
                }`
            : selectedKeys.length > 0
              ? `已选中 ${selectedKeys.length} 个关键帧（${channels}）`
              : '在 dope sheet 里点选关键帧后可编辑其属性'}
        </span>
        {selectedKeys.length > 0 ? (
          <button
            type="button"
            title="删除选中的关键帧（Delete）"
            className="flex h-[16px] w-[16px] shrink-0 items-center justify-center rounded text-danger/80 hover:bg-danger/15 cursor-pointer"
            onClick={remove}
          >
            <Trash2 size={11} />
          </button>
        ) : null}
      </div>

      {selectedKeys.length === 0 ? (
        <p className="flex flex-1 items-center text-3xs text-content-lo">
          选中关键帧后，这里可以改时间轴上的缓动与数值；曲线形状在左侧曲线编辑器里拖控制点调整。
        </p>
      ) : single ? (
        <div className="hao-scroll flex max-h-[104px] flex-wrap content-start items-center gap-x-3 gap-y-1 overflow-y-auto pt-0.5">
          {single.kind === 'event' ? (
            <>
              <InfoChip label="时间" value={`${single.time.toFixed(3)}s · 第 ${frameIndex} 帧`} />
              <div className={SLOT}>
                <TextField
                  label="事件名"
                  value={frame?.name ?? ''}
                  commitOnBlur
                  placeholder="hit / footstep"
                  onChange={(value) => editFrames('修改事件名', (item) => { item.name = value })}
                />
              </div>
              <div className={SLOT}>
                <TextField
                  label="字符串"
                  value={frame?.stringParam ?? ''}
                  commitOnBlur
                  placeholder="可空"
                  onChange={(value) => editFrames('修改事件字符串参数', (item) => { item.stringParam = value })}
                />
              </div>
              <div className={SLOT}>
                <NumberField
                  label="整数"
                  value={frame?.intParam ?? 0}
                  precision={0}
                  step={1}
                  onChange={(value) => editFrames('修改事件整数参数', (item) => { item.intParam = Math.round(value) })}
                />
              </div>
              <div className={SLOT}>
                <NumberField
                  label="浮点"
                  value={frame?.floatParam ?? 0}
                  step={0.1}
                  precision={3}
                  onChange={(value) => editFrames('修改事件浮点参数', (item) => { item.floatParam = value })}
                />
              </div>
            </>
          ) : (
            <>
              <InfoChip label="对象" value={`${KIND_LABEL[single.kind]} · ${single.target || '（无）'}`} />
              <InfoChip label="通道" value={channels || single.channel} />
              {/* 时间只读：改时间统一在时间轴上拖关键帧，避免两处入口 */}
              <InfoChip label="时间" value={`${single.time.toFixed(3)}s · 第 ${frameIndex} 帧`} />
              <div className="w-[150px] shrink-0">
                <SelectField label="缓动" value={String(easing)} options={EASING_OPTIONS} onChange={applyEasing} />
              </div>
              {easing === Easing.Bezier ? (
                <InfoChip
                  label="曲线"
                  value={
                    frame?.curve
                      ? `c1(${frame.curve[0].toFixed(2)}, ${frame.curve[1].toFixed(2)}) c2(${frame.curve[2].toFixed(2)}, ${frame.curve[3].toFixed(2)})`
                      : '默认 0.25, 0.25, 0.75, 0.75'
                  }
                />
              ) : null}
              <FrameValueEditor frame={frame} onEdit={(label, mutate) => editFrames(label, mutate)} />
            </>
          )}
        </div>
      ) : (
        <div className="hao-scroll flex max-h-[104px] flex-wrap content-start items-center gap-x-3 gap-y-1 overflow-y-auto pt-0.5">
          <div className="w-[150px] shrink-0">
            <SelectField label="缓动" value={String(easing)} options={EASING_OPTIONS} onChange={applyEasing} />
          </div>
          <ul className="flex min-w-0 flex-1 flex-wrap gap-x-2 gap-y-0.5">
            {selectedKeys.slice(0, 12).map((key, index) => (
              <li
                key={`${key.target}-${key.channel}-${index}`}
                className="rounded bg-ink-900/60 px-1.5 py-[1px] text-3xs text-content-lo"
              >
                {key.target || key.channel} · {CHANNEL_LABEL[key.channel] ?? key.channel} ·{' '}
                <span className="font-mono">{key.time.toFixed(3)}s</span>
              </li>
            ))}
            {selectedKeys.length > 12 ? (
              <li className="text-3xs text-content-lo">…还有 {selectedKeys.length - 12} 个</li>
            ) : null}
          </ul>
        </div>
      )}
    </div>
  )
}

/** 只读信息：紧贴字段行排布的小标签 + 值 */
function InfoChip({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <span className="hao-label shrink-0">{label}</span>
      <span className="hao-field flex max-w-[190px] items-center border-transparent bg-transparent px-0 font-mono text-content-mid">
        <span className="truncate">{value}</span>
      </span>
    </span>
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
      <div className={SLOT}>
        <NumberField
          label="值"
          value={value}
          step={1}
          precision={3}
          onChange={(next) => onEdit('修改关键帧值', (item) => { item.value = next })}
        />
      </div>
    )
  }

  if (typeof value === 'boolean') {
    return (
      <div className={SLOT}>
        <ToggleField
          label="值"
          value={value}
          onChange={(next) => onEdit('修改关键帧值', (item) => { item.value = next })}
        />
      </div>
    )
  }

  if (value && typeof value === 'object' && 'x' in value && 'y' in value) {
    const vec = value as { x: number; y: number }
    return (
      <div className={SLOT}>
        <Vector2Field
          label="值"
          value={vec}
          step={0.01}
          onChange={(next) => onEdit('修改关键帧值', (item) => { item.value = { x: next.x, y: next.y } })}
        />
      </div>
    )
  }

  if (value && typeof value === 'object' && 'r' in value) {
    const color = value as RGBA
    return (
      <div className={SLOT}>
        <ColorField
          label="颜色"
          value={rgbaToHex(color)}
          onChange={(hex) => onEdit('修改关键帧颜色', (item) => { item.value = hexToRgba(hex, color) })}
        />
      </div>
    )
  }

  if (frame && Array.isArray(frame.offsets)) {
    const count = Math.floor(frame.offsets.length / 2)
    return <InfoChip label="FFD" value={`${count} 个顶点偏移（视口用 FFD 工具拖）`} />
  }

  return <InfoChip label="值" value="该通道没有可直接编辑的值" />
}

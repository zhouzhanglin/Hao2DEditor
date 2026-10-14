import { hexToRgba, rgbaToHex } from '@core/util/color'
import type { RGBA } from '@core/model/types'
import { useProjectStore } from '@editor/store/projectStore'
import { useTimelineStore } from '@editor/store/timelineStore'
import { findKeyframe } from '@editor/timeline/model'
import type { AnyKeyframe, KeySelector } from '@editor/timeline/model'
import { ColorField, NumberField, PX_PER_UNIT, TextField, ToggleField, Vector2Field } from '@ui/widgets/fields'

const KIND_LABEL: Record<KeySelector['kind'], string> = {
  bone: '骨骼',
  slot: '插槽',
  deform: 'FFD 变形',
  constraint: '约束',
  event: '事件',
  drawOrder: '插槽层级'
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
  order: '绘制顺序',
  offsets: 'FFD 偏移',
  mix: '权重',
  position: '位置',
  spacing: '间距'
}

/** 控件固定宽度：横向排列时宽度稳定，超宽自动换行 */
const SLOT = 'w-[196px] shrink-0'

/**
 * 关键帧「值」浮动面板：贴在**视口正下方中间**，横向排列，风格与视口工具面板一致。
 *
 * 原先关键帧的值 / 事件参数在时间轴底部工具条的「关键帧属性」卡里，离视口远、编辑时要来回看；
 * 挪到视口下方后，改值时光看画面即可。没选中关键帧时不渲染（不占视线）。
 *
 * 只承载「值」与事件参数 —— 缓动 / 曲线在左栏「曲线」面板，时间在 dope sheet 里拖。
 */
export default function KeyframeValueBar() {
  const document = useProjectStore((s) => s.document)
  const update = useProjectStore((s) => s.update)
  const animationName = useTimelineStore((s) => s.currentAnimation)
  const selectedKeys = useTimelineStore((s) => s.selectedKeys)

  const animation = document.animations.find((item) => item.name === animationName) ?? null
  const single = selectedKeys.length === 1 ? selectedKeys[0] : null
  const frame = single && animation ? findKeyframe(animation, single) : null

  /** 在选中帧上做原地改动（值 / 事件参数） */
  const editFrames = (label: string, mutate: (frame: AnyKeyframe) => void): void => {
    update(label, (draft) => {
      const target = draft.animations.find((item) => item.name === animationName)
      for (const selector of selectedKeys) {
        const hit = findKeyframe(target, selector)
        if (hit) mutate(hit)
      }
    })
  }

  if (selectedKeys.length === 0) return null

  const frameIndex = single ? Math.round(single.time * document.frameRate) : 0
  const channels = selectedKeys.map((key) => CHANNEL_LABEL[key.channel] ?? key.channel).join('、')

  return (
    <div className="pointer-events-auto absolute bottom-2 left-1/2 z-20 flex max-w-[calc(100%-12px)] -translate-x-1/2 flex-wrap items-center justify-center gap-x-3 gap-y-1 rounded-lg border border-line bg-ink-900/85 px-2.5 py-1.5 shadow-lg shadow-black/40 backdrop-blur-sm">
      {single ? (
        single.kind === 'event' ? (
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
        ) : single.kind === 'drawOrder' ? (
          <>
            <InfoChip label="轨道" value="插槽层级 · 绘制顺序" />
            <InfoChip label="时间" value={`${single.time.toFixed(3)}s · 第 ${frameIndex} 帧`} />
            <InfoChip
              label="顺序"
              value={((frame as { order?: string[] } | null)?.order ?? []).join(' → ') || '（空）'}
            />
          </>
        ) : (
          <>
            {/* 信息合成一行文本：浮动条要小，不做成三组「标签 + 值」 */}
            <span className="shrink-0 text-3xs text-content-lo">
              {KIND_LABEL[single.kind]} · <span className="text-content-mid">{single.target || '（无）'}</span> ·{' '}
              {channels || single.channel} · <span className="font-mono">{single.time.toFixed(3)}s</span>
              （第 {frameIndex} 帧）
            </span>
            <FrameValueEditor frame={frame} channel={single.channel} onEdit={(label, mutate) => editFrames(label, mutate)} />
          </>
        )
      ) : (
        <InfoChip label="关键帧" value={`已选中 ${selectedKeys.length} 个（${channels}）`} />
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
  channel,
  onEdit
}: {
  frame: AnyKeyframe | null
  /** 轨道名（translate / rotate / scale / …）：同一控件承载不同物理量，长度类要按轨道决定是否按像素显示 */
  channel: string
  onEdit: (label: string, mutate: (frame: AnyKeyframe) => void) => void
}) {
  const value = frame?.value

  if (typeof value === 'number') {
    // 标量轨道无量纲（rotate 是度、mix 是权重）：不换算。
    // 路径 position / spacing 的量纲随 spacingMode 变化（percent 模式是比例），暂不换算
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
    // 位移轨道是位置量（世界单位），与检查器同口径按像素显示；缩放 / 斜切是比例，不换算
    const isTranslate = channel === 'translate'
    return (
      <div className={SLOT}>
        <Vector2Field
          label="值"
          value={vec}
          unitScale={isTranslate ? PX_PER_UNIT : undefined}
          step={isTranslate ? 1 : 0.01}
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

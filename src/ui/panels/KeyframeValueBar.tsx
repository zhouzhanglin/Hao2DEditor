import { hexToRgba, rgbaToHex } from '@core/util/color'
import type { EditorDocument } from '@core/model/authoring'
import type { RGBA } from '@core/model/types'
import { keySlotDisplay } from '@editor/commands/animationCommands'
import { usePreviewStore } from '@editor/store/previewStore'
import { useProjectStore } from '@editor/store/projectStore'
import { useSelectionStore } from '@editor/store/selectionStore'
import { useTimelineStore } from '@editor/store/timelineStore'
import { findKeyframe } from '@editor/timeline/model'
import type { AnyKeyframe, KeySelector } from '@editor/timeline/model'
import {
  ColorField,
  NumberField,
  PX_PER_UNIT,
  SelectField,
  TextField,
  ToggleField,
  Vector2Field
} from '@ui/widgets/fields'

const KIND_LABEL: Record<KeySelector['kind'], string> = {
  bone: '骨骼',
  slot: '插槽',
  deform: 'FFD 变形',
  constraint: '约束',
  event: '事件',
  drawOrder: '插槽层级'
}

/**
 * 这些轨道的帧**没有**可直接编辑的值，浮动条对它们整条不出现（免得白挂一行字挡在视口下边）：
 * - `deform`（FFD / 网格顶点偏移）：一帧偏移是「每个顶点两个数」，只能在视口里用 FFD 工具拖；
 * - `drawOrder`（插槽层级 / 绘制顺序）：一帧存的是**所有插槽的先后顺序**，只能在层级树里拖行调整。
 */
const NO_VALUE_KINDS: ReadonlySet<KeySelector['kind']> = new Set(['deform', 'drawOrder'])

const CHANNEL_LABEL: Record<string, string> = {
  rotate: '旋转',
  translate: '位移',
  scale: '缩放',
  shear: '斜切',
  color: '颜色',
  // 与时间轴的行内标签同一口径（`SLOT_CHANNELS` 里就是「显示」）
  display: '显示',
  displayIndex: '显示',
  visible: '可见性',
  order: '绘制顺序',
  offsets: 'FFD 偏移',
  mix: '权重',
  position: '位置',
  spacing: '间距'
}

/**
 * 浮动条首行的两个名字：**对象名 + 通道名**（渲染成 `shouL*显示`）。
 *
 * 原先一行塞了四段「种类 · 对象 · 通道 · 时间（第 N 帧）」：时间在 dope sheet 的播放头与底栏
 * 时间码上都有，种类（骨骼 / 插槽 / 约束…）也多半能从通道名一眼看出来 —— 挤在一起的结果是
 * 真正要找的对象名反而不好认。多选时不写标题，那条信息交给「已选中 N 个」。
 */
function titleOf(key: KeySelector): { object: string; channel: string } {
  const channel = CHANNEL_LABEL[key.channel] ?? key.channel
  // 事件轨的 target 与 channel 都是事件名（`hit` / `footstep`），照抄会写成 `hit*hit`
  if (key.kind === 'event') return { object: key.target || channel, channel: KIND_LABEL.event }
  // target 为空（整具骨架一条轨，不属于任何对象）时用轨道种类兜底，免得标题只剩后半截
  return { object: key.target || KIND_LABEL[key.kind], channel }
}

/**
 * 控件固定宽度：横向排列时宽度稳定，超宽自动换行。
 *
 * 220px 是**按 8 个字符定的**：位移显示到小数点后 3 位，最多是 `-184.318` 这种 8 字符
 * （负号 + 3 位整数 + 小数点 + 3 位小数），而 `Vector2Field` 一行里并排两个框，两个都要放得下。
 * 行内固定是「52px 标签 + 6px 缝 + 框 + 6px 缝 + 框」，所以每个框 = (220 − 64) / 2 = 78px；
 * 再扣掉 `.hao-field` 的 `px-2`（左右各 8px）与 1px 边框，还剩 60px ≈ 8.3 字符。
 * 196px 时每个框只有 66px（可用 48px ≈ 6.7 字符），`117.413` 这种 7 字符就已经被切掉了。
 */
const SLOT = 'w-[220px] shrink-0'

/**
 * 颜色行要更宽：`ColorField` 一行摆了四件**固定宽**的东西 —— 色块 30 + 透明度滑杆 64 + 百分比 46，
 * 加上 52px 标签与 4 道 6px 缝就有 216px，而上面那个槽位是 220px；夹在中间的 hex 输入框是
 * `flex-1 min-w-0`，只能分到 4px —— 缩成一条只剩左右 padding + 边框的空框（约 22px 宽），
 * `#FFFFFFFF` 一个字符都看不见（截图里「颜色显示值框显示不全」就是它）。
 *
 * 310px 让 hex 拿到 94px：`.hao-field` 是 12px 字（Menlo 等宽约 7.2px/字符），
 * 扣掉 px-2 与 1px 边框还有 76px ≈ 10.5 字符，`#FFFFFFFF` 九字符放得下。
 */
const SLOT_COLOR = 'w-[310px] shrink-0'

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
  /** 当前皮肤：display 通道的下拉要从它取清单（取法同层级树 / 属性面板） */
  const skinName = useSelectionStore((s) => s.skin)

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
  // 全是「没有值可编辑」的轨道就不渲染；混选了骨骼 / 插槽等仍有值可改的轨道时照常显示
  if (selectedKeys.every((key) => NO_VALUE_KINDS.has(key.kind))) return null

  /** display 清单来自当前皮肤（空则 default）：帧里那个下标就是它的下标，`-1` = 不显示 */
  const activeSkin =
    (skinName ? document.skins.find((item) => item.name === skinName) : null) ?? document.skins[0] ?? null
  const displaysOf = (slotName: string): EditorDocument['skins'][number]['slots'][number]['attachments'] =>
    activeSkin?.slots.find((item) => item.slot === slotName)?.attachments ?? []

  /**
   * 选中的这一帧显示的是哪个 display（按**名**取）。
   *
   * 帧里只存了下标，名字在并行的 `displayAttachment` 里；两者不一致时**名字优先**
   * （运行期与导出同一口径，见 core 的 resolveDisplay 与 spineExport 的 resolveDisplayAttachment），
   * 所以先按名字取，名字为空（DragonBones 导入的数据没名字）再按下标回查当前皮肤。
   */
  const displayNameOf = (slotName: string, time: number, index: number): string => {
    const track = animation?.slots.find((item) => item.slot === slotName)
    const at = track ? track.displayIndex.findIndex((item) => Math.abs(item.time - time) < 1e-4) : -1
    const byName = at >= 0 ? (track?.displayAttachment[at] ?? '') : ''
    return byName || displaysOf(slotName)[index]?.name || ''
  }

  /**
   * 改「显示附件」关键帧：下拉给的是 display 名，帧里要写的却是**下标**，两者必须成对写回
   * （交给 `keySlotDisplay`，它按时间 upsert 并保持配对）。只写一个的话名字优先级更高，
   * 播放时看到的还是原来那个 display。
   */
  const setDisplay = (displayName: string): void => {
    if (!single) return
    const slotName = single.target
    const time = single.time
    // 空名 = 这一帧起不显示任何 display，下标写 -1（与 setup「什么都不显示」同一约定）
    const index = displayName ? displaysOf(slotName).findIndex((item) => item.name === displayName) : -1
    update('修改显示关键帧', (draft) => {
      const target = draft.animations.find((item) => item.name === animationName)
      if (target) keySlotDisplay(target, slotName, time, index, displayName)
    })
  }

  /**
   * display 通道专用下拉：帧里存的是下标（还有 `-1` 这种「不显示」的隐藏值），
   * 让人对着一个数字猜是哪个 display 没有意义 —— 名字才是能看懂、也是运行期认的那个口径。
   */
  const displayField =
    single && single.kind === 'slot' && (single.channel === 'display' || single.channel === 'displayIndex')
      ? {
          value: displayNameOf(single.target, single.time, typeof frame?.value === 'number' ? frame.value : -1),
          options: [
            { value: '', label: '不显示' },
            ...displaysOf(single.target).map((item) => ({ value: item.name, label: item.name }))
          ],
          onChange: setDisplay
        }
      : null

  const title = single ? titleOf(single) : null
  const channels = selectedKeys.map((key) => CHANNEL_LABEL[key.channel] ?? key.channel).join('、')

  return (
    <div className="pointer-events-auto absolute bottom-2 left-1/2 z-20 flex max-w-[calc(100%-12px)] -translate-x-1/2 flex-wrap items-center justify-center gap-x-3 gap-y-1 rounded-lg border border-line bg-ink-900/85 px-2.5 py-1.5 shadow-lg shadow-black/40 backdrop-blur-sm">
      {/* 首行只留「对象名 * 通道名」：时间与帧号在 dope sheet / 底栏时间码上都有，不重复占地方 */}
      {title ? <KeyTitle object={title.object} channel={title.channel} /> : null}
      {single ? (
        single.kind === 'event' ? (
          <>
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
            <FrameValueEditor
              frame={frame}
              channel={single.channel}
              display={displayField}
              previewSlot={single.kind === 'slot' ? single.target : ''}
              onEdit={(label, mutate) => editFrames(label, mutate)}
            />
          </>
        )
      ) : (
        <InfoChip label="关键帧" value={`已选中 ${selectedKeys.length} 个（${channels}）`} />
      )}
    </div>
  )
}

/**
 * 浮动条首行的标题：`对象名*通道名`（例如 `shouL*显示`）。
 *
 * 只留这两个名字 —— 对象亮一档、通道压在底色上，扫一眼就能分清「谁 · 哪条通道」。
 */
function KeyTitle({ object, channel }: { object: string; channel: string }) {
  return (
    <span className="shrink-0 text-3xs text-content-lo">
      <span className="text-content-mid">{object}</span>*{channel}
    </span>
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

/** 按关键帧值的实际形状分派编辑控件（display 下拉 / 数值 / 二维 / 颜色 / 布尔） */
function FrameValueEditor({
  frame,
  channel,
  display,
  previewSlot,
  onEdit
}: {
  frame: AnyKeyframe | null
  /** 轨道名（translate / rotate / scale / …）：同一控件承载不同物理量，长度类要按轨道决定是否按像素显示 */
  channel: string
  /** display 通道的下拉（帧里存的是下标，得按名字选）；其它通道为 null */
  display: { value: string; options: Array<{ value: string; label: string }>; onChange: (name: string) => void } | null
  /** 颜色帧所属插槽名（不是插槽轨就是空串）：拖动预览要按插槽名热写运行期颜色 */
  previewSlot: string
  onEdit: (label: string, mutate: (frame: AnyKeyframe) => void) => void
}) {
  const value = frame?.value

  // 显示附件要排在数值分支前面：它的值恰好也是数字（下标），但这里要选的是 display 名
  if (display) {
    return (
      <div className={SLOT}>
        <SelectField label="值" value={display.value} options={display.options} onChange={display.onChange} />
      </div>
    )
  }

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
      // 颜色行用更宽的槽位，理由见 SLOT_COLOR：220px 槽位下 hex 输入框只剩 4px 宽
      <div className={SLOT_COLOR}>
        <ColorField
          // 标签与其它通道统一叫「值」（对象名 * 通道名已经写明这是颜色帧，再写一遍「颜色」是重复）
          label="值"
          value={rgbaToHex(color)}
          // 拾色器 / 滑杆的连续拖动包成**一条**撤销记录：不包的话每个 `input` 事件都会
          // 往撤销栈塞一条等价记录、并且每次都要深拷贝一遍整个项目快照（拖动时必卡）
          onDragStart={() => useProjectStore.getState().beginTransaction('修改关键帧颜色')}
          onDragEnd={() => {
            useProjectStore.getState().endTransaction()
            usePreviewStore.getState().clearSlotColors()
          }}
          // 拖动中只写预览通道：视口按帧热更新颜色，文档 / 历史 / 面板一动不动（松手才提交一次）
          onPreview={
            previewSlot === '' ? undefined : (hex) => usePreviewStore.getState().setSlotColor(previewSlot, hex)
          }
          onChange={(hex) => onEdit('修改关键帧颜色', (item) => { item.value = hexToRgba(hex, color) })}
        />
      </div>
    )
  }

  // FFD（网格顶点偏移）不会走到这里：整条属性面板对 deform 帧直接不渲染，见组件顶部的早退

  return <InfoChip label="值" value="该通道没有可直接编辑的值" />
}

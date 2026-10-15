import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Droplet,
  Image as ImageIcon,
  Move,
  MoveDiagonal2,
  Palette,
  RotateCw,
  Scaling
} from 'lucide-react'
import { sampleAngle, sampleVec2 } from '@core/anim/interpolation'
import { hexToRgba, rgbaToHex } from '@core/util/color'
import { getActiveScene } from '@editor/activeScene'
import { highlightSlotColorKey, slotColorHexAt, slotColorMessage, writeSlotColor } from '@editor/slotColorOps'
import { useModeStore } from '@editor/store/modeStore'
import { useProjectStore } from '@editor/store/projectStore'
import { useSelectionStore } from '@editor/store/selectionStore'
import { useTimelineStore } from '@editor/store/timelineStore'
import {
  keySlotDisplayNow,
  NO_ANIMATION_MESSAGE,
  resolveAnimationName,
  setBoneChannelNow
} from '@editor/timeline/actions'
import { findKeyframe } from '@editor/timeline/model'
import { CommitTextField, format, parseHexColor, PX_PER_UNIT, VectorInput } from '@ui/widgets/fields'
import type { BoneChannel } from '@editor/commands/animationCommands'
import type { SlotColorTarget } from '@editor/slotColorOps'
import type { KeyKind } from '@editor/timeline/model'
import type { AuthoringAnimData } from '@core/model/authoring'
import type { Float2Keyframe, FloatKeyframe } from '@core/model/animation'
import type { Vec2 } from '@core/math/matrix'

/**
 * 输入框那一列：两个 70px 小框 + 3px 缝 = 143px。
 * 单值行（旋转 / 透明度）也占满这 143px，各行图标列与菱形列才会对齐（对齐靠列宽固定，
 * 所以列里放一个 70px 的框 + 空白也是对的，不必把框拉满）。
 *
 * 70px 是**按 8 个字符定的**：平移到小数点后 3 位最多是 `-184.318` 这种 8 字符
 * （负号 + 3 位整数 + 小数点 + 3 位小数）。12px SF Mono 一个字符约 7.2px，
 * 扣掉 `[&_input]:px-1` 的左右各 4px 与 1px 边框，还剩 60px ≈ 8.3 字符，刚好留一点余量。
 */
const FIELDS_CLASS = 'flex w-[143px] shrink-0 items-center gap-[3px] [&_input]:px-1 [&_select]:px-1'

/** 透明度显示到 0.1%：`0~255` 的 alpha 反算出来是 50.196… 这种长小数，四舍五入到可见精度 */
const round1 = (value: number): number => Math.round(value * 10) / 10

/** 二维通道：有轨就采样（与运行期同一套 easing），没轨或首帧之前用绑定姿态值 */
function sampledVec2(keys: readonly Float2Keyframe[] | undefined, time: number, fallback: Vec2): Vec2 {
  if (keys === undefined || keys.length === 0) return fallback
  const out = new Float32Array(2)
  out[0] = fallback.x
  out[1] = fallback.y
  return sampleVec2(keys, time, out, 0) ? { x: out[0], y: out[1] } : fallback
}

/** 角度通道（旋转）：走 `sampleAngle` 的跨 0°/360° 规则，不能当普通标量插值 */
function sampledAngle(keys: readonly FloatKeyframe[] | undefined, time: number, fallback: number): number {
  if (keys === undefined || keys.length === 0) return fallback
  return sampleAngle(keys, time) ?? fallback
}

/** 一行的悬停提示：名字 + 单位 + 当前帧有没有关键帧 */
function hintOf(name: string, target: string, unit: string, keyed: boolean, time: number): string {
  const at = `${time.toFixed(2)}s`
  const state = keyed
    ? `当前帧（${at}）已有关键帧 —— 点菱形重打一帧`
    : `点右侧菱形在当前帧（${at}）打一帧`
  return `「${target}」${name}${unit}\n${state}`
}

/**
 * 一格小输入框。包一层有两个理由：
 *
 * 1. **按「看得见的文本」判有没有改**。`VectorInput` 显示只保留 3 位小数，而文档里的值是任意
 *    浮点（拖过 gizmo 之后尤其碎）：`0.123456789` 显示成 `0.123`，用户点进框再点出去，提交
 *    回来的数是 `0.123` —— 与文档原值差了 3e-6，一个数都没打却多出一帧。所以这里拿**换算回
 *    显示空间后的文本**比：文本没变就当场收工，连 `onCommit` 都不调。
 * 2. **提交被拒时把框里的数字复原**。`VectorInput` 提交后会把原文留在框里
 *    （`setText(format(parsed))`），万一没写进去（工程里没动画 / 显示序号越界），框里就会留一个
 *    「看着像改了、其实没落地」的假数字，而它的 `useEffect` 只在真实值变化时才同步 —— 靠 key
 *    重挂是这里最省事的复原手段。返回 false 才算被拒。
 */
function Field({
  value,
  unitScale = 1,
  step = 1,
  onCommit
}: {
  value: number
  unitScale?: number
  step?: number
  onCommit: (next: number) => boolean
}) {
  const [ticket, setTicket] = useState(0)
  const scale = unitScale > 0 ? unitScale : 1
  return (
    <span className="w-[70px] shrink-0">
      <VectorInput
        key={ticket}
        value={value}
        unitScale={unitScale}
        step={step}
        onCommit={(next) => {
          if (format(next * scale) === format(value * scale)) return
          if (!onCommit(next)) setTicket((n) => n + 1)
        }}
      />
    </span>
  )
}

/**
 * 颜色行的**色块** + hex 框。
 *
 * 色块就是原生 `<input type="color">`（与检查器的 `ColorField` 同一个控件）：点开系统的
 * 拾色器面板，比在面板里塞一条色相条省地方。旁边跟一个能打字的 hex 框，两个入口一起给出
 * 截图里那种「看得见颜色、也能直接改」的样子。
 *
 * 这里只管 **RGB 那 7 位**，透明度归下一行 —— 写回去时必须把当前的 alpha 拼回来，
 * 否则改一下颜色就把透明度顶成 100（`ColorField` 接 alpha 也是这么拼的）。
 *
 * 系统拾色器拖动时会连发 `input`：整段用事务收成**一条**撤销记录（`History.push` 在事务
 * 期间是空操作），松手（原生 `change` / 失焦）才收尾并刷新时间轴上的关键帧高亮。
 */
function ColorSwatch({
  value,
  onChange,
  onSettled
}: {
  /** `#RRGGBBAA` */
  value: string
  onChange: (hex: string) => void
  /** 整段改完（拾色器关闭 / 失焦）时收尾：关事务 + 报状态 + 高亮关键帧 */
  onSettled: () => void
}) {
  const rgb = value.length === 9 ? value.slice(0, 7) : value
  const alphaHex = value.length === 9 ? value.slice(7) : 'FF'
  const dragging = useRef(false)
  const latest = useRef({ onChange, onSettled })
  latest.current = { onChange, onSettled }

  const begin = (): void => {
    if (dragging.current) return
    dragging.current = true
    useProjectStore.getState().beginTransaction('插槽颜色关键帧')
  }
  const end = (): void => {
    if (!dragging.current) return
    dragging.current = false
    useProjectStore.getState().endTransaction()
    latest.current.onSettled()
  }

  // 原生的 `change` 只在拾色器**关闭（确认）**时发一次，用它收尾最可靠；`onBlur` 兜底
  //（点空白处关掉），卸载时也收尾 —— 否则事务一直挂着，后面的编辑全被并进这一条。
  const swatchRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const el = swatchRef.current
    if (!el) return
    el.addEventListener('change', end)
    return () => {
      el.removeEventListener('change', end)
      end()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <>
      <input
        ref={swatchRef}
        type="color"
        // 40px 是把「看得见颜色」放在第一位：hex 框是 flex-1，色块宽一点它就自己窄下去。
        // 三个 `::-webkit-color-swatch*` 是要清掉 Chromium 给拾色器的默认留白与描边 ——
        // 不清的话颜色只填中间窄窄一条，看起来不像色块（检查器那边窄，留白不明显）
        className="h-[22px] w-[40px] shrink-0 cursor-pointer rounded border border-line bg-ink-900 p-0 [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:rounded-[3px] [&::-webkit-color-swatch]:border-0"
        value={rgb.startsWith('#') ? rgb : '#ffffff'}
        title={`点开系统拾色器改颜色（当前 ${rgb}）`}
        onBlur={end}
        onChange={(event) => {
          begin()
          latest.current.onChange(`${event.target.value.toUpperCase()}${alphaHex}`)
        }}
      />
      <CommitTextField
        className="hao-field min-w-0 flex-1 font-mono uppercase"
        value={rgb}
        title="颜色 #RRGGBB；失焦 / 回车生效（透明度看下一行）"
        sanitize={parseHexColor}
        // 手打 8 位（带 alpha）就整串用，否则只换 RGB、保留原透明度
        onCommit={(hex) => latest.current.onChange(hex.length === 9 ? hex : `${hex}${alphaHex}`)}
      />
    </>
  )
}

/** 滑杆的原生步进会带出 `50.199999…` 这类浮点噪声，按 0.1 取整并夹到 0 ~ 100 */
const quantizeAlpha = (percent: number): number =>
  Number.isFinite(percent) ? Math.min(100, Math.max(0, Number(percent.toFixed(1)))) : 0

/**
 * 透明度：滑杆 + 百分比读数。
 *
 * 没有直接用 `fields.tsx` 的 `SliderField` —— 那个左边自带 52px 的标签列（给检查器当行首用），
 * 塞进本面板 143px 的输入列后滑杆只剩三十几像素。本行的「哪个属性」已经由图标表达了，
 * 所以这里只留「滑杆 + 读数」。
 *
 * 写入约定与 `SliderField` / 上面的 `ColorSwatch` 一致：按下并**真的拖出第一个值**才开事务
 * —— 只在 pointerdown 就开会留下一条「什么都没改」的撤销记录（`History.end` 无条件记账）。
 * 中途走 `silent`（`updateSilent`，不记账），松开收尾，整段拖动只留一条撤销记录。
 * 键盘方向键调滑杆没有按下 / 松开配对（`pointer` 是 false），按普通可撤销编辑写。
 */
function AlphaSlider({
  value,
  onChange,
  onSettled,
  hint
}: {
  /** 0 ~ 100 */
  value: number
  onChange: (percent: number, silent: boolean) => void
  /** 拖动收尾：关事务 + 报一次状态 + 高亮刚写的关键帧 */
  onSettled: () => void
  hint: string
}) {
  /** 指针是否按在滑杆上（区分「拖动」与「键盘调值」，只有前者才降级成 silent） */
  const pointer = useRef(false)
  /** 事务是否已经开了：开了才需要收尾，也保证整段只开一次 */
  const begun = useRef(false)
  const latest = useRef({ onSettled })
  latest.current = { onSettled }

  const finish = (): void => {
    pointer.current = false
    if (!begun.current) return
    begun.current = false
    useProjectStore.getState().endTransaction()
    latest.current.onSettled()
  }

  // 指针在窗口外松开时 pointerup 不一定收得到，卸载兜底收尾 ——
  // 事务一直挂着的话，后面的编辑会被并进这一条撤销记录里
  useEffect(() => finish, [])

  return (
    <>
      <input
        type="range"
        className="h-[14px] min-w-0 flex-1 cursor-pointer accent-accent"
        min={0}
        max={100}
        step={0.1}
        value={value}
        title={hint}
        onPointerDown={() => {
          pointer.current = true
        }}
        onPointerUp={finish}
        onPointerCancel={finish}
        onChange={(event) => {
          const dragging = pointer.current
          if (dragging && !begun.current) {
            begun.current = true
            useProjectStore.getState().beginTransaction('插槽透明度关键帧')
          }
          onChange(quantizeAlpha(Number(event.target.value)), dragging)
        }}
      />
      <CommitTextField
        className="hao-field w-[42px] shrink-0 text-right font-mono"
        value={format(value, 1)}
        inputMode="decimal"
        scrub
        title="透明度 0 ~ 100；失焦 / 回车生效（中键左右拖动可调）"
        sanitize={(raw) => {
          const next = Number(raw)
          return Number.isFinite(next) ? format(quantizeAlpha(next), 1) : null
        }}
        onCommit={(next) => onChange(quantizeAlpha(Number(next)), false)}
      />
    </>
  )
}

/**
 * 一行：图标（是哪个属性）+ 输入框（当前帧的值）+ 菱形（打一帧）。
 *
 * 打帧的热区**只在菱形那个按钮上**（它 `flex-1` 吃掉整行剩下的宽度，点在菱形附近也算）：
 * 行里现在有输入框，把整行做成 `<button>` 是非法 HTML —— Chromium 里 `input` 套进 `button`
 * 焦点会乱，打字也点不进去，所以热区只能退到菱形这一列。
 */
function KeyRow({
  icon: Icon,
  title,
  keyed,
  onKey,
  children
}: {
  icon: typeof Move
  title: string
  keyed: boolean
  onKey: () => void
  children: ReactNode
}) {
  return (
    <div
      title={title}
      className="group flex h-[24px] w-full items-center gap-1 rounded-[5px] border border-transparent px-1 transition-colors duration-panel hover:border-white/10 hover:bg-white/[0.06]"
    >
      <Icon size={13} className="shrink-0 text-content-mid group-hover:text-content-hi" />
      <span className={FIELDS_CLASS}>{children}</span>
      <button
        type="button"
        onClick={onKey}
        aria-label="在当前帧打关键帧"
        aria-pressed={keyed}
        className="flex h-[20px] flex-1 cursor-pointer items-center justify-end rounded-[4px] pr-1 outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        {/* key 标识：有关键帧 = 实心亮蓝（时间轴上关键帧同色），没有 = 空心中灰 */}
        <span
          className={[
            'h-[7px] w-[7px] rotate-45 rounded-[1px] border transition-colors duration-panel',
            keyed ? 'border-accent bg-accent' : 'border-content-lo/70 bg-transparent group-hover:border-content-mid'
          ].join(' ')}
        />
      </button>
    </div>
  )
}

export interface PropertyKeyBarProps {
  onStatus: (text: string) => void
}

/**
 * 属性打帧条：**Animate 态**贴在视口左下角的一列极简「属性行」，跟着当前选中的对象走。
 *
 * 一行一条通道，从左到右三件东西：图标（是哪个属性）、输入框（当前帧的值）、菱形（打一帧）。
 * 之前改一条通道的值只能走「层级树右键 → 位置关键帧…」或者先在时间轴上点中那一行再按 K，
 * 视线和鼠标都要离开画面；这里把「选中对象能打帧的属性 + 当前值 + 打帧」摆在视口边上。
 *
 * 三件事是同一份数据：
 *
 * 1. **输入框里改一个数 = 把当前帧的关键帧写成这个值**（gizmo 拖拽、检查器的「改值即打帧」
 *    也都是这么干的）。不写运行时姿态：姿态会被下一次采样冲掉（播放、拖时间、任何一次文档
 *    编辑都会重采样），只改姿态等于「输进去的数字一会儿自己变回去」。
 * 2. **菱形亮 / 灰** = 当前帧有没有这条通道的关键帧，判据与「点下去写到哪」严格同源
 *    （同一个动画、同一帧）；否则会出现「亮着但点下去打在别处」这种说不清的错觉。
 * 3. **读值**与运行期同一规则：有轨按当前时间采样（旋转走跨 0° 的角度规则），没轨 / 首帧之前
 *    用绑定姿态（`setup`）值。
 *
 * 显示条件：`Animate` 态且选中的是骨骼 / 插槽。选中 display 时按它**所在的插槽**显示 ——
 * 附件永远挂在插槽里，颜色与显示选择本来就是那个插槽的属性，这时把面板收起来看着像「选中丢了」。
 * 约束 / 空选 / Pose 态不显示。
 *
 * 位置：左下角与网格子工具条（MeshSubtoolBar）同一处，但两者一个只出现在 Pose 态、一个只出现在
 * Animate 态，永远不会同时在场。
 */
export default function PropertyKeyBar({ onStatus }: PropertyKeyBarProps) {
  const mode = useModeStore((s) => s.mode)
  const kind = useSelectionStore((s) => s.kind)
  const boneName = useSelectionStore((s) => s.bone)
  const slotName = useSelectionStore((s) => s.slot)
  const document = useProjectStore((s) => s.document)
  const animationName = useTimelineStore((s) => s.currentAnimation)
  /**
   * 读 `timelineStore.time`（低频时间）而不是播放头时钟：打帧入口写的正是它。
   * 播放中它不会动（播放只推高频通道），此时面板停在「暂停时的那一刻」，
   * 与「点一下会打在哪」仍然一致 —— 播放结束后主 store 会被同步回来（见 ViewportCanvas 渲染循环）。
   */
  const time = useTimelineStore((s) => s.time)

  if (mode !== 'animate') return null

  const keyKind: KeyKind | null =
    kind === 'bone' && boneName !== ''
      ? 'bone'
      : (kind === 'slot' || kind === 'attachment') && slotName !== ''
        ? 'slot'
        : null
  if (keyKind === null) return null
  const target = keyKind === 'bone' ? boneName : slotName

  /**
   * 读哪份数据：动画按「当前选中的，没选就用第一个」——
   * 与打帧入口 `resolveAnimationName` 的自动选中规则一致（不然一个动画都没点过时全是灰的，
   * 点下去却能打上帧）。
   */
  const scope = animationName ?? document.animations[0]?.name ?? null
  const animation = document.animations.find((item) => item.name === scope) ?? null
  const keyed = (channel: string): boolean =>
    animation !== null &&
    findKeyframe(animation, { kind: keyKind, target, attachment: '', channel, time }) !== null

  // 宽度 206 是照着行内布局倒推的：图标 13 + 缝 4 + 输入区 143 + 缝 4 + 菱形列 22，再加上
  // 行的边框与内边距 10、面板自己的边框与内边距 10。菱形列那 22px 不能省：它是打帧热区，
  // 挤到 14px 就紧贴着输入框了，想打帧却点进输入框是最烦的误操作。
  return (
    <div className="pointer-events-auto absolute bottom-3 left-3 z-20 flex w-[206px] flex-col gap-px rounded-[8px] border border-white/10 bg-ink-900/70 p-1 shadow-lg shadow-black/30 backdrop-blur-md">
      {keyKind === 'bone' ? (
        <BoneRows bone={target} animation={animation} time={time} keyed={keyed} onStatus={onStatus} />
      ) : (
        <SlotRows slot={target} animation={animation} scope={scope} time={time} keyed={keyed} onStatus={onStatus} />
      )}
    </div>
  )
}

/** 骨骼四行：位置 / 旋转 / 缩放 / 斜切 —— 与右键菜单、时间轴子轨道同名字、同顺序 */
function BoneRows({
  bone,
  animation,
  time,
  keyed,
  onStatus
}: {
  bone: string
  animation: AuthoringAnimData | null
  time: number
  keyed: (channel: string) => boolean
  onStatus: (text: string) => void
}) {
  const document = useProjectStore((s) => s.document)
  const boneData = document.bones.find((item) => item.name === bone)
  if (boneData === undefined) return null

  const track = animation?.bones.find((item) => item.bone === bone)
  const position = sampledVec2(track?.translate, time, boneData.localPosition)
  const rotation = sampledAngle(track?.rotate, time, boneData.rotation)
  const scale = sampledVec2(track?.scale, time, boneData.localScale)
  const shear = sampledVec2(track?.shear, time, boneData.localShear)

  /** 改值 = 打帧；返回是否真的写下去了（没写下去时输入框要复原） */
  const write = (channel: BoneChannel, value: number | Vec2): boolean => {
    const result = setBoneChannelNow(bone, channel, value)
    onStatus(result.message)
    return result.ok
  }
  /** 菱形：把这一帧的当前值显式打成关键帧 */
  const key = (channel: BoneChannel, value: number | Vec2): void => {
    const result = setBoneChannelNow(bone, channel, value)
    onStatus(result.message)
  }

  return (
    <>
      <KeyRow
        icon={Move}
        title={hintOf('位置', bone, '（X / Y，像素）', keyed('translate'), time)}
        keyed={keyed('translate')}
        onKey={() => key('translate', position)}
      >
        {/* 位移是位置量：与检查器 / 关键帧值条同口径按像素显示（unitScale 负责换算） */}
        <Field
          value={position.x}
          unitScale={PX_PER_UNIT}
          onCommit={(x) => write('translate', { x, y: position.y })}
        />
        <Field
          value={position.y}
          unitScale={PX_PER_UNIT}
          onCommit={(y) => write('translate', { x: position.x, y })}
        />
      </KeyRow>

      <KeyRow
        icon={RotateCw}
        title={hintOf('旋转', bone, '（度）', keyed('rotate'), time)}
        keyed={keyed('rotate')}
        onKey={() => key('rotate', rotation)}
      >
        <Field value={rotation} onCommit={(v) => write('rotate', v)} />
      </KeyRow>

      <KeyRow
        icon={Scaling}
        title={hintOf('缩放', bone, '（比例，1 = 原大）', keyed('scale'), time)}
        keyed={keyed('scale')}
        onKey={() => key('scale', scale)}
      >
        <Field value={scale.x} step={0.01} onCommit={(x) => write('scale', { x, y: scale.y })} />
        <Field value={scale.y} step={0.01} onCommit={(y) => write('scale', { x: scale.x, y })} />
      </KeyRow>

      <KeyRow
        icon={MoveDiagonal2}
        title={hintOf('斜切', bone, '（比例，不换算）', keyed('shear'), time)}
        keyed={keyed('shear')}
        onKey={() => key('shear', shear)}
      >
        {/* 斜切是比例量，一把调 0.1 才够用（缩放那种 0.01 的细粒度在这一行太磨人） */}
        <Field value={shear.x} step={0.1} onCommit={(x) => write('shear', { x, y: shear.y })} />
        <Field value={shear.y} step={0.1} onCommit={(y) => write('shear', { x: shear.x, y })} />
      </KeyRow>
    </>
  )
}

/** 插槽三行：颜色、透明度、显示选择（颜色与透明度共用同一个颜色帧，各改各的那一半） */
function SlotRows({
  slot,
  animation,
  scope,
  time,
  keyed,
  onStatus
}: {
  slot: string
  animation: AuthoringAnimData | null
  scope: string | null
  time: number
  keyed: (channel: string) => boolean
  onStatus: (text: string) => void
}) {
  const document = useProjectStore((s) => s.document)

  /**
   * 显示选择要问运行期：当前皮肤里这个插槽的显示列表与当前下标（`slotDisplayIndex` 已按
   * 附件名在合并皮肤里解析过），与 `keySlotDisplayNow` 写入时用的是同一套解析。
   * 没有运行期（工程刚打开、骨架还没编译）时这一行留空不可编。
   */
  const bundle = getActiveScene()?.runtime ?? null
  const slotIndex = bundle === null ? -1 : bundle.slotIndex[slot] ?? -1
  const displays =
    bundle !== null && slotIndex >= 0
      ? bundle.maps.skinArr[bundle.maps.skinOfSlot[slotIndex]]?.attachments ?? []
      : []
  const displayIndex = bundle !== null && slotIndex >= 0 ? bundle.skeleton.slotDisplayIndex[slotIndex] : -1
  const displayReady = bundle !== null && slotIndex >= 0
  // 显示下拉被写回拒绝时靠它重挂，把 DOM 拨回文档里的值（见 select 的 onChange）
  const [displayTicket, setDisplayTicket] = useState(0)

  // 颜色帧是「插槽色」：颜色与透明度两行改的都是同一个颜色帧（只显示 RGB 那一半）
  const colorTarget: SlotColorTarget = { animate: true, animation: scope, time, label: '插槽颜色关键帧' }
  // `slotColorHexAt` 拿不到插槽时给的是 `#FFFFFFFF`（不透明），所以这里不用再兜一层
  const colorHex = slotColorHexAt(document, colorTarget, slot)
  const alphaPercent = round1(hexToRgba(colorHex).a * 100)

  /**
   * 实际要写的颜色目标。动画按 `resolveAnimationName` 兜底（没选中就用第一个）——
   * 与菱形点击同一条规则，否则输入框写进去、画面上却看不见效果。没有动画时返回 null。
   */
  const colorWriteTarget = (): SlotColorTarget | null => {
    const animScope = resolveAnimationName()
    return animScope === ''
      ? null
      : { animate: true, animation: animScope, time, label: '插槽颜色关键帧' }
  }

  /** 写一个颜色帧（颜色行 / 透明度行 / 菱形共用），报状态并刷新时间轴高亮 */
  const writeColor = (hex: string): boolean => {
    const target = colorWriteTarget()
    if (target === null) {
      onStatus(NO_ANIMATION_MESSAGE)
      return false
    }
    const message = writeSlotColor(slot, hex, target)
    onStatus(message)
    if (message !== slotColorMessage(slot, target)) return false
    highlightSlotColorKey(slot, time)
    return true
  }

  /** 拖拾色器时的实时预览：只写值。每动一下都刷状态栏会把状态栏刷花，收尾时统一报一次 */
  const writeColorQuiet = (hex: string): void => {
    const target = colorWriteTarget()
    if (target !== null) writeSlotColor(slot, hex, target)
  }

  /** 拾色器整段改完的收尾：报一次结果 + 把时间轴上刚写的这一帧点亮 */
  const settleColor = (): void => {
    const target = colorWriteTarget()
    if (target === null) {
      onStatus(NO_ANIMATION_MESSAGE)
      return
    }
    onStatus(slotColorMessage(slot, target))
    highlightSlotColorKey(slot, time)
  }

  /**
   * 透明度：保留当前颜色，只换 alpha（写的是同一个颜色帧，与颜色行各改各的那一半）。
   * `silent = true` 是滑杆拖动中的高频写入，走 `updateSilent` 不记账，整段由事务收成一条。
   */
  const writeAlpha = (percent: number, silent = false): boolean => {
    const target = colorWriteTarget()
    if (target === null) {
      // 拖动中不报，免得每动一下就刷一次状态栏；收尾时 onSettled 会报
      if (!silent) onStatus(NO_ANIMATION_MESSAGE)
      return false
    }
    const color = hexToRgba(slotColorHexAt(document, target, slot))
    color.a = Math.min(1, Math.max(0, percent / 100))
    const hex = rgbaToHex(color)
    if (silent) {
      writeSlotColor(slot, hex, target, true)
      return true
    }
    return writeColor(hex)
  }

  /** 当前显示的是哪个附件（`''` = 不显示）；没有运行期时读不到，下拉会整条禁用 */
  const currentDisplay = displayReady ? displays[displayIndex]?.name ?? '' : ''
  /** 下拉项：`''` 是「不显示」，其余是当前皮肤里可选的附件名（与写入同一套名字口径） */
  const displayOptions: Array<{ value: string; label: string }> = displayReady
    ? [{ value: '', label: '不显示' }, ...displays.map((item) => ({ value: item.name, label: item.name }))]
    : [{ value: '', label: '视口未就绪' }]

  /** 显示选择：按**附件名**写（`keySlotDisplayNow` 收的也是名字，`''` = 不显示任何附件） */
  const writeDisplay = (name: string): boolean => {
    if (!displayReady || name === currentDisplay) return true
    const result = keySlotDisplayNow(slot, name)
    onStatus(result.message)
    return result.ok
  }

  return (
    <>
      {/* 颜色一行：色块（点开系统拾色器）+ hex。写的是 RGB，透明度原样拼回去 */}
      <KeyRow
        icon={Palette}
        title={hintOf('颜色', slot, '（#RRGGBB）', keyed('color'), time)}
        keyed={keyed('color')}
        onKey={() => writeColor(colorHex)}
      >
        <ColorSwatch value={colorHex} onChange={writeColorQuiet} onSettled={settleColor} />
      </KeyRow>

      {/* 透明度单独一行：与颜色共用同一个颜色帧，各改各的那一半 */}
      <KeyRow
        icon={Droplet}
        title={hintOf('透明度', slot, '（0 ~ 100）', keyed('color'), time)}
        keyed={keyed('color')}
        onKey={() => writeColor(colorHex)}
      >
        <AlphaSlider
          value={alphaPercent}
          hint="左右拖动调透明度；右侧读数可打字或中键拖动微调"
          onChange={writeAlpha}
          onSettled={settleColor}
        />
      </KeyRow>

      <KeyRow
        icon={ImageIcon}
        title={displayTitle({ slot, name: currentDisplay, ready: displayReady, keyed: keyed('display'), time })}
        keyed={keyed('display')}
        onKey={() => {
          const result = keySlotDisplayNow(slot, currentDisplay)
          onStatus(result.message)
        }}
      >
        <select
          key={displayTicket}
          className="hao-field cursor-pointer bg-ink-900 disabled:cursor-not-allowed disabled:opacity-40"
          value={currentDisplay}
          disabled={!displayReady}
          onChange={(event) => {
            // 写不进去（工程里一个动画都没有）就把下拉改回文档里的值 —— 受控组件的 value 没变时
            // React 不保证把 DOM 拨回来，重挂一次最省事
            if (!writeDisplay(event.target.value)) setDisplayTicket((n) => n + 1)
          }}
        >
          {displayOptions.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
      </KeyRow>
    </>
  )
}

/** 显示选择那一行的提示：当前显示的是哪个附件；没有运行期时说清为什么这条点不动 */
function displayTitle(info: {
  slot: string
  name: string
  ready: boolean
  keyed: boolean
  time: number
}): string {
  if (!info.ready) return `「${info.slot}」显示选择\n视口还没就绪，暂时读不到显示列表`
  const current = info.name === '' ? '不显示任何附件' : `「${info.name}」`
  return `${hintOf('显示选择', info.slot, '', info.keyed, info.time)}\n当前：${current}`
}

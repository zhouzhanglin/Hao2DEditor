import { getActiveScene } from '../activeScene'
import { useProjectStore } from '../store/projectStore'
import { useSelectionStore } from '../store/selectionStore'
import { useTimelineStore } from '../store/timelineStore'
import type { Selection } from '../store/selectionStore'
import type { RuntimeBundle } from '../runtime'
import { buildTimeline, deleteKeys, keyframeTargets, syncDuration } from './model'
import {
  keyBoneChannel,
  keySlotDisplay,
  keySlotSubArmature,
  pruneEmptyTracks
} from '../commands/animationCommands'
import { sampleSubArmature } from '@core/nesting/nest'
import { AttachmentType } from '@core/model/types'
import type { BoneChannel } from '../commands/animationCommands'
import type { KeyframeTarget, KeyKind, KeySelector, PoseSnapshot } from './model'
import type { AuthoringAnimData } from '@core/model/authoring'
import type { EventKeyframe } from '@core/model/animation'
import type { Vec2 } from '@core/math/matrix'
import { t } from '@i18n'

export interface ActionResult {
  ok: boolean
  message: string
}

/** 把当前选中对象映射为可打关键帧的目标 */
export function selectionTargets(selection: Selection): Array<{ kind: KeyKind; target: string; attachment: string }> {
  // 多选：整批骨骼都算目标（按 K 一次给所有选中骨骼打帧）
  if (selection.kind === 'bone' && selection.bones.length > 0) {
    return selection.bones.map((name) => ({ kind: 'bone' as KeyKind, target: name, attachment: '' }))
  }
  if (selection.kind === 'slot' && selection.slot) {
    return [{ kind: 'slot', target: selection.slot, attachment: '' }]
  }
  if (selection.kind === 'attachment' && selection.slot && selection.attachment) {
    return [{ kind: 'deform', target: selection.slot, attachment: selection.attachment }]
  }
  // 约束：IK 的混合（mix）等参数是可做动画的，选中约束按 K 就给它的全部通道打帧
  if (selection.kind === 'constraint' && selection.constraint) {
    return [{ kind: 'constraint', target: selection.constraint, attachment: '' }]
  }
  return []
}

/**
 * 打帧要写进哪个动画：优先当前选中的动画；**没选但工程里有动画时自动选第一个** ——
 * 右键菜单打帧不该因为「还没在时间轴上点过动画」就静默失败（只闪一行状态栏，很难发现）。
 * 一个动画都没有时返回空串，由调用方给出明确提示。
 *
 * 导出给视口左下角的「属性打帧条」用：那张面板上「菱形亮不亮」和「点下去写到哪」必须是
 * 同一个动画，否则会出现「亮着但点下去打在别处」。
 */
export function resolveAnimationName(): string {
  const current = useTimelineStore.getState().currentAnimation
  if (current) return current
  const first = useProjectStore.getState().document.animations[0]
  if (!first) return ''
  // 只设置当前动画，不动播放头时间（用户可能正停在某个时刻上打帧）
  useTimelineStore.setState({ currentAnimation: first.name })
  return first.name
}

/** 没有可用动画时的统一提示（视口属性打帧条也用它，避免同一件事两套说法） */
export function noAnimationMessage(): string {
  return t('工程里还没有动画：先在时间轴点「+ 动画」建一个，再打关键帧')
}

/**
 * 打帧目标 → 时间轴子轨道 id（与 `buildTimeline` 的 id 规则一致）：
 * 有通道的用 `kind:target:channel`，约束这类整条轨道用 `kind:target`。
 * DopeSheet 靠它把打帧的轨道滚动到可见并高亮。
 */
function trackIdOf(target: KeyframeTarget): string {
  if (target.kind === 'constraint') return `constraint:${target.target}`
  if (target.kind === 'deform') return `deform:${target.target}:${target.attachment}`
  return target.channel ? `${target.kind}:${target.target}:${target.channel}` : `${target.kind}:${target.target}`
}

/** 运行时姿态 → 打关键帧的快照（层级树 / slot 层级的右键菜单也走这里） */
function snapshotPose(bundle: RuntimeBundle): PoseSnapshot {
  return {
    localRot: bundle.skeleton.localRot,
    localPos: bundle.skeleton.localPos,
    localScale: bundle.skeleton.localScale,
    localShear: bundle.skeleton.localShear,
    slotColors: bundle.skeleton.slotColors,
    slotDisplayIndex: bundle.skeleton.slotDisplayIndex,
    // 显示帧要把附件名一起写进去（运行期名字优先）：从当前皮肤反查每个插槽正在显示谁
    slotDisplayNames: bundle.asset.slots.map((_, slotIndex) => {
      const skin = bundle.maps.skinOfSlot[slotIndex]
      const attachments = skin >= 0 ? bundle.maps.skinArr[skin].attachments : []
      return attachments[bundle.skeleton.slotDisplayIndex[slotIndex]]?.name ?? ''
    }),
    slotVisible: bundle.skeleton.slotVisible,
    deformOffsets: bundle.skeleton.deformOffsets,
    boneIndex: bundle.boneIndex,
    slotIndex: bundle.slotIndex,
    // 约束打帧读的是**画面上正在生效**的值（动画轨道驱动过的 mix 也在里面），
    // 所以取运行期状态而不是工程文件里的静态参数
    constraintStates: bundle.asset.constraints.map((_, index) => bundle.player.constraintStateAt(index) ?? undefined),
    constraintIndex: bundle.constraintIndex
  }
}

/**
 * 给**指定目标**打关键帧（层级树 / slot 层级的右键菜单用）。
 * `label` 只用于状态提示，如「骨骼「root」的位置」。
 */
export function keyframeTargetsNow(targets: readonly KeyframeTarget[], label = ''): ActionResult {
  const scene = getActiveScene()
  if (!scene) return { ok: false, message: t('视口尚未就绪') }
  const bundle = scene.runtime
  if (!bundle) return { ok: false, message: t('没有可打关键帧的骨架') }
  const animScope = resolveAnimationName()
  if (!animScope) return { ok: false, message: noAnimationMessage() }
  const timeline = useTimelineStore.getState()
  const animationName = animScope
  if (targets.length === 0) return { ok: false, message: t('没有可打关键帧的目标') }

  let count = 0
  useProjectStore.getState().update(t('打关键帧'), (draft) => {
    count = keyframeTargets(draft, animationName, snapshotPose(bundle), targets, timeline.time, draft.editorMeta.activeSkin)
  })
  if (count > 0) {
    // 让时间轴滚动到该轨道并高亮：不然打的帧在轨道列表下方看不见，像「没反应」
    useTimelineStore.getState().notifyKeyed(trackIdOf(targets[0]), timeline.time)
    // 顺手把刚打的关键帧选中：时间轴上会高亮，底部关键帧属性面板也会显示它
    const first = targets[0]
    if (first.channel) {
      useTimelineStore.getState().setSelectedKeys([
        {
          kind: first.kind,
          target: first.target,
          attachment: first.attachment,
          channel: first.channel,
          time: timeline.time
        }
      ])
    }
  }
  return count > 0
    ? {
        ok: true,
        message: label
          ? t('已在 {0}s 为「{1}」打关键帧', [timeline.time.toFixed(2), label])
          : t('已在 {0}s 为选中对象打关键帧', timeline.time.toFixed(2))
      }
    : { ok: false, message: t('当前对象没有可打关键帧的数据（FFD 需要先编辑过顶点）') }
}

/**
 * 在当前时间点打一帧**显示**关键帧：把插槽切到指定附件，**传空名表示不显示任何附件**。
 *
 * 名字与下标一起写入（运行期名字优先，换皮肤后仍能解析）；不显示时下标写 -1，
 * 这是「setup 时不显示任何附件」的合法值（见 asset.ts 的 setupDisplayIndex）。
 */
export function keySlotDisplayNow(slotName: string, attachmentName: string): ActionResult {
  const scene = getActiveScene()
  const bundle = scene?.runtime
  if (!bundle) return { ok: false, message: t('没有可打关键帧的骨架') }
  const animScope = resolveAnimationName()
  if (!animScope) return { ok: false, message: noAnimationMessage() }
  const timeline = useTimelineStore.getState()
  const animationName = animScope
  const slotIndex = bundle.slotIndex[slotName]
  if (slotIndex === undefined) return { ok: false, message: t('找不到插槽「{0}」', slotName) }
  const skin = bundle.maps.skinOfSlot[slotIndex]
  const attachments = skin >= 0 ? bundle.maps.skinArr[skin].attachments : []
  // 空名 = 这一个关键帧起不再显示任何 display（下标 -1），不需要校验附件是否存在
  const index = attachmentName
    ? attachments.findIndex((attachment) => attachment.name === attachmentName)
    : -1
  if (attachmentName && index < 0) return { ok: false, message: t('当前皮肤里没有「{0}」', attachmentName) }

  const at = timeline.time
  useProjectStore.getState().update(t('打显示关键帧'), (draft) => {
    const animation = draft.animations.find((item) => item.name === animationName)
    if (animation) keySlotDisplay(animation, slotName, at, index, attachmentName)
  })
  // 同打帧：把时间轴的这一行滚到可见并高亮，并选中刚打的显示帧
  useTimelineStore.getState().notifyKeyed(`slot:${slotName}:display`, at)
  useTimelineStore.getState().setSelectedKeys([
    { kind: 'slot', target: slotName, attachment: '', channel: 'display', time: at }
  ])
  return {
    ok: true,
    message: attachmentName
      ? t('已在 {0}s 打「{1}」的显示帧 → 「{2}」', [at.toFixed(2), slotName, attachmentName])
      : t('已在 {0}s 打「{1}」的显示帧 → 不显示', [at.toFixed(2), slotName])
  }
}

/**
 * 在当前时间点给某插槽打「子骨架」帧。
 *
 * 取值用该插槽**当前显示的嵌套骨架 display 的 setup 值**（动画名 / 次数 / 偏移 / 倍速）：
 * 这是「先调好一次、之后按时间点复制」的常见用法。没挂嵌套骨架时直接失败并说明原因。
 */
export function keySlotSubArmatureNow(
  slotName: string,
  /** 只改其中一个参数时传入（例如属性条里换动画名，其余参数沿用当前帧 / setup 值） */
  overrides?: Partial<{ animation: string; playTimes: number; offset: number; speed: number }>
): ActionResult {
  const scene = getActiveScene()
  const bundle = scene?.runtime
  if (!bundle) return { ok: false, message: t('没有可打关键帧的骨架') }
  const animationName = resolveAnimationName()
  if (!animationName) return { ok: false, message: noAnimationMessage() }
  const slotIndex = bundle.slotIndex[slotName]
  if (slotIndex === undefined) return { ok: false, message: t('找不到插槽「{0}」', slotName) }

  const skin = bundle.maps.skinOfSlot[slotIndex]
  const attachments = skin >= 0 ? bundle.maps.skinArr[skin].attachments : []
  const display = attachments[bundle.skeleton.slotDisplayIndex[slotIndex]]
  const armature =
    display && display.type === AttachmentType.Armature
      ? display
      : attachments.find((item) => item.type === AttachmentType.Armature)
  if (!armature) return { ok: false, message: t('插槽「{0}」上没有嵌套骨架', slotName) }

  const at = useTimelineStore.getState().time
  // 未显式覆盖的参数：优先沿用**当前位置已生效的那一帧**（改动画名不该把次数/偏移/倍速重置回 setup）
  const doc = useProjectStore.getState().document
  const currentTrack = doc.animations
    .find((item) => item.name === animationName)
    ?.slots.find((item) => item.slot === slotName)
  const current = currentTrack ? sampleSubArmature(currentTrack.subArmature, at) : null
  const params = {
    animation: overrides?.animation ?? current?.animation ?? armature.subAnimation,
    playTimes: overrides?.playTimes ?? current?.playTimes ?? armature.subPlayTimes,
    offset: overrides?.offset ?? current?.offset ?? armature.subOffset,
    speed: overrides?.speed ?? current?.speed ?? armature.subSpeed
  }
  useProjectStore.getState().update(t('打子骨架控制帧'), (draft) => {
    const animation = draft.animations.find((item) => item.name === animationName)
    if (!animation) return
    keySlotSubArmature(animation, slotName, at, params)
  })
  useTimelineStore.getState().notifyKeyed(`slot:${slotName}:subArmature`, at)
  useTimelineStore.getState().setSelectedKeys([
    { kind: 'slot', target: slotName, attachment: '', channel: 'subArmature', time: at }
  ])
  return {
    ok: true,
    message: params.animation
      ? t('已在 {0}s 打「{1}」的子骨架帧 → 「{2}」', [at.toFixed(2), slotName, params.animation])
      : t('已在 {0}s 打「{1}」的子骨架帧（setup 姿态）', [at.toFixed(2), slotName])
  }
}

/** 事件名默认取 `event`、`event2`…（避开已用过的名字） */
function nextEventName(events: readonly EventKeyframe[]): string {
  const used = new Set(events.map((event) => event.name))
  if (!used.has('event')) return 'event'
  for (let i = 2; i < 10000; i++) {
    const candidate = `event${i}`
    if (!used.has(candidate)) return candidate
  }
  return `event${events.length + 1}`
}

/**
 * 在当前播放头位置插入一个**事件帧**（时间轴最上面那条事件轨）。
 *
 * 事件帧只有「时间 + 事件名 + 字符串 / 整数 / 浮点参数」（见 `EventKeyframe`）：
 * 运行期由 `AnimationPlayer.fireEvents` 在越过该时刻时触发（含循环回绕），
 * 导出到 spine / DragonBones 也带着它 —— 之前缺的就是这里的创建入口。
 *
 * 名字按 `event` / `event2`… 递增，插入后**立刻选中它**：视口下方的值栏会直接给出
 * 改名与三个参数的输入框，不用再去轨道里把它找出来。
 */
export function keyEventNow(): ActionResult {
  const animScope = resolveAnimationName()
  if (!animScope) return { ok: false, message: noAnimationMessage() }
  // 与 dope sheet 新建关键帧同一取整口径（4 位小数），保证键 id / 选中判定稳定
  const at = Math.round(useTimelineStore.getState().time * 1e4) / 1e4
  let name = ''
  useProjectStore.getState().update(t('添加事件帧'), (draft) => {
    const animation = draft.animations.find((item) => item.name === animScope)
    if (!animation) return
    name = nextEventName(animation.events)
    animation.events.push({ time: at, name, stringParam: '', intParam: 0, floatParam: 0 })
    animation.events.sort((a, b) => a.time - b.time)
    // 时长是「可编辑范围」：事件落在末尾之外时同步延长（只增不减）
    syncDuration(animation)
  })
  if (!name) return { ok: false, message: t('找不到动画「{0}」', animScope) }

  const timeline = useTimelineStore.getState()
  // 事件轨固定在最上面，这里主要借高亮闪一下，确认「帧确实加上了」
  timeline.notifyKeyed('event', at)
  timeline.setSelectedKeys([{ kind: 'event', target: name, attachment: '', channel: name, time: at }])
  return {
    ok: true,
    message: t('已在 {0}s 添加事件帧「{1}」（在视口下方值栏改名 / 设参数）', [at.toFixed(2), name])
  }
}

/**
 * 在当前时间点为选中对象打关键帧（捕获运行时姿态）。
 * 需要 Animate 状态 + 已选动画 + 有效的运行时 bundle。
 */
export function keyframeNow(): ActionResult {
  const scene = getActiveScene()
  if (!scene) return { ok: false, message: t('视口尚未就绪') }
  const bundle = scene.runtime
  if (!bundle) return { ok: false, message: t('没有可打关键帧的骨架') }
  const animScope = resolveAnimationName()
  if (!animScope) return { ok: false, message: noAnimationMessage() }
  const timeline = useTimelineStore.getState()
  const animationName = animScope

  // 时间轴上点了某条子轨道（如插槽的「显示」）就只打那一条；否则按选中对象的全部通道打
  const focusedTrack = timeline.selectedTrack
  const targets: KeyframeTarget[] = focusedTrack
    ? [
        {
          kind: focusedTrack.kind as KeyKind,
          target: focusedTrack.target,
          attachment: focusedTrack.attachment,
          channel: focusedTrack.channel
        }
      ]
    : selectionTargets(useSelectionStore.getState())
  if (targets.length === 0) return { ok: false, message: t('请先选中骨骼、插槽、网格附件或约束') }
  const trackLabel = focusedTrack
    ? t('「{0}」', trackLabelOf({ kind: focusedTrack.kind, target: focusedTrack.target, channel: focusedTrack.channel }))
    : ''

  let count = 0
  useProjectStore.getState().update(t('打关键帧'), (draft) => {
    count = keyframeTargets(draft, animationName, snapshotPose(bundle), targets, timeline.time, draft.editorMeta.activeSkin)
  })
  if (count > 0) {
    // 与右键菜单一致：滚到该轨道并高亮（K 键打帧同样不该「悄无声息」）
    useTimelineStore.getState().notifyKeyed(trackIdOf(targets[0]), timeline.time)
  }

  return count > 0
    ? {
        ok: true,
        message: focusedTrack
          ? t('已在 {0}s 为{1}打关键帧', [timeline.time.toFixed(2), trackLabel])
          : t('已在 {0}s 打了 {1} 处关键帧', [timeline.time.toFixed(2), count])
      }
    : { ok: false, message: t('当前对象没有可打关键帧的数据（FFD 需要先编辑过顶点）') }
}

/** 删除 dope sheet 里选中的关键帧 */
export function removeSelectedKeys(): ActionResult {
  const timeline = useTimelineStore.getState()
  if (timeline.selectedKeys.length === 0) return { ok: false, message: t('先在 dope sheet 里选中关键帧') }
  let removed = 0
  useProjectStore.getState().update(t('删除关键帧'), (draft) => {
    removed = deleteKeys(draft, timeline.currentAnimation, timeline.selectedKeys)
  })
  timeline.setSelectedKeys([])
  return { ok: true, message: t('已删除 {0} 个关键帧', removed) }
}

/** 收集某条通道（轨道）当前的全部关键帧选择器：按 kind / target / attachment / channel 精确定位 */
function selectorsOfFocus(animation: AuthoringAnimData | null, focus: KeySelector): KeySelector[] {
  if (!animation) return []
  return buildTimeline(animation)
    .flatMap((track) => track.keys)
    .filter(
      (key) =>
        key.kind === focus.kind &&
        key.target === focus.target &&
        // 通道行本身不带附件名（display 的关键帧却带每帧的 display 名、deform 带附件名）：
        // focus.attachment 为空时按「整条通道」匹配；只有 deform 这类行才用它精确到某个附件
        (!focus.attachment || key.attachment === focus.attachment) &&
        (!focus.channel || key.channel === focus.channel)
    )
    .map((key) => ({
      kind: key.kind,
      target: key.target,
      attachment: key.attachment,
      channel: key.channel,
      time: key.time
    }))
}

/**
 * 删除**当前选中的整条通道**（轨道）：把它名下的关键帧一次性删掉。
 *
 * 走的是与「删除选中关键帧」同一条数据链路，因此事件、插槽层级（绘制顺序）
 * 这类特殊轨也一样支持；删空后由数据层清理空轨道并同步动画时长。
 */
export function deleteSelectedTrack(): ActionResult {
  const timeline = useTimelineStore.getState()
  const focus = timeline.selectedTrack
  if (!focus) return { ok: false, message: t('先在时间轴上点选一条通道，再按 Delete 删除它') }
  return deleteTrack(focus as KeySelector)
}

/**
 * 删除**指定通道**（时间轴行尾的垃圾桶图标 / 键盘 Delete 共用）。
 *
 * 与 `deleteSelectedTrack` 的区别只是入口：图标点的是「这一行」，不需要先选中它。
 *
 * 时间轴上的行都来自真实关键帧（没打过帧的通道不占行），所以删完这一行的帧、
 * 轨道空了之后就由数据层一并清掉，行随之消失 —— 不存在「只能藏起来的空行」。
 */
export function deleteTrack(focus: KeySelector): ActionResult {
  const timeline = useTimelineStore.getState()
  const animation =
    useProjectStore.getState().document.animations.find((item) => item.name === timeline.currentAnimation) ?? null
  if (!animation) return { ok: false, message: noAnimationMessage() }
  const label = trackLabelOf(focus)
  const selectors = selectorsOfFocus(animation, focus)
  if (selectors.length === 0) return { ok: false, message: t('通道「{0}」已经没有关键帧了', label) }

  let removed = 0
  // runCommand：一帧都没删掉时不写撤销记录
  useProjectStore.getState().runCommand(t('删除动画通道'), (draft) => {
    removed = deleteKeys(draft, timeline.currentAnimation, selectors)
    // 删光后把空轨道也清掉：否则工程文件里会留下一条「0 帧但存在」的插槽/骨骼轨道
    const target = draft.animations.find((item) => item.name === timeline.currentAnimation)
    if (target) pruneEmptyTracks(target)
    return removed > 0
  })
  timeline.setSelectedKeys([])
  return removed > 0
    ? { ok: true, message: t('已删除通道「{0}」（{1} 个关键帧）', [label, removed]) }
    : { ok: false, message: t('通道「{0}」没有可删除的关键帧', label) }
}

/**
 * 清理帧：把**当前动画**里没有任何关键帧的轨道条目一次性删掉。
 *
 * 时间轴上的行都由数据生成，但工程数据里可能残留「0 帧但存在」的轨道（导入、早期版本、
 * 或反复打帧 / 删帧后的边角），它们会占着数据、也可能在别处冒出空行。
 * 这里复用删帧后的同一套清理（`pruneEmptyTracks`），覆盖骨骼 / 插槽（显示·颜色·可见性·子骨架）/
 * FFD / 约束 —— 也就是时间轴上能显示的所有轨道类型。
 */
export function cleanupEmptyTracks(): ActionResult {
  const timeline = useTimelineStore.getState()
  const animation =
    useProjectStore.getState().document.animations.find((item) => item.name === timeline.currentAnimation) ?? null
  if (!animation) return { ok: false, message: noAnimationMessage() }

  let removed = 0
  useProjectStore.getState().runCommand(t('清理帧'), (draft) => {
    const target = draft.animations.find((item) => item.name === timeline.currentAnimation)
    if (!target) return false
    const before = countTrackEntries(target)
    pruneEmptyTracks(target)
    removed = before - countTrackEntries(target)
    return removed > 0
  })
  return removed > 0
    ? { ok: true, message: t('已清理 {0} 条没有关键帧的通道', removed) }
    : { ok: true, message: t('当前动画没有空通道需要清理') }
}

/** 轨道条目数（骨骼 / 插槽 / FFD / 约束）：清理前后对比，用来回报「清掉了几条」 */
function countTrackEntries(anim: AuthoringAnimData): number {
  return anim.bones.length + anim.slots.length + anim.deforms.length + anim.constraints.length
}

/**
 * 给**一条骨骼通道**写入一个**明确的值** —— 也就是「改值即打帧」：Animate 态下改一个数就是
 * 把当前帧的关键帧写成这个值（视口 gizmo 拖拽也是这么干的，见 `writeBoneValue`）。
 *
 * 与 `keyframeTargetsNow` 只差值的来源：那个从运行时姿态捕获，这个直接用调用方给的数；
 * 收尾完全一致（同步时长 / 时间轴滚到该轨道并高亮 / 选中刚打的帧）。
 * 不写运行时姿态：姿态会被下一次采样冲掉（播放、拖时间、任何一次文档编辑都会重采样），
 * 只改姿态等于「输进去的数字一会儿自己变回去」。
 *
 * 提示文案里不回报数值：调用方（视口属性打帧条）显示的是像素 / 度这类界面单位，
 * 而这里的 value 是文档单位（世界单位 / 度 / 比例），报出来会和输入框里的数对不上。
 */
export function setBoneChannelNow(bone: string, channel: BoneChannel, value: number | Vec2): ActionResult {
  const animScope = resolveAnimationName()
  if (!animScope) return { ok: false, message: noAnimationMessage() }
  const at = useTimelineStore.getState().time
  const label = trackLabelOf({ kind: 'bone', target: bone, channel })
  let written = false
  useProjectStore.getState().update(t('{0}关键帧', label), (draft) => {
    const animation = draft.animations.find((item) => item.name === animScope)
    if (!animation) return
    keyBoneChannel(animation, bone, channel, at, value)
    // 帧落在动画时长之外时同步延长（与时间轴打帧同一套兜底）
    syncDuration(animation)
    written = true
  })
  if (!written) return { ok: false, message: t('找不到动画「{0}」', animScope) }

  useTimelineStore.getState().notifyKeyed(`bone:${bone}:${channel}`, at)
  useTimelineStore.getState().setSelectedKeys([{ kind: 'bone', target: bone, attachment: '', channel, time: at }])
  return { ok: true, message: t('已在 {0}s 打「{1}」关键帧', [at.toFixed(2), label]) }
}

/** 通道名 → 当前语言下的 label（提示文案用） */
function trackLabelOf(focus: { kind: string; target: string; channel: string }): string {
  const channel = channelLabel(focus.channel)
  if (focus.kind === 'drawOrder') return t('插槽层级')
  if (focus.kind === 'event') return t('事件 {0}', focus.target)
  // 分组行没有通道名：只报对象名，别留一个「 · 」尾巴
  if (focus.kind === 'bone' || focus.kind === 'slot') {
    return channel ? `${focus.target} · ${channel}` : focus.target
  }
  if (focus.kind === 'deform') return `${focus.target} · FFD`
  return focus.target || channel
}

/** 通道 key → 文案；未知通道原样返回（约束名之类） */
function channelLabel(channel: string): string {
  if (channel === 'translate') return t('位置')
  if (channel === 'rotate') return t('旋转')
  if (channel === 'scale') return t('缩放')
  if (channel === 'shear') return t('斜切')
  if (channel === 'display') return t('显示')
  if (channel === 'color') return t('颜色')
  if (channel === 'visible') return t('可见性')
  if (channel === 'order') return t('绘制顺序')
  if (channel === 'offsets') return 'FFD'
  return channel
}

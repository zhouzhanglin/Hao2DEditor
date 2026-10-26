import { Easing } from '@core/model/animation'
import type { KeyframeBase } from '@core/model/animation'
import type { AuthoringAnimData, AuthoringSkin, EditorDocument } from '@core/model/authoring'
import { hexToRgba } from '@core/util/color'
import {
  keyBoneChannel,
  keyDeform,
  keyDrawOrder,
  keySlotColor,
  keySlotDisplay,
  keySlotSubArmature,
  keySlotVisible,
  removeBoneKeyframe,
  removeDeformKeyframe
} from './animationCommands'
import type { BoneChannel } from './animationCommands'
import { findSkinSlot } from './authoringCommands'
import type { Vec2 } from './skeletonOps'

/**
 * 关键帧操作：给 AI 用的「打帧 / 删帧 / 改帧」。
 *
 * 与 `animationCommands` 的分工：那边是**轨道层**的写入原语（要自己 ensure 轨道、
 * 还要懂 displayIndex 与 displayAttachment 必须成对排序这类坑），这边是**语义层**：
 * AI 只说「给 arm 在 0.5 秒打个旋转帧 30 度」，由这里负责解析成正确的轨道与下标。
 *
 * 时间单位一律是**秒**（与工程文件、时间轴标尺一致）。
 */

type Vec2Like = Vec2

/** 取要操作的动画：不传名字就用当前编辑中的动画 */
export function requireAnimation(doc: EditorDocument, name?: string): AuthoringAnimData {
  const target = name?.trim() || doc.editorMeta.activeAnimation
  const anim = doc.animations.find((item) => item.name === target)
  if (anim) return anim
  if (doc.animations.length === 0) throw new Error('还没有任何动画：先用 addAnimation 建一条')
  throw new Error(`动画不存在：${target || '(空)'}（现有：${doc.animations.map((item) => item.name).join(' / ')}）`)
}

export function requireSlot(doc: EditorDocument, name: string): EditorDocument['slots'][number] {
  const slot = doc.slots.find((item) => item.name === name)
  if (!slot) throw new Error(`插槽不存在：${name}（用 listSlots 查现有插槽名）`)
  return slot
}

/** 皮肤：按名字找，不传就用当前皮肤，再退回第一套 */
export function pickSkin(doc: EditorDocument, name?: string): AuthoringSkin | null {
  if (name) {
    const named = doc.skins.find((skin) => skin.name === name)
    if (!named) throw new Error(`皮肤不存在：${name}（用 listSkins 查现有皮肤名）`)
    return named
  }
  return doc.skins.find((skin) => skin.name === doc.editorMeta.activeSkin) ?? doc.skins[0] ?? null
}

function requireTime(time: number): number {
  if (!Number.isFinite(time) || time < 0) throw new Error(`time 必须是不小于 0 的数字（单位：秒），收到 ${time}`)
  return time
}

// ---------------- 骨骼变换通道 ----------------

export interface KeyBoneFrameOptions {
  animation?: string
  bone: string
  channel: BoneChannel
  /** 秒 */
  time: number
  /** rotate 传数字（度）；translate / scale / shear 传 {x,y}，传单个数字表示 x = y */
  value: number | Vec2Like
}

/** 给某根骨骼的某个变换通道打一帧（同时间点重复打即覆盖） */
export function keyBoneFrame(
  doc: EditorDocument,
  options: KeyBoneFrameOptions
): { animation: string; bone: string; channel: BoneChannel; time: number; value: number | Vec2Like } {
  if (!doc.bones.some((bone) => bone.name === options.bone)) {
    throw new Error(`骨骼不存在：${options.bone}（用 listBones 查现有骨骼名）`)
  }
  if (options.channel === 'rotate') {
    if (typeof options.value !== 'number') throw new Error('rotate 通道的 value 要传数字（度）')
  } else if (typeof options.value !== 'number' && (typeof options.value !== 'object' || options.value === null)) {
    throw new Error(`${options.channel} 通道的 value 要传 {x,y} 或单个数字`)
  }
  const anim = requireAnimation(doc, options.animation)
  const time = requireTime(options.time)
  keyBoneChannel(anim, options.bone, options.channel, time, options.value)
  return { animation: anim.name, bone: options.bone, channel: options.channel, time, value: options.value }
}

export interface RemoveBoneFrameOptions {
  animation?: string
  bone: string
  channel: BoneChannel
  time: number
}

/** 删掉某个通道在指定时间点的关键帧 */
export function removeBoneFrame(doc: EditorDocument, options: RemoveBoneFrameOptions): { removed: boolean; animation: string } {
  const anim = requireAnimation(doc, options.animation)
  const removed = removeBoneKeyframe(anim, options.bone, options.channel, requireTime(options.time))
  return { removed, animation: anim.name }
}

// ---------------- 插槽通道 ----------------

export interface KeySlotDisplayFrameOptions {
  animation?: string
  slot: string
  time: number
  /** 要显示的附件名；空串 = 这一帧起不显示 */
  attachment: string
  /** 皮肤，默认当前皮肤 */
  skin?: string
}

/**
 * 打一帧「显示哪个附件」（换装动画的基础）。
 *
 * 这里把附件名翻译成运行期需要的下标：AI 只认名字，下标由编辑器算 ——
 * 让 AI 自己数下标，附件一增删就全错位了。
 */
export function keySlotDisplayFrame(
  doc: EditorDocument,
  options: KeySlotDisplayFrameOptions
): { animation: string; slot: string; time: number; attachment: string; displayIndex: number } {
  const anim = requireAnimation(doc, options.animation)
  const slot = requireSlot(doc, options.slot)
  const time = requireTime(options.time)
  const name = options.attachment ?? ''
  let displayIndex = -1
  if (name) {
    const skin = pickSkin(doc, options.skin)
    const skinSlot = skin ? findSkinSlot(skin, slot.name) : null
    displayIndex = skinSlot ? skinSlot.attachments.findIndex((item) => item.name === name) : -1
    if (displayIndex < 0) {
      throw new Error(
        `插槽「${slot.name}」在皮肤「${skin?.name ?? '(无)'}」里没有附件「${name}」（用 listDisplays 查该插槽下的附件名）`
      )
    }
  }
  keySlotDisplay(anim, slot.name, time, displayIndex, name)
  return { animation: anim.name, slot: slot.name, time, attachment: name, displayIndex }
}

export interface KeySlotVisibleFrameOptions {
  animation?: string
  slot: string
  time: number
  visible: boolean
}

export function keySlotVisibleFrame(
  doc: EditorDocument,
  options: KeySlotVisibleFrameOptions
): { animation: string; slot: string; time: number; visible: boolean } {
  const anim = requireAnimation(doc, options.animation)
  const slot = requireSlot(doc, options.slot)
  const time = requireTime(options.time)
  keySlotVisible(anim, slot.name, time, options.visible !== false)
  return { animation: anim.name, slot: slot.name, time, visible: options.visible !== false }
}

export interface KeySlotColorFrameOptions {
  animation?: string
  slot: string
  time: number
  /** `#RRGGBB` / `#RRGGBBAA` */
  color: string
}

export function keySlotColorFrame(
  doc: EditorDocument,
  options: KeySlotColorFrameOptions
): { animation: string; slot: string; time: number; color: string } {
  const anim = requireAnimation(doc, options.animation)
  const slot = requireSlot(doc, options.slot)
  const time = requireTime(options.time)
  const rgba = hexToRgba(options.color, { r: 1, g: 1, b: 1, a: 1 })
  keySlotColor(anim, slot.name, time, rgba)
  return { animation: anim.name, slot: slot.name, time, color: options.color }
}

export interface KeySlotSubArmatureFrameOptions {
  animation?: string
  slot: string
  time: number
  /** 子骨架里要播的动画名；空串 = 回 setup 姿态 */
  clip: string
  /** 播放次数：0 或负数 = 无限循环（每轮从 offset 起播） */
  playTimes?: number
  /** 起始偏移（秒），即从子动画的第几秒开始 */
  offset?: number
  /** 倍速，1 = 原速 */
  speed?: number
}

/**
 * 打一帧「嵌套骨架播什么」（子骨架通道）。
 *
 * 只写动画名 / 次数 / 偏移 / 倍速这 4 个语义参数，轨道与帧排序交给 `keySlotSubArmature`；
 * 插槽上没挂嵌套骨架时直接报错 —— 否则会静默写出一条永远不生效的轨道。
 */
export function keySlotSubArmatureFrame(
  doc: EditorDocument,
  options: KeySlotSubArmatureFrameOptions
): {
  animation: string
  slot: string
  time: number
  clip: string
  playTimes: number
  offset: number
  speed: number
} {
  const anim = requireAnimation(doc, options.animation)
  const slot = requireSlot(doc, options.slot)
  const time = requireTime(options.time)
  const hasNest = doc.skins.some((skin) =>
    skin.slots.some(
      (item) => item.slot === slot.name && item.attachments.some((attachment) => attachment.type === 'armature')
    )
  )
  if (!hasNest) {
    throw new Error(`插槽「${slot.name}」上没有嵌套骨架 display（先用 nestArmature 把别的骨架挂上来）`)
  }
  const clip = options.clip ?? ''
  // 0 与负数都表示循环（负数写法让人一眼看出不是 1 次），这里只做取整
  const playTimes = Math.round(options.playTimes ?? 0)
  const offset = options.offset ?? 0
  const speed = options.speed ?? 1
  if (!Number.isFinite(offset)) throw new Error(`offset 必须是数字（秒），收到 ${offset}`)
  if (!Number.isFinite(speed) || speed < 0) throw new Error(`speed 必须是不小于 0 的数字，收到 ${speed}`)
  keySlotSubArmature(anim, slot.name, time, { animation: clip, playTimes, offset, speed })
  return { animation: anim.name, slot: slot.name, time, clip, playTimes, offset, speed }
}

export interface KeyDrawOrderFrameOptions {
  animation?: string
  time: number
  /** 完整插槽名序列，**第 0 个最先画（最底层）**；不传则按当前 setup 的层序 */
  order?: string[]
}

/** 打一帧绘制顺序（整帧离散值，重复打即覆盖） */
export function keyDrawOrderFrame(
  doc: EditorDocument,
  options: KeyDrawOrderFrameOptions
): { animation: string; time: number; order: string[] } {
  const anim = requireAnimation(doc, options.animation)
  const time = requireTime(options.time)
  let order: string[]
  if (options.order && options.order.length > 0) {
    const known = new Set(doc.slots.map((slot) => slot.name))
    const unknown = options.order.filter((name) => !known.has(name))
    if (unknown.length > 0) throw new Error(`绘制顺序里有不存在的插槽：${unknown.join(' / ')}（用 listSlots 查）`)
    const missing = doc.slots.filter((slot) => !options.order!.includes(slot.name)).map((slot) => slot.name)
    if (missing.length > 0) {
      // 绘制顺序帧是「完整顺序」的整帧：漏掉插槽会让它们在这帧之后消失
      throw new Error(`绘制顺序必须是完整序列，漏了：${missing.join(' / ')}`)
    }
    order = [...options.order]
  } else {
    order = [...doc.slots].sort((a, b) => a.zOrder - b.zOrder).map((slot) => slot.name)
  }
  keyDrawOrder(anim, time, order)
  return { animation: anim.name, time, order }
}

// ---------------- FFD ----------------

export interface KeyDeformFrameOptions {
  animation?: string
  slot: string
  attachment: string
  time: number
  /** 满顶点长度的 [x0,y0,x1,y1,...]；全 0 = 该帧复位 */
  offsets: number[]
}

/** 打一帧 FFD（网格顶点偏移） */
export function keyDeformFrame(
  doc: EditorDocument,
  options: KeyDeformFrameOptions
): { animation: string; slot: string; attachment: string; time: number; vertexCount: number } {
  const anim = requireAnimation(doc, options.animation)
  const slot = requireSlot(doc, options.slot)
  const time = requireTime(options.time)
  const attachment = findAttachmentOrThrow(doc, slot.name, options.attachment)
  if (
    attachment.type !== 'mesh' &&
    attachment.type !== 'linkedmesh' &&
    attachment.type !== 'clipping'
  ) {
    throw new Error(
      `附件「${options.attachment}」不是网格/遮罩，打不了 FFD（网格先用 convertToMesh；遮罩用 createMask / convertToMask）`
    )
  }
  const vertexCount = attachment.vertices.length
  if (options.offsets.length !== vertexCount * 2) {
    // 长度对不上会写出一帧错位的 FFD，播放时网格直接变形错乱 —— 这里必须挡住
    throw new Error(
      `offsets 长度必须是点数的 2 倍：该附件有 ${vertexCount} 个点（网格顶点 / 遮罩控制点），需要 ${vertexCount * 2} 个数字，收到 ${options.offsets.length}`
    )
  }
  keyDeform(anim, slot.name, options.attachment, time, options.offsets)
  return { animation: anim.name, slot: slot.name, attachment: options.attachment, time, vertexCount }
}

export interface RemoveDeformFrameOptions {
  animation?: string
  slot: string
  attachment: string
  time: number
}

export function removeDeformFrame(
  doc: EditorDocument,
  options: RemoveDeformFrameOptions
): { removed: boolean; animation: string } {
  const anim = requireAnimation(doc, options.animation)
  const removed = removeDeformKeyframe(anim, options.slot, options.attachment, requireTime(options.time))
  return { removed, animation: anim.name }
}

// ---------------- 帧的通用操作：改时间 / 改缓动 / 清轨道 ----------------

export type KeyKind = 'bone' | 'slot' | 'deform' | 'drawOrder'

type Frames = KeyframeBase[]

/** 按「种类 + 目标 + 通道」定位到实际的关键帧数组（AI 侧不用知道内部结构） */
function framesOf(
  doc: EditorDocument,
  anim: AuthoringAnimData,
  kind: KeyKind,
  target: string,
  channel: string,
  attachment?: string
): Frames {
  if (kind === 'drawOrder') return anim.drawOrder as unknown as Frames
  if (kind === 'bone') {
    const track = anim.bones.find((item) => item.bone === target)
    if (!track) throw new Error(`动画「${anim.name}」里没有骨骼「${target}」的轨道`)
    return track[channel as BoneChannel] as unknown as Frames
  }
  if (kind === 'slot') {
    if (!doc.slots.some((slot) => slot.name === target)) throw new Error(`插槽不存在：${target}`)
    const track = anim.slots.find((item) => item.slot === target)
    if (!track) throw new Error(`动画「${anim.name}」里没有插槽「${target}」的轨道`)
    if (channel === 'display') return track.displayIndex as unknown as Frames
    if (channel === 'color') return track.color as unknown as Frames
    if (channel === 'visible') return track.visible as unknown as Frames
    // 嵌套骨架通道：帧是对象（动画名 + 次数 / 偏移 / 倍速），但「按时间定位」的语义与其它轨道一致
    if (channel === 'subArmature') return (track.subArmature ?? []) as unknown as Frames
    throw new Error(`插槽通道只能是 display / color / visible / subArmature，收到 ${channel}`)
  }
  const track = anim.deforms.find((item) => item.slot === target && item.attachment === (attachment ?? ''))
  if (!track) throw new Error(`动画「${anim.name}」里没有 ${target} / ${attachment ?? ''} 的 FFD 轨道`)
  return track.frames as unknown as Frames
}

export interface KeyTargetOptions {
  animation?: string
  kind: KeyKind
  /** 骨骼名 / 插槽名；kind = drawOrder 时忽略 */
  target?: string
  /** kind = deform 时的附件名 */
  attachment?: string
  /** bone: translate/rotate/scale/shear；slot: display/color/visible/subArmature */
  channel?: string
}

export interface MoveKeyframeOptions extends KeyTargetOptions {
  from: number
  to: number
}

/**
 * 把一帧从 `from` 挪到 `to` 秒。
 *
 * 落点已有帧时**覆盖**它（同一时间点只允许一帧）。
 * display 通道会连名字一起搬 —— 名字是按下标并行存的，只搬帧会让显示项错位。
 */
export function moveKeyframe(
  doc: EditorDocument,
  options: MoveKeyframeOptions
): { moved: boolean; from: number; to: number; animation: string } {
  const anim = requireAnimation(doc, options.animation)
  const from = requireTime(options.from)
  const to = requireTime(options.to)
  const frames = framesOf(doc, anim, options.kind, options.target ?? '', options.channel ?? '', options.attachment)
  const index = frames.findIndex((frame) => Math.abs(frame.time - from) < 1e-4)
  if (index < 0) throw new Error(`没有落在 ${from} 秒的关键帧`)
  if (Math.abs(from - to) < 1e-4) return { moved: false, from, to, animation: anim.name }

  if (options.kind === 'slot' && options.channel === 'display') {
    const track = anim.slots.find((item) => item.slot === options.target)
    if (track) {
      // displayIndex 与 displayAttachment 成对搬：否则播放时这一帧会显示成别的附件
      const name = track.displayAttachment[index] ?? ''
      track.displayIndex.splice(index, 1)
      track.displayAttachment.splice(index, 1)
      const collision = track.displayIndex.findIndex((frame) => Math.abs(frame.time - to) < 1e-4)
      if (collision >= 0) {
        track.displayIndex.splice(collision, 1)
        track.displayAttachment.splice(collision, 1)
      }
      const frame = frames[index]
      frame.time = to
      const pairs = track.displayIndex.map((item, i) => ({ frame: item, name: track.displayAttachment[i] ?? '' }))
      pairs.push({ frame: frame as unknown as (typeof track.displayIndex)[number], name })
      pairs.sort((left, right) => left.frame.time - right.frame.time)
      track.displayIndex = pairs.map((pair) => pair.frame)
      track.displayAttachment = pairs.map((pair) => pair.name)
      return { moved: true, from, to, animation: anim.name }
    }
  }

  const collision = frames.findIndex((frame, i) => i !== index && Math.abs(frame.time - to) < 1e-4)
  if (collision >= 0) frames.splice(collision, 1)
  const moved = frames.find((frame) => Math.abs(frame.time - from) < 1e-4) ?? frames[index]
  moved.time = to
  frames.sort((left, right) => left.time - right.time)
  return { moved: true, from, to, animation: anim.name }
}

export interface SetKeyEasingOptions extends KeyTargetOptions {
  time: number
  easing: 'linear' | 'stepped' | 'bezier'
  /** bezier 的 4 个控制量 [cx1, cy1, cx2, cy2] */
  curve?: number[]
}

const EASING_BY_NAME: Record<string, Easing> = {
  linear: Easing.Linear,
  stepped: Easing.Stepped,
  bezier: Easing.Bezier
}

/** 改某一帧的缓动（bezier 必须同时给 curve，否则退回 linear） */
export function setKeyEasing(
  doc: EditorDocument,
  options: SetKeyEasingOptions
): { ok: boolean; easing: string; animation: string } {
  const anim = requireAnimation(doc, options.animation)
  const time = requireTime(options.time)
  const frames = framesOf(doc, anim, options.kind, options.target ?? '', options.channel ?? '', options.attachment)
  const frame = frames.find((item) => Math.abs(item.time - time) < 1e-4)
  if (!frame) throw new Error(`没有落在 ${time} 秒的关键帧`)
  const easing = EASING_BY_NAME[options.easing]
  if (easing === undefined) throw new Error(`easing 只能是 linear / stepped / bezier，收到 ${options.easing}`)
  if (easing === Easing.Bezier && (!options.curve || options.curve.length !== 4)) {
    throw new Error('easing = bezier 时必须给 curve：[cx1, cy1, cx2, cy2]（4 个数字）')
  }
  frame.easing = easing
  frame.curve = easing === Easing.Bezier ? [...options.curve!] : null
  return { ok: true, easing: options.easing, animation: anim.name }
}

export interface ClearTrackOptions extends KeyTargetOptions {
  /** 只删某一帧时传它（秒） */
  time?: number
}

/** 清空一条轨道（或轨道上的某一帧） */
export function clearTrack(
  doc: EditorDocument,
  options: ClearTrackOptions
): { cleared: number; animation: string } {
  const anim = requireAnimation(doc, options.animation)
  const frames = framesOf(doc, anim, options.kind, options.target ?? '', options.channel ?? '', options.attachment)
  if (options.time === undefined) {
    const count = frames.length
    frames.length = 0
    return { cleared: count, animation: anim.name }
  }
  const time = requireTime(options.time)
  const kept = frames.filter((frame) => Math.abs(frame.time - time) >= 1e-4)
  const cleared = frames.length - kept.length
  frames.length = 0
  frames.push(...kept)
  return { cleared, animation: anim.name }
}

/** 清空整条动画的关键帧（保留动画本身与时长），用于「重做一遍」 */
export function clearAnimation(doc: EditorDocument, name?: string): { animation: string } {
  const anim = requireAnimation(doc, name)
  anim.bones = []
  anim.slots = []
  anim.deforms = []
  anim.drawOrder = []
  return { animation: anim.name }
}

function findAttachmentOrThrow(doc: EditorDocument, slotName: string, attachmentName: string) {
  for (const skin of doc.skins) {
    const skinSlot = findSkinSlot(skin, slotName)
    const found = skinSlot?.attachments.find((item) => item.name === attachmentName)
    if (found) return found
  }
  throw new Error(`找不到附件：${slotName} / ${attachmentName}（用 listDisplays 查插槽下的附件名）`)
}

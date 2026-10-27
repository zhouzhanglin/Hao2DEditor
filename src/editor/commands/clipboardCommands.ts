import type { AuthoringBone } from '@core/model/authoring'
import { rootBoneName } from '@core/model/authoring'
import { uniqueName } from './authoringCommands'
import { useClipboardStore } from '../store/clipboardStore'
import type { ClipboardNodeData } from '../store/clipboardStore'
import { useProjectStore } from '../store/projectStore'
import { useSelectionStore } from '../store/selectionStore'
import { useTimelineStore } from '../store/timelineStore'
import { useModeStore } from '../store/modeStore'
import { useTreeUiStore } from '../store/treeUiStore'
import { findKeyframe, pasteKeyframes as pasteKeyframesInto, type PasteKeyEntry } from '../timeline/model'
import { t } from '@i18n'

/**
 * 复制 / 粘贴 / 直接复制（Ctrl+C / Ctrl+V / Ctrl+D）。
 *
 * 两套内容共享一个内存剪贴板：层级树里的节点（骨骼 / 插槽，支持多节点一起复制）与
 * 时间轴上的关键帧（支持多帧一起复制与粘贴）。复制什么取决于当前上下文：
 * Animate 态且选中了关键帧 → 关键帧；否则 → 层级节点。
 */

// ---------------------------------------------------------------------------
// 节点复制 / 粘贴
// ---------------------------------------------------------------------------

/** 收集选中骨骼的全部后代（让粘贴出来的子树自包含） */
function withDescendants(boneNames: ReadonlySet<string>, all: readonly AuthoringBone[]): Set<string> {
  const collected = new Set(boneNames)
  let changed = true
  while (changed) {
    changed = false
    for (const bone of all) {
      if (collected.has(bone.name) || !bone.parent || !collected.has(bone.parent)) continue
      collected.add(bone.name)
      changed = true
    }
  }
  return collected
}

/** 在复制集内按「父先于子」排序，保证粘贴时父骨骼先建好 */
function boneDepth(name: string, set: ReadonlySet<string>, byName: ReadonlyMap<string, AuthoringBone>): number {
  let depth = 0
  let current: string | undefined = name
  while (current && set.has(current)) {
    depth++
    const bone = byName.get(current)
    current = bone?.parent || undefined
  }
  return depth
}

export function copyNodes(): number {
  const selection = useSelectionStore.getState()
  const document = useProjectStore.getState().document

  const collectedBones = withDescendants(new Set(selection.bones), document.bones)

  const slotNames = new Set<string>()
  if (selection.kind === 'slot' && selection.slot) slotNames.add(selection.slot)
  // 选中的骨骼（含其后代）上挂的插槽一并复制，让「复制一根骨骼」能带走它的显示内容
  for (const slot of document.slots) {
    if (collectedBones.has(slot.bone)) slotNames.add(slot.name)
  }

  const bones = document.bones.filter((b) => collectedBones.has(b.name)).map((b) => structuredClone(b))
  const slots = document.slots.filter((s) => slotNames.has(s.name)).map((s) => structuredClone(s))

  const skinSlots: ClipboardNodeData['skinSlots'] = []
  for (const skin of document.skins) {
    for (const skinSlot of skin.slots) {
      if (slotNames.has(skinSlot.slot)) {
        skinSlots.push({ slot: skinSlot.slot, attachments: structuredClone(skinSlot.attachments) })
      }
    }
  }

  if (bones.length === 0 && slots.length === 0) return 0
  useClipboardStore.getState().setContent({ kind: 'nodes', data: { bones, slots, skinSlots } })
  return bones.length + slots.length
}

export function pasteNodes(): number {
  const clip = useClipboardStore.getState().content
  if (!clip || clip.kind !== 'nodes') return 0
  const data = clip.data
  // 复制生成 / 粘贴节点时保持原层级：骨骼的父节点、slot 的挂载骨骼，都沿用被复制节点的
  // 原父节点；仅当该父节点本身也在被复制集合内时，才重映射到对应的新名字（否则会变成孤儿/错挂）。
  const copiedBoneSet = new Set(data.bones.map((b) => b.name))
  const byName = new Map(data.bones.map((b) => [b.name, b]))

  const newNames: string[] = []
  const rename = new Map<string, string>()
  /*
   * 顶层骨骼（`parent` 为空）粘贴后挂到层级根骨骼 root 下：结构上只允许一个根，
   * 复制 root 本身（连它整棵子树）不能粘出第二根与它平级的顶层骨骼。
   */
  const fallbackParent = rootBoneName(useProjectStore.getState().document.bones)
  useProjectStore.getState().update(t('粘贴节点'), (draft) => {
    const existingBones = draft.bones.map((b) => b.name)
    const existingSlots = draft.slots.map((s) => s.name)

    const sorted = [...data.bones].sort(
      (a, b) => boneDepth(a.name, copiedBoneSet, byName) - boneDepth(b.name, copiedBoneSet, byName)
    )
    for (const bone of sorted) {
      const newName = uniqueName(existingBones, bone.name)
      rename.set(bone.name, newName)
      existingBones.push(newName)
      const parent = rename.get(bone.parent) ?? bone.parent
      draft.bones.push({ ...structuredClone(bone), name: newName, parent: parent || fallbackParent })
    }

    for (const slot of data.slots) {
      const newName = uniqueName(existingSlots, slot.name)
      rename.set(slot.name, newName)
      existingSlots.push(newName)
      const bone = rename.get(slot.bone) ?? slot.bone
      draft.slots.push({ ...structuredClone(slot), name: newName, bone })
    }

    // 重建各皮肤里的插槽条目（含附件）
    for (const skin of draft.skins) {
      for (const entry of data.skinSlots) {
        const newSlot = rename.get(entry.slot)
        if (newSlot) skin.slots.push({ slot: newSlot, attachments: structuredClone(entry.attachments) })
      }
    }

    newNames.push(...rename.values())
  })

  // 折叠状态（层级树的 UI 本地状态）按源节点照搬到新节点：源节点折叠则新节点也折叠，
  // 让复制生成的层级在视觉上和源一致。注意 key 口径：骨骼直接存名字、插槽存 `slot:名字`。
  useTreeUiStore.getState().setCollapsed((prev) => {
    const next = new Set(prev)
    for (const bone of data.bones) {
      if (prev.has(bone.name)) {
        const nn = rename.get(bone.name)
        if (nn) next.add(nn)
      }
    }
    for (const slot of data.slots) {
      const key = `slot:${slot.name}`
      if (prev.has(key)) {
        const nn = rename.get(slot.name)
        if (nn) next.add(`slot:${nn}`)
      }
    }
    return next
  })

  const pastedBones = newNames.filter((name) =>
    useProjectStore.getState().document.bones.some((b) => b.name === name)
  )
  if (pastedBones.length > 0) useSelectionStore.getState().selectBones(pastedBones)
  return newNames.length
}

// ---------------------------------------------------------------------------
// 关键帧复制 / 粘贴
// ---------------------------------------------------------------------------

export function copyKeyframes(): number {
  const timeline = useTimelineStore.getState()
  if (timeline.selectedKeys.length === 0) return 0
  const document = useProjectStore.getState().document
  const animation = document.animations.find((a) => a.name === timeline.currentAnimation)
  if (!animation) return 0

  const entries: PasteKeyEntry[] = []
  for (const selector of timeline.selectedKeys) {
    const frame = findKeyframe(animation, selector)
    if (!frame) continue
    let displayName: string | undefined
    if (selector.kind === 'slot' && selector.channel === 'display') {
      const track = animation.slots.find((s) => s.slot === selector.target)
      if (track) {
        const index = track.displayIndex.findIndex((f) => Math.abs(f.time - selector.time) < 1e-4)
        if (index >= 0) displayName = track.displayAttachment[index] ?? ''
      }
    }
    entries.push({ selector: { ...selector }, frame: structuredClone(frame), displayName, time: selector.time })
  }
  if (entries.length === 0) return 0
  useClipboardStore.getState().setContent({
    kind: 'keyframes',
    data: { animation: animation.name, entries }
  })
  return entries.length
}

/** 粘贴到指定时间（默认当前播放头）；相对间距保持不变 */
export function pasteKeyframes(targetTime?: number): number {
  const clip = useClipboardStore.getState().content
  if (!clip || clip.kind !== 'keyframes') return 0
  const { animation: sourceAnim, entries } = clip.data
  const timeline = useTimelineStore.getState()
  // 优先贴进当前动画；若已切到 Pose 态（currentAnimation 被清空）则退回来源动画，避免粘贴失败
  const targetAnim = timeline.currentAnimation ?? sourceAnim

  const minTime = entries.reduce((min, e) => Math.min(min, e.selector.time), Number.POSITIVE_INFINITY)
  const target = targetTime ?? timeline.time
  const offset = minTime === Number.POSITIVE_INFINITY ? 0 : target - minTime

  const newEntries: PasteKeyEntry[] = entries.map((e) => ({
    selector: e.selector,
    frame: structuredClone(e.frame),
    displayName: e.displayName,
    time: Math.max(0, e.selector.time + offset)
  }))

  let count = 0
  useProjectStore.getState().update(t('粘贴关键帧'), (draft) => {
    count = pasteKeyframesInto(draft, targetAnim, newEntries)
  })

  if (count > 0) {
    useTimelineStore.getState().setSelectedKeys(newEntries.map((e) => ({ ...e.selector, time: e.time })))
    useTimelineStore.getState().setTime(target)
  }
  return count
}

// ---------------------------------------------------------------------------
// 上下文分发（供快捷键 / 菜单调用）
// ---------------------------------------------------------------------------

/** 复制当前上下文：Animate 态且选中关键帧 → 关键帧，否则 → 层级节点 */
export function copySelection(): number {
  if (useModeStore.getState().mode === 'animate' && useTimelineStore.getState().selectedKeys.length > 0) {
    return copyKeyframes()
  }
  return copyNodes()
}

/** 粘贴当前剪贴板内容 */
export function pasteSelection(): number {
  const clip = useClipboardStore.getState().content
  if (!clip) return 0
  return clip.kind === 'keyframes' ? pasteKeyframes() : pasteNodes()
}

/**
 * 直接复制生成（Ctrl+D）：复制当前选择并立即粘贴。
 * 关键帧粘贴到选中帧之后（避免原地覆盖）；节点粘贴到选中骨骼之下。
 */
export function duplicateSelection(): number {
  if (useModeStore.getState().mode === 'animate' && useTimelineStore.getState().selectedKeys.length > 0) {
    if (copyKeyframes() === 0) return 0
    const clip = useClipboardStore.getState().content
    if (!clip || clip.kind !== 'keyframes') return 0
    const frameRate = useProjectStore.getState().document.frameRate
    const step = frameRate > 0 ? 1 / frameRate : 1 / 30
    const maxTime = clip.data.entries.reduce((max, e) => Math.max(max, e.selector.time), 0)
    return pasteKeyframes(maxTime + step)
  }
  if (copyNodes() === 0) return 0
  return pasteNodes()
}

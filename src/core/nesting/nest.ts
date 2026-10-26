import type { EditorDocument } from '../model/authoring'
import type { RuntimeAsset } from '../model/asset'
import type { AttachmentData } from '../model/types'
import { AttachmentType } from '../model/types'
import type { SubArmatureKeyframe } from '../model/animation'
import { lowerBoundByTime } from '../model/animation'

/**
 * 骨架嵌套的纯逻辑：这里不碰 pixi、不碰 store，只做「数据 → 数」的换算，
 * 方便单测，也让运行期（编辑器视口 / 预览页）与导入器共用同一套规则。
 */

/** 嵌套层数上限：超过它基本可以断定是数据异常（A→B→A→… 的环或恶意构造） */
export const MAX_NEST_DEPTH = 8

export interface NestDisplay {
  slotIndex: number
  slotName: string
  attachment: AttachmentData
}

/** 某骨架里所有「嵌套骨架」附件（含各皮肤；调用方按当前皮肤再筛一次即可） */
export function armatureDisplays(asset: RuntimeAsset): NestDisplay[] {
  const out: NestDisplay[] = []
  const slotIndex = new Map<string, number>()
  asset.slots.forEach((slot, index) => slotIndex.set(slot.name, index))
  for (const skin of asset.skins) {
    for (const skinSlot of skin.slots) {
      const index = slotIndex.get(skinSlot.slotName)
      if (index === undefined) continue
      for (const attachment of skinSlot.attachments) {
        if (attachment.type !== AttachmentType.Armature) continue
        out.push({ slotIndex: index, slotName: skinSlot.slotName, attachment })
      }
    }
  }
  return out
}

/** 该骨架是否存在嵌套 display（层级树 / 时间轴决定要不要显示「子骨架」通道） */
export function hasArmatureDisplay(asset: RuntimeAsset): boolean {
  for (const skin of asset.skins) {
    for (const skinSlot of skin.slots) {
      if (skinSlot.attachments.some((attachment) => attachment.type === AttachmentType.Armature)) return true
    }
  }
  return false
}

export interface SubArmatureSample {
  animation: string
  playTimes: number
  offset: number
  speed: number
  /** 命中的关键帧时间（子时钟从它起算）；没有关键帧时为 0 */
  keyTime: number
}

/**
 * 阶跃采样子骨架控制轨道：动画名 / 循环次数这类离散量不能插值。
 * 首个关键帧之前返回 null（调用方用附件的 setup 默认值）。
 */
export function sampleSubArmature(
  frames: readonly SubArmatureKeyframe[] | undefined,
  time: number
): SubArmatureSample | null {
  if (!frames || frames.length === 0) return null
  const index = lowerBoundByTime(frames, time + 1e-6)
  if (index < 0) return null
  const frame = frames[index]
  return {
    animation: frame.animation,
    playTimes: frame.playTimes,
    offset: frame.offset,
    speed: frame.speed,
    keyTime: frame.time
  }
}

export interface ChildClockInput {
  /** 父动画当前时间（秒） */
  parentTime: number
  /** 控制关键帧的时间（秒） */
  keyTime: number
  /** 子动画内部起始偏移（秒） */
  offset: number
  /** 倍速 */
  speed: number
  /** 0 = 无限循环；n = 播 n 次后定格 */
  playTimes: number
  /** 子动画时长（秒） */
  duration: number
}

/**
 * 子骨架时间**确定性**换算：同一条路径同时服务「播放」与「拖播放头」，
 * 因此暂停后拖动时间轴、来回拖都不会漂移（不能用 dt 累加）。
 *
 * - `playTimes === 0`：对时长取模（负偏移也落回 `[0, duration)`）；
 * - `playTimes > 0`：夹到 `duration × n`，到末尾定格在最后一帧；
 * - 时长为 0（子骨架没有可用动画）：恒返回 0。
 */
export function childClock(input: ChildClockInput): number {
  const duration = input.duration
  if (!(duration > 1e-6)) return 0
  const elapsed = (input.parentTime - input.keyTime) * input.speed + input.offset
  if (input.playTimes > 0) {
    const limit = duration * Math.max(1, Math.floor(input.playTimes))
    // 留 1e-6 的余量：seek(duration) 在非循环下会被当成「已结束」，画面停在末帧前更自然
    return Math.min(Math.max(0, elapsed), Math.max(0, limit - 1e-6))
  }
  const wrapped = elapsed % duration
  return wrapped < 0 ? wrapped + duration : wrapped
}

export interface NestEdge {
  /** 父骨架名 */
  from: string
  /** 子骨架名 */
  to: string
  slot: string
  attachment: string
}

/** 抽取「父骨架 → 子骨架」引用边（同一对出现多次也全部返回，便于报出具体插槽） */
export function nestEdges(docs: readonly EditorDocument[]): NestEdge[] {
  const edges: NestEdge[] = []
  for (const doc of docs) {
    const self = doc.armatureName
    for (const skin of doc.skins) {
      for (const slot of skin.slots) {
        for (const attachment of slot.attachments) {
          if (attachment.type !== 'armature') continue
          const target = attachment.subArmature
          if (!target) continue
          edges.push({ from: self, to: target, slot: slot.slot, attachment: attachment.name })
        }
      }
    }
  }
  return edges
}

export interface NestValidation {
  /** 指向自己的引用（拖放时就该拦掉，这里兜加载进来的工程） */
  selfReferences: NestEdge[]
  /** 引用了工程里不存在的骨架 */
  missing: NestEdge[]
  /** 环（每项是一条环上的骨架名序列，首尾重复） */
  cycles: string[][]
  /** 超过层数上限的骨架名 */
  tooDeep: string[]
}

/**
 * 校验整份工程的嵌套引用：自引用、环、缺失、超深。
 *
 * 三类调用点共用：拖放前（只校验将要新增的一条边）、导入后、工程加载后。
 * 返回的 `missing` 只包含「工程里有其它骨架、但目标名不在其中」的情况 ——
 * 空串（未引用）不算缺失。
 */
export function validateNestGraph(docs: readonly EditorDocument[], maxDepth = MAX_NEST_DEPTH): NestValidation {
  const names = new Set(docs.map((doc) => doc.armatureName))
  const edges = nestEdges(docs)
  const selfReferences = edges.filter((edge) => edge.from === edge.to)
  const missing = edges.filter((edge) => edge.to !== '' && !names.has(edge.to))

  const adjacency = new Map<string, string[]>()
  for (const edge of edges) {
    if (edge.from === edge.to || !names.has(edge.to)) continue
    const list = adjacency.get(edge.from) ?? []
    if (!list.includes(edge.to)) list.push(edge.to)
    adjacency.set(edge.from, list)
  }

  // DFS 三色标记找环，并把环上的节点按顺序收集出来
  const state = new Map<string, 0 | 1 | 2>()
  const stack: string[] = []
  const seen = new Set<string>()
  const cycles: string[][] = []
  const visit = (name: string): void => {
    state.set(name, 1)
    stack.push(name)
    for (const next of adjacency.get(name) ?? []) {
      const color = state.get(next) ?? 0
      if (color === 1) {
        const start = stack.indexOf(next)
        if (start >= 0) {
          const cycle = [...stack.slice(start), next]
          const key = [...cycle].sort().join('\u0000')
          if (!seen.has(key)) {
            seen.add(key)
            cycles.push(cycle)
          }
        }
      } else if (color === 0) {
        visit(next)
      }
    }
    stack.pop()
    state.set(name, 2)
  }
  for (const doc of docs) if ((state.get(doc.armatureName) ?? 0) === 0) visit(doc.armatureName)

  // 深度：从每个节点往下走的最长链（已检测出环，这里只统计不含环的分支）
  const depth = new Map<string, number>()
  const depthOf = (name: string, guard: Set<string>): number => {
    const cached = depth.get(name)
    if (cached !== undefined) return cached
    if (guard.has(name)) return 0
    guard.add(name)
    let best = 0
    for (const next of adjacency.get(name) ?? []) best = Math.max(best, 1 + depthOf(next, guard))
    guard.delete(name)
    depth.set(name, best)
    return best
  }
  const tooDeep: string[] = []
  for (const doc of docs) {
    if (depthOf(doc.armatureName, new Set()) > maxDepth) tooDeep.push(doc.armatureName)
  }

  return { selfReferences, missing, cycles, tooDeep }
}

/**
 * 拖放前的单条边校验：把 `child` 挂到 `parent` 上是否合法。
 *
 * 与 `validateNestGraph` 同口径，但只需要一次邻接查询，用于 UI 即时反馈。
 * 返回 `null` 表示可以，否则返回人类可读的原因（由调用方再包一层 `t()`）。
 */
export function checkNestDrop(
  docs: readonly EditorDocument[],
  parent: string,
  child: string,
  maxDepth = MAX_NEST_DEPTH
): string | null {
  if (!parent || !child) return '骨架名不能为空'
  if (parent === child) return '不能把骨架拖到它自己的层级里'
  const names = new Set(docs.map((doc) => doc.armatureName))
  if (!names.has(parent)) return `父骨架「${parent}」不存在`
  if (!names.has(child)) return `子骨架「${child}」不存在`

  // 从 child 出发能否回到 parent：能则新增这条边会成环
  const adjacency = new Map<string, string[]>()
  for (const edge of nestEdges(docs)) {
    if (edge.from === edge.to) continue
    const list = adjacency.get(edge.from) ?? []
    if (!list.includes(edge.to)) list.push(edge.to)
    adjacency.set(edge.from, list)
  }
  const stack = [child]
  const visited = new Set<string>()
  let depth = 0
  const levels = new Map<string, number>([[child, 0]])
  while (stack.length > 0) {
    const name = stack.pop() as string
    if (visited.has(name)) continue
    visited.add(name)
    const level = levels.get(name) ?? 0
    depth = Math.max(depth, level)
    for (const next of adjacency.get(name) ?? []) {
      if (next === parent) return `会形成循环引用：${parent} → … → ${child} → ${parent}`
      if (!visited.has(next)) {
        levels.set(next, level + 1)
        stack.push(next)
      }
    }
  }
  if (depth + 1 > maxDepth) return `嵌套层数超过上限（${maxDepth} 层）`
  return null
}

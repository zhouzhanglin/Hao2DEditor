import { AnimationPlayer } from '@core/anim/player'
import { Skeleton } from '@core/model/skeleton'
import { buildRuntimeMaps } from '@core/model/asset'
import type { RuntimeAsset, RuntimeMaps } from '@core/model/asset'
import type { EditorDocument } from '@core/model/authoring'
import { compileDocument } from '@core/codec/compile'
import type { CompileResult } from '@core/codec/compile'
import { hexToRgba } from '@core/util/color'
import { lastKeyTime } from './timeline/model'

export interface RuntimeBundle {
  asset: RuntimeAsset
  skeleton: Skeleton
  player: AnimationPlayer
  maps: RuntimeMaps
  /** 编译期的引用 / 结构告警（去重后展示） */
  warnings: string[]
  boneIndex: Record<string, number>
  slotIndex: Record<string, number>
  constraintIndex: Record<string, number>
  /** 编译对应的文档引用，用于判断是否需要重建 */
  sourceDocument: EditorDocument
  skinName: string
}

/**
 * 把 Authoring 工程文档编译成可直接渲染 / 播放的运行期 bundle。
 *
 * 编译是纯函数且足够快（骨骼 / 插槽 / 关键帧量级为千），因此文档每次变化都重建；
 * 调用方用 `needsRebuild` 判断是否需要替换 bundle。
 */
export function buildRuntime(doc: EditorDocument, skinName = ''): RuntimeBundle {
  const compiled: CompileResult = compileDocument(doc)
  const maps = buildRuntimeMaps(compiled.asset, skinName)
  const skeleton = new Skeleton(compiled.asset)
  skeleton.applyRuntimeMaps(maps)
  const player = new AnimationPlayer(compiled.asset, skeleton)
  return {
    asset: compiled.asset,
    skeleton,
    player,
    maps,
    warnings: dedupe(compiled.warnings),
    boneIndex: compiled.boneIndex,
    slotIndex: compiled.slotIndex,
    constraintIndex: compiled.constraintIndex,
    sourceDocument: doc,
    skinName
  }
}

/**
 * 需要重建吗？
 *
 * 原实现比的是**文档引用**（`bundle.sourceDocument !== doc`），而任何一次编辑都会换掉
 * 文档对象（store 里 `cloneDocument` + `set`），于是每次编辑都全量重编译 + 销毁重建视图 +
 * 新建玩家 —— 拖颜色时就是一帧一遍。
 *
 * 现在比的是**值**：除了明确列出的「热更字段」（插槽颜色，见 `applyValueChanges`），
 * 其余任何差异才算结构变化。
 *
 * 为什么用**深比较**而不是手写结构签名（骨骼 / 插槽 / 附件 / 图片 / 关键帧各写一段）：
 * 签名一旦漏了字段（骨骼长度？约束参数？附件 UV？FFD 偏移？），漏掉的编辑就会
 * 「既不重建、也不热更」—— 画面上什么都不动，比卡顿难查得多。深比较的默认答案是保守的
 * （认不出来就当结构变了，重建），最多是少省一点性能，不会出错。
 *
 * 代价：一次 O(文档) 的逐字段比较（每次 `set` 一次）。相比它省掉的整套重编译 + 重建视图，
 * 这是零头；而且比 store 里那次 `structuredClone` 还便宜。
 */
export function needsRebuild(bundle: RuntimeBundle | null, doc: EditorDocument, skinName: string): boolean {
  if (!bundle || bundle.skinName !== skinName) return true
  if (bundle.sourceDocument === doc) return false
  return !onlyValuesChanged(bundle.sourceDocument, doc)
}

/**
 * 文档是不是**只改了热更字段**（目前只有插槽颜色）。
 *
 * 注意 `slots[i].color` 之外的插槽字段（绑定骨骼 / 层级 / 显示附件 / 可见性 / 混合模式）
 * 都会改变运行期结构，必须重建。
 */
function onlyValuesChanged(before: EditorDocument, after: EditorDocument): boolean {
  // 其余顶层字段逐项比较（slots 留到最后：它要逐项跳过颜色，最贵）
  const a = before as unknown as Record<string, unknown>
  const b = after as unknown as Record<string, unknown>
  for (const key of Object.keys(a)) {
    if (key === 'slots') continue
    if (!deepEqual(a[key], b[key])) return false
  }
  // 多出来的键也算结构变化（正常不会发生，防御一下）
  if (!Object.keys(b).every((key) => key in a)) return false
  if (before.slots.length !== after.slots.length) return false
  for (let index = 0; index < before.slots.length; index++) {
    if (!deepEqual(before.slots[index], after.slots[index], 'color')) return false
  }
  return true
}

/**
 * JSON 化的深比较：值 / 结构完全相同返回 true。
 *
 * `skip`：在这一层忽略这个键 —— 用于热更字段；只在一层生效（够用且不会误伤嵌套里同名的键）。
 */
function deepEqual(a: unknown, b: unknown, skip?: string): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    for (let index = 0; index < a.length; index++) {
      if (!deepEqual(a[index], b[index])) return false
    }
    return true
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  const ao = a as Record<string, unknown>
  const bo = b as Record<string, unknown>
  for (const key of Object.keys(ao)) {
    if (key === skip) continue
    if (!deepEqual(ao[key], bo[key])) return false
  }
  for (const key of Object.keys(bo)) {
    if (key === skip) continue
    if (!(key in ao)) return false
  }
  return true
}

/** 只用到 4 个分量，不把一个工具函数绑到 `RGBA` 的类型来源上 */
interface Rgba4 {
  r: number
  g: number
  b: number
  a: number
}

/**
 * 把颜色写进运行期的**两处**；值没变返回 false。
 *
 * - `asset.slots[i].color`：编译产物的真值 —— `skeleton.refresh()`（Pose 工具每次鼠标移动
 *   都会调）与切换皮肤都从它取值，只写另一处会被立刻抹掉；
 * - `skeleton.slotColors[i]`：运行期正在用的那份，网格直接读它。
 *
 * 刻意**不**调 `skeleton.refresh()`：Animate 模式下它会把播放器采样出来的姿态重置回绑定姿态
 * （画面上就是「一改颜色角色跳回 setup」）。
 */
function writeSlotColor(bundle: RuntimeBundle, index: number, rgba: Rgba4): boolean {
  const assetColor = bundle.asset.slots[index]?.color
  const live = bundle.skeleton.slotColors[index]
  if (!assetColor) return false
  if (
    assetColor.r === rgba.r &&
    assetColor.g === rgba.g &&
    assetColor.b === rgba.b &&
    assetColor.a === rgba.a &&
    live &&
    live.r === rgba.r &&
    live.g === rgba.g &&
    live.b === rgba.b &&
    live.a === rgba.a
  ) {
    return false
  }
  assetColor.r = rgba.r
  assetColor.g = rgba.g
  assetColor.b = rgba.b
  assetColor.a = rgba.a
  if (live) {
    live.r = rgba.r
    live.g = rgba.g
    live.b = rgba.b
    live.a = rgba.a
  }
  return true
}

/**
 * 值热更新：把文档里「只影响渲染值」的字段写进已有的 bundle，**不重建运行期**。
 *
 * 目前只有插槽颜色（`slots[i].color`）。配合 `needsRebuild` 的判定：只改颜色时运行期原地更新，
 * 省掉「全量重编译 + 销毁重建视图 + 新建玩家」。
 */
export function applyValueChanges(bundle: RuntimeBundle, doc: EditorDocument): void {
  const count = Math.min(doc.slots.length, bundle.asset.slots.length)
  for (let index = 0; index < count; index++) {
    writeSlotColor(bundle, index, hexToRgba(doc.slots[index].color))
  }
}

/**
 * 拖动预览：把 `{ 插槽名: '#RRGGBBAA' }` 写成运行期的即时颜色（不进文档 / 历史 / 面板）。
 * 返回是否有内容真的变了（调用方据此决定要不要标脏重画）。
 */
export function applyPreviewSlotColors(bundle: RuntimeBundle, colors: Record<string, string>): boolean {
  let changed = false
  for (const name of Object.keys(colors)) {
    const index = bundle.slotIndex[name]
    if (index === undefined) continue
    if (writeSlotColor(bundle, index, hexToRgba(colors[name]))) changed = true
  }
  return changed
}

function dedupe(list: readonly string[]): string[] {
  return [...new Set(list)]
}

/**
 * 动画的可编辑范围（秒）＝ 时长与最后一个关键帧的较大者。
 *
 * 这是「时间轴能擦洗到哪 / 播放头能放到哪」的上限，用于往后继续加帧；
 * **不是播放长度** —— 播放到哪算完由 AnimationPlayer 按最后一个关键帧算。
 */
export function animationDuration(doc: EditorDocument, name: string | null): number {
  if (!name) return 1
  const found = doc.animations.find((a) => a.name === name)
  if (!found) return 1
  const stored = found.duration > 0 ? found.duration : 1
  return Math.max(stored, lastKeyTime(found))
}

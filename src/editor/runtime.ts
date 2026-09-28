import { AnimationPlayer } from '@core/anim/player'
import { Skeleton } from '@core/model/skeleton'
import { buildRuntimeMaps } from '@core/model/asset'
import type { RuntimeAsset, RuntimeMaps } from '@core/model/asset'
import type { EditorDocument } from '@core/model/authoring'
import { compileDocument } from '@core/codec/compile'
import type { CompileResult } from '@core/codec/compile'

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

export function needsRebuild(bundle: RuntimeBundle | null, doc: EditorDocument, skinName: string): boolean {
  return !bundle || bundle.sourceDocument !== doc || bundle.skinName !== skinName
}

function dedupe(list: readonly string[]): string[] {
  return [...new Set(list)]
}

/** 动画时长（秒），未找到时返回 1 */
export function animationDuration(doc: EditorDocument, name: string | null): number {
  if (!name) return 1
  const found = doc.animations.find((a) => a.name === name)
  return found && found.duration > 0 ? found.duration : 1
}

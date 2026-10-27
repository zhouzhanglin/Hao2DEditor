import { describe, expect, it } from 'vitest'
import * as spine from '@esotericsoftware/spine-core'
import { AnimationPlayer } from '@core/anim/player'
import { Easing, emptyBoneAnim } from '@core/model/animation'
import { buildRuntimeMaps } from '@core/model/asset'
import { Skeleton } from '@core/model/skeleton'
import { buildSpineJson } from '@editor/services/spineExport'
import { anim, asset, bone } from './fixtures'

/**
 * 旋转帧「绕整圈」回归。
 *
 * DragonBones 的旋转帧是作者拖出来的**未归一化**值（相对 setup 的原始角度差）。
 * Dora_zorder / forearm_r 的真实数据就是例子：setup 12.7493°，帧值 174.0408° → -160.2742°，
 * 原始差 -334.3°；编辑器与 Unity 端 Hao2D 运行时 `AnimationPlayer.SampleAngle → Mathf.LerpAngle` 走最短弧，
 * 实际只转 +25.7°。
 *
 * 官方运行库对 rotate 是**按取值直接线性插值**（`RotateTimeline` 无任何环绕处理），
 * 所以导出前必须把键连续化（相邻键跨度压回 ±180°），否则导出播放会朝反方向绕一大圈，
 * 与编辑器预览完全对不上。
 */

const SETUP_ROT = 12.7493
const ANIM = 'doraMove'

/** 编辑器里的角度（绝对、含 setup），与 DB 导入后的取值一致 */
const KEYS = [
  { time: 0, value: -12.7493 },
  { time: 0.3, value: 174.0408 },
  { time: 1.6, value: -160.2742 }
]

function doraAsset() {
  const bones = [bone('root', -1), bone('forearm_r', 0, 0, 0, SETUP_ROT)]
  const data = anim(ANIM, 1.8)
  data.bones = [
    {
      ...emptyBoneAnim(1),
      rotate: KEYS.map((k) => ({ time: k.time, value: k.value, easing: Easing.Linear, curve: null }))
    }
  ]
  return asset(bones, [], [], { animations: [data], textures: [] })
}

const wrap360 = (deg: number): number => ((deg % 360) + 360) % 360
/** 角度差（deg），已被折回 (-180, 180] */
const angleGap = (a: number, b: number): number => {
  const d = Math.abs(wrap360(a) - wrap360(b))
  return Math.min(d, 360 - d)
}

describe('导出 rotate 关键帧的连续化', () => {
  const runtime = doraAsset()
  const json = buildSpineJson(runtime)
  const frames = (json.animations as never as Record<string, { bones: Record<string, { rotate: { time: number; value: number }[] }> }>)[ANIM]
    .bones.forearm_r.rotate

  it('原始数据确实跨越 180°（否则这条回归没有意义）', () => {
    expect(Math.abs(KEYS[1].value - KEYS[0].value)).toBeGreaterThan(180)
    expect(Math.abs(KEYS[2].value - KEYS[1].value)).toBeGreaterThan(180)
  })

  it('相邻键跨度 ≤ 180°，数值与原角度等价（mod 360）', () => {
    expect(frames.map((f) => f.time)).toEqual([0, 0.3, 1.6])
    for (let i = 1; i < frames.length; i++) {
      expect(Math.abs(frames[i].value - frames[i - 1].value)).toBeLessThanOrEqual(180 + 1e-9)
    }
    for (let i = 0; i < frames.length; i++) {
      // 写出的值仍是「相对 setup 的偏移」，只是取同方向的等价角
      expect(angleGap(frames[i].value, KEYS[i].value - SETUP_ROT)).toBeLessThan(1e-6)
    }
  })

  it('官方运行库播放与编辑器采样逐帧一致（含关键帧之间）', () => {
    /*
     * 这个用例只用旋转轨道（json 里没有任何附件），运行库不需要附件加载器 ——
     * 官方实现允许传 null，但类型定义要求非空，故显式断言。
     */
    const noLoader = null as unknown as spine.AttachmentLoader
    const data = new spine.SkeletonJson(noLoader).readSkeletonData(JSON.stringify(json))
    const editorSkel = new Skeleton(runtime)
    editorSkel.applyRuntimeMaps(buildRuntimeMaps(runtime))
    const player = new AnimationPlayer(runtime, editorSkel)

    for (const t of [0.1, 0.3, 0.62, 0.95, 1.3, 1.6]) {
      editorSkel.setToSetupPose()
      player.play(ANIM, true)
      player.seek(t)
      const edRot = editorSkel.localRot[1]

      const skel = new spine.Skeleton(data)
      skel.setupPose()
      const state = new spine.AnimationState(new spine.AnimationStateData(data))
      state.setAnimation(0, ANIM, true)
      state.update(t)
      state.apply(skel)
      const spineRot = skel.bones[1].appliedPose.rotation

      expect(angleGap(spineRot, edRot)).toBeLessThan(0.01)
    }
  })
})

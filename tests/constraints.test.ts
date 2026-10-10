import { describe, expect, it } from 'vitest'
import { createConstraintStates, solveConstraints } from '@core/constraints/solver'
import { Skeleton } from '@core/model/skeleton'
import { AnimationPlayer } from '@core/anim/player'
import { emptyConstraintAnim, emptyFloatKeyframe } from '@core/model/animation'
import { createIkConstraint, createPhysicsConstraint, createTransformConstraint } from '@core/model/constraints'
import type { Constraint } from '@core/model/constraints'
import { createAuthoringBone, createEmptyDocument } from '@core/model/authoring'
import type { EditorDocument } from '@core/model/authoring'
import { compileDocument } from '@core/codec/compile'
import { anim, asset, bone, region, skin, slot } from './fixtures'

function makeRuntime(bones = [bone('root', -1, 0, 0, 0, 10), bone('mid', 0, 10, 0, 0, 10), bone('target', -1, 10, 10)]) {
  return asset(
    bones,
    [slot('s', 0)],
    [skin('default', [{ slotName: 's', attachments: [region('r', 'tex', 2, 2)] }])],
    { textures: ['tex'] }
  )
}

/** 骨骼链末端的世界坐标（沿骨骼长度延伸） */
function tipOf(skeleton: Skeleton, boneIndex: number): [number, number] {
  const o = boneIndex * 16
  const length = skeleton.asset.bones[boneIndex].length
  return [
    skeleton.world[o] * length + skeleton.world[o + 12],
    skeleton.world[o + 1] * length + skeleton.world[o + 13]
  ]
}

function run(constraints: Constraint[]) {
  const runtime = makeRuntime()
  runtime.constraints = constraints
  const skeleton = new Skeleton(runtime)
  const states = createConstraintStates(runtime.constraints)
  solveConstraints(skeleton, runtime.constraints, states)
  return skeleton
}

describe('IK 两骨解析解', () => {
  it('可到达时末端落在目标骨骼位置', () => {
    const skeleton = run([
      createIkConstraint({ name: 'leg', boneIndices: [0, 1], targetBoneIndex: 2, mix: 1, bendSign: 1 })
    ])
    const [x, y] = tipOf(skeleton, 1)
    expect(x).toBeCloseTo(10, 3)
    expect(y).toBeCloseTo(10, 3)
  })

  it('弯曲方向由 bendSign 决定', () => {
    const up = run([
      createIkConstraint({ name: 'leg', boneIndices: [0, 1], targetBoneIndex: 2, mix: 1, bendSign: 1 })
    ])
    const down = run([
      createIkConstraint({ name: 'leg', boneIndices: [0, 1], targetBoneIndex: 2, mix: 1, bendSign: -1 })
    ])
    // 膝盖（mid 骨骼原点）在 bendSign 为正时位于目标侧，为负时位于另一侧
    expect(up.boneWorldY(1)).toBeGreaterThan(0)
    expect(down.boneWorldY(1)).toBeLessThan(10)
  })

  it('mix = 0 时姿势不变', () => {
    const skeleton = run([
      createIkConstraint({ name: 'leg', boneIndices: [0, 1], targetBoneIndex: 2, mix: 0, bendSign: 1 })
    ])
    expect(skeleton.localRot[0]).toBeCloseTo(0, 5)
    expect(skeleton.localRot[1]).toBeCloseTo(0, 5)
  })

  it('够不到时把手臂拉直并朝向目标', () => {
    const runtime = makeRuntime([
      bone('root', -1, 0, 0, 0, 10),
      bone('mid', 0, 10, 0, 0, 10),
      bone('target', -1, 100, 0)
    ])
    runtime.constraints = [
      createIkConstraint({ name: 'leg', boneIndices: [0, 1], targetBoneIndex: 2, mix: 1, bendSign: 1 })
    ]
    const skeleton = new Skeleton(runtime)
    solveConstraints(skeleton, runtime.constraints, createConstraintStates(runtime.constraints))
    const [x, y] = tipOf(skeleton, 1)
    expect(x).toBeCloseTo(20, 3)
    expect(y).toBeCloseTo(0, 3)
  })

  it('useBoneLength 影响 l1 取值（骨骼 length 与实际距离不一致时结果不同）', () => {
    // 根骨 length = 20，但子骨原点距根骨原点只有 10：两种 l1 取值必然不同
    const make = () => {
      const runtime = asset(
        [bone('root', -1, 0, 0, 0, 20), bone('mid', 0, 10, 0, 0, 10), bone('target', -1, 10, 10)],
        [slot('s', 0)],
        [skin('default', [{ slotName: 's', attachments: [region('r', 'tex', 2, 2)] }])]
      )
      return runtime
    }
    const byDistance = make()
    byDistance.constraints = [
      createIkConstraint({ name: 'leg', boneIndices: [0, 1], targetBoneIndex: 2, mix: 1, bendSign: 1 })
    ]
    const skeletonA = new Skeleton(byDistance)
    solveConstraints(skeletonA, byDistance.constraints, createConstraintStates(byDistance.constraints))

    const byLength = make()
    byLength.constraints = [
      createIkConstraint({
        name: 'leg',
        boneIndices: [0, 1],
        targetBoneIndex: 2,
        mix: 1,
        bendSign: 1,
        useBoneLength: true
      })
    ]
    const skeletonB = new Skeleton(byLength)
    solveConstraints(skeletonB, byLength.constraints, createConstraintStates(byLength.constraints))

    expect(skeletonA.localRot[0]).not.toBeCloseTo(skeletonB.localRot[0], 3)
  })
})

describe('CCD（链长 != 2）', () => {
  it('三骨链迭代后末端更接近目标', () => {
    const runtime = makeRuntime([
      bone('root', -1, 0, 0, 0, 10),
      bone('mid', 0, 10, 0, 0, 10),
      bone('tip', 1, 10, 0, 0, 10),
      bone('target', -1, 10, 25)
    ])
    runtime.constraints = [
      createIkConstraint({ name: 'arm', boneIndices: [0, 1, 2], targetBoneIndex: 3, mix: 1, bendSign: 1 })
    ]
    const skeleton = new Skeleton(runtime)
    const before = Math.hypot(...tipOf(skeleton, 2).map((v, i) => v - (i === 0 ? 10 : 25)) as [number, number])
    solveConstraints(skeleton, runtime.constraints, createConstraintStates(runtime.constraints))
    const [tx, ty] = tipOf(skeleton, 2)
    const after = Math.hypot(tx - 10, ty - 25)
    expect(after).toBeLessThan(before)
  })
})

describe('求解顺序', () => {
  it('order 更大的约束最后应用，结果以它为准', () => {
    const runtimeA = asset(
      [
        bone('root', -1, 0, 0, 0, 10),
        bone('mid', 0, 10, 0, 0, 10),
        bone('targetA', -1, 10, 10),
        bone('targetB', -1, 0, 10)
      ],
      [slot('s', 0)],
      [skin('default', [{ slotName: 's', attachments: [region('r', 'tex', 2, 2)] }])]
    )
    runtimeA.constraints = [
      createIkConstraint({ name: 'a', order: 0, boneIndices: [0, 1], targetBoneIndex: 2, mix: 1, bendSign: 1 }),
      createIkConstraint({ name: 'b', order: 1, boneIndices: [0, 1], targetBoneIndex: 3, mix: 1, bendSign: 1 })
    ]
    const skeletonA = new Skeleton(runtimeA)
    solveConstraints(skeletonA, runtimeA.constraints, createConstraintStates(runtimeA.constraints))
    const [xa, ya] = tipOf(skeletonA, 1)
    expect(xa).toBeCloseTo(0, 3)
    expect(ya).toBeCloseTo(10, 3)

    const runtimeB = asset(
      [
        bone('root', -1, 0, 0, 0, 10),
        bone('mid', 0, 10, 0, 0, 10),
        bone('targetA', -1, 10, 10),
        bone('targetB', -1, 0, 10)
      ],
      [slot('s', 0)],
      [skin('default', [{ slotName: 's', attachments: [region('r', 'tex', 2, 2)] }])]
    )
    runtimeB.constraints = [
      createIkConstraint({ name: 'a', order: 1, boneIndices: [0, 1], targetBoneIndex: 2, mix: 1, bendSign: 1 }),
      createIkConstraint({ name: 'b', order: 0, boneIndices: [0, 1], targetBoneIndex: 3, mix: 1, bendSign: 1 })
    ]
    const skeletonB = new Skeleton(runtimeB)
    solveConstraints(skeletonB, runtimeB.constraints, createConstraintStates(runtimeB.constraints))
    const [xb, yb] = tipOf(skeletonB, 1)
    expect(xb).toBeCloseTo(10, 3)
    expect(yb).toBeCloseTo(10, 3)
  })
})

describe('变换约束', () => {
  it('平移 mix 为 1 时骨骼对齐到目标位置', () => {
    const runtime = asset(
      [bone('root', -1, 0, 0), bone('target', -1, 10, 5)],
      [slot('s', 0)],
      [skin('default', [{ slotName: 's', attachments: [region('r', 'tex', 2, 2)] }])]
    )
    runtime.constraints = [
      createTransformConstraint({
        name: 'follow',
        boneIndices: [0],
        targetBoneIndex: 1,
        mixRotate: 0,
        mixScaleX: 0,
        mixScaleY: 0
      })
    ]
    const skeleton = new Skeleton(runtime)
    solveConstraints(skeleton, runtime.constraints, createConstraintStates(runtime.constraints))
    expect(skeleton.boneWorldX(0)).toBeCloseTo(10, 4)
    expect(skeleton.boneWorldY(0)).toBeCloseTo(5, 4)
  })

  it('mix 为 0 时不动', () => {
    const runtime = asset(
      [bone('root', -1, 0, 0), bone('target', -1, 10, 5)],
      [slot('s', 0)],
      [skin('default', [{ slotName: 's', attachments: [region('r', 'tex', 2, 2)] }])]
    )
    runtime.constraints = [
      createTransformConstraint({
        name: 'follow',
        boneIndices: [0],
        targetBoneIndex: 1,
        mixX: 0,
        mixY: 0,
        mixRotate: 0,
        mixScaleX: 0,
        mixScaleY: 0
      })
    ]
    const skeleton = new Skeleton(runtime)
    solveConstraints(skeleton, runtime.constraints, createConstraintStates(runtime.constraints))
    expect(skeleton.boneWorldX(0)).toBeCloseTo(0, 4)
  })
})

describe('物理约束', () => {
  it('只做数据保留，不参与求解', () => {
    const runtime = asset(
      [bone('root', -1, 0, 0), bone('target', -1, 10, 5)],
      [slot('s', 0)],
      [skin('default', [{ slotName: 's', attachments: [region('r', 'tex', 2, 2)] }])]
    )
    runtime.constraints = [
      createPhysicsConstraint({ name: 'phys', boneIndices: [0], targetBoneIndex: 1 })
    ]
    const skeleton = new Skeleton(runtime)
    solveConstraints(skeleton, runtime.constraints, createConstraintStates(runtime.constraints))
    expect(skeleton.boneWorldX(0)).toBeCloseTo(0, 4)
    expect(skeleton.boneWorldY(0)).toBeCloseTo(0, 4)
  })
})

describe('运行期约束状态（编辑器打关键帧读它）', () => {
  it('constraintStateAt 返回当前 mix：先给静态值，动画轨道驱动后跟着变', () => {
    const runtime = makeRuntime()
    runtime.constraints = [
      createIkConstraint({ name: 'leg', boneIndices: [0, 1], targetBoneIndex: 2, mix: 0.25, bendSign: 1 })
    ]
    const track = emptyConstraintAnim(0)
    track.mix = [emptyFloatKeyframe(0, 0.5), emptyFloatKeyframe(1, 1)]
    const data = anim('idle', 1)
    data.constraints.push(track)
    runtime.animations.push(data)

    const skeleton = new Skeleton(runtime)
    const player = new AnimationPlayer(runtime, skeleton)
    expect(player.constraintStateAt(0)?.mix).toBeCloseTo(0.25, 4)
    expect(player.constraintStateAt(1)).toBeNull()

    player.play('idle', false)
    expect(player.constraintStateAt(0)?.mix).toBeCloseTo(0.5, 4)
    player.time = 1
    expect(player.constraintStateAt(0)?.mix).toBeCloseTo(1, 4)
  })

  it('返回的是副本：改不动运行期状态', () => {
    const runtime = makeRuntime()
    runtime.constraints = [
      createIkConstraint({ name: 'leg', boneIndices: [0, 1], targetBoneIndex: 2, mix: 0.5, bendSign: 1 })
    ]
    const skeleton = new Skeleton(runtime)
    const player = new AnimationPlayer(runtime, skeleton)
    const state = player.constraintStateAt(0)
    if (state) state.mix = 0
    player.refresh()
    expect(player.constraintStateAt(0)?.mix).toBeCloseTo(0.5, 4)
  })
})

describe('Pose 态求解（scene.setDocument / refresh 走的路径）', () => {
  /**
   * Pose 态没有动画在推进播放器，编译出来的运行时又不会自己求解 —— 编辑器在
   * 重建运行时之后补一次 `refresh()`（没有当前动画时 = 「重算 FK + 求解约束」）。
   * 这里盯住那个契约：漏掉它，新建 / 编辑 IK 后视口就没有任何效果。
   */
  it('新建的运行时 refresh() 一次就把 IK 解出来', () => {
    const runtime = makeRuntime()
    runtime.constraints = [
      createIkConstraint({ name: 'leg', boneIndices: [0, 1], targetBoneIndex: 2, mix: 1, bendSign: 1 })
    ]
    const skeleton = new Skeleton(runtime)
    const player = new AnimationPlayer(runtime, skeleton)
    expect(tipOf(skeleton, 1)[1]).toBeCloseTo(0, 3) // 求解前：mid 沿 +X，末端在 (20, 0)

    player.refresh()
    const [x, y] = tipOf(skeleton, 1)
    expect(x).toBeCloseTo(10, 3)
    expect(y).toBeCloseTo(10, 3)
  })
})

describe('IK 约束缺失目标时的编译告警', () => {
  function docWithIk(target: string): EditorDocument {
    const doc = createEmptyDocument('t')
    doc.bones = [
      createAuthoringBone({ name: 'root', parent: '', localPosition: { x: 0, y: 0 }, length: 10 }),
      createAuthoringBone({ name: 'mid', parent: 'root', localPosition: { x: 10, y: 0 }, length: 10 })
    ]
    doc.constraints = [{ ...createIkConstraint(), name: 'leg', bones: ['root', 'mid'], target }]
    return doc
  }

  it('没选目标 / 目标骨骼不存在都会告警（求解器拿到 -1 会直接返回，等于静默失效）', () => {
    expect(compileDocument(docWithIk('')).warnings.some((w) => w.includes('没有目标骨骼'))).toBe(true)
    expect(compileDocument(docWithIk('ghost')).warnings.some((w) => w.includes('目标骨骼不存在'))).toBe(true)
    expect(compileDocument(docWithIk('mid')).warnings.some((w) => w.includes('目标骨骼'))).toBe(false)
  })
})

describe('IK 链条端到端：编译无告警，两骨链解到目标', () => {
  it('链 root → mid 把末端送到目标骨骼的位置', () => {
    const doc = createEmptyDocument('t')
    doc.bones = [
      createAuthoringBone({ name: 'root', parent: '', localPosition: { x: 0, y: 0 }, length: 10 }),
      createAuthoringBone({ name: 'mid', parent: 'root', localPosition: { x: 10, y: 0 }, length: 10 }),
      createAuthoringBone({ name: 'target', parent: '', localPosition: { x: 10, y: 10 }, length: 0 })
    ]
    doc.constraints = [
      {
        ...createIkConstraint(),
        name: 'leg',
        bones: ['root', 'mid'],
        target: 'target',
        mix: 1,
        bendSign: 1
      }
    ]

    const { asset: runtime, warnings } = compileDocument(doc)
    expect(warnings).toEqual([])
    const skeleton = new Skeleton(runtime)
    const player = new AnimationPlayer(runtime, skeleton)
    player.refresh()
    expect(tipOf(skeleton, 1)[0]).toBeCloseTo(10, 3)
    expect(tipOf(skeleton, 1)[1]).toBeCloseTo(10, 3)
  })
})


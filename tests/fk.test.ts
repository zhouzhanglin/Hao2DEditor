import { describe, expect, it } from 'vitest'
import { solveFk } from '@core/math/fk'
import type { FkBone } from '@core/math/fk'
import { invertInto, mat4Identity, mulInto, mulPointX, mulPointY, trsInto } from '@core/math/matrix'

function bone(parentIndex = -1, inheritRotation = true, inheritScale = true): FkBone {
  return { parentIndex, inheritRotation, inheritScale }
}

interface Pose {
  pos: Array<[number, number]>
  rot: number[]
  scale: Array<[number, number]>
  shear: Array<[number, number]>
}

function solve(
  bones: FkBone[],
  pose: Pose,
  startBone = 0
): { world: Float32Array; worldRot: Float32Array; worldScale: Float32Array } {
  const n = bones.length
  const pos = new Float32Array(n * 2)
  const rot = new Float32Array(n)
  const scale = new Float32Array(n * 2)
  const shear = new Float32Array(n * 2)
  for (let i = 0; i < n; i++) {
    pos[i * 2] = pose.pos[i][0]
    pos[i * 2 + 1] = pose.pos[i][1]
    rot[i] = pose.rot[i]
    scale[i * 2] = pose.scale[i][0]
    scale[i * 2 + 1] = pose.scale[i][1]
    shear[i * 2] = pose.shear[i][0]
    shear[i * 2 + 1] = pose.shear[i][1]
  }
  const world = new Float32Array(n * 16)
  const worldRot = new Float32Array(n)
  const worldScale = new Float32Array(n * 2)
  solveFk(bones, pos, rot, scale, shear, world, worldRot, worldScale, startBone)
  return { world, worldRot, worldScale }
}

function linear(world: Float32Array, i: number): [number, number, number, number] {
  const o = i * 16
  return [world[o], world[o + 1], world[o + 4], world[o + 5]]
}

interface Buffers {
  pos: Float32Array
  rot: Float32Array
  scale: Float32Array
  shear: Float32Array
  world: Float32Array
  worldRot: Float32Array
  worldScale: Float32Array
}

/** 只准备输入缓冲，不执行 FK，便于验证增量重算 */
function prepare(bones: FkBone[], pose: Pose): Buffers {
  const n = bones.length
  const pos = new Float32Array(n * 2)
  const rot = new Float32Array(n)
  const scale = new Float32Array(n * 2)
  const shear = new Float32Array(n * 2)
  for (let i = 0; i < n; i++) {
    pos[i * 2] = pose.pos[i][0]
    pos[i * 2 + 1] = pose.pos[i][1]
    rot[i] = pose.rot[i]
    scale[i * 2] = pose.scale[i][0]
    scale[i * 2 + 1] = pose.scale[i][1]
    shear[i * 2] = pose.shear[i][0]
    shear[i * 2 + 1] = pose.shear[i][1]
  }
  return {
    pos,
    rot,
    scale,
    shear,
    world: new Float32Array(n * 16),
    worldRot: new Float32Array(n),
    worldScale: new Float32Array(n * 2)
  }
}

function translation(world: Float32Array, i: number): [number, number] {
  const o = i * 16
  return [world[o + 12], world[o + 13]]
}

describe('math/matrix', () => {
  it('mul 与 invert 互为逆运算', () => {
    const a = trsInto(new Float32Array(16), 12, -7, 35, 2, 3)
    const b = trsInto(new Float32Array(16), -4, 9, -110, 0.5, 4)
    const ab = mulInto(new Float32Array(16), a, b)
    const inv = invertInto(new Float32Array(16), ab)
    const id = mulInto(new Float32Array(16), ab, inv)
    const expect0 = mat4Identity()
    for (let i = 0; i < 16; i++) expect(id[i]).toBeCloseTo(expect0[i], 5)
  })

  it('mulPoint 含平移，mulVector 不含', () => {
    const m = trsInto(new Float32Array(16), 10, 20, 90, 1, 1)
    expect(mulPointX(m, 1, 0)).toBeCloseTo(10, 5)
    expect(mulPointY(m, 1, 0)).toBeCloseTo(21, 5)
  })
})

describe('FK 单骨骼', () => {
  it('无 shear 时与 TRS 等价（平移/旋转/缩放）', () => {
    const { world } = solve([bone()], {
      pos: [[3, -5]],
      rot: [35],
      scale: [[2, 3]],
      shear: [[0, 0]]
    })
    const expectMatrix = trsInto(new Float32Array(16), 3, -5, 35, 2, 3)
    for (let i = 0; i < 16; i++) expect(world[i]).toBeCloseTo(expectMatrix[i], 5)
  })

  it('shearY 通过 +90 作用在 Y 轴（shearY=90 时 Y 轴指向 -X）', () => {
    const { world } = solve([bone()], {
      pos: [[0, 0]],
      rot: [0],
      scale: [[1, 1]],
      shear: [[0, 90]]
    })
    const [a, c, b, d] = linear(world, 0)
    expect(a).toBeCloseTo(1, 5)
    expect(c).toBeCloseTo(0, 5)
    expect(b).toBeCloseTo(-1, 5)
    expect(d).toBeCloseTo(0, 5)
  })

  it('worldRot / worldScale 从列向量分解（镜像时负号放在 X）', () => {
    const { worldRot, worldScale } = solve([bone()], {
      pos: [[0, 0]],
      rot: [30],
      scale: [[-2, 3]],
      shear: [[0, 0]]
    })
    expect(worldRot[0]).toBeCloseTo(-150, 4)
    expect(worldScale[0]).toBeCloseTo(-2, 4)
    expect(worldScale[1]).toBeCloseTo(3, 4)
  })
})

describe('FK 父子继承', () => {
  const bones = [bone(), bone(0)]

  it('默认：父旋转与缩放都传递（P * L）', () => {
    const { world, worldRot, worldScale } = solve(bones, {
      pos: [
        [0, 0],
        [10, 0]
      ],
      rot: [90, 0],
      scale: [
        [1, 1],
        [1, 1]
      ],
      shear: [
        [0, 0],
        [0, 0]
      ]
    })
    // 子骨平移经父矩阵：父旋转 90°，子局部 (10,0) → 世界 (0,10)
    expect(translation(world, 1)[0]).toBeCloseTo(0, 4)
    expect(translation(world, 1)[1]).toBeCloseTo(10, 4)
    expect(worldRot[1]).toBeCloseTo(90, 4)
    expect(worldScale[2]).toBeCloseTo(1, 4)
    expect(worldScale[3]).toBeCloseTo(1, 4)
  })

  it('inheritRotation=false 且 inheritScale=true：不继承旋转但乘父缩放模长', () => {
    const chain = [bone(), bone(0, false, true)]
    const { world, worldRot, worldScale } = solve(chain, {
      pos: [
        [0, 0],
        [0, 0]
      ],
      rot: [90, 0],
      scale: [
        [2, 3],
        [1, 1]
      ],
      shear: [
        [0, 0],
        [0, 0]
      ]
    })
    const [a, c, b, d] = linear(world, 1)
    expect(a).toBeCloseTo(2, 4)
    expect(c).toBeCloseTo(0, 4)
    expect(b).toBeCloseTo(0, 4)
    expect(d).toBeCloseTo(3, 4)
    expect(worldRot[1]).toBeCloseTo(0, 4)
    expect(worldScale[2]).toBeCloseTo(2, 4)
    expect(worldScale[3]).toBeCloseTo(3, 4)
  })

  it('inheritScale=false：只继承父旋转，父缩放被剥离', () => {
    const chain = [bone(), bone(0, true, false)]
    const { world, worldRot, worldScale } = solve(chain, {
      pos: [
        [0, 0],
        [0, 0]
      ],
      rot: [90, 0],
      scale: [
        [2, 2],
        [1, 1]
      ],
      shear: [
        [0, 0],
        [0, 0]
      ]
    })
    const [a, c, b, d] = linear(world, 1)
    expect(a).toBeCloseTo(0, 4)
    expect(c).toBeCloseTo(1, 4)
    expect(b).toBeCloseTo(-1, 4)
    expect(d).toBeCloseTo(0, 4)
    expect(worldRot[1]).toBeCloseTo(90, 4)
    expect(worldScale[2]).toBeCloseTo(1, 4)
    expect(worldScale[3]).toBeCloseTo(1, 4)
  })

  it('父非均匀缩放 + 子旋转：线性部分按 P*L 组合（父 X 缩放作用到子 Y 轴）', () => {
    const chain = [bone(), bone(0)]
    const { world } = solve(chain, {
      pos: [
        [0, 0],
        [0, 0]
      ],
      rot: [0, 90],
      scale: [
        [2, 1],
        [1, 1]
      ],
      shear: [
        [0, 0],
        [0, 0]
      ]
    })
    const [a, c, b, d] = linear(world, 1)
    // 子局部旋转 90° → 局部列 1 = (cos180, sin180) = (-1, 0)；
    // 父线性 = diag(2, 1) → 结果列 1 = (2 * -1, 1 * 0) = (-2, 0)
    expect(a).toBeCloseTo(0, 4)
    expect(c).toBeCloseTo(1, 4)
    expect(b).toBeCloseTo(-2, 4)
    expect(d).toBeCloseTo(0, 4)
  })
})

describe('FK 增量重算', () => {
  const bones = [bone(), bone(0), bone(1), bone(0)]

  const pose: Pose = {
    pos: [
      [1, 2],
      [10, 0],
      [0, 5],
      [-3, 4]
    ],
    rot: [12, 34, -56, 78],
    scale: [
      [1.5, 0.5],
      [2, 3],
      [0.8, 1.2],
      [-1, 1]
    ],
    shear: [
      [3, -4],
      [0, 7],
      [5, 5],
      [0, 0]
    ]
  }

  it('从任一骨骼起增量重算与全量结果一致（父骨骼矩阵已在缓冲中）', () => {
    const full = solve(bones, pose, 0)
    for (const start of [1, 2, 3]) {
      // 先全量算出父骨骼，再以相同缓冲从 start 增量重算
      const buffers = prepare(bones, pose)
      solveFk(
        bones,
        buffers.pos,
        buffers.rot,
        buffers.scale,
        buffers.shear,
        buffers.world,
        buffers.worldRot,
        buffers.worldScale,
        0
      )
      solveFk(
        bones,
        buffers.pos,
        buffers.rot,
        buffers.scale,
        buffers.shear,
        buffers.world,
        buffers.worldRot,
        buffers.worldScale,
        start
      )
      for (let i = 0; i < full.world.length; i++) {
        expect(buffers.world[i]).toBeCloseTo(full.world[i], 5)
      }
      for (let i = 0; i < full.worldRot.length; i++) {
        expect(buffers.worldRot[i]).toBeCloseTo(full.worldRot[i], 5)
      }
      for (let i = 0; i < full.worldScale.length; i++) {
        expect(buffers.worldScale[i]).toBeCloseTo(full.worldScale[i], 5)
      }
    }
  })
})

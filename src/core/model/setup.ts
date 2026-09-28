import { solveFk } from '../math/fk'
import type { FkBone } from '../math/fk'
import { invertInto, mulInto } from '../math/matrix'
import type { RuntimeAsset } from './asset'

/**
 * setup pose（绑定姿态）的世界矩阵快照。
 * 用途：bindposes 推导、变换约束的「相对模式」增量、编辑器绑定姿态编辑。
 */
export interface SetupPose {
  bones: FkBone[]
  pos: Float32Array
  rot: Float32Array
  scale: Float32Array
  shear: Float32Array
  world: Float32Array
  worldRot: Float32Array
  worldScale: Float32Array
}

const setupCache = new WeakMap<RuntimeAsset, SetupPose>()

export function fkBonesOf(asset: RuntimeAsset): FkBone[] {
  return asset.bones.map((bone) => ({
    parentIndex: bone.parentIndex,
    inheritRotation: bone.inheritRotation,
    inheritScale: bone.inheritScale
  }))
}

export function createSetupPose(asset: RuntimeAsset): SetupPose {
  const b = asset.bones.length
  const setup: SetupPose = {
    bones: fkBonesOf(asset),
    pos: new Float32Array(b * 2),
    rot: new Float32Array(b),
    scale: new Float32Array(b * 2),
    shear: new Float32Array(b * 2),
    world: new Float32Array(b * 16),
    worldRot: new Float32Array(b),
    worldScale: new Float32Array(b * 2)
  }
  for (let i = 0; i < b; i++) {
    const bone = asset.bones[i]
    setup.pos[i * 2] = bone.localPosition.x
    setup.pos[i * 2 + 1] = bone.localPosition.y
    setup.rot[i] = bone.rotation
    setup.scale[i * 2] = bone.localScale.x
    setup.scale[i * 2 + 1] = bone.localScale.y
    setup.shear[i * 2] = bone.localShear.x
    setup.shear[i * 2 + 1] = bone.localShear.y
  }
  solveFk(setup.bones, setup.pos, setup.rot, setup.scale, setup.shear, setup.world, setup.worldRot, setup.worldScale, 0)
  return setup
}

/** 带缓存的 setup pose（asset 不变时只算一次） */
export function setupPoseOf(asset: RuntimeAsset): SetupPose {
  const cached = setupCache.get(asset)
  if (cached) return cached
  const computed = createSetupPose(asset)
  setupCache.set(asset, computed)
  return computed
}

export function invalidateSetupPose(asset: RuntimeAsset): void {
  setupCache.delete(asset)
}

/**
 * 推导 bindposes：每骨骼的逆绑定矩阵 = inverse(setup 世界矩阵)。
 * 必须使用矩阵式 FK（含 shear），否则父级非均匀缩放 / setup shear 会与运行期对不上。
 */
export function computeBindposes(asset: RuntimeAsset): Float32Array {
  const setup = createSetupPose(asset)
  const n = asset.bones.length
  const out = new Float32Array(n * 16)
  const tmp = new Float32Array(16)
  for (let i = 0; i < n; i++) {
    const o = i * 16
    invertInto(tmp, setup.world.subarray(o, o + 16))
    out.set(tmp, o)
  }
  return out
}

/** 顶点从绑定空间变换到某骨骼局部空间：L = bindpose[bone] · worldVertex */
export function bindToLocal(bindpose: Float32Array, offset: number, x: number, y: number): { x: number; y: number } {
  return {
    x: bindpose[offset] * x + bindpose[offset + 4] * y + bindpose[offset + 12],
    y: bindpose[offset + 1] * x + bindpose[offset + 5] * y + bindpose[offset + 13]
  }
}

/** 组合矩阵（供需要多次相乘的场景复用缓冲） */
export function multiplyAll(out: Float32Array, first: Float32Array, second: Float32Array, extra: Float32Array): void {
  const tmp = new Float32Array(16)
  mulInto(tmp, first, second)
  mulInto(out, tmp, extra)
}

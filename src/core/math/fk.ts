import { DEG2RAD, RAD2DEG } from './utils'

/**
 * FK 输入所需的最小骨骼信息（拓扑序：parentIndex < 自身下标）。
 */
export interface FkBone {
  parentIndex: number
  inheritRotation: boolean
  inheritScale: boolean
}

/**
 * Spine 式矩阵 FK —— 与 Unity 端 Hao2D 运行时 `Hao2DMath.FK` 逐行对应。
 *
 * 局部 2x2 = [ cos(r+shearX)*sx , -sin(r+90+shearY)*sy ;
 *              sin(r+shearX)*sx ,  cos(r+90+shearY)*sy ]
 *
 * 要点（不得简化）：
 * - `rY = r + 90 + shearY`，shearY 通过 +90 作用在 Y 轴上；
 * - 非根骨骼的**平移一律先乘父矩阵**，与 inherit 标志无关；
 * - `inheritRotation === false` **不是** Spine 4.x 的 OnlyTranslation：
 *   不继承父旋转时，若 inheritScale 为真仍要乘父两列的**长度**（父非均匀缩放会传递）；
 * - `inheritScale === false` 时只继承父旋转（去掉父缩放/镜像再乘自身）。
 *
 * 缓冲均为扁平 Float32Array，减少每帧分配：
 *   localPos / localScale / localShear: 长度 2n（x,y 相邻）
 *   localRot: 长度 n（度）  world: 长度 16n（列主序）  worldScale: 长度 2n
 */
export function solveFk(
  bones: readonly FkBone[],
  localPos: Float32Array,
  localRot: Float32Array,
  localScale: Float32Array,
  localShear: Float32Array,
  world: Float32Array,
  worldRot: Float32Array,
  worldScale: Float32Array,
  startBone = 0
): void {
  const start = startBone < 0 ? 0 : startBone
  const count = bones.length

  for (let i = start; i < count; i++) {
    const bone = bones[i]
    const r = localRot[i]
    const sx = localScale[i * 2]
    const sy = localScale[i * 2 + 1]
    const shx = localShear[i * 2]
    const shy = localShear[i * 2 + 1]

    const rY = r + 90 + shy
    const ax = (r + shx) * DEG2RAD
    const ay = rY * DEG2RAD
    const la = Math.cos(ax) * sx
    const lc = Math.sin(ax) * sx
    const lb = Math.cos(ay) * sy
    const ld = Math.sin(ay) * sy

    const px = localPos[i * 2]
    const py = localPos[i * 2 + 1]
    const p = bone.parentIndex

    let a: number
    let b: number
    let c: number
    let d: number
    let wx: number
    let wy: number

    if (p < 0) {
      wx = px
      wy = py
      a = la
      b = lb
      c = lc
      d = ld
    } else {
      const po = p * 16
      const pa = world[po]
      const pc = world[po + 1]
      const pb = world[po + 4]
      const pd = world[po + 5]
      const ptx = world[po + 12]
      const pty = world[po + 13]

      wx = pa * px + pb * py + ptx
      wy = pc * px + pd * py + pty

      if (!bone.inheritRotation) {
        let kx = 1
        let ky = 1
        if (bone.inheritScale) {
          kx = Math.hypot(pa, pc)
          ky = Math.hypot(pb, pd)
        }
        a = la * kx
        c = lc * kx
        b = lb * ky
        d = ld * ky
      } else if (!bone.inheritScale) {
        const pr = Math.atan2(pc, pa)
        const cs = Math.cos(pr)
        const sn = Math.sin(pr)
        a = cs * la - sn * lc
        b = cs * lb - sn * ld
        c = sn * la + cs * lc
        d = sn * lb + cs * ld
      } else {
        a = pa * la + pb * lc
        b = pa * lb + pb * ld
        c = pc * la + pd * lc
        d = pc * lb + pd * ld
      }
    }

    const wo = i * 16
    world[wo] = a
    world[wo + 1] = c
    world[wo + 2] = 0
    world[wo + 3] = 0
    world[wo + 4] = b
    world[wo + 5] = d
    world[wo + 6] = 0
    world[wo + 7] = 0
    world[wo + 8] = 0
    world[wo + 9] = 0
    world[wo + 10] = 1
    world[wo + 11] = 0
    world[wo + 12] = wx
    world[wo + 13] = wy
    world[wo + 14] = 0
    world[wo + 15] = 1

    worldRot[i] = Math.atan2(c, a) * RAD2DEG
    let wsx = Math.hypot(a, c)
    const wsy = Math.hypot(b, d)
    if (a * d - b * c < 0) wsx = -wsx
    worldScale[i * 2] = wsx
    worldScale[i * 2 + 1] = wsy
  }
}

/**
 * 约束求解需要「直接指定某骨骼世界朝向/位置」的能力：
 * 把世界旋转换算回局部旋转（考虑父世界旋转与 inheritRotation）。
 */
export function localRotationFromWorld(
  bones: readonly FkBone[],
  worldRot: Float32Array,
  boneIndex: number,
  worldDeg: number
): number {
  const parent = bones[boneIndex]?.parentIndex ?? -1
  if (parent < 0 || !bones[boneIndex].inheritRotation) return worldDeg
  return worldDeg - worldRot[parent]
}

import {
  AnimationState,
  AnimationStateData,
  AtlasAttachmentLoader,
  Physics,
  Skeleton,
  SkeletonJson,
  TextureAtlas
} from '@esotericsoftware/spine-core'
import { PPU } from './uv'

/**
 * 用**官方 Spine 运行库**（`@esotericsoftware/spine-core`）把动画烘焙成关键帧轨道。
 *
 * 思路与参考工程 `Hao2D/Editor/Converter/SpineConverter.cs` 一致（它用官方 C# 运行库采样）：
 * 缓动的两种写法（旧版是归一化 0..1、4.2+ 换成「(时间, 值) 绝对坐标」）、mix/blend、
 * IK 与其它约束、物理、各版本格式差异 —— 全部交给官方运行库，我们只按固定帧率
 * 采样**最终局部姿态**（`BonePose`，含约束修正）。
 *
 * 采样即含 IK，所以运行期不必再跑我们自己的解算器（`runtimeIK = false`），
 * 从而避免「Pose 态的脚不对」「膝盖朝反」这类问题；约束数据仍保留，
 * 只是不再参与求解。
 *
 * 顶点 / FFD / 图集 / UV 仍走我们自己的解析（那边要与附件模型、UV 约定对齐）。
 *
 * 采样是「每帧一个关键帧」，但其中绝大多数是纯冗余（静止部件、匀速运动）。采样后统一做
 * **阶跃还原 + 关键帧简化**（见下方 markStepped / simplify，与参考的 SpineBakeAnimator
 * 后处理一致）：实测 spineboy-pro 从 12.3 万键压到 9 千键（92.7%），动画表现不变。
 */

/** 双分量采样键（translate / scale / shear 共用） */
export interface BakedVec2Key {
  time: number
  x: number
  y: number
  /** 阶跃：本帧到下一帧是瞬间切换（由 markStepped 标出，还原官方 stepped 语义） */
  stepped?: boolean
}

/** 单值采样键（rotate） */
export interface BakedScalarKey {
  time: number
  value: number
  stepped?: boolean
}

export interface BakedBoneTrack {
  /** 我们模型的骨骼下标 */
  bone: number
  translate: BakedVec2Key[]
  rotate: BakedScalarKey[]
  scale: BakedVec2Key[]
  shear: BakedVec2Key[]
}

export interface BakedSlotTrack {
  /** 我们模型的插槽下标 */
  slot: number
  /** 换装：附件名（空串 = 不显示） */
  display: Array<{ time: number; name: string }>
  color: Array<{ time: number; r: number; g: number; b: number; a: number }>
}

export interface BakedAnimation {
  name: string
  duration: number
  bones: BakedBoneTrack[]
  slots: BakedSlotTrack[]
}

export interface SpineBakeInput {
  json: unknown
  /** 图集文本：官方运行库靠它建立 region / mesh 附件（缺失时 readSkeletonData 会失败） */
  atlasText: string
  /** 我们模型的骨骼名（下标 → 名字），采样值按名字落位，顺序不必一致 */
  boneNames: readonly string[]
  /** 我们模型的插槽名（下标 → 名字） */
  slotNames: readonly string[]
  fps?: number
}

/**
 * 采样后的两步后处理，对齐参考 `Hao2D/Editor/Converter/SpineBakeAnimator.cs`。
 *
 * ① **markStepped**：官方用「阶跃关键帧」表达瞬间切换（最典型是 head-turn 的
 *    head.scale 从 1 直接切到 -1 做水平镜像）。逐帧采样会把它摊成密集线性帧 ——
 *    运行期在两帧之间平滑过渡（scaleX 1 → 0 → -1，头先被压扁再反向展开），
 *    看着不自然，且与采样率无关。相邻采样点差值超过阈值即把前一点标成阶跃。
 *    正常线性动画每帧变化远小于阈值（位移 < 1 像素、旋转 < 10 度、缩放 < 0.1），不会误判。
 *
 * ② **simplify**：删掉能用直线近似替代的中间帧。采样烘焙是「每帧写一个关键帧」，
 *    但绝大多数轨道每帧变化很小甚至完全不动（静止的部件、匀速运动的部件），
 *    这些中间帧是纯冗余 —— 参考实测压缩率 60%~80%（长期静止的部件可达 95%+）。
 *    阈值取「视觉无损」量级：位置 1e-4 世界单位（= 0.01 像素 @PPU100）、旋转 0.05 度。
 *    **阶跃段不简化**，否则会破坏瞬间切换语义。
 */

/** 阶跃检测（双分量）：超阈值即认为该点之后是瞬间切换 */
export function markSteppedVec2(keys: BakedVec2Key[], threshold: number): void {
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i]
    const b = keys[i + 1]
    if (Math.abs(b.x - a.x) > threshold || Math.abs(b.y - a.y) > threshold) a.stepped = true
  }
}

/** 阶跃检测（单值） */
export function markSteppedScalar(keys: BakedScalarKey[], threshold: number): void {
  for (let i = 0; i < keys.length - 1; i++) {
    if (Math.abs(keys[i + 1].value - keys[i].value) > threshold) keys[i].stepped = true
  }
}

/** 简化（双分量）：中间点都落在「锚点 → 终点」直线上（误差 ≤ eps）就丢掉 */
export function simplifyVec2(keys: BakedVec2Key[], eps: number): BakedVec2Key[] {
  if (keys.length <= 2) return keys
  const keep: BakedVec2Key[] = [keys[0]]
  let anchor = 0
  for (let i = 1; i < keys.length; i++) {
    let straight = true
    for (let j = anchor; j < i; j++) {
      if (keys[j].stepped) {
        straight = false
        break
      }
    }
    if (straight) {
      const dt = keys[i].time - keys[anchor].time
      if (dt <= 1e-6) straight = false
      else {
        for (let j = anchor + 1; j < i; j++) {
          const f = (keys[j].time - keys[anchor].time) / dt
          const dx = keys[anchor].x + (keys[i].x - keys[anchor].x) * f - keys[j].x
          const dy = keys[anchor].y + (keys[i].y - keys[anchor].y) * f - keys[j].y
          if (Math.hypot(dx, dy) > eps) {
            straight = false
            break
          }
        }
      }
    }
    if (!straight) {
      // 拐点（i-1）必须保留，并从它重新起算
      const pivot = i - 1 > anchor ? i - 1 : i
      keep.push(keys[pivot])
      anchor = pivot
      i = anchor
    }
  }
  keep.push(keys[keys.length - 1])
  return keep.length < keys.length ? keep : keys
}

/** 简化（单值） */
export function simplifyScalar(keys: BakedScalarKey[], eps: number): BakedScalarKey[] {
  if (keys.length <= 2) return keys
  const keep: BakedScalarKey[] = [keys[0]]
  let anchor = 0
  for (let i = 1; i < keys.length; i++) {
    let straight = true
    for (let j = anchor; j < i; j++) {
      if (keys[j].stepped) {
        straight = false
        break
      }
    }
    if (straight) {
      const dt = keys[i].time - keys[anchor].time
      if (dt <= 1e-6) straight = false
      else {
        for (let j = anchor + 1; j < i; j++) {
          const f = (keys[j].time - keys[anchor].time) / dt
          const lerped = keys[anchor].value + (keys[i].value - keys[anchor].value) * f
          if (Math.abs(lerped - keys[j].value) > eps) {
            straight = false
            break
          }
        }
      }
    }
    if (!straight) {
      const pivot = i - 1 > anchor ? i - 1 : i
      keep.push(keys[pivot])
      anchor = pivot
      i = anchor
    }
  }
  keep.push(keys[keys.length - 1])
  return keep.length < keys.length ? keep : keys
}

/** 连续重复的显示值只保留第一帧（display 是阶跃量，同值重复帧对结果毫无影响） */
function dedupeDisplay(keys: Array<{ time: number; name: string }>): Array<{ time: number; name: string }> {
  if (keys.length <= 1) return keys
  const out = [keys[0]]
  for (let i = 1; i < keys.length; i++) {
    if (keys[i].name !== out[out.length - 1].name) out.push(keys[i])
  }
  return out
}

/** 连续相同的颜色采样帧只保留第一帧（颜色恒定的槽位会被压成 1 帧） */
function dedupeColor<T extends { r: number; g: number; b: number; a: number }>(keys: T[]): T[] {
  if (keys.length <= 1) return keys
  const out = [keys[0]]
  for (let i = 1; i < keys.length; i++) {
    const previous = out[out.length - 1]
    const current = keys[i]
    if (current.r !== previous.r || current.g !== previous.g || current.b !== previous.b || current.a !== previous.a) {
      out.push(current)
    }
  }
  return out
}

/**
 * 烘焙所有动画；失败（版本不兼容 / 图集缺 region / 数据异常）返回 null，
 * 调用方据此回退到内置解析。
 */
export function bakeSpineAnimations(input: SpineBakeInput): BakedAnimation[] | null {
  try {
    const atlas = new TextureAtlas(input.atlasText)
    const skeletonJson = new SkeletonJson(new AtlasAttachmentLoader(atlas))
    // 让官方运行库直接输出我们的世界单位：骨骼位置 ÷ PPU（角度 / 缩放 / 剪切不受影响）
    skeletonJson.scale = 1 / PPU
    const data = skeletonJson.readSkeletonData(input.json)
    const skeleton = new Skeleton(data)
    const state = new AnimationState(new AnimationStateData(data))
    const fps = input.fps && input.fps > 0 ? input.fps : 30

    const boneIndexOf = new Map<string, number>()
    input.boneNames.forEach((name, i) => boneIndexOf.set(name, i))
    const slotIndexOf = new Map<string, number>()
    input.slotNames.forEach((name, i) => slotIndexOf.set(name, i))

    const out: BakedAnimation[] = []
    for (const animation of data.animations) {
      const duration = animation.duration > 0 ? animation.duration : 1 / fps
      const frames = Math.max(1, Math.round(duration * fps))
      const boneTracks = new Map<number, BakedBoneTrack>()
      const slotTracks = new Map<number, BakedSlotTrack>()

      skeleton.setupPose()
      state.clearTracks()
      // 循环播放：末尾回绕的姿态与首帧一致，我们另外补采 t = duration 一帧
      state.setAnimation(0, animation, true)
      state.update(0)

      for (let f = 0; f <= frames; f++) {
        if (f > 0) state.update(1 / fps)
        state.apply(skeleton)
        // 官方在这里应用 IK / 变换 / 路径 / 物理约束，并把结果写进 appliedPose
        skeleton.updateWorldTransform(Physics.update)
        const time = Math.min(duration, f / fps)

        for (const bone of skeleton.bones) {
          const index = boneIndexOf.get(bone.data.name)
          if (index === undefined) continue
          const pose = bone.appliedPose
          let track = boneTracks.get(index)
          if (!track) {
            track = { bone: index, translate: [], rotate: [], scale: [], shear: [] }
            boneTracks.set(index, track)
          }
          track.translate.push({ time, x: pose.x, y: pose.y })
          track.rotate.push({ time, value: pose.rotation })
          track.scale.push({ time, x: pose.scaleX, y: pose.scaleY })
          track.shear.push({ time, x: pose.shearX, y: pose.shearY })
        }

        for (const slot of skeleton.slots) {
          const index = slotIndexOf.get(slot.data.name)
          if (index === undefined) continue
          const pose = slot.appliedPose
          let track = slotTracks.get(index)
          if (!track) {
            track = { slot: index, display: [], color: [] }
            slotTracks.set(index, track)
          }
          const attachment = pose.attachment
          track.display.push({ time, name: attachment ? attachment.name : '' })
          track.color.push({ time, r: pose.color.r, g: pose.color.g, b: pose.color.b, a: pose.color.a })
        }
      }

      // 采样后处理：先还原阶跃语义，再压缩冗余帧（阶跃段会被 simplify 自动跳过）
      for (const track of boneTracks.values()) {
        markSteppedVec2(track.translate, 0.1)
        markSteppedVec2(track.scale, 1)
        markSteppedScalar(track.rotate, 60)
        markSteppedVec2(track.shear, 60)
        track.translate = simplifyVec2(track.translate, 1e-4)
        track.scale = simplifyVec2(track.scale, 1e-4)
        track.rotate = simplifyScalar(track.rotate, 0.05)
        track.shear = simplifyVec2(track.shear, 0.05)
      }
      for (const track of slotTracks.values()) {
        track.display = dedupeDisplay(track.display)
        track.color = dedupeColor(track.color)
      }

      out.push({
        name: animation.name,
        duration,
        bones: [...boneTracks.values()],
        slots: [...slotTracks.values()]
      })
    }
    return out
  } catch {
    return null
  }
}

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
 */

export interface BakedBoneTrack {
  /** 我们模型的骨骼下标 */
  bone: number
  translate: Array<{ time: number; x: number; y: number }>
  rotate: Array<{ time: number; value: number }>
  scale: Array<{ time: number; x: number; y: number }>
  shear: Array<{ time: number; x: number; y: number }>
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

import {
  AnimationState,
  AnimationStateData,
  AtlasAttachmentLoader,
  Physics,
  Skeleton,
  SkeletonJson,
  Skin,
  TextureAtlas
} from '@esotericsoftware/spine-core'
import type { Bone, BoneData, ConstraintData, SkeletonData } from '@esotericsoftware/spine-core'
import { PPU } from './uv'
import { normalizeLegacyAnimations } from './spineLegacyCurves'
import type { SpineCurveKeyframe, SpineJson } from './spineTypes'

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

/** 骨骼的局部变换（我们 BoneData 的同一口径：位置是世界单位、角度是度） */
export interface SetupBoneLocal {
  x: number
  y: number
  rotation: number
  scaleX: number
  scaleY: number
  shearX: number
  shearY: number
}

/** 官方运行库的 `appliedPose`：局部姿态 + 约束算出的世界变换 */
type BonePose = SetupBoneLocal & {
  updateLocalTransform?: (skeleton: Skeleton) => void
  a: number
  b: number
  c: number
  d: number
  worldX: number
  worldY: number
  /** 局部值所属的「第几次更新」；等于 `skeleton._update` 表示是被约束改写的脏值 */
  local?: number
}

/**
 * 取**约束求解之后**的骨骼局部变换（`updateWorldTransform` 之后再调用）。
 *
 * 官方运行库的约束只改世界变换（`PathConstraint` / `TransformConstraint` 都走
 * `modifyWorld`），局部值仍是**约束前**那一份；官方用 `appliedPose.local === skeleton._update`
 * 标记「局部已经和世界对不上」，再由 `validateLocalTransform` 按需反解回局部。
 *
 * 我们导入后不再跑任何约束，照抄那份过期局部值，整条受约束的骨链就会偏：
 * 路径约束铺在曲线上的 `leg-front-1..8`（mix-and-match）、变换约束驱动的 `hat-control` /
 * `dress-control-*` 都是这样，网格蒙皮后脚 / 帽子 / 裙子贴图错位。
 *
 * 所以只对**被约束碰过**的骨骼（`derive`，见 `constrainedBones`）调用 `updateLocalTransform`。
 * 不能对所有骨骼一概反解：没被约束碰过的骨骼世界与局部本来就一致，反解只是把同一变换重新分解一遍
 *（旋转 + 斜切不是唯一表示），我们自己的 FK 会还原出略微不同的世界，子链跟着漂 ——
 * 3.3 的 Spineunitygirl 就是这样被弄成四肢脱位的。
 *
 * 另外父级 0 缩放（Spine 里常见的「靠缩放隐藏」做法）会让世界矩阵不可逆：反解结果是 0 缩放 +
 * 巨大位移，数值有限却完全错误（mix-and-match 的 `hair-strand-*`），这类骨骼也退回局部值。
 */
function resolveLocal(skeleton: Skeleton, bone: Bone, derive: boolean): SetupBoneLocal | null {
  const pose = (bone as unknown as { appliedPose?: BonePose }).appliedPose
  if (!pose) return null
  const before = readLocal(pose)
  // 约束列表里查不到、但官方自己标了脏的（约束间接改写了世界）同样要反解
  const needDerive = derive || isLocalDirty(skeleton, pose)
  if (needDerive && typeof pose.updateLocalTransform === 'function' && !isSingularWorld(pose)) {
    pose.updateLocalTransform(skeleton)
    const after = readLocal(pose)
    if (isFiniteLocal(after)) return after
    writeLocal(pose, before)
  }
  return isFiniteLocal(before) ? before : null
}

/** 局部值是否已被约束改写而失效（官方自己的脏标记，见 `BonePose.validateLocalTransform`） */
function isLocalDirty(skeleton: Skeleton, pose: BonePose): boolean {
  const update = (skeleton as unknown as { _update?: number })._update
  return typeof update === 'number' && pose.local === update
}

/**
 * 官方运行库**真的会解算**的骨骼名（被 IK / 变换 / 路径约束直接改写的那些）。
 *
 * 只看 `data.constraints`（运行库实际解析出来的约束），不看 JSON 版本号：
 * - 4.2+ 的约束在 `constraints` 数组里，运行库会解，世界变换被改写 → 局部必须反解；
 * - 3.x / 4.0 / 4.1 的约束写在顶层 `ik` / `transform` / `path`，4.x 运行库**根本不读**，
 *   `data.constraints` 是空的，世界变换没被动过 → 局部原样即可
 *  （Spineunitygirl 的 `main` 就是这样：约束由我们自己的运行期求解，烘焙值不能动）。
 */
function constrainedBones(data: SkeletonData): Set<string> {
  const out = new Set<string>()
  for (const constraint of data.constraints) {
    const bones = (constraint as unknown as { bones?: BoneData[] }).bones ?? []
    for (const bone of bones) out.add(bone.name)
  }
  return out
}

function readLocal(pose: SetupBoneLocal): SetupBoneLocal {
  return {
    x: pose.x,
    y: pose.y,
    rotation: pose.rotation,
    scaleX: pose.scaleX,
    scaleY: pose.scaleY,
    shearX: pose.shearX,
    shearY: pose.shearY
  }
}

function writeLocal(pose: SetupBoneLocal, local: SetupBoneLocal): void {
  pose.x = local.x
  pose.y = local.y
  pose.rotation = local.rotation
  pose.scaleX = local.scaleX
  pose.scaleY = local.scaleY
  pose.shearX = local.shearX
  pose.shearY = local.shearY
}

/**
 * 让所有「只在特定皮肤里出现」的骨骼 / 约束都生效。
 *
 * Spine 4.x 的 `skin: true`（`skinRequired`）在运行库里意味着：当前皮肤没声明它时，
 * 该骨骼**不进更新队列** —— `appliedPose` 不再从 `pose` 重算、世界变换恒为 0；带同样标记的
 * 约束也不参与求解（见 `Skeleton.updateCache`）。
 *
 * 编辑器没有这个概念（导入后所有骨骼都可见可动），所以烘焙前必须合成一个「包含所有皮肤
 * 声明过的骨骼与约束」的皮肤。否则这些骨骼的采样值永远停在 setup：mix-and-match 的
 * `hair-bangs-transparent` 网格额外蒙皮在 `hair-strand-*` 上，那些骨骼不跟动画走，
 * 动画里这一片头发就会错位。
 */
function activateAllSkinParts(skeleton: Skeleton, data: SkeletonData): void {
  const skin = new Skin('*bake-all')
  const bones = new Set<BoneData>()
  const constraints = new Set<ConstraintData<any, any>>()
  for (const item of data.skins) {
    for (const bone of item.bones) bones.add(bone)
    for (const constraint of item.constraints) constraints.add(constraint)
  }
  skin.bones = [...bones]
  skin.constraints = [...constraints]
  skeleton.setSkin(skin)
}

/**
 * 世界矩阵是否退化（不可逆）。
 *
 * 判据用「行列式相对于自身量级」而不是绝对阈值：整副骨架被放大 / 缩小时，
 * 真实的 0 行列式依然会被判出来，而 0.001 这种合法的小缩放不会被误伤。
 */
function isSingularWorld(world: { a: number; b: number; c: number; d: number }): boolean {
  if (![world.a, world.b, world.c, world.d].every(Number.isFinite)) return true
  const det = world.a * world.d - world.b * world.c
  const scale = Math.abs(world.a * world.d) + Math.abs(world.b * world.c)
  return !(Math.abs(det) > 1e-12 * (scale + 1))
}

function isFiniteLocal(local: SetupBoneLocal): boolean {
  return (
    Number.isFinite(local.x) &&
    Number.isFinite(local.y) &&
    Number.isFinite(local.rotation) &&
    Number.isFinite(local.scaleX) &&
    Number.isFinite(local.scaleY) &&
    Number.isFinite(local.shearX) &&
    Number.isFinite(local.shearY)
  )
}

/**
 * 用官方运行库求 **setup 姿态**的骨骼局部变换（含 IK / 变换 / 路径约束），key = 我们的骨骼下标。
 *
 * 回传的是**全部骨骼**的求解结果，调用方按需与 JSON 原值比较后替换（没被约束改过的骨骼
 * 差异只在浮点末位，替换成原值可避免把噪声写进工程）。
 * 读不到官方运行库（老格式 / 图集缺失）时返回 null，调用方保持 JSON 里的原始姿态。
 */
export function bakeSetupLocals(input: SpineBakeInput): Map<number, SetupBoneLocal> | null {
  try {
    const atlas = new TextureAtlas(input.atlasText)
    const skeletonJson = new SkeletonJson(new AtlasAttachmentLoader(atlas))
    // 与动画烘焙同一口径：官方输出的位置直接是我们的世界单位
    skeletonJson.scale = 1 / PPU
    const data = skeletonJson.readSkeletonData(input.json)
    const skeleton = new Skeleton(data)
    const index = new Map<string, number>()
    input.boneNames.forEach((name, i) => index.set(name, i))
    activateAllSkinParts(skeleton, data)
    // setup 姿态里不推进物理，只让约束落位
    skeleton.setupPose()
    skeleton.updateWorldTransform(Physics.reset)
    const derive = constrainedBones(data)
    const out = new Map<number, SetupBoneLocal>()
    for (const bone of skeleton.bones) {
      const at = index.get(bone.data.name)
      if (at === undefined) continue
      const local = resolveLocal(skeleton, bone, derive.has(bone.data.name))
      if (local) out.set(at, local)
    }
    return out
  } catch {
    return null
  }
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

/**
 * 旋转通道合并键时的**最大取值跨度**（度）。
 *
 * 运行期角度采样走 `sampleAngle → lerpAngle`（**沿最短弧**）：相邻两键的取值跨度一旦超过 180°，
 * 「正转 313°」会被解释成「反转 -47°」。而烘焙做的正是把官方逐帧姿态压成稀疏键 ——
 * 所以压出来的每一段都必须留在这个上限内，否则播放会整段拐错方向。
 *
 * 实测 Dragon 的 flying：COG 第 10–19 帧正转 313.87°，压缩后成为一对相邻键（跨度 282.5°），
 * 播放时该段被当成反转，第 19 帧读出 -53.5°（正确值 306.5°）。
 */
export const MAX_ANGLE_SPAN = 180

/**
 * 简化（单值）：中间点都落在「锚点 → 终点」直线上（误差 ≤ eps）就丢掉。
 *
 * `maxSpan` 额外限制**合并后的取值跨度**：角度传 `MAX_ANGLE_SPAN`（见上），
 * 其余场合保持默认（数值通道没有回绕问题）。
 */
export function simplifyScalar(keys: BakedScalarKey[], eps: number, maxSpan = Infinity): BakedScalarKey[] {
  if (keys.length <= 2) return keys
  const keep: BakedScalarKey[] = [keys[0]]
  let anchor = 0
  for (let i = 1; i < keys.length; i++) {
    // 跨度超上限就不合并：中间点确实还在同一条直线上，但播放时会被当成反向旋转
    let straight = Math.abs(keys[i].value - keys[anchor].value) <= maxSpan
    for (let j = anchor; j < i && straight; j++) {
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
  // 尾巴补最后一键；已经作为 pivot 推过就不要再推（同刻双键在时间轴上会出现空悬键）
  const last = keys[keys.length - 1]
  if (keep[keep.length - 1] !== last) keep.push(last)
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

/** 骨骼通道名（`sourceChannels` 的键、`BakedBoneTrack` 的字段、源 JSON 的键三者一致） */
const CHANNELS = ['translate', 'rotate', 'scale', 'shear'] as const

/**
 * 源动画里**显式带有动画数据**的通道集合：骨骼名 → { translate | rotate | scale | shear }。
 *
 * 官方的采样结果看不出「这条通道在源动画里到底存不存在」，但两者语义并不相同：
 * 没有通道 = 保持 setup；有通道（哪怕值恰好恒等于 setup）= 该通道参与混合 / 叠加。
 * 所以整条删通道不能只看采样值 —— 见 `compactConstantVec2`。
 *
 * 兼容两种导出格式：旧版把通道放在同一对象里（`translate` / `rotate` / `scale` / `shear`），
 * 新版按通道拆开（`translateFrame` / `rotateFrame` / …）。空数组算「没有数据」。
 */
function sourceChannels(json: unknown, animationName: string): Map<string, Set<string>> {
  const animations = (json as { animations?: Record<string, unknown> } | null | undefined)?.animations
  const animation = animations?.[animationName] as { bones?: unknown } | undefined
  const bones = animation?.bones
  if (!bones || typeof bones !== 'object') return new Map()
  const out = new Map<string, Set<string>>()
  for (const [boneName, raw] of Object.entries(bones as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue
    const timeline = raw as Record<string, unknown>
    const channels = new Set<string>()
    for (const channel of CHANNELS) {
      const legacy = timeline[channel]
      const split = timeline[`${channel}Frame`]
      if ((Array.isArray(legacy) && legacy.length > 0) || (Array.isArray(split) && split.length > 0)) {
        channels.add(channel)
      }
    }
    if (channels.size > 0) out.set(boneName, channels)
  }
  return out
}

/**
 * 常量通道压缩（采样值全程相同）。运行期是**替换式**采样：没有轨道就保持 setup 值
 * （见 `player.ts` 的 `sampleInto`，buf 先填 setup，轨道只做覆盖）。
 *
 * - 整段常量但**不同于 setup**（如某部件全程保持一个偏置姿势）→ 只留 1 帧，
 *   采样器对单帧轨道恒取该值，等价。
 * - 整段常量**且等于 setup** → 再看 `keep`：
 *   - `keep = false`：源动画里**没有**这条通道的数据 → 整条删掉，结果完全等价。
 *     这类通道占比最高（静止且停在 setup 的部件），删掉后轨道数与体积大幅下降。
 *   - `keep = true`：源动画里**有**这条通道 → 只留 1 帧，通道保留。
 *     值语义不变（仍是常量），但结构与源一致 —— 删掉的话，这条通道在混合 / 叠加时的
 *     行为会跟着变，导入结果和源动画对不上。
 */
function compactConstantVec2(
  keys: BakedVec2Key[],
  setupX: number,
  setupY: number,
  eps: number,
  keep: boolean
): BakedVec2Key[] {
  if (keys.length === 0) return keys
  const first = keys[0]
  for (const key of keys) {
    if (Math.abs(key.x - first.x) > eps || Math.abs(key.y - first.y) > eps) return keys
  }
  if (!keep && Math.abs(first.x - setupX) <= eps && Math.abs(first.y - setupY) <= eps) return []
  return [first]
}

/** 常量通道压缩（单值），规则同 `compactConstantVec2` */
function compactConstantScalar(
  keys: BakedScalarKey[],
  setup: number,
  eps: number,
  keep: boolean
): BakedScalarKey[] {
  if (keys.length === 0) return keys
  const first = keys[0]
  for (const key of keys) {
    if (Math.abs(key.value - first.value) > eps) return keys
  }
  if (!keep && Math.abs(first.value - setup) <= eps) return []
  return [first]
}

/**
 * 烘焙所有动画；失败（版本不兼容 / 图集缺 region / 数据异常）返回 null，
 * 调用方据此回退到内置解析。
 *
 * 老格式（3.x）的 `translate` 轨道带缓动时官方运行库会算出 NaN（见 spineLegacyCurves），
 * 所以失败后会把那些曲线段拆成线性子键**再试一次** —— 拆完就不再走那条坏路径，
 * 于是老资源也能用官方运行库烘焙，与 Unity 侧一致。
 */
/** 读一帧 rotate 的取值（4.2+ 写 `value`，老文件写 `angle`） */
function rotateKeyValue(key: SpineCurveKeyframe): number {
  const raw = typeof key.value === 'number' ? key.value : key.angle
  return typeof raw === 'number' ? raw : 0
}

/** 回写时用原来的字段名（老文件是 `angle` 就仍写 `angle`） */
function rotateKeyField(key: SpineCurveKeyframe): 'value' | 'angle' {
  return typeof key.value === 'number' ? 'value' : 'angle'
}

/**
 * 把 rotate 通道的取值**连续化**：每一键换成与前一键同方向、跨度落在 (-180°, 180°] 内的等价角。
 *
 * 官方运行库对 rotate 是**按取值直接线性插值**的（`RotateTimeline.getRelativeValue → getCurveValue`，
 * 里面没有任何环绕处理），而运行期角度采样走最短弧（`sampleAngle → lerpAngle`）。
 *
 * 老导出会把角度写成 0..360 的**正数**：Dragon `flying` 的 COG 关键帧是
 * `0° → 23.93° → 337.8° → 0°`，本意是「抬到 23.93° 再轻轻回摆 -22.2°」（337.8 ≡ -22.2），
 * 照字面值交给官方库就会在中间**跨过 180° 把角色翻倒立**（实测第 15 帧 180.91°，画面整个倒过来）。
 *
 * 所以烘焙前先按最短弧连续化：`337.8 → -22.2`，两端 0° 不动，逐帧采样出来就是那条回摆曲线。
 * 旋转差 360° 是同一个姿态，这一步只改数值表示，不改任何一帧看起来的样子。
 *
 * 只复制要改的这一层（animations → bones → rotate 键），骨架 / 皮肤等大对象仍按引用共享；
 * 没改动时原样返回入参对象。
 */
export function wrapRotateKeys(json: unknown): unknown {
  const animations = (json as SpineJson | undefined)?.animations
  if (!animations || typeof animations !== 'object') return json
  const animationsOut = { ...(animations as Record<string, unknown>) }
  let changed = false

  for (const [animationName, animation] of Object.entries(animationsOut)) {
    const bones = (animation as { bones?: Record<string, unknown> } | undefined)?.bones
    if (!bones || typeof bones !== 'object') continue
    let bonesOut: Record<string, unknown> | null = null

    for (const [boneName, track] of Object.entries(bones)) {
      const keys = (track as { rotate?: SpineCurveKeyframe[] } | undefined)?.rotate
      if (!Array.isArray(keys) || keys.length < 2) continue
      let previous = rotateKeyValue(keys[0])
      let keysOut: SpineCurveKeyframe[] | null = null

      for (let i = 1; i < keys.length; i++) {
        const key = keys[i]
        const value = rotateKeyValue(key)
        // 取最近的那个等价角：差值一步就落进 (-180, 180]
        const wrapped = value - 360 * Math.round((value - previous) / 360)
        if (Math.abs(wrapped - value) > 1e-9) {
          if (!keysOut) keysOut = keys.slice()
          keysOut[i] = rotateKeyField(key) === 'value' ? { ...key, value: wrapped } : { ...key, angle: wrapped }
          changed = true
        }
        previous = wrapped
      }

      if (keysOut) {
        if (!bonesOut) bonesOut = { ...bones }
        bonesOut[boneName] = { ...(track as object), rotate: keysOut }
      }
    }

    if (bonesOut) animationsOut[animationName] = { ...(animation as object), bones: bonesOut }
  }

  return changed ? { ...(json as object), animations: animationsOut } : json
}

export function bakeSpineAnimations(input: SpineBakeInput): BakedAnimation[] | null {
  const fps = input.fps && input.fps > 0 ? input.fps : 30
  /*
   * rotate 取值先连续化再交给官方库：官方按取值线性插值，直接读 337.8 会在中途把角色翻过来。
   * 必须在**拆缓动之前**做 —— 拆出来的子键是按原始端点算的（337.8 → 0 的长弧），
   * 事后再连续化就会顺着这些子键一路减 360°，末尾多转一整圈。
   */
  const wrapped = wrapRotateKeys(input.json)
  const first = bakeOnce(input, wrapped, fps, true)
  if (first) return first

  const fixed = normalizeLegacyAnimations(wrapped as SpineJson, fps)
  if (fixed.segments === 0 && fixed.renamed === 0) return null
  const retry = bakeOnce(input, fixed.json, fps, false)
  if (retry) {
    console.info(
      `[spine] 老格式动画已规整（拆缓动 ${fixed.segments} 段 / 改名 ${fixed.renamed} 帧），改用官方运行库烘焙`
    )
    return retry
  }
  return null
}

/**
 * 单次烘焙尝试。
 *
 * `quiet` = 这次失败是**预期内**的（外层还要拿拆过曲线的数据重试），不要把 NaN / 异常打出来。
 */
function bakeOnce(
  input: SpineBakeInput,
  json: unknown,
  fps: number,
  quiet: boolean
): BakedAnimation[] | null {
  try {
    const atlas = new TextureAtlas(input.atlasText)
    const skeletonJson = new SkeletonJson(new AtlasAttachmentLoader(atlas))
    // 让官方运行库直接输出我们的世界单位：骨骼位置 ÷ PPU（角度 / 缩放 / 剪切不受影响）
    skeletonJson.scale = 1 / PPU
    const data = skeletonJson.readSkeletonData(json)
    const skeleton = new Skeleton(data)
    const state = new AnimationState(new AnimationStateData(data))

    const boneIndexOf = new Map<string, number>()
    input.boneNames.forEach((name, i) => boneIndexOf.set(name, i))

    // 皮肤专属骨骼/约束必须全部生效，否则它们的 appliedPose 停在 setup、动画采样不到（见 activateAllSkinParts）
    activateAllSkinParts(skeleton, data)

    // setup 基准（含约束求解后反解回局部的值，与导入时落到 BoneData 的口径一致）：
    // 常量通道要靠它判断「是否已在 setup」，用原始 JSON 值当基准会把被约束改过的骨骼
    // 全部误判成「有动画」（每个动画都多出一堆恒定轨道）
    const derive = constrainedBones(data)
    const setupById = new Map<number, SetupBoneLocal>()
    skeleton.setupPose()
    skeleton.updateWorldTransform(Physics.reset)
    for (const bone of skeleton.bones) {
      const index = boneIndexOf.get(bone.data.name)
      if (index === undefined) continue
      const pose: SetupBoneLocal = resolveLocal(skeleton, bone, derive.has(bone.data.name)) ?? bone.appliedPose
      setupById.set(index, {
        x: pose.x,
        y: pose.y,
        rotation: pose.rotation,
        scaleX: pose.scaleX,
        scaleY: pose.scaleY,
        shearX: pose.shearX,
        shearY: pose.shearY
      })
    }

    const out: BakedAnimation[] = []
    for (const animation of data.animations) {
      const duration = animation.duration > 0 ? animation.duration : 1 / fps
      const frames = Math.max(1, Math.round(duration * fps))
      const boneTracks = new Map<number, BakedBoneTrack>()
      const slotTracks = new Map<number, BakedSlotTrack>()
      /** NaN 只报一次（它在逐帧循环里，报多了刷屏） */
      let nanReported = false

      skeleton.setupPose()
      state.clearTracks()
      // 循环播放：末尾回绕的姿态与首帧一致，我们另外补采 t = duration 一帧
      state.setAnimation(0, animation, true)
      state.update(0)

      for (let f = 0; f <= frames; f++) {
        if (f > 0) state.update(1 / fps)
        /*
         * 把内部 `trackTime` 对齐到**精确的帧时刻**。
         *
         * `state.update(1 / fps)` 是逐帧累加，33 帧后得到的是 1.0999999999999999
         * 而不是 1.1 —— 源动画里正好落在该帧的关键帧（例如 `portal` 的 flare1/flare2
         * 在 1.1s、= 第 33 帧的 translate）就会差 1e-16 而**晚一帧**才被采样，
         * 于是整条轨道从这一帧起都往后错一帧：第 33 帧火焰还在原位、第 34 帧才飞出去。
         *
         * 吸附到帧网格既消掉累加误差，又保留循环回卷后的时间（回卷值会被吸到 0）。
         */
        for (const track of state.tracks) {
          if (!track) continue
          const trackDuration = track.animation.duration
          const snapped = Math.round(track.trackTime * fps) / fps
          track.trackTime = trackDuration > 0 ? Math.min(trackDuration, snapped) : snapped
        }
        state.apply(skeleton)
        // 官方在这里应用 IK / 变换 / 路径 / 物理约束，并把结果写进 appliedPose
        skeleton.updateWorldTransform(Physics.update)
        const time = Math.min(duration, f / fps)

        for (const bone of skeleton.bones) {
          const index = boneIndexOf.get(bone.data.name)
          if (index === undefined) continue
          // 被约束改写过世界的骨骼必须反解回局部才能被我们的 FK 重现（见 resolveLocal）
          const pose: SetupBoneLocal = resolveLocal(skeleton, bone, derive.has(bone.data.name)) ?? bone.appliedPose
          // 采样值必须是有限数。官方运行库对**过老的格式**只有部分兼容：实测 3.3 的工程
          // （对象式 skins + Y 轴朝下的坐标约定）里，所有采样值的 y 分量都会变成 NaN ——
          // 一旦带进轨道，播放时整条骨骼链连同网格顶点全部 NaN，角色直接消失
          //（表现：Pose 正常，一播动画就没图像）。发现异常就整体放弃烘焙，
          // 让调用方回退到内置解析（那边对老格式有完整兼容）。
          if (
            !Number.isFinite(pose.x) ||
            !Number.isFinite(pose.y) ||
            !Number.isFinite(pose.rotation) ||
            !Number.isFinite(pose.scaleX) ||
            !Number.isFinite(pose.scaleY) ||
            !Number.isFinite(pose.shearX) ||
            !Number.isFinite(pose.shearY)
          ) {
            // 只报一次：这是逐帧逐骨骼的循环，报在这里能直接看出是哪根骨骼 / 哪条轨道
            if (!quiet && !nanReported) {
              nanReported = true
              console.warn(
                `[spine] 官方运行库采样出 NaN（动画「${animation.name}」第 ${f} 帧，骨骼「${bone.data.name}」，` +
                  `pose=${pose.x},${pose.y},${pose.rotation}）：多为 3.3 及更早的老格式与 4.x 运行库不兼容，` +
                  `本次导入的动画将回退到内置解析`
              )
            }
            return null
          }
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

        // 这里**不采样 slot（附件显示 / 颜色）** —— 对齐参考实现：
        // 「采样只烘焙骨骼变换（含 IK 反算到 localPose）；slot / deform / drawOrder 用自解析」。
        //
        // 原因是采样时骨架只挂了**默认皮肤**：换装角色（如 Goblins 的 default 只有 3 个槽）
        // 里其余槽位 sampling 出 null，会被写成「隐藏（-1）」，一播动画整个角色就没了；
        // 而未采样的槽位在运行期会保持按**当前皮肤**算出的 setup 显示（player 的替换式采样）。
        // 附件轨道交给内置解析（它是稀疏关键帧，且按附件名在当前皮肤里解析）。
      }

      // 采样后处理：① 还原阶跃语义 → ② 压掉能直线近似的冗余帧（阶跃段会被跳过）
      // → ③ 常量通道压缩（**源里没这条通道**才整条删掉，源里有则至少留 1 帧）
      //
      // ③ 的判据取自源 JSON 而不是采样值：采样结果看不出「这条通道在源动画里存不存在」，
      // 而两者语义不同（无通道 = 保持 setup；有通道 = 参与混合 / 叠加）。
      const animated = sourceChannels(input.json, animation.name)
      const bones: BakedBoneTrack[] = []
      for (const track of boneTracks.values()) {
        markSteppedVec2(track.translate, 0.1)
        markSteppedVec2(track.scale, 1)
        markSteppedScalar(track.rotate, 60)
        markSteppedVec2(track.shear, 60)
        track.translate = simplifyVec2(track.translate, 1e-4)
        track.scale = simplifyVec2(track.scale, 1e-4)
        track.rotate = simplifyScalar(track.rotate, 0.05, MAX_ANGLE_SPAN)
        track.shear = simplifyVec2(track.shear, 0.05)

        const setup = setupById.get(track.bone)
        if (setup) {
          // 「源里有这条通道的数据就不删」：常量值同样压成 1 帧（值语义不变），但通道保留
          const channels = animated.get(input.boneNames[track.bone] ?? '')
          track.translate = compactConstantVec2(
            track.translate,
            setup.x,
            setup.y,
            1e-4,
            channels?.has('translate') ?? false
          )
          track.scale = compactConstantVec2(
            track.scale,
            setup.scaleX,
            setup.scaleY,
            1e-4,
            channels?.has('scale') ?? false
          )
          track.rotate = compactConstantScalar(track.rotate, setup.rotation, 0.05, channels?.has('rotate') ?? false)
          track.shear = compactConstantVec2(
            track.shear,
            setup.shearX,
            setup.shearY,
            0.05,
            channels?.has('shear') ?? false
          )
        }
        // 四条通道都被删掉的骨骼不再作为轨道出现（时间轴上也不该看到空轨道）
        if (track.translate.length + track.rotate.length + track.scale.length + track.shear.length > 0) {
          bones.push(track)
        }
      }
      for (const track of slotTracks.values()) {
        track.display = dedupeDisplay(track.display)
        track.color = dedupeColor(track.color)
      }

      out.push({
        name: animation.name,
        duration,
        bones,
        slots: [...slotTracks.values()]
      })
    }
    return out
  } catch (error) {
    /*
     * 静默回退很容易让人以为是「我们算错了」——其实多半是官方运行库读不了这个文件
     *（版本差异：3.3 的键名、图集缺 region、附件类型不认识…）。把原因打出来，
     * 排查「导入后动画和官方库不一致」时第一眼就能看到。
     */
    if (!quiet) console.warn('[spine] 官方运行库烘焙抛错，已回退内置解析：', error)
    return null
  }
}

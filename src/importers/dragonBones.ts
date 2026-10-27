import { AttachmentType, AnimType, BlendMode, createAttachmentData, createBoneData } from '@core/model/types'
import { t } from '@i18n'
import type { AttachmentData, BoneData, ImageRef, SkinData, SlotData, VertexWeight } from '@core/model/types'
import { createRuntimeAsset } from '@core/model/asset'
import type { RuntimeAsset } from '@core/model/asset'
import { computeBindposes, createSetupPose } from '@core/model/setup'
import { createIkConstraint } from '@core/model/constraints'
import type { IkConstraint } from '@core/model/constraints'
import {
  Easing,
  emptyBoneAnim,
  emptyDeformAnim,
  emptySlotAnim,
  emptySubArmatureKeyframe
} from '@core/model/animation'
import type { AnimData, BoneAnim, DeformAnim, DrawOrderKeyframe, EventKeyframe, IkAnim, SlotAnim } from '@core/model/animation'
import { PPU, pxToUnit } from './uv'
import { triangulateFromHull } from '@core/mesh/triangulate'
import { indexDbSubTextures } from './dragonBonesAtlas'
import type { DbSubTexture } from './dragonBonesAtlas'
import type {
  DbActionJson,
  DbAnimationJson,
  DbArmatureJson,
  DbBoneJson,
  DbDisplayJson,
  DbFrameEasingJson,
  DbJson,
  DbSkinSlotJson,
  DbSlotJson
} from './dragonBonesTypes'

export interface DragonBonesImportInput {
  json: DbJson
  /** 合并后的所有图集 SubTexture（多张 texture_N.json） */
  subTextures: readonly DbSubTexture[]
  pageSizes: Record<string, { width: number; height: number }>
  pageImages?: Record<string, string>
}

export interface DragonBonesImportResult {
  asset: RuntimeAsset
  warnings: string[]
}

export interface DragonBonesImportOptions {
  /** 取第几个 armature（缺省 0）。同名 armature 也能逐个导入 */
  armatureIndex?: number
  /** 输出骨架名（名称去重后的最终名）；缺省用 DB 里的 armature 名 */
  label?: string
  /** DB armature 名 → 工程骨架名（嵌套 display 按这张表改写） */
  armatureNames?: ReadonlyMap<string, string>
  /** 与调用方共享的告警数组（多 armature 导入时汇总到一处） */
  warnings?: string[]
}

/** 一份 DB 骨骼 JSON 导入成整个工程：一个 armature = 一个骨架 */
export interface DragonBoneProjectImportResult {
  assets: RuntimeAsset[]
  /** 与 assets 一一对应的最终骨架名 */
  names: string[]
  /** 各骨架的默认动画名（来自 armature.defaultActions，空串 = 没有） */
  defaultAnimations: string[]
  warnings: string[]
}

const FLIP_Y = -1

/**
 * 取第 `index` 个 armature。
 *
 * **按下标而不是按名字**：DragonBones 里可能出现两个同名 armature（手动复制造成的），
 * 按名字 `find` 永远只会拿到第一个，第二个会被静默吞掉。
 */
function armatureAt(json: DbJson, index = 0): DbArmatureJson | null {
  const list = json.armature ?? []
  if (list.length === 0) return null
  return list[Math.max(0, Math.min(list.length - 1, index))]
}

/** 取一条动作里的「播哪个动画」（gotoAndPlay 优先，其次 gotoAndStop 播一次） */
function actionAnimation(actions: readonly DbActionJson[] | undefined): {
  animation: string
  playTimes: number
} | null {
  for (const action of actions ?? []) {
    const play = (action.gotoAndPlay ?? '').trim()
    // DB 的 0 表示循环；负数在新规则里也等价于循环，原样保留
    if (play) return { animation: play, playTimes: Math.round(action.playTimes ?? 0) }
    const stop = (action.gotoAndStop ?? '').trim()
    if (stop) return { animation: stop, playTimes: 1 }
  }
  return null
}

/** DB 骨骼命名空间用「父名/子名」，去重时保留最后一段 */
function shortName(full: string): string {
  const slash = full.lastIndexOf('/')
  return slash >= 0 ? full.slice(slash + 1) : full
}

function orderBones(bones: readonly DbBoneJson[], warnings: string[]): {
  ordered: DbBoneJson[]
  index: Map<string, number>
  origToNew: number[]
} {
  const byName = new Map<string, DbBoneJson>()
  for (const bone of bones) byName.set(bone.name, bone)

  const ordered: DbBoneJson[] = []
  const visited = new Set<string>()
  const visit = (bone: DbBoneJson, depth: number): void => {
    if (visited.has(bone.name)) return
    if (depth > 512) {
      warnings.push(t('骨骼「{0}」父链过深或存在环，已截断', bone.name))
      return
    }
    if (bone.parent) {
      const parent = byName.get(bone.parent)
      if (!parent) warnings.push(t('骨骼「{0}」的父骨骼「{1}」不存在，已作为根骨骼', [bone.name, bone.parent]))
      else visit(parent, depth + 1)
    }
    if (!visited.has(bone.name)) {
      visited.add(bone.name)
      ordered.push(bone)
    }
  }
  for (const bone of bones) visit(bone, 0)

  const index = new Map<string, number>()
  ordered.forEach((bone, i) => index.set(bone.name, i))
  return { ordered, index, origToNew: bones.map((b) => index.get(b.name) ?? 0) }
}

function blendOf(mode: number | string | undefined, slotName: string, warnings: string[]): BlendMode {
  const value = typeof mode === 'number' ? mode : Number(mode ?? 0)
  switch (value) {
    case 1:
      return BlendMode.Additive
    case 2:
      return BlendMode.Multiply
    case 3:
      return BlendMode.Screen
    case 4:
      return BlendMode.Erase
    case 5:
      // DB 的 5 在旧模型里对应 Mask；Mask 已移除，回退 Normal（DB 也没有 clipping 语义）
      warnings.push(t('插槽「{0}」的混合模式 5（原 Mask）不受支持，已按 Normal 导入', slotName))
      return BlendMode.Normal
    case 6:
      return BlendMode.Below
    case 7:
      return BlendMode.None
    default:
      return BlendMode.Normal
  }
}

/** DB 颜色：乘数（0~100）+ 偏移（-255~255），相加后 clamp01 */
function dbColor(raw: DbBoneColorJson | undefined, base = { r: 1, g: 1, b: 1, a: 1 }): {
  r: number
  g: number
  b: number
  a: number
} {
  if (!raw) return { ...base }
  const mix = (m: number | undefined, o: number | undefined, fallback: number): number => {
    const multiplier = (m ?? 100) / 100
    const offset = (o ?? 0) / 255
    return Math.max(0, Math.min(1, fallback * multiplier + offset))
  }
  return {
    r: mix(raw.rM, raw.rO, base.r),
    g: mix(raw.gM, raw.gO, base.g),
    b: mix(raw.bM, raw.bO, base.b),
    a: mix(raw.aM, raw.aO, base.a)
  }
}

interface DbBoneColorJson {
  aM?: number
  rM?: number
  gM?: number
  bM?: number
  aO?: number
  rO?: number
  gO?: number
  bO?: number
}

/** slotPose：[a,b,c,d,tx,ty] 的 y 反射矩阵（列主序 4x4 的 2x2 + 平移） */
function slotPoseMatrix(pose: readonly number[] | undefined): Float32Array {
  const m = new Float32Array(16)
  m[0] = 1
  m[5] = 1
  m[10] = 1
  m[15] = 1
  if (!pose || pose.length < 6) return m
  m[0] = pose[0]
  m[1] = -pose[1]
  m[4] = -pose[2]
  m[5] = pose[3]
  m[12] = pxToUnit(pose[4])
  m[13] = -pxToUnit(pose[5])
  return m
}

function mulPoint(m: Float32Array, x: number, y: number): { x: number; y: number } {
  return { x: m[0] * x + m[4] * y + m[12], y: m[1] * x + m[5] * y + m[13] }
}

interface AttachmentContext {
  bindposes: Float32Array
  setupWorld: Float32Array
  subTextures: Map<string, DbSubTexture>
  origToNew: number[]
  /** DB armature 名 → 工程骨架名（重名去重后的映射；DB 的嵌套 display 用原名引用） */
  armatureNames: ReadonlyMap<string, string>
  warnings: string[]
}

/** 顶点：DB 为 y-down 且以像素计，统一做 y 翻转 + ÷PPU */
function flipVertex(value: number, index: number): number {
  return index % 2 === 1 ? pxToUnit(value * FLIP_Y) : pxToUnit(value)
}

function parseDbWeights(
  weights: readonly number[],
  vertexCount: number,
  ctx: AttachmentContext,
  slotPose: Float32Array
): VertexWeight[] {
  const out: VertexWeight[] = []
  const boneCount = ctx.origToNew.length
  let cursor = 0
  for (let v = 0; v < vertexCount; v++) {
    if (cursor >= weights.length) {
      // 数据提前耗尽（导出损坏）：补空权重，保证返回值和顶点一一对应
      out.push(packWeights([], 0, ctx, slotPose, v))
      continue
    }
    // DragonBones 的 weights 结构是「[骨骼数, (骨骼下标, 权重) × 骨骼数]」逐顶点排列，
    // 每组占 1 + 2×count 个数。
    // 早先这里按「每根骨骼固定吃 3 个数」推进（cursor += 3），只在「顶点只绑 1 根骨骼」
    // 时凑巧正确；一旦出现绑 2 根以上的顶点，后面**所有**顶点的骨骼与权重就整体错位，
    // 表现为导入后网格被乱骨骼拉扯、部件散架（SkinnedMeshAnim 这类例子必错）。
    const count = Math.max(0, Math.round(weights[cursor] ?? 0))
    cursor += 1
    const entries: Array<{ bone: number; lx: number; ly: number; w: number }> = []
    for (let k = 0; k < count; k++) {
      const rawBone = weights[cursor] ?? 0
      const w = weights[cursor + 1] ?? 0
      cursor += 2
      const mapped = rawBone >= 0 && rawBone < boneCount ? ctx.origToNew[rawBone] : 0
      entries.push({ bone: mapped, lx: 0, ly: 0, w })
    }
    const sorted = entries.filter((e) => e.w > 1e-6).sort((a, b) => b.w - a.w).slice(0, 4)
    const total = sorted.reduce((sum, e) => sum + e.w, 0)
    out.push(packWeights(sorted, total, ctx, slotPose, v))
  }
  return out
}

/** 权重只给了骨骼下标与权值：局部坐标需要从「顶点在世界空间的位置」反算 */
function packWeights(
  entries: Array<{ bone: number; w: number }>,
  total: number,
  ctx: AttachmentContext,
  slotPose: Float32Array,
  vertexIndex: number
): VertexWeight {
  const result: VertexWeight = {
    b0: 0,
    b1: 0,
    b2: 0,
    b3: 0,
    lx0: 0,
    ly0: 0,
    lx1: 0,
    ly1: 0,
    lx2: 0,
    ly2: 0,
    lx3: 0,
    ly3: 0,
    w0: 0,
    w1: 0,
    w2: 0,
    w3: 0
  }
  void slotPose
  void vertexIndex
  const bones = [0, 0, 0, 0]
  const ws = [0, 0, 0, 0]
  for (let k = 0; k < entries.length && k < 4; k++) {
    bones[k] = entries[k].bone
    ws[k] = total > 0 ? entries[k].w / total : 0
  }
  result.b0 = bones[0]
  result.b1 = bones[1]
  result.b2 = bones[2]
  result.b3 = bones[3]
  result.w0 = ws[0]
  result.w1 = ws[1]
  result.w2 = ws[2]
  result.w3 = ws[3]
  return result
}

function convertDisplay(
  display: DbDisplayJson,
  ctx: AttachmentContext,
  slotBoneIndex: number,
  /** setup 默认动作（display → skin slot → slot 依次回退） */
  actions?: readonly DbActionJson[]
): AttachmentData | null {
  const type = (display.type ?? 'image').toLowerCase()

  const transform = display.transform ?? {}
  const base = {
    name: display.name ?? '',
    position: { x: pxToUnit(transform.x ?? 0), y: -pxToUnit(transform.y ?? 0) },
    rotation: -(transform.skX ?? 0),
    scale: { x: transform.scX ?? 1, y: transform.scY ?? 1 }
  }

  /*
   * 嵌套骨架：DB 的 `type:"armature"` display。
   *
   * **绝不能像旧实现那样返回 null**：`displayIndex` 是按下标引用 display 数组的，
   * 少一项后面所有动画的显示下标都会整体错位（表现为「换装换错图 / 部件凭空消失」）。
   * 引用不存在的 armature 时也保留附件，只把 `subArmature` 留空并告警。
   */
  if (type === 'armature') {
    const rawName = (display.path ?? display.name ?? '').trim()
    const mapped = ctx.armatureNames.get(rawName) ?? ''
    if (!mapped) {
      ctx.warnings.push(
        t('嵌套骨架「{0}」引用的 armature 在文件里不存在，已留空', rawName || display.name || '未命名')
      )
    }
    const setup = actionAnimation(actions)
    return createAttachmentData({
      ...base,
      type: AttachmentType.Armature,
      subArmature: mapped,
      subAnimation: setup?.animation ?? '',
      subPlayTimes: setup?.playTimes ?? 0,
      subOffset: 0,
      subSpeed: 1,
      size: { x: pxToUnit(display.width ?? 0), y: pxToUnit(display.height ?? 0) }
    })
  }

  if (type === 'mesh') {
    const rawVertices = display.vertices ?? []
    const vertexCount = Math.floor(rawVertices.length / 2)
    const vertices = new Float32Array(vertexCount * 2)
    for (let i = 0; i < vertices.length; i++) vertices[i] = flipVertex(rawVertices[i], i)

    const uvs = new Float32Array(vertexCount * 2)
    const subTexture = ctx.subTextures.get(display.path ?? display.name ?? '')
    const rawUvs = display.uvs ?? []
    for (let i = 0; i < vertexCount; i++) {
      const u = rawUvs[i * 2] ?? 0
      const v = rawUvs[i * 2 + 1] ?? 0
      if (subTexture) {
        // DB 的 mesh uvs 是「区域内的相对坐标」，v=0 指向区域**顶边**（与官方 UnitySlot 一致）。
        // 映射到图集再翻成 uv 的底左原点：v 直接用，只对图集 y 做一次 1-y。
        // （早先多套了一层 (1-v)，等于把网格贴图上下翻了过来 —— 纹理会与顶点错位。）
        uvs[i * 2] = (subTexture.x + u * subTexture.width) / Math.max(1, subTexture.textureWidth)
        uvs[i * 2 + 1] = 1 - (subTexture.y + v * subTexture.height) / Math.max(1, subTexture.textureHeight)
      } else {
        uvs[i * 2] = u
        uvs[i * 2 + 1] = 1 - v
      }
    }

    // 加权网格：局部坐标 = bindpose[b] · (slotPose · vertex)
    const slotPose = slotPoseMatrix(display.slotPose)
    const rawWeights = display.weights ?? []
    let weights: VertexWeight[] = []
    if (rawWeights.length > 0) {
      const weighted = parseDbWeights(rawWeights, vertexCount, ctx, slotPose)
      for (let i = 0; i < vertexCount; i++) {
        const world = mulPoint(slotPose, vertices[i * 2], vertices[i * 2 + 1])
        const entry = weighted[i]
        fillLocal(entry, ctx.bindposes, world.x, world.y)
      }
      weights = weighted
    }

    const hull = Math.max(0, Math.min(display.hull ?? vertexCount, vertexCount))
    let triangles = display.triangles ?? []
    // 损坏/非三角形索引数组也按缺失处理
    if (triangles.length % 3 !== 0) triangles = []
    // DragonBones 经常只给 hull+edges 不给 triangles，我们自己耳切兜底；
    // 否则 Spine/Unity 只能用 hull 做凸包填充，丢失凹形（羊的四肢/身体变方块）。
    if (triangles.length === 0 && hull >= 3) {
      triangles = triangulateFromHull(vertices, hull, display.edges ?? [])
    }
    const edges: number[] = []
    if (display.edges && display.edges.length > 0) {
      edges.push(...display.edges)
    } else if (hull >= 3) {
      // edges 缺失时按 hull 顺序生成闭合外环，保证导出和编辑器的边界显示一致
      for (let i = 0; i < hull; i++) edges.push(i, (i + 1) % hull)
    }

    return createAttachmentData({
      ...base,
      type: AttachmentType.Mesh,
      textureName: subTexture?.textureName ?? '',
      regionName: subTexture?.name,
      size: { x: pxToUnit(display.width ?? 0), y: pxToUnit(display.height ?? 0) },
      uvs,
      vertices,
      triangles,
      edges,
      hull,
      weights,
      ffdInBoneSpace: false
    })
  }

  if (type === 'boundingbox') {
    const rawVertices = display.vertices ?? []
    const vertices = new Float32Array(rawVertices.length)
    for (let i = 0; i < vertices.length; i++) vertices[i] = flipVertex(rawVertices[i], i)
    return createAttachmentData({
      ...base,
      type: AttachmentType.BoundingBox,
      vertices,
      triangles: display.triangles ?? [],
      hull: display.hull ?? 0
    })
  }

  // image（Region）
  const subTexture = ctx.subTextures.get(display.path ?? display.name ?? '')
  if (!subTexture) ctx.warnings.push(t('附件「{0}」的图集区域不存在', display.name ?? ''))
  const frameWidth = subTexture ? (subTexture.frameWidth || subTexture.width) : 0
  const frameHeight = subTexture ? (subTexture.frameHeight || subTexture.height) : 0
  const packedWidth = subTexture?.width ?? 0
  const packedHeight = subTexture?.height ?? 0
  /*
   * 裁剪（trim）：区域中心相对原图中心的位移，y 向上，**图片自身坐标轴**里的量。
   *
   * DB 的 frameX/frameY 与 Spine atlas 的 offset 同号同值（frameX = -左裁量），所以
   * 裁剪块在原图里的位置直接由它们给出；DB 的显示原点默认取**原图中心**。
   * 这个位移必须写成 `contentOffset`（渲染时在附件局部坐标里叠加），**不能**加进 `position`
   * —— position 会被骨骼的旋转带着转，位移就跟着歪（Rooster 的下嘴跑到上嘴上方就是栽在这）。
   */
  const centerX = (packedWidth - frameWidth) * 0.5 - (subTexture?.frameX ?? 0)
  const centerY = (frameHeight - packedHeight) * 0.5 + (subTexture?.frameY ?? 0)
  void slotBoneIndex

  return createAttachmentData({
    ...base,
    type: AttachmentType.Region,
    textureName: subTexture?.textureName ?? '',
    regionName: subTexture?.name,
    // position = 显示变换（= 原图中心）；裁剪块的位置交给 contentOffset（见上）
    position: { x: base.position.x, y: base.position.y },
    /*
     * 尺寸取**图集区域**尺寸，而不是未裁剪的 frame 尺寸。
     *
     * Region 的四边形就是 `size × size`（见 meshBuilder.emitRegion），UV 又只覆盖区域本身 ——
     * 用 frame 尺寸等于把裁掉的部分一起拉长：Rooster 的 beak_lower（区域 39×14 塞在
     * 73×53 的逻辑帧里）会被拉成 73×53，看上去就像「位置和旋转都错了」。
     *
     * 未裁剪时 frame 尺寸 == 区域尺寸，行为不变；与 C# DragonBonesConverter 的
     * `size = float2(rw, rh)` 一致（那边注释：矩形中心 = frameOffset，尺寸 = 图集区域）。
     */
    size: { x: pxToUnit(packedWidth), y: pxToUnit(packedHeight) },
    // 原图尺寸（含裁剪留白）与内容偏移：前者给编辑器画框 / 变换手柄，后者渲染时在附件局部叠加。
    // 未裁剪时 frameX/Y = 0 且 frame 尺寸 == 区域尺寸，两个字段等价于无效果。
    frameSize: { x: pxToUnit(frameWidth), y: pxToUnit(frameHeight) },
    contentOffset: { x: pxToUnit(centerX), y: pxToUnit(centerY) },
    uvs: subTexture
      ? Float32Array.from([
          subTexture.x / subTexture.textureWidth,
          1 - (subTexture.y + subTexture.height) / subTexture.textureHeight,
          (subTexture.x + subTexture.width) / subTexture.textureWidth,
          1 - (subTexture.y + subTexture.height) / subTexture.textureHeight,
          (subTexture.x + subTexture.width) / subTexture.textureWidth,
          1 - subTexture.y / subTexture.textureHeight,
          subTexture.x / subTexture.textureWidth,
          1 - subTexture.y / subTexture.textureHeight
        ])
      : Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1])
  })
}

/** 用 bindpose 把「世界/骨架空间」的顶点反算成每骨骼局部坐标 */
function fillLocal(entry: VertexWeight, bindposes: Float32Array, worldX: number, worldY: number): void {
  const count = Math.max(1, Math.floor(bindposes.length / 16))
  const localX = (bone: number): number => {
    const o = Math.max(0, Math.min(count - 1, bone)) * 16
    return bindposes[o] * worldX + bindposes[o + 4] * worldY + bindposes[o + 12]
  }
  const localY = (bone: number): number => {
    const o = Math.max(0, Math.min(count - 1, bone)) * 16
    return bindposes[o + 1] * worldX + bindposes[o + 5] * worldY + bindposes[o + 13]
  }
  entry.lx0 = localX(entry.b0)
  entry.ly0 = localY(entry.b0)
  entry.lx1 = localX(entry.b1)
  entry.ly1 = localY(entry.b1)
  entry.lx2 = localX(entry.b2)
  entry.ly2 = localY(entry.b2)
  entry.lx3 = localX(entry.b3)
  entry.ly3 = localY(entry.b3)
}

/**
 * DragonBones（骨骼 JSON + texture_N.json 图集）→ Runtime 模型。
 *
 * 要点：
 * - y-down → y-up：位置 y 取反、旋转取反、顶点与 FFD 的奇数下标取反
 * - 动画时间以帧计，统一除以 frameRate 转秒
 * - 多张图集合并成「SubTexture 名 → 页」表，附件 UV 按各自页尺寸归一化
 * - 加权网格：局部坐标 = bindpose[骨骼] · (slotPose · 顶点)
 * - playTimes == 0（无限循环）时在末尾补一帧等于首帧的关键帧
 */
export function importDragonBones(
  input: DragonBonesImportInput,
  options: DragonBonesImportOptions = {}
): DragonBonesImportResult {
  const warnings = options.warnings ?? []
  const armature = armatureAt(input.json, options.armatureIndex ?? 0)
  if (!armature) {
    warnings.push(t('DragonBones 数据里没有 armature 段'))
    return { asset: createRuntimeAsset({ dataType: AnimType.DragonBone }), warnings }
  }
  const label = (options.label ?? (armature.name ?? '').trim()) || 'armature'

  const { ordered, index: boneIndex, origToNew } = orderBones(armature.bone ?? [], warnings)
  const boneData: BoneData[] = ordered.map((bone) => {
    const transform = bone.transform ?? {}
    const parentIndex = bone.parent ? (boneIndex.get(bone.parent) ?? -1) : -1
    return createBoneData({
      name: shortName(bone.name),
      parentIndex,
      localPosition: { x: pxToUnit(transform.x ?? 0), y: -pxToUnit(transform.y ?? 0) },
      rotation: -(transform.skX ?? 0),
      localScale: { x: transform.scX ?? 1, y: transform.scY ?? 1 },
      localShear: { x: 0, y: 0 },
      inheritRotation: bone.inheritRotation !== false,
      inheritScale: bone.inheritScale !== false,
      length: pxToUnit(bone.length ?? 0)
    })
  })

  const slotJsons = armature.slot ?? []
  // DB 的绘制顺序 = 按 `slot[].z` 升序（同 z 保持声明顺序；缺省 z 用声明下标兜底，
  // 与参考 `s["z"].AsInt(i)` 一致）。**导入时就把 slots 排成这个顺序**：
  // 编译期按 zOrder 再排一次是恒等的，于是「运行期插槽下标 == 这里建造的下标」，
  // 动画 / FFD 轨道里的 slotIndex 才能对上号（早先按声明顺序摆放，z 不等于声明
  // 顺序的资源会把动画应用到错误的插槽上）。
  const orderedSlots = slotJsons
    .map((slot: DbSlotJson, i) => ({ slot, index: i, z: typeof slot.z === 'number' ? slot.z : i }))
    .sort((a, b) => a.z - b.z || a.index - b.index)
  /** 各插槽的静态层级键（已按运行期下标排列）：层级动画要把它当初始值 */
  const staticZOrder = orderedSlots.map((entry) => entry.z)
  const slots: SlotData[] = orderedSlots.map(({ slot }, i) => ({
    name: slot.name,
    boneIndex: boneIndex.get(slot.parent ?? '') ?? 0,
    color: dbColor(slot.color as DbBoneColorJson | undefined),
    blendMode: blendOf(slot.blendMode, slot.name, warnings),
    defaultDisplayIndex: -1,
    // 排序后的位次：compile 侧按它排序即恒等，层序在导入期就固化了
    defaultZOrder: i,
    z: 0,
    setupAttachment: '',
    // DB 没有插槽级可见性概念，全部按可见导入
    visible: true
  }))
  const slotIndexByName = new Map<string, number>()
  slots.forEach((slot, i) => slotIndexByName.set(slot.name, i))

  const skeletonOnly = createRuntimeAsset({
    dataType: AnimType.DragonBone,
    armatureName: label,
    frameRate: armature.frameRate ?? input.json.frameRate ?? 24,
    bones: boneData,
    slots,
    skins: [],
    constraints: [],
    animations: [],
    textureNames: [],
    defaultSkinIndex: 0,
    runtimeIK: true,
    images: []
  })
  const setup = createSetupPose(skeletonOnly)
  const bindposes = computeBindposes(skeletonOnly)

  const ctx: AttachmentContext = {
    bindposes,
    setupWorld: setup.world,
    subTextures: indexDbSubTextures(input.subTextures),
    origToNew,
    armatureNames: options.armatureNames ?? new Map(),
    warnings
  }

  /** 插槽级默认动作（嵌套骨架 setup 动画的第二优先级） */
  const slotActions = new Map<string, DbActionJson[]>()
  for (const slot of slotJsons) if (slot.actions && slot.actions.length > 0) slotActions.set(slot.name, slot.actions)

  const skins: SkinData[] = (armature.skin ?? [{ name: 'default', slot: [] }]).map((skin, skinIdx) => ({
    /*
     * DB 的默认皮肤常常写成空串（`"skin": [{ "name": "", ... }]`），而不是省掉 name ——
     * 只判 `??` 会把这个空串原样带进来，皮肤面板上就是一个空白标签（实测 Demon 就是如此）。
     * 空串要当成「没有名字」：首个皮肤叫 `default`（与 createEmptyDocument / 编译器的
     * 默认皮肤查找口径一致），其余按序号。
     */
    name: (skin.name ?? '').trim() || (skinIdx === 0 ? 'default' : `skin${skinIdx}`),
    slots: (skin.slot ?? []).map((skinSlot: DbSkinSlotJson) => {
      const slotIndex = slotIndexByName.get(skinSlot.name ?? '')
      const boneIdx = slotIndex !== undefined ? slots[slotIndex].boneIndex : 0
      const setupActions = [...(skinSlot.actions ?? []), ...(slotActions.get(skinSlot.name ?? '') ?? [])]
      /** display 名在同一插槽里必须唯一（运行期按名字解析显示项） */
      const usedNames = new Set<string>()
      const attachments: AttachmentData[] = []
      for (const display of skinSlot.display ?? []) {
        const converted = convertDisplay(display, ctx, boneIdx, [...(display.actions ?? []), ...setupActions])
        if (!converted) continue
        if (!converted.name) converted.name = `display_${attachments.length}`
        if (usedNames.has(converted.name)) {
          let suffix = 2
          while (usedNames.has(`${converted.name}_${suffix}`)) suffix++
          converted.name = `${converted.name}_${suffix}`
        }
        usedNames.add(converted.name)
        attachments.push(converted)
      }
      return { slotName: skinSlot.name ?? '', attachments }
    })
  }))

  // setup 显示下标
  const defaultSkinIndex = Math.max(0, skins.findIndex((s) => s.name === 'default'))
  const defaultSkin = skins[defaultSkinIndex]
  slotJsons.forEach((slot: DbSlotJson, i) => {
    const target = slots[i]
    const skinSlot = defaultSkin?.slots.find((s) => s.slotName === slot.name)
    const displayIndex = slot.displayIndex ?? 0
    if (skinSlot && displayIndex >= 0 && displayIndex < skinSlot.attachments.length) {
      target.defaultDisplayIndex = displayIndex
      target.setupAttachment = skinSlot.attachments[displayIndex].name
    }
  })

  const textureNames: string[] = []
  for (const skin of skins) {
    for (const slot of skin.slots) {
      for (const attachment of slot.attachments) {
        if (attachment.textureName && !textureNames.includes(attachment.textureName)) {
          textureNames.push(attachment.textureName)
        }
      }
    }
  }

  const iks: IkConstraint[] = (armature.ik ?? [])
    .map((ik) => {
      const tip = boneIndex.get(ik.bone ?? '')
      const target = boneIndex.get(ik.target ?? '')
      // DragonBones 的 IK：`bone` 是**末端**骨骼，`chain` 是「末端之外还要向上追溯的骨骼数」
      //（chain:1 即「父 + 末端」两骨链）。boneIndices 约定为「根 → … → 末端」，末端在最后。
      //
      // 早先只放了一根末端骨骼、完全忽略 chain —— 两骨腿会退化成 CCD 迭代解，
      // 脚解不到 IK 目标（表现：播放含 IK 的动画时脚穿到地面以下、膝盖方向错）。
      const chainIndices: number[] = []
      if (tip !== undefined) {
        const up: number[] = []
        let cur = tip
        const chain = ik.chain ?? 1
        for (let c = 0; c < chain; c++) {
          const parent = boneData[cur]?.parentIndex ?? -1
          if (parent < 0) break
          up.push(parent)
          cur = parent
        }
        // 从末端向上收集后反转，末端补在最后
        for (let c = up.length - 1; c >= 0; c--) chainIndices.push(up[c])
        chainIndices.push(tip)
      }
      return createIkConstraint({
        name: ik.name ?? 'ik',
        order: 0,
        enabled: true,
        boneIndices: chainIndices,
        targetBoneIndex: target ?? -1,
        mix: ik.weight ?? 1,
        // 对齐 Unity 端 Hao2D 运行时：DB 的 bendPositive（缺省 true）表示正向弯曲 → +1
        bendSign: ik.bendPositive === false ? -1 : 1,
        // DragonBones 用「根骨 length × 缩放」作为 l1
        useBoneLength: true
      })
    })
    .filter((ik) => ik.boneIndices.length > 0 && ik.targetBoneIndex >= 0)

  /** 默认皮肤里各插槽的 display 名（动画的 displayIndex 要落成名字才稳） */
  const displayNames = new Map<string, string[]>()
  for (const skinSlot of defaultSkin?.slots ?? []) {
    displayNames.set(
      skinSlot.slotName,
      skinSlot.attachments.map((attachment) => attachment.name)
    )
  }
  /** 挂了嵌套骨架的插槽：只有这些插槽的 actions 才写成「子骨架」通道 */
  const armatureSlots = new Set<string>()
  for (const skin of skins) {
    for (const skinSlot of skin.slots) {
      if (skinSlot.attachments.some((attachment) => attachment.type === AttachmentType.Armature)) {
        armatureSlots.add(skinSlot.slotName)
      }
    }
  }

  const frameRate = armature.frameRate ?? input.json.frameRate ?? 24
  const animations: AnimData[] = (armature.animation ?? []).map((animation) =>
    importDbAnimation(animation, {
      boneIndex,
      slotIndex: slotIndexByName,
      bones: boneData,
      slots,
      staticZOrder,
      iks,
      textureNames,
      displayNames,
      armatureSlots,
      frameRate,
      warnings
    })
  )

  // 按页分组所有 SubTexture，导出时把图集页里每个 sprite 子区域照原样写进 .atlas，
  // 而不是整页当一块（否则重新导入 Spine 后每个附件都指向整页区域）。
  const subByPage = new Map<string, DbSubTexture[]>()
  for (const sub of input.subTextures) {
    const list = subByPage.get(sub.textureName) ?? []
    list.push(sub)
    subByPage.set(sub.textureName, list)
  }
  const images: ImageRef[] = textureNames.map((name) => {
    const subs = subByPage.get(name)
    return {
      name,
      path: input.pageImages?.[name] ?? name,
      width: input.pageSizes[name]?.width ?? 0,
      height: input.pageSizes[name]?.height ?? 0,
      loose: subs ? false : undefined,
      regions: subs
        ? subs.map((s) => {
            // DB 的裁剪（trim）信息必须完整保留到 atlas 区域，否则导出到 Spine 后
            // trimmed 子图（如 logo24、Rooster 的 beak_lower）的尺寸/位置会错乱。
            //
            // 对应关系（y 向上，与编辑器 contentOffset 真值对齐）：
            //   editor.contentOffset.x = (packedW - frameW)/2 - frameX
            //   editor.contentOffset.y = (frameH - packedH)/2 + frameY
            // spine RegionAttachment 渲染四边形中心 = -frame/2 + offset + packed/2，
            // 反推得：offsetX = -frameX，offsetY = (frameH - packedH) + frameY，
            // 且 origWidth/Height = frame（原图含留白），region.width/height = 打包尺寸。
            const frameW = s.frameWidth
            const frameH = s.frameHeight
            const fx = s.frameX
            const fy = s.frameY
            return {
              name: s.name,
              x: s.x,
              y: s.y,
              width: s.width,
              height: s.height,
              rotate: 0,
              origWidth: frameW,
              origHeight: frameH,
              offsetX: -fx,
              offsetY: frameH - s.height + fy
            }
          })
        : undefined
    }
  })

  const asset = createRuntimeAsset({
    dataType: AnimType.DragonBone,
    armatureName: label,
    frameRate,
    bones: boneData,
    slots,
    skins,
    constraints: iks,
    animations,
    textureNames,
    defaultSkinIndex,
    runtimeIK: true,
    images
  })
  asset.bindposes = bindposes

  return { asset, warnings }
}

/**
 * 一份 DragonBones 骨骼 JSON → 整个工程（**一个 armature = 一个骨架**）。
 *
 * 为什么必须整份导入：DB 的嵌套是「armature 之间按名字引用」，
 * 只取第一个 armature 会把嵌套的父骨架与被引用的子骨架割开，`type:"armature"`
 * 的 display 就只能变成一个空引用。名称去重（重名 / 空名）也要在这里统一决定，
 * 否则子骨架改名后父骨架里的引用会指空。
 */
export function importDragonBoneProject(input: DragonBonesImportInput): DragonBoneProjectImportResult {
  const warnings: string[] = []
  const list = input.json.armature ?? []
  if (list.length === 0) {
    warnings.push(t('DragonBones 数据里没有 armature 段'))
    return {
      assets: [createRuntimeAsset({ dataType: AnimType.DragonBone })],
      names: ['armature'],
      defaultAnimations: [''],
      warnings
    }
  }

  const used = new Set<string>()
  const names: string[] = []
  /** DB armature 名（原始） → 工程骨架名 */
  const nameMap = new Map<string, string>()
  for (let i = 0; i < list.length; i++) {
    const raw = (list[i].name ?? '').trim()
    const base = raw || `armature_${i + 1}`
    let final = base
    let suffix = 2
    while (used.has(final)) final = `${base}_${suffix++}`
    used.add(final)
    names.push(final)
    if (!raw) continue
    const mapped = nameMap.get(raw)
    if (mapped === undefined) nameMap.set(raw, final)
    else
      warnings.push(
        t('armature 名「{0}」重复：第 {1} 个改名为「{2}」，其嵌套引用仍指向「{3}」', [
          raw,
          i + 1,
          final,
          mapped
        ])
      )
    nameMap.set(final, final)
  }

  const assets: RuntimeAsset[] = []
  const defaultAnimations: string[] = []
  list.forEach((armature, index) => {
    const result = importDragonBones(input, {
      armatureIndex: index,
      label: names[index],
      armatureNames: nameMap,
      warnings
    })
    assets.push(result.asset)

    // 骨架级默认动作：只作为「打开时默认选中的动画」，不新增字段（避免双份真源）
    const setup = actionAnimation(armature.defaultActions)
    const exists = setup !== null && result.asset.animations.some((animation) => animation.name === setup.animation)
    if (setup && !exists)
      warnings.push(
        t('骨架「{0}」的默认动画「{1}」不存在，已忽略', [names[index], setup.animation])
      )
    defaultAnimations.push(exists && setup ? setup.animation : '')
  })

  return { assets, names, defaultAnimations, warnings }
}

interface DbAnimContext {
  boneIndex: Map<string, number>
  slotIndex: Map<string, number>
  bones: readonly BoneData[]
  slots: readonly SlotData[]
  /** 各插槽的静态层级键（已按运行期下标排列）：层级动画的初始值 */
  staticZOrder: readonly number[]
  iks: readonly IkConstraint[]
  textureNames: readonly string[]
  /** 默认皮肤里各插槽的 display 名（displayIndex → 名字） */
  displayNames: ReadonlyMap<string, readonly string[]>
  /** 挂了嵌套骨架的插槽名（只有它们的 actions 才落成「子骨架」通道） */
  armatureSlots: ReadonlySet<string>
  frameRate: number
  warnings: string[]
}

/**
 * 帧缓动：DB 的 `tweenEasing` **缺省 / null 表示线性补间**（导出时"线性"常常直接省略该字段），
 * 有 `curve` 数组时用贝塞尔，数值型缓动本转换器统一按线性近似。
 *
 * 早先把 null 当成「不补间（阶跃）」是反的：每段都会瞬间跳变，循环动画在末帧↔首帧
 * 还会抖一次 —— 这是"导入后动画看着不对"的主要原因之一。
 * displayIndex 这类真正的阶跃量在各自的解析处强制 Stepped，不依赖这里。
 */
/**
 * 展开 DB 的 **稀疏 zOrder 表示**：帧里只列出被移动的槽 `[槽下标, 偏移, ...]`，
 * 要还原成完整的绘制顺序数组。规则照抄参考 `Hao2DConvertUtil.ExpandDrawOrder`：
 *
 * ① 默认是声明顺序；
 * ② 被移动的槽占据「原下标 + 偏移」的**绝对位次**（越界则夹到两端）；
 * ③ 其余空位按原顺序填入**未移动**的槽；被移动项按下标升序处理，结果才稳定。
 *
 * 早先是「在已移动的数组里逐个 splice」：每次 `indexOf` 拿到的位置已被前面的移动带偏，
 * 元素会错位。Dora_zorder 实测 pairs `[21,-8, 23,-11, 24,-10, 34,-19]`：
 * 参考得到 `…12, 23, 21, 24, 34…`，旧实现得到 `…12, 23, 12, 24, 34…`（21 被挤出、12 错位）。
 */
export function expandDrawOrder(slotIndices: readonly number[], offsets: readonly number[], slotCount: number): number[] {
  const result: number[] = []
  for (let i = 0; i < slotCount; i++) result.push(i)
  const n = Math.min(slotIndices.length, offsets.length)
  if (slotCount <= 0 || n === 0) return result

  // 按下标升序（补空位规则要求顺序稳定）
  const pairs: Array<{ index: number; offset: number }> = []
  for (let i = 0; i < n; i++) pairs.push({ index: slotIndices[i], offset: offsets[i] })
  pairs.sort((a, b) => a.index - b.index)

  // 被移动的槽占据「原下标 + 偏移」的位次
  result.fill(-1)
  const moved = new Array<boolean>(slotCount).fill(false)
  for (const pair of pairs) {
    if (pair.index < 0 || pair.index >= slotCount) continue
    const at = Math.max(0, Math.min(slotCount - 1, pair.index + pair.offset))
    result[at] = pair.index
    moved[pair.index] = true
  }

  // 空位按原顺序填入未移动的槽
  let free = 0
  for (let i = 0; i < slotCount; i++) {
    if (moved[i]) continue
    while (free < slotCount && result[free] !== -1) free++
    if (free >= slotCount) break
    result[free++] = i
  }
  return result.filter((value) => value >= 0)
}

function easingOfFrame(frame: DbFrameEasingJson): { easing: Easing; curve: number[] | null } {
  const raw = Array.isArray(frame.curve) ? frame.curve : null
  if (raw && raw.length >= 4) {
    return { easing: Easing.Bezier, curve: raw.slice(0, 4).map((value) => Number(value) || 0) }
  }
  return { easing: Easing.Linear, curve: null }
}

/** DB 动画：所有时间以帧计，除以 frameRate 转秒；playTimes == 0 时补循环闭合帧 */
function importDbAnimation(animation: DbAnimationJson, ctx: DbAnimContext): AnimData {
  const fps = animation.frameRate && animation.frameRate > 0 ? animation.frameRate : ctx.frameRate
  const toSeconds = (frames: number): number => frames / Math.max(1, fps)
  const playTimes = animation.playTimes ?? 0
  const loop = playTimes === 0

  const bones: BoneAnim[] = []
  for (const track of animation.bone ?? []) {
    const index = ctx.boneIndex.get(track.name ?? '')
    if (index === undefined) continue
    const bone = ctx.bones[index]
    const anim = emptyBoneAnim(index)
    const pushTranslate = (time: number, x: number, y: number, frame: DbFrameEasingJson): void => {
      const e = easingOfFrame(frame)
      anim.translate.push({
        time: toSeconds(time),
        value: { x: bone.localPosition.x + pxToUnit(x), y: bone.localPosition.y - pxToUnit(y) },
        easing: e.easing,
        curve: e.curve
      })
    }
    const pushRotate = (time: number, rotate: number, frame: DbFrameEasingJson): void => {
      const e = easingOfFrame(frame)
      anim.rotate.push({
        time: toSeconds(time),
        value: bone.rotation - rotate,
        easing: e.easing,
        curve: e.curve
      })
    }
    const pushScale = (time: number, scX: number, scY: number, frame: DbFrameEasingJson): void => {
      const e = easingOfFrame(frame)
      anim.scale.push({
        time: toSeconds(time),
        value: { x: bone.localScale.x * scX, y: bone.localScale.y * scY },
        easing: e.easing,
        curve: e.curve
      })
    }

    const legacy = track.frame ?? []
    let trackDuration = 0
    if (legacy.length > 0) {
      // 5.5 之前的旧格式：每帧带完整 transform（值为相对 setup 的增量）
      let time = 0
      for (const frame of legacy) {
        const transform = frame.transform ?? {}
        pushTranslate(time, transform.x ?? 0, transform.y ?? 0, frame)
        pushRotate(time, transform.skX ?? 0, frame)
        pushScale(time, transform.scX ?? 1, transform.scY ?? 1, frame)
        time += frame.duration ?? 0
      }
      trackDuration = time
    } else {
      // 5.x 新格式：通道拆开，`duration` 是「这一帧持续多少帧」，时间逐帧累加；
      // 单帧缺省的分量表示「增量为 0」（即保持 setup），所以**每一帧都要写** ——
      // 跳过"这一帧没给值"的帧，会让那一整段被相邻关键帧插值覆盖，姿势就错了。
      //
      // 早先只认旧格式 track.frame，新格式下一条关键帧都读不到 → 整段骨骼动画被当成
      // 空轨道丢掉，表现就是「导入后动画不动、蒙皮网格塌成碎片」（SkinnedMeshAnim 这类
      // 用新格式导出的工程必错）。
      let duration = 0
      let time = 0
      for (const frame of track.translateFrame ?? []) {
        pushTranslate(time, frame.x ?? 0, frame.y ?? 0, frame)
        time += frame.duration ?? 0
      }
      duration = Math.max(duration, time)
      time = 0
      for (const frame of track.rotateFrame ?? []) {
        pushRotate(time, frame.rotate ?? 0, frame)
        time += frame.duration ?? 0
      }
      duration = Math.max(duration, time)
      time = 0
      for (const frame of track.scaleFrame ?? []) {
        pushScale(time, frame.x ?? 1, frame.y ?? 1, frame)
        time += frame.duration ?? 0
      }
      trackDuration = Math.max(duration, time)
    }
    // 三条通道全空才算空轨道（只看 rotate 会把「只动位置」的骨骼整条丢掉）
    if (anim.rotate.length > 0 || anim.translate.length > 0 || anim.scale.length > 0) {
      closeLoop(anim, loop, toSeconds(trackDuration))
      bones.push(anim)
    }
  }

  const slots: SlotAnim[] = []
  /** 层级动画：各插槽帧里 `z`（排序键）的采样序列，循环后统一重排成 drawOrder */
  const zTracks: Array<{ slot: number; keys: Array<{ time: number; z: number }> }> = []
  for (const track of animation.slot ?? []) {
    const slotName = track.name ?? ''
    const index = ctx.slotIndex.get(slotName)
    if (index === undefined) continue
    const slot = ctx.slots[index]
    const anim = emptySlotAnim(index)
    const displayNames = ctx.displayNames.get(slotName)
    const nested = ctx.armatureSlots.has(slotName)
    let time = 0
    let hasColor = false
    const zKeys: Array<{ time: number; z: number }> = []
    for (const frame of track.frame ?? []) {
      if (typeof frame.z === 'number') zKeys.push({ time: toSeconds(time), z: frame.z })
      /*
       * 缺省 displayIndex = 「这一帧不换显示项」（DB 的 -2 也是这个意思），不能默认成 0：
       * 只为 `actions` 存在、没写 displayIndex 的帧（嵌套骨架的控制帧正是如此）会被顺手
       * 把显示项切回第一个附件 —— 换装与嵌套 display 切换都会因此错位。
       */
      if (typeof frame.displayIndex === 'number' && frame.displayIndex > -2) {
        const value = frame.displayIndex
        anim.displayIndex.push({
          time: toSeconds(time),
          value,
          easing: Easing.Stepped,
          curve: null
        })
        // 名字要和下标一一对应（并行数组）：运行期优先按名字解析，换装才不容易切错
        anim.displayAttachment.push(value >= 0 ? (displayNames?.[value] ?? '') : '')
      }
      if (nested && frame.actions && frame.actions.length > 0) {
        const action = actionAnimation(frame.actions)
        if (action) {
          anim.subArmature.push(
            emptySubArmatureKeyframe(toSeconds(time), action.animation, action.playTimes, 0, 1)
          )
        } else {
          ctx.warnings.push(
            t('动画「{0}」插槽「{1}」的 actions 里没有 gotoAndPlay / gotoAndStop，已忽略', [
              animation.name ?? '',
              slotName
            ])
          )
        }
      }
      if (frame.color) {
        const e = easingOfFrame(frame)
        anim.color.push({
          time: toSeconds(time),
          value: dbColor(frame.color as DbBoneColorJson, slot.color),
          easing: e.easing,
          curve: e.curve
        })
        hasColor = true
      }
      time += frame.duration ?? 0
    }
    if (anim.displayIndex.length > 0 || hasColor || anim.subArmature.length > 0) slots.push(anim)
    if (zKeys.length > 0) zTracks.push({ slot: index, keys: zKeys })
  }

  const deforms: DeformAnim[] = []
  for (const track of animation.ffd ?? []) {
    const index = ctx.slotIndex.get(track.slot ?? '')
    if (index === undefined) continue
    const anim = emptyDeformAnim(index, track.name ?? '')
    // DB 的 FFD 帧：`offset` 是**浮点数组下标**（起始顶点 = offset/2，需向下取偶），
    // `vertices` 是相对绑定位置的位移（y-down）；区间外的顶点补 0。
    // 这里烘焙成「满顶点长度」的数组（vertexOffset 恒为 0），运行期不必再做基址换算。
    const frames = track.frame ?? []
    let need = 0
    for (const frame of frames) {
      const start = Math.round(frame.offset ?? 0) & ~1
      need = Math.max(need, start + (frame.vertices?.length ?? 0))
    }
    let time = 0
    for (const frame of frames) {
      const start = Math.max(0, Math.round(frame.offset ?? 0) & ~1)
      const vertices = frame.vertices ?? []
      const offsets = new Array<number>(need).fill(0)
      for (let i = 0; i < vertices.length; i++) {
        // 奇偶按**段内相对下标**判断 —— 早先误用绝对下标（offset + i），
        // offset 为奇数时整个 x/y 会反转，FFD 直接把网格拉变形
        offsets[start + i] = flipVertex(vertices[i], i)
      }
      const e = easingOfFrame(frame)
      anim.frames.push({
        time: toSeconds(time),
        offsets,
        vertexOffset: 0,
        easing: e.easing,
        curve: e.curve
      })
      time += frame.duration ?? 0
    }
    if (anim.frames.length > 0) {
      closeLoopDeform(anim, loop, toSeconds(time))
      deforms.push(anim)
    }
  }

  const drawOrder: DrawOrderKeyframe[] = []
  const zOrderFrames = animation.zOrder?.frame ?? []
  {
    let time = 0
    for (const frame of zOrderFrames) {
      const pairs = frame.zOrder ?? []
      const slotIndices: number[] = []
      const offsets: number[] = []
      for (let i = 0; i + 1 < pairs.length; i += 2) {
        slotIndices.push(pairs[i])
        offsets.push(pairs[i + 1])
      }
      drawOrder.push({
        time: toSeconds(time),
        order: expandDrawOrder(slotIndices, offsets, ctx.slots.length)
      })
      time += frame.duration ?? 0
    }
  }

  /**
   * 层级动画（DB 4.5）：插槽的层序在**每个 slot 帧的 `z`** 里给（`z` 是排序键，
   * 升序绘制、同 z 保持静态顺序）。动画重新给插槽赋 z 就是「层级变化动画」——
   * 例如 Demon 的 run 把 effect5 从 29 提到 22、火焰从身体后面挪到前面。
   *
   * 这里在**每个 z 出现的时刻**用当前所有插槽的 z 重排一次完整绘制顺序，
   * 只在与上一帧不同时落成关键帧（运行期按阶跃采样，天然贴合 DB 的瞬间换层语义）。
   *
   * 早先完全没读帧里的 `z`：层级动画被整段忽略，整段动画都用静态层序。
   */
  if (zTracks.length > 0) {
    const count = ctx.slots.length
    const currentZ = ctx.staticZOrder.slice()
    const cursors = zTracks.map(() => 0)
    const moments = new Set<number>()
    for (const track of zTracks) for (const key of track.keys) moments.add(key.time)

    let previous: number[] = Array.from({ length: count }, (_, i) => i)
    for (const moment of [...moments].sort((a, b) => a - b)) {
      zTracks.forEach((track, i) => {
        while (cursors[i] < track.keys.length && track.keys[cursors[i]].time <= moment + 1e-9) {
          currentZ[track.slot] = track.keys[cursors[i]].z
          cursors[i]++
        }
      })
      const order = Array.from({ length: count }, (_, i) => i).sort(
        (a, b) => currentZ[a] - currentZ[b] || a - b
      )
      if (order.some((value, i) => value !== previous[i])) {
        drawOrder.push({ time: moment, order })
        previous = order
      }
    }
  }

  const events: EventKeyframe[] = []
  {
    let time = 0
    for (const frame of animation.frame ?? []) {
      const event = frame.event ?? frame.action
      if (event && typeof event.name === 'string' && event.name.length > 0) {
        events.push({
          time: toSeconds(time),
          name: event.name,
          stringParam: '',
          intParam: Math.round(event.data?.int ?? 0),
          floatParam: event.data?.float ?? 0
        })
      }
      time += frame.duration ?? 0
    }
  }

  const iks: IkAnim[] = []
  {
    let time = 0
    for (const frame of animation.ik ?? []) {
      const index = ctx.iks.findIndex((ik) => ik.name === frame.name)
      if (index < 0) continue
      const existing = iks.find((track) => track.ikIndex === index)
      const target = existing ?? { ikIndex: index, mix: [] }
      target.mix.push({
        time: toSeconds(time),
        value: frame.frame?.[0]?.weight ?? 1,
        easing: Easing.Linear,
        curve: null
      })
      if (!existing) iks.push(target)
      time += 0
    }
  }

  let duration = Math.max(toSeconds(animation.duration ?? 0), 0)
  for (const track of bones) {
    duration = Math.max(duration, track.rotate[track.rotate.length - 1]?.time ?? 0)
    duration = Math.max(duration, track.translate[track.translate.length - 1]?.time ?? 0)
  }
  for (const track of deforms) duration = Math.max(duration, track.frames[track.frames.length - 1]?.time ?? 0)
  for (const event of events) duration = Math.max(duration, event.time)

  return {
    name: animation.name ?? 'animation',
    duration: duration > 0 ? duration : 1,
    bones,
    slots,
    deforms,
    drawOrder,
    events,
    iks,
    constraints: []
  }
}

/** FFD 轨道的循环闭合：末尾补一帧「等于首帧偏移」，让末帧→回绕处连续 */
function closeLoopDeform(anim: DeformAnim, loop: boolean, duration: number): void {
  if (!loop || duration <= 0 || anim.frames.length === 0) return
  const first = anim.frames[0]
  const last = anim.frames[anim.frames.length - 1]
  if (last.time >= duration - 1e-6) return
  const same =
    first.offsets.length === last.offsets.length &&
    first.offsets.every((value, i) => Math.abs(value - last.offsets[i]) < 1e-5)
  if (same) return
  anim.frames.push({
    time: duration,
    offsets: first.offsets.slice(),
    vertexOffset: 0,
    easing: Easing.Linear,
    curve: null
  })
}

/** playTimes == 0（无限循环）时在末尾补一帧等于首帧的关键帧，角度走最短弧 */
function closeLoop(anim: BoneAnim, loop: boolean, duration: number): void {
  if (!loop || duration <= 0) return
  const firstRotate = anim.rotate[0]
  if (firstRotate && anim.rotate[anim.rotate.length - 1]?.time < duration) {
    let target = firstRotate.value
    const last = anim.rotate[anim.rotate.length - 1].value
    while (target - last > 180) target -= 360
    while (last - target > 180) target += 360
    anim.rotate.push({ time: duration, value: target, easing: Easing.Linear, curve: null })
  }
  for (const track of [anim.translate, anim.scale] as const) {
    const first = track[0]
    if (first && track[track.length - 1]?.time < duration) {
      track.push({ time: duration, value: { ...first.value }, easing: Easing.Linear, curve: null })
    }
  }
}

export { PPU }

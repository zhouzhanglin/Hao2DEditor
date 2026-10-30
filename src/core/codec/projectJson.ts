import { BlendMode } from '../model/types'
import { t } from '@i18n'
import type { ConstraintType, InheritMode } from '../model/constraints'
import {
  createIkConstraint,
  createPathConstraint,
  createTransformConstraint
} from '../model/constraints'
import type { AnimData, ConstraintAnim, DeformKeyframe, EventKeyframe, KeyframeBase } from '../model/animation'
import { Easing } from '../model/animation'
import type {
  AuthoringAnimData,
  AuthoringAttachment,
  AuthoringBone,
  AuthoringConstraint,
  AuthoringImage,
  AuthoringSkin,
  AuthoringSkinSlot,
  AuthoringSlot,
  AuthoringVertex,
  EditorDocument,
  EditorMeta,
  StageImage
} from '../model/authoring'
import { CURRENT_SCHEMA_VERSION, createDefaultMeta, createEmptyDocument } from '../model/authoring'

/**
 * 工程文件后缀（不含点，落盘文件名形如 `hero.hao2dproj`）。
 *
 * 为什么从 `.hao2d.proj` 改成单段后缀：复合后缀在文件对话框、`path.extname()`、
 * 双击打开、命令行补全里处处要特判（extname 只给最后的 `.proj`），
 * 而 `.hao2dproj` 一段就能表达「Hao2D 工程」。
 */
export const PROJECT_EXTENSION = 'hao2dproj'

/** 旧后缀也认：`.hao2d.proj` 是改动之前的正式后缀，`.json` 是更早手改过的工程 */
export const LEGACY_PROJECT_EXTENSIONS = ['hao2d.proj', 'json']

/**
 * 工程文件路径 → 项目名：`My.Game.hao2d.proj` → `My.Game`。
 *
 * 用途：老工程文件里没有 `projectName` 字段时拿它兜底 —— 导出目录、图集名与图集页名
 * 都该跟**项目名**走，而不是跟骨架名（`hero.hao2d.proj` 里有个叫 `hero` 的骨架只是常事）。
 */
export function projectNameFromPath(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path
  const lower = base.toLowerCase()
  for (const ext of [PROJECT_EXTENSION, ...LEGACY_PROJECT_EXTENSIONS]) {
    const suffix = `.${ext.toLowerCase()}`
    if (lower.endsWith(suffix)) return base.slice(0, base.length - suffix.length)
  }
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

/** 路径是否已经是工程文件（新后缀 / 旧后缀都算，用于文件对话框与拖放判断） */
export function isProjectPath(path: string): boolean {
  const lower = path.toLowerCase()
  return [PROJECT_EXTENSION, ...LEGACY_PROJECT_EXTENSIONS].some((ext) => lower.endsWith(`.${ext}`))
}

/**
 * 旧后缀 → 新后缀：`hero.hao2d.proj` → `hero.hao2dproj`。
 *
 * 只在保存时用（打开老工程不改名，用户没保存就不该动他的文件）。
 * 不是旧后缀（已经是新的、或是 `.json` 老工程）时原样返回。
 */
export function migrateLegacyProjectExtension(path: string): { path: string; migrated: boolean } {
  const lower = path.toLowerCase()
  const legacy = `.${LEGACY_PROJECT_EXTENSIONS[0]}`
  if (!lower.endsWith(legacy)) return { path, migrated: false }
  return { path: `${path.slice(0, path.length - legacy.length)}.${PROJECT_EXTENSION}`, migrated: true }
}

export interface ParseDocumentResult {
  document: EditorDocument
  warnings: string[]
}

/** 工程文件是「Authoring 模型 + 编辑器元数据」的可读 JSON，便于 diff 与手工排查。 */
export function serializeDocument(doc: EditorDocument): string {
  return `${JSON.stringify(doc, null, 2)}\n`
}

export function parseDocument(text: string): ParseDocumentResult {
  const raw = JSON.parse(text) as unknown
  return normalizeDocument(raw)
}

/**
 * 工程文件的**多骨架**写法。
 *
 * 文件结构（单骨架工程与老格式完全一样）：
 * - 顶层仍是「当前骨架」的扁平字段 + 共享的 `images`（老版本编辑器读到的就是当前骨架）；
 * - 多骨架时再补两个字段：`activeSkeleton`（下标）与 `skeletons`（**全部**骨架的骨架部分，
 *   不含 `images` —— 图片池只有顶层那一份，由所有骨架共享）。
 */
export function serializeProject(
  skeletons: readonly EditorDocument[],
  activeSkeleton: number,
  projectName?: string
): string {
  const list = skeletons.length > 0 ? skeletons : [createEmptyDocument()]
  const index = Math.min(Math.max(0, Math.round(activeSkeleton)), list.length - 1)
  const payload: Record<string, unknown> = { ...list[index] }
  // 项目名是**项目级**的（与骨架名无关）：导出的图集名与输出目录用它
  if (projectName && projectName.length > 0) payload.projectName = projectName
  if (list.length > 1) {
    payload.activeSkeleton = index
    payload.skeletons = list.map((doc) => skeletonPart(doc))
  }
  return `${JSON.stringify(payload, null, 2)}\n`
}

/** 骨架部分的字段（共享的图片池与版本号留在工程顶层） */
function skeletonPart(doc: EditorDocument): Record<string, unknown> {
  return {
    armatureName: doc.armatureName,
    frameRate: doc.frameRate,
    runtimeIK: doc.runtimeIK,
    bones: doc.bones,
    slots: doc.slots,
    skins: doc.skins,
    constraints: doc.constraints,
    animations: doc.animations,
    editorMeta: doc.editorMeta
  }
}

export interface ParseProjectResult {
  skeletons: EditorDocument[]
  activeSkeleton: number
  /**
   * 工程里记的项目名。老工程没有这个字段 → **空串**，由调用方按工程文件名兜底
   *（见 `projectNameFromPath`）—— 导出目录 / 图集名 / 图集页名都跟项目名走，不跟骨架名。
   */
  projectName: string
  warnings: string[]
}

export function parseProject(text: string): ParseProjectResult {
  return normalizeProject(JSON.parse(text) as unknown)
}

/**
 * 把任意 JSON 规整成「多骨架工程」。
 *
 * - 有 `skeletons` 数组（且非空）→ 逐个骨架规整，图片池取顶层 `images`；
 * - 否则按老格式处理（顶层就是一份骨架文档），等价于「只有一个骨架」。
 *
 * 项目名缺失（老工程）时给空串：调用方更清楚工程文件叫什么，由它兜底。
 */
export function normalizeProject(raw: unknown): ParseProjectResult {
  if (!isRecord(raw)) {
    const single = normalizeDocument(raw)
    return {
      skeletons: [single.document],
      activeSkeleton: 0,
      projectName: '',
      warnings: single.warnings
    }
  }
  const parts = Array.isArray(raw.skeletons) ? raw.skeletons.filter(isRecord) : []
  if (parts.length === 0) {
    const single = normalizeDocument(raw)
    return {
      skeletons: [single.document],
      activeSkeleton: 0,
      projectName: str(raw.projectName, ''),
      warnings: single.warnings
    }
  }

  const pool = arr(raw.images).map((item) => normalizeImage(isRecord(item) ? item : {}))
  const warnings: string[] = []
  const skeletons = parts.map((part) => {
    // 复用单骨架规整：图片池在工程顶层共享，逐骨架带上同一份
    const parsed = normalizeDocument({ ...part, schemaVersion: raw.schemaVersion, images: pool })
    for (const warning of parsed.warnings) warnings.push(warning)
    return parsed.document
  })
  const active = Math.min(Math.max(0, Math.round(num(raw.activeSkeleton, 0))), skeletons.length - 1)
  return { skeletons, activeSkeleton: active, projectName: str(raw.projectName, ''), warnings }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function strArray(value: unknown): string[] {
  return arr(value).filter((v): v is string => typeof v === 'string')
}

function vec2(value: unknown, fallbackX = 0, fallbackY = 0): { x: number; y: number } {
  if (isRecord(value)) return { x: num(value.x, fallbackX), y: num(value.y, fallbackY) }
  return { x: fallbackX, y: fallbackY }
}

function easeOf(value: unknown): Easing {
  const v = num(value, Easing.Linear)
  return v === Easing.Stepped ? Easing.Stepped : v === Easing.Bezier ? Easing.Bezier : Easing.Linear
}

function curveOf(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null
  const list = value.filter((v): v is number => typeof v === 'number')
  return list.length === 0 ? null : list
}

function keyBase(raw: Record<string, unknown>): KeyframeBase {
  return { time: num(raw.time), easing: easeOf(raw.easing), curve: curveOf(raw.curve) }
}

function floatKeys(value: unknown): AuthoringAnimData['bones'][number]['rotate'] {
  return arr(value).map((item) => {
    const raw = isRecord(item) ? item : {}
    return { ...keyBase(raw), value: num(raw.value) }
  })
}

function float2Keys(value: unknown): AuthoringAnimData['bones'][number]['translate'] {
  return arr(value).map((item) => {
    const raw = isRecord(item) ? item : {}
    return { ...keyBase(raw), value: vec2(raw.value) }
  })
}

function colorKeys(value: unknown): AuthoringAnimData['slots'][number]['color'] {
  return arr(value).map((item) => {
    const raw = isRecord(item) ? item : {}
    return {
      ...keyBase(raw),
      value: {
        r: num((raw.value as Record<string, unknown>)?.r, 1),
        g: num((raw.value as Record<string, unknown>)?.g, 1),
        b: num((raw.value as Record<string, unknown>)?.b, 1),
        a: num((raw.value as Record<string, unknown>)?.a, 1)
      }
    }
  })
}

/** 子骨架控制帧：动画名是字符串，不能套用数值关键帧的读法（与 displayAttachment 同理） */
function subArmatureKeys(value: unknown): AuthoringAnimData['slots'][number]['subArmature'] {
  return arr(value).map((item) => {
    const raw = isRecord(item) ? item : {}
    return {
      ...keyBase(raw),
      animation: str(raw.animation),
      playTimes: Math.round(num(raw.playTimes)),
      offset: num(raw.offset),
      speed: num(raw.speed, 1)
    }
  })
}

function intKeys(value: unknown): AuthoringAnimData['slots'][number]['displayIndex'] {
  return arr(value).map((item) => {
    const raw = isRecord(item) ? item : {}
    return { ...keyBase(raw), value: Math.round(num(raw.value)) }
  })
}

function deformFrames(value: unknown): DeformKeyframe[] {
  return arr(value).map((item) => {
    const raw = isRecord(item) ? item : {}
    return {
      ...keyBase(raw),
      offsets: arr(raw.offsets).map((v) => num(v)),
      vertexOffset: Math.round(num(raw.vertexOffset))
    }
  })
}

function eventKeys(value: unknown): EventKeyframe[] {
  return arr(value).map((item) => {
    const raw = isRecord(item) ? item : {}
    return {
      time: num(raw.time),
      name: str(raw.name),
      stringParam: str(raw.stringParam),
      intParam: Math.round(num(raw.intParam)),
      floatParam: num(raw.floatParam)
    }
  })
}

function normalizeBone(raw: Record<string, unknown>): AuthoringBone {
  const scale = vec2(raw.localScale, 1, 1)
  return {
    name: str(raw.name, 'bone'),
    parent: str(raw.parent),
    localPosition: vec2(raw.localPosition),
    rotation: num(raw.rotation),
    localScale: { x: scale.x === 0 ? 1 : scale.x, y: scale.y === 0 ? 1 : scale.y },
    localShear: vec2(raw.localShear),
    inheritRotation: bool(raw.inheritRotation, true),
    inheritScale: bool(raw.inheritScale, true),
    length: num(raw.length, 20),
    color: str(raw.color, '#F97316'),
    locked: bool(raw.locked)
  }
}

function normalizeVertex(raw: Record<string, unknown>): AuthoringVertex {
  return {
    x: num(raw.x),
    y: num(raw.y),
    weights: arr(raw.weights).map((item) => {
      const w = isRecord(item) ? item : {}
      return { bone: str(w.bone), weight: num(w.weight) }
    })
  }
}

function normalizeAttachment(raw: Record<string, unknown>): AuthoringAttachment {
  const type = str(raw.type, 'region')
  const resolvedType: AuthoringAttachment['type'] =
    type === 'mesh' ||
    type === 'linkedmesh' ||
    type === 'boundingbox' ||
    type === 'clipping' ||
    type === 'armature'
      ? type
      : 'region'
  return {
    name: str(raw.name, 'attachment'),
    type: resolvedType,
    image: str(raw.image),
    // 导出 Spine 用：附件在图集里的区域名（= sprite 名）。老工程没有此字段 → undefined
    regionName: str(raw.regionName) || undefined,
    position: vec2(raw.position),
    rotation: num(raw.rotation),
    scale: vec2(raw.scale, 1, 1),
    size: vec2(raw.size, 100, 100),
    // 未裁剪原图（含留白）尺寸与内容偏移；老工程没有这两个字段 → 0（= 没裁剪过，框就是 size）
    frameSize: vec2(raw.frameSize, 0, 0),
    contentOffset: vec2(raw.contentOffset, 0, 0),
    color: str(raw.color, '#FFFFFFFF'),
    vertices: arr(raw.vertices).map((item) => normalizeVertex(isRecord(item) ? item : {})),
    uvs: arr(raw.uvs).map((v) => num(v)),
    triangles: arr(raw.triangles).map((v) => Math.round(num(v))),
    edges: arr(raw.edges).map((v) => Math.round(num(v))),
    hull: Math.round(num(raw.hull)),
    ffdInBoneSpace: bool(raw.ffdInBoneSpace),
    linkedMeshSkin: str(raw.linkedMeshSkin),
    linkedMeshAttachment: str(raw.linkedMeshAttachment),
    // 由 Region 转来的网格会带一份源 Region 快照，读回来才能「还原为 Region」
    regionSnapshot: normalizeRegionSnapshot(raw.regionSnapshot),
    // 权重骨骼列表（白名单逐字段还原，漏了这行落盘的绑定关系会被丢掉）
    bones: strArray(raw.bones),
    // 遮罩字段：老工程没有 → 空串/关闭（等价于「不是遮罩」）
    clipEndSlot: str(raw.clipEndSlot),
    clipInverse: bool(raw.clipInverse),
    clipConvex: bool(raw.clipConvex),
    // 嵌套骨架（v3）：老工程没有 → 空串/循环/原速（等价于「不是嵌套附件」）
    subArmature: str(raw.subArmature),
    subAnimation: str(raw.subAnimation),
    subPlayTimes: Math.round(num(raw.subPlayTimes)),
    subOffset: num(raw.subOffset),
    subSpeed: num(raw.subSpeed, 1)
  }
}

function normalizeRegionSnapshot(raw: unknown): { size: { x: number; y: number }; uvs: number[] } | undefined {
  if (!isRecord(raw)) return undefined
  return {
    size: vec2(raw.size, 100, 100),
    uvs: arr(raw.uvs).map((value) => num(value))
  }
}

function normalizeSkin(raw: Record<string, unknown>): AuthoringSkin {
  return {
    name: str(raw.name, 'default'),
    slots: arr(raw.slots).map<AuthoringSkinSlot>((item) => {
      const slot = isRecord(item) ? item : {}
      return {
        slot: str(slot.slot),
        attachments: arr(slot.attachments).map((a) => normalizeAttachment(isRecord(a) ? a : {}))
      }
    })
  }
}

/**
 * 旧版本的混合模式数值 → 新枚举。
 *
 * v1 的取值是 Normal 0 / Additive 1 / Multiply 2 / Screen 3 / Erase 4 /
 * Mask 5 / Below 6 / None 7；v2 移除了 Mask 并把 Below、None 各前移一位。
 * 旧 Mask 插槽没有可恢复的遮罩多边形，只能回退 Normal（并提示用户改用遮罩附件）。
 */
function migrateBlendMode(value: unknown, version: number): { mode: BlendMode; legacyMask: boolean } {
  const blend = Math.round(num(value))
  if (version < 2) {
    if (blend === 5) return { mode: BlendMode.Normal, legacyMask: true }
    if (blend === 6) return { mode: BlendMode.Below, legacyMask: false }
    if (blend === 7) return { mode: BlendMode.None, legacyMask: false }
  }
  if (blend >= BlendMode.Normal && blend <= BlendMode.None) {
    return { mode: blend as BlendMode, legacyMask: false }
  }
  return { mode: BlendMode.Normal, legacyMask: false }
}

function normalizeSlot(raw: Record<string, unknown>, version: number, warnings: string[]): AuthoringSlot {
  const blend = migrateBlendMode(raw.blendMode, version)
  if (blend.legacyMask) {
    warnings.push(
        t('插槽「{0}」使用了已移除的混合模式 Mask，已迁移为 Normal；遮罩请改用遮罩附件', str(raw.name, 'slot'))
      )
  }
  return {
    name: str(raw.name, 'slot'),
    bone: str(raw.bone),
    color: str(raw.color, '#FFFFFFFF'),
    blendMode: blend.mode,
    zOrder: Math.round(num(raw.zOrder)),
    z: num(raw.z),
    attachment: str(raw.attachment),
    visible: bool(raw.visible, true),
    locked: bool(raw.locked)
  }
}

const CONSTRAINT_TYPES: ConstraintType[] = ['ik', 'transform', 'path', 'physics']

function constraintCommon(raw: Record<string, unknown>, fallbackName: string) {
  return {
    name: str(raw.name, fallbackName),
    order: Math.round(num(raw.order)),
    enabled: bool(raw.enabled, true),
    bones: strArray(raw.bones),
    target: str(raw.target)
  }
}

/** 约束按类型分别补齐默认值，保证工程文件缺字段时也能安全加载 */
function normalizeConstraint(raw: Record<string, unknown>): AuthoringConstraint {
  const type = str(raw.type, 'ik') as ConstraintType
  const resolved = CONSTRAINT_TYPES.includes(type) ? type : 'ik'

  if (resolved === 'transform') {
    const base = createTransformConstraint()
    const inherit = str(raw.inherit, base.inherit)
    const inheritMode: InheritMode =
      inherit === 'onlyTranslation' ||
      inherit === 'noRotationOrReflection' ||
      inherit === 'noScale' ||
      inherit === 'noScaleOrReflection'
        ? inherit
        : 'normal'
    return {
      ...constraintCommon(raw, base.name),
      type: 'transform',
      mixRotate: num(raw.mixRotate, base.mixRotate),
      mixX: num(raw.mixX, base.mixX),
      mixY: num(raw.mixY, base.mixY),
      mixScaleX: num(raw.mixScaleX, base.mixScaleX),
      mixScaleY: num(raw.mixScaleY, base.mixScaleY),
      mixShearY: num(raw.mixShearY, base.mixShearY),
      offsetRotate: num(raw.offsetRotate, base.offsetRotate),
      offsetX: num(raw.offsetX, base.offsetX),
      offsetY: num(raw.offsetY, base.offsetY),
      offsetScaleX: num(raw.offsetScaleX, base.offsetScaleX),
      offsetScaleY: num(raw.offsetScaleY, base.offsetScaleY),
      offsetShearY: num(raw.offsetShearY, base.offsetShearY),
      relative: bool(raw.relative, base.relative),
      local: bool(raw.local, base.local),
      inherit: inheritMode
    }
  }

  if (resolved === 'path') {
    const base = createPathConstraint()
    const positionMode = str(raw.positionMode, base.positionMode)
    const spacingMode = str(raw.spacingMode, base.spacingMode)
    const rotateMode = str(raw.rotateMode, base.rotateMode)
    return {
      ...constraintCommon(raw, base.name),
      type: 'path',
      position: num(raw.position, base.position),
      spacing: num(raw.spacing, base.spacing),
      rotateMix: num(raw.rotateMix, base.rotateMix),
      translateMix: num(raw.translateMix, base.translateMix),
      positionMode: positionMode === 'fixed' ? 'fixed' : 'percent',
      spacingMode: spacingMode === 'fixed' || spacingMode === 'percent' ? spacingMode : 'length',
      rotateMode: rotateMode === 'chainScale' || rotateMode === 'tangent' ? rotateMode : 'chain'
    }
  }

  if (resolved === 'physics') {
    return {
      ...constraintCommon(raw, 'physics'),
      type: 'physics',
      raw: isRecord(raw.raw) ? raw.raw : {}
    }
  }

  const base = createIkConstraint()
  return {
    ...constraintCommon(raw, base.name),
    type: 'ik',
    mix: num(raw.mix, base.mix),
    bendSign: num(raw.bendSign, base.bendSign) >= 0 ? 1 : -1,
    useBoneLength: bool(raw.useBoneLength, base.useBoneLength),
    compress: bool(raw.compress, base.compress),
    stretch: bool(raw.stretch, base.stretch),
    softness: num(raw.softness, base.softness)
  }
}

function normalizeConstraintAnim(raw: Record<string, unknown>): ConstraintAnim {
  return {
    constraintIndex: 0,
    mix: floatKeys(raw.mix),
    mixRotate: floatKeys(raw.mixRotate),
    mixX: floatKeys(raw.mixX),
    mixY: floatKeys(raw.mixY),
    mixScaleX: floatKeys(raw.mixScaleX),
    mixScaleY: floatKeys(raw.mixScaleY),
    mixShearY: floatKeys(raw.mixShearY),
    offsetRotate: floatKeys(raw.offsetRotate),
    offsetX: floatKeys(raw.offsetX),
    offsetY: floatKeys(raw.offsetY),
    offsetScaleX: floatKeys(raw.offsetScaleX),
    offsetScaleY: floatKeys(raw.offsetScaleY),
    offsetShearY: floatKeys(raw.offsetShearY),
    position: floatKeys(raw.position),
    spacing: floatKeys(raw.spacing),
    rotateMix: floatKeys(raw.rotateMix),
    translateMix: floatKeys(raw.translateMix)
  }
}

function normalizeAnimation(raw: Record<string, unknown>): AuthoringAnimData {
  return {
    name: str(raw.name, 'animation'),
    duration: num(raw.duration, 1),
    bones: arr(raw.bones).map((item) => {
      const track = isRecord(item) ? item : {}
      return {
        bone: str(track.bone),
        translate: float2Keys(track.translate),
        rotate: floatKeys(track.rotate),
        scale: float2Keys(track.scale),
        shear: float2Keys(track.shear)
      }
    }),
    slots: arr(raw.slots).map((item) => {
      const track = isRecord(item) ? item : {}
      return {
        slot: str(track.slot),
        color: colorKeys(track.color),
        displayIndex: intKeys(track.displayIndex),
        displayAttachment: strArray(track.displayAttachment),
        visible: intKeys(track.visible),
        subArmature: subArmatureKeys(track.subArmature)
      }
    }),
    deforms: arr(raw.deforms).map((item) => {
      const track = isRecord(item) ? item : {}
      return {
        slot: str(track.slot),
        attachment: str(track.attachment),
        // 皮肤归属（Spine 4.2+）：缺省不写，保持旧工程 JSON 原样
        ...(str(track.skin) ? { skin: str(track.skin) } : {}),
        frames: deformFrames(track.frames)
      }
    }),
    drawOrder: arr(raw.drawOrder).map((item) => {
      const key = isRecord(item) ? item : {}
      return { time: num(key.time), order: strArray(key.order) }
    }),
    events: eventKeys(raw.events),
    constraints: arr(raw.constraints).map((item) => {
      const track = isRecord(item) ? item : {}
      const anim = normalizeConstraintAnim(track)
      return { ...anim, constraint: str(track.constraint) }
    })
  }
}

function normalizeImage(raw: Record<string, unknown>): AuthoringImage {
  const regionRaw = Array.isArray(raw.regions) ? raw.regions : []
  const regions = (regionRaw.filter(isRecord) as Record<string, unknown>[])
    .map((r) => ({
      name: str(r.name),
      x: num(r.x),
      y: num(r.y),
      width: num(r.width),
      height: num(r.height),
      rotate: num(r.rotate),
      origWidth: num(r.origWidth),
      origHeight: num(r.origHeight),
      offsetX: num(r.offsetX),
      offsetY: num(r.offsetY)
    }))
    .filter((r) => r.name.length > 0)
  return {
    name: str(raw.name),
    path: str(raw.path),
    width: Math.round(num(raw.width)),
    height: Math.round(num(raw.height)),
    /*
     * 只有**显式** `false` 才算「已经是图集」（导出时整页复制）。
     *
     * 老工程文件没有这个字段：那时导出是一律重新打包的，缺省按「碎图」走才不会
     * 让散图一张一页地导出去；导入资源时写入的都是显式值，因此不受影响。
     */
    loose: raw.loose !== false,
    regions: regions.length > 0 ? regions : undefined
  }
}

function normalizeMeta(raw: unknown): EditorMeta {
  const base = createDefaultMeta()
  if (!isRecord(raw)) return base
  const viewport = isRecord(raw.viewport) ? raw.viewport : {}
  const overlay = isRecord(raw.overlay) ? raw.overlay : {}
  const brush = isRecord(raw.brush) ? raw.brush : {}
  /*
   * Mode 取 Unity 的三种。老工程里存的是 add / subtract / replace（方向语义），
   * 它们都属于「影响选中骨骼周围的所有顶点」，统一归到 addSubtract。
   */
  const rawMode = str(brush.mode, base.brush.mode)
  const mode: EditorMeta['brush']['mode'] =
    rawMode === 'growShrink' || rawMode === 'grow'
      ? 'growShrink'
      : rawMode === 'smooth'
        ? 'smooth'
        : 'addSubtract'
  /*
   * 老工程的 `strength` 是 0..1 的直接强度（更早的版本），新语义是 0..100 的「一笔上限」：
   * ≤1 按老单位 ×100。`hardness`（每笔增量）在新语义下换不回来（增量 ≠ 上限），
   * 只有它时回退默认值 —— 笔刷偏好丢掉比换成错误的手感好。
   */
  const rawStrength = num(brush.strength, NaN)
  const strength = Number.isFinite(rawStrength)
    ? Math.min(100, Math.max(0, rawStrength <= 1 ? rawStrength * 100 : rawStrength))
    : base.brush.strength
  return {
    layout: isRecord(raw.layout)
      ? Object.fromEntries(
          Object.entries(raw.layout).map(([key, value]) => [key, num(value)])
        )
      : {},
    viewport: {
      x: num(viewport.x),
      y: num(viewport.y),
      zoom: num(viewport.zoom, 1)
    },
    activeSkin: str(raw.activeSkin),
    activeAnimation: str(raw.activeAnimation),
    overlay: {
      bones: bool(overlay.bones, base.overlay.bones),
      constraints: bool(overlay.constraints, base.overlay.constraints)
    },
    brush: {
      mode,
      size: num(brush.size, num(brush.radius, base.brush.size)),
      strength,
      feather: Math.min(100, Math.max(0, num(brush.feather, base.brush.feather))),
      normalize: bool(brush.normalize, base.brush.normalize)
    },
    stage: normalizeStage(raw.stage)
  }
}

/** 舞台参考图：缺字段填默认值；没有 file（没设置过 / 老工程）就是 null */
function normalizeStage(raw: unknown): StageImage | null {
  if (!isRecord(raw)) return null
  const file = str(raw.file)
  if (!file) return null
  return {
    file,
    x: num(raw.x),
    y: num(raw.y),
    width: Math.max(0.01, num(raw.width, 1)),
    height: Math.max(0.01, num(raw.height, 1)),
    opacity: Math.min(1, Math.max(0, num(raw.opacity, 0.5)))
  }
}

/** 把任意 JSON 规整成合法工程文档；缺字段填默认值，非法值被纠正并记录告警 */
export function normalizeDocument(raw: unknown): ParseDocumentResult {
  const warnings: string[] = []
  if (!isRecord(raw)) {
    warnings.push(t('工程文件内容不是对象，已创建空工程'))
    return { document: createEmptyDocument(), warnings }
  }

  const version = Math.round(num(raw.schemaVersion, 1))
  if (version > CURRENT_SCHEMA_VERSION) {
    warnings.push(
        t('工程文件版本 {0} 高于当前编辑器支持的 {1}，可能丢失部分数据', [version, CURRENT_SCHEMA_VERSION])
      )
  }

  const bones = arr(raw.bones).map((item) => normalizeBone(isRecord(item) ? item : {}))
  const slots = arr(raw.slots).map((item) => normalizeSlot(isRecord(item) ? item : {}, version, warnings))
  const skins = arr(raw.skins).map((item) => normalizeSkin(isRecord(item) ? item : {}))
  if (skins.length === 0) {
    skins.push({ name: 'default', slots: [] })
    warnings.push(t('工程缺少皮肤，已补一个空的默认皮肤'))
  }

  const document: EditorDocument = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    armatureName: str(raw.armatureName, 'armature'),
    frameRate: num(raw.frameRate, 30) || 30,
    runtimeIK: bool(raw.runtimeIK, true),
    bones,
    slots,
    skins,
    constraints: arr(raw.constraints).map((item) => normalizeConstraint(isRecord(item) ? item : {})),
    animations: arr(raw.animations).map((item) => normalizeAnimation(isRecord(item) ? item : {})),
    images: arr(raw.images).map((item) => normalizeImage(isRecord(item) ? item : {})),
    editorMeta: normalizeMeta(raw.editorMeta)
  }

  const boneNames = new Set(bones.map((bone) => bone.name))
  for (const bone of bones) {
    if (bone.parent && !boneNames.has(bone.parent)) {
      warnings.push(t('骨骼「{0}」的父骨骼「{1}」不存在，已作为根骨骼', [bone.name, bone.parent]))
    }
  }
  return { document, warnings }
}

export type { AnimData, ConstraintAnim }

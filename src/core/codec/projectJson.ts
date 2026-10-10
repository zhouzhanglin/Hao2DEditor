import { BlendMode } from '../model/types'
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
  EditorMeta
} from '../model/authoring'
import { CURRENT_SCHEMA_VERSION, createDefaultMeta, createEmptyDocument } from '../model/authoring'

/** 工程文件后缀（含点，落盘文件名形如 `hero.hao2d.proj`） */
export const PROJECT_EXTENSION = 'hao2d.proj'

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
  /** 项目名（老工程没有这个字段 → 用当前骨架名兜底） */
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
 */
export function normalizeProject(raw: unknown): ParseProjectResult {
  if (!isRecord(raw)) {
    const single = normalizeDocument(raw)
    return {
      skeletons: [single.document],
      activeSkeleton: 0,
      projectName: single.document.armatureName,
      warnings: single.warnings
    }
  }
  const parts = Array.isArray(raw.skeletons) ? raw.skeletons.filter(isRecord) : []
  if (parts.length === 0) {
    const single = normalizeDocument(raw)
    return {
      skeletons: [single.document],
      activeSkeleton: 0,
      projectName: str(raw.projectName, single.document.armatureName),
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
  return { skeletons, activeSkeleton: active, projectName: str(raw.projectName, skeletons[active].armatureName), warnings }
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
  return {
    name: str(raw.name, 'attachment'),
    type: type === 'mesh' || type === 'linkedmesh' || type === 'boundingbox' ? type : 'region',
    image: str(raw.image),
    position: vec2(raw.position),
    rotation: num(raw.rotation),
    scale: vec2(raw.scale, 1, 1),
    size: vec2(raw.size, 100, 100),
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
    bones: strArray(raw.bones)
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

function normalizeSlot(raw: Record<string, unknown>): AuthoringSlot {
  const blend = Math.round(num(raw.blendMode))
  return {
    name: str(raw.name, 'slot'),
    bone: str(raw.bone),
    color: str(raw.color, '#FFFFFFFF'),
    blendMode: (blend >= 0 && blend <= 7 ? blend : BlendMode.Normal) as BlendMode,
    zOrder: Math.round(num(raw.zOrder)),
    z: num(raw.z),
    attachment: str(raw.attachment),
    visible: bool(raw.visible, true)
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
        visible: intKeys(track.visible)
      }
    }),
    deforms: arr(raw.deforms).map((item) => {
      const track = isRecord(item) ? item : {}
      return {
        slot: str(track.slot),
        attachment: str(track.attachment),
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
  return {
    name: str(raw.name),
    path: str(raw.path),
    width: Math.round(num(raw.width)),
    height: Math.round(num(raw.height)),
    loose: bool(raw.loose)
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
      // 老工程的 strength 是 0..1 的直接强度；换成 0..100 的 Hardness 要乘 100
      hardness: num(brush.hardness, num(brush.strength, base.brush.hardness / 100) * 100),
      normalize: bool(brush.normalize, base.brush.normalize)
    }
  }
}

/** 把任意 JSON 规整成合法工程文档；缺字段填默认值，非法值被纠正并记录告警 */
export function normalizeDocument(raw: unknown): ParseDocumentResult {
  const warnings: string[] = []
  if (!isRecord(raw)) {
    warnings.push('工程文件内容不是对象，已创建空工程')
    return { document: createEmptyDocument(), warnings }
  }

  const version = Math.round(num(raw.schemaVersion, 1))
  if (version > CURRENT_SCHEMA_VERSION) {
    warnings.push(`工程文件版本 ${version} 高于当前编辑器支持的 ${CURRENT_SCHEMA_VERSION}，可能丢失部分数据`)
  }

  const bones = arr(raw.bones).map((item) => normalizeBone(isRecord(item) ? item : {}))
  const slots = arr(raw.slots).map((item) => normalizeSlot(isRecord(item) ? item : {}))
  const skins = arr(raw.skins).map((item) => normalizeSkin(isRecord(item) ? item : {}))
  if (skins.length === 0) {
    skins.push({ name: 'default', slots: [] })
    warnings.push('工程缺少皮肤，已补一个空的默认皮肤')
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
      warnings.push(`骨骼「${bone.name}」的父骨骼「${bone.parent}」不存在，已作为根骨骼`)
    }
  }
  return { document, warnings }
}

export type { AnimData, ConstraintAnim }

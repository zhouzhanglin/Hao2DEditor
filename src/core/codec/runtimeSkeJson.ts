import { AnimType } from '../model/types'
import type { RuntimeAsset } from '../model/asset'

/**
 * 自定义运行时数据格式（与 Spine / DragonBones 格式**无关**，仅服务于本编辑器导出的游戏侧加载）。
 *
 * 设计取向：
 * - 字段与内部 Runtime 模型同名，转换成本最低，出问题也容易对照；
 * - 数值数组直接写 JSON 数组，避免自定义编码，方便直接用 JSON.parse 读取；
 * - 骨骼 / 插槽 / 附件都已经「绝对值化」，运行时不需要再解析 setup 增量。
 */

export interface RuntimeAtlasPage {
  /** 页图文件名（相对 ske / atlas 同一目录） */
  image: string
  width: number
  height: number
}

export interface RuntimeAtlasRegion {
  /** = AttachmentData.textureName 的原始图片名 */
  name: string
  page: number
  x: number
  y: number
  width: number
  height: number
}

export interface RuntimeAtlasJson {
  format: 'hao2d-atlas'
  version: 1
  pages: RuntimeAtlasPage[]
  regions: RuntimeAtlasRegion[]
}

export interface RuntimeSkeJson {
  format: 'hao2d-ske'
  version: 1
  armatureName: string
  frameRate: number
  /** 骨架单位 → 像素（1 单位 = ppu 像素），方便游戏侧按像素布局 */
  ppu: number
  /** 配套图集描述文件名 */
  atlas: string
  dataType: AnimType
  /** 图集页名，顺序 = 材质槽顺序 */
  textureNames: string[]
  bones: unknown[]
  slots: unknown[]
  skins: unknown[]
  constraints: unknown[]
  animations: unknown[]
  bindposes: number[]
}

export const RUNTIME_PPU = 100

/** 序列化图集描述 */
export function serializeRuntimeAtlas(atlas: RuntimeAtlasJson): string {
  return `${JSON.stringify(atlas, null, 2)}\n`
}

/**
 * 序列化骨骼数据。
 * Float32Array 字段（uvs / vertices / bindposes）转成普通数组；
 * images 不再重复写入（图集页信息在 atlas.json 里）。
 */
export function serializeRuntimeSke(
  asset: RuntimeAsset,
  options: { atlasFileName: string; ppu?: number }
): string {
  const json: RuntimeSkeJson = {
    format: 'hao2d-ske',
    version: 1,
    armatureName: asset.armatureName,
    frameRate: asset.frameRate,
    ppu: options.ppu ?? RUNTIME_PPU,
    atlas: options.atlasFileName,
    dataType: asset.dataType,
    textureNames: [...asset.textureNames],
    bones: asset.bones.map((bone) => ({
      name: bone.name,
      parentIndex: bone.parentIndex,
      localPosition: [bone.localPosition.x, bone.localPosition.y],
      rotation: bone.rotation,
      localScale: [bone.localScale.x, bone.localScale.y],
      localShear: [bone.localShear.x, bone.localShear.y],
      inheritRotation: bone.inheritRotation,
      inheritScale: bone.inheritScale,
      length: bone.length
    })),
    slots: asset.slots.map((slot) => ({
      name: slot.name,
      boneIndex: slot.boneIndex,
      color: [slot.color.r, slot.color.g, slot.color.b, slot.color.a],
      blendMode: slot.blendMode,
      defaultDisplayIndex: slot.defaultDisplayIndex,
      defaultZOrder: slot.defaultZOrder,
      z: slot.z,
      setupAttachment: slot.setupAttachment
    })),
    skins: asset.skins.map((skin) => ({
      name: skin.name,
      slots: skin.slots.map((skinSlot) => ({
        slotName: skinSlot.slotName,
        attachments: skinSlot.attachments.map((attachment) => ({
          ...attachment,
          position: [attachment.position.x, attachment.position.y],
          scale: [attachment.scale.x, attachment.scale.y],
          size: [attachment.size.x, attachment.size.y],
          color: [attachment.color.r, attachment.color.g, attachment.color.b, attachment.color.a],
          uvs: Array.from(attachment.uvs),
          vertices: Array.from(attachment.vertices)
        }))
      }))
    })),
    constraints: asset.constraints.map((constraint) => ({ ...constraint })),
    animations: asset.animations.map((animation) => ({ ...animation })),
    bindposes: Array.from(asset.bindposes)
  }
  return `${JSON.stringify(json, null, 2)}\n`
}

/** 解析骨架数据（不做完整校验，结构不符时抛出可读错误） */
export function parseRuntimeSke(text: string): RuntimeSkeJson {
  const raw = JSON.parse(text) as RuntimeSkeJson
  if (!raw || raw.format !== 'hao2d-ske') {
    throw new Error('不是 hao2d-ske 格式的骨骼数据')
  }
  if (raw.version !== 1) {
    throw new Error(`不支持的 hao2d-ske 版本 ${raw.version}`)
  }
  return raw
}

export function parseRuntimeAtlas(text: string): RuntimeAtlasJson {
  const raw = JSON.parse(text) as RuntimeAtlasJson
  if (!raw || raw.format !== 'hao2d-atlas') {
    throw new Error('不是 hao2d-atlas 格式的图集描述')
  }
  if (raw.version !== 1) {
    throw new Error(`不支持的 hao2d-atlas 版本 ${raw.version}`)
  }
  return raw
}

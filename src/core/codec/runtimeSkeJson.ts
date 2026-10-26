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
  /** 旋转（度，0/90/180/270）。Spine 的 `rotate: true` 即 90 */
  rotate?: number
  /** 未裁剪原始尺寸 */
  origWidth?: number
  origHeight?: number
  /** 裁剪偏移 */
  offsetX?: number
  offsetY?: number
}

export interface RuntimeAtlasJson {
  format: 'hao2d-atlas'
  version: 1
  pages: RuntimeAtlasPage[]
  regions: RuntimeAtlasRegion[]
}

/**
 * 被嵌套引用的子骨架（v2）。
 *
 * 只写「骨架名 → 文件名」：加载端按需递归读取，父子骨架之间仍是**名字引用**，
 * 与编辑器工程文件同一套语义（重命名骨架不会让引用错位，重新导出即可）。
 */
export interface RuntimeSkeNested {
  armatureName: string
  /** 相对当前 ske 文件名的子骨架文件名（如 `Sword_ske.json`） */
  file: string
}

export interface RuntimeSkeJson {
  format: 'hao2d-ske'
  /**
   * - **1**：单骨架（没有嵌套）；
   * - **2**：新增 `nested`（被嵌套引用的子骨架清单）。
   */
  version: 1 | 2
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
  /** v2：子骨架清单（v1 文件没有这个字段，读成空数组） */
  nested?: RuntimeSkeNested[]
  /**
   * 运行期默认皮肤下标（= 导出时编辑器正在编辑的皮肤）。
   * v1 / 缺省时加载端回落到名为 `default` 的皮肤。
   */
  defaultSkinIndex?: number
  /**
   * 运行期默认叠加皮肤（= 导出时编辑器当前皮肤）。基底皮肤由 `defaultSkinIndex` 决定，
   * 两者叠加（同名覆盖）。缺省 = 只显示基底皮肤。
   */
  defaultSkin?: string
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
  options: { atlasFileName: string; ppu?: number; nested?: readonly RuntimeSkeNested[] }
): string {
  const json: RuntimeSkeJson = {
    format: 'hao2d-ske',
    version: 2,
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
      setupAttachment: slot.setupAttachment,
      visible: slot.visible
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
          // 裁剪信息：frameSize = 未裁剪原图尺寸（编辑器画框用）；contentOffset = 内容中心相对
          // 原图中心的位移，**附件自身坐标轴**（渲染四边形时局部叠加，别并进 position）
          frameSize: [attachment.frameSize.x, attachment.frameSize.y],
          contentOffset: [attachment.contentOffset.x, attachment.contentOffset.y],
          color: [attachment.color.r, attachment.color.g, attachment.color.b, attachment.color.a],
          uvs: Array.from(attachment.uvs),
          vertices: Array.from(attachment.vertices)
        }))
      }))
    })),
    constraints: asset.constraints.map((constraint) => ({ ...constraint })),
    animations: asset.animations.map((animation) => ({ ...animation })),
    bindposes: Array.from(asset.bindposes),
    defaultSkinIndex: asset.defaultSkinIndex,
    defaultSkin: asset.defaultSkin,
    nested: options.nested ? options.nested.map((item) => ({ ...item })) : []
  }
  return `${JSON.stringify(json, null, 2)}\n`
}

/** 解析骨架数据（不做完整校验，结构不符时抛出可读错误） */
export function parseRuntimeSke(text: string): RuntimeSkeJson {
  const raw = JSON.parse(text) as RuntimeSkeJson
  if (!raw || raw.format !== 'hao2d-ske') {
    throw new Error('不是 hao2d-ske 格式的骨骼数据')
  }
  // v1 是「无嵌套」的老格式：继续可读，缺的字段读成空
  if (raw.version !== 1 && raw.version !== 2) {
    throw new Error(`不支持的 hao2d-ske 版本 ${raw.version}`)
  }
  if (typeof raw.defaultSkinIndex !== 'number' || raw.defaultSkinIndex < 0) delete raw.defaultSkinIndex
  if (typeof raw.defaultSkin !== 'string') delete raw.defaultSkin
  raw.nested = Array.isArray(raw.nested)
    ? raw.nested.filter((item) => typeof item?.armatureName === 'string' && typeof item?.file === 'string')
    : []
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

import type { DbTextureJson } from './dragonBonesAtlas'

export type ImportFormat = 'spine' | 'dragonbones' | 'spineAtlas' | 'dbTexture' | 'looseImage' | 'unknown'

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** 按**内容**判别骨骼数据格式（不看文件名） */
export function detectSkeletonFormat(json: unknown): ImportFormat {
  const record = asRecord(json)
  if (!record) return 'unknown'
  if (Array.isArray(record.armature)) return 'dragonbones'
  if (record.skeleton !== undefined || Array.isArray(record.bones)) {
    // Spine 的骨骼文件一定有 skeleton 段；仅有 bones 时也按 Spine 处理
    if (record.skeleton !== undefined) return 'spine'
    if (Array.isArray(record.bones) && record.skins !== undefined) return 'spine'
  }
  if (Array.isArray(record.SubTexture)) return 'dbTexture'
  return 'unknown'
}

/** DragonBones 图集 JSON：含 SubTexture 数组（或 imagePath） */
export function isDbTextureJson(json: unknown): boolean {
  const record = asRecord(json)
  if (!record) return false
  return Array.isArray(record.SubTexture) || typeof record.imagePath === 'string'
}

/** Spine 图集文本：非 JSON，含 "xxx.png" 页头与缩进的键值对 */
export function looksLikeSpineAtlasText(text: string): boolean {
  const head = text.slice(0, 4096)
  if (head.trimStart().startsWith('{')) return false
  return /\.(png|jpg|jpeg|webp)\s*$/im.test(head) && /^\s+(xy|size|bounds|orig|offset|offsets|rotate)\s*:/m.test(head)
}

export function dbTextureJsonOf(json: unknown): DbTextureJson | null {
  const record = asRecord(json)
  if (!record) return null
  if (Array.isArray(record.SubTexture)) {
    return {
      name: typeof record.name === 'string' ? record.name : undefined,
      imagePath: typeof record.imagePath === 'string' ? record.imagePath : '',
      width: typeof record.width === 'number' ? record.width : undefined,
      height: typeof record.height === 'number' ? record.height : undefined,
      SubTexture: record.SubTexture as DbTextureJson['SubTexture']
    }
  }
  return null
}

/** 通过扩展名判断是否可能是图片（拖入时的快速筛选） */
export function isImageFileName(name: string): boolean {
  return /\.(png|jpg|jpeg|webp|gif|bmp)$/i.test(name)
}

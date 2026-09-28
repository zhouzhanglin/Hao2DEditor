/** DragonBones 图集（texture_N.json）的解析与合并 */

export interface DbSubTextureJson {
  name: string
  path?: string
  x: number
  y: number
  width: number
  height: number
  frameX?: number
  frameY?: number
  frameWidth?: number
  frameHeight?: number
}

export interface DbTextureJson {
  name?: string
  imagePath: string
  width?: number
  height?: number
  SubTexture: DbSubTextureJson[]
}

export interface DbSubTexture {
  name: string
  path: string
  x: number
  y: number
  width: number
  height: number
  frameX: number
  frameY: number
  frameWidth: number
  frameHeight: number
  /** 所属图集页（png 名） */
  textureName: string
  textureWidth: number
  textureHeight: number
}

/**
 * 解析单张 texture_N.json。
 * 页尺寸优先取实际 png 的像素尺寸（由调用方读取），缺失时退回 json 里的 width/height。
 */
export function parseDbTextureJson(
  json: DbTextureJson,
  pageSizes: Record<string, { width: number; height: number }>
): DbSubTexture[] {
  const page = json.imagePath
  const size = pageSizes[page] ?? { width: json.width ?? 0, height: json.height ?? 0 }
  const textureWidth = size.width > 0 ? size.width : (json.width ?? 1)
  const textureHeight = size.height > 0 ? size.height : (json.height ?? 1)

  return (json.SubTexture ?? []).map((sub) => ({
    name: sub.name,
    path: sub.path ?? sub.name,
    x: sub.x,
    y: sub.y,
    width: sub.width,
    height: sub.height,
    frameX: sub.frameX ?? 0,
    frameY: sub.frameY ?? 0,
    frameWidth: sub.frameWidth ?? sub.width,
    frameHeight: sub.frameHeight ?? sub.height,
    textureName: page,
    textureWidth,
    textureHeight
  }))
}

/** 多张图集合并成「SubTexture 名 → 区域」表（同名先到先得） */
export function indexDbSubTextures(list: readonly DbSubTexture[]): Map<string, DbSubTexture> {
  const map = new Map<string, DbSubTexture>()
  for (const sub of list) {
    if (!map.has(sub.name)) map.set(sub.name, sub)
    if (sub.path && !map.has(sub.path)) map.set(sub.path, sub)
  }
  return map
}

/** 从合并结果里提取所有图集页名（顺序 = 材质槽顺序） */
export function dbTextureNames(list: readonly DbSubTexture[]): string[] {
  const names: string[] = []
  for (const sub of list) if (!names.includes(sub.textureName)) names.push(sub.textureName)
  return names
}

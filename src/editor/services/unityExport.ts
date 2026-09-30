/**
 * Unity 侧产物的生成：材质（.mat）与各类 .meta。
 *
 * 约定来自 Hao2D Unity 包（参考库 `Assets/Hao2D`）：
 * - `.hao2d` 由 ScriptedImporter（`Hao2DImporter`）导入成 Hao2DAsset；
 * - 图集纹理按 `.hao2d` 内 `textureNames`（含扩展名的文件名）**在同目录**查找；
 * - 材质按 `<纹理基名>_Hao2D.mat` **在同目录**查找（`Hao2DConvertUtil.SiblingMaterialPath`）；
 *   找不到时导入器会自动建一个内部子资产材质，但那样改不了参数、每次导入重建；
 * - shader 用 `Hao2D/Sprite`（GUID `eca54793560eb42a9b7b966518f4d714`）。
 *
 * 因此外部导出时必须**自己生成材质与纹理的 .meta**：材质要用纹理的 GUID 引用它，
 * 而 GUID 只有在 .meta 里才存在。
 */

/** `Assets/Hao2D/Shader/Hao2DSprite.shader.meta` 里的 GUID（Hao2D/Sprite） */
export const HAO2D_SPRITE_SHADER_GUID = 'eca54793560eb42a9b7b966518f4d714'

/** `Assets/Hao2D/Editor/Hao2DImporter.cs.meta` 里的 GUID（.hao2d 的 ScriptedImporter） */
export const HAO2D_IMPORTER_SCRIPT_GUID = '45b93833354d44a84af558c3bea096b7'

/** Hao2D 的 .hao2d 导入器返回的 asset 类型（ScriptedImporter 写法固定） */
export const HAO2D_DEFAULT_PREMULTIPLIED = false

// Unity 内部 fileID（固定值，写 YAML 引用用）
const FILE_ID_SHADER = 4800000
const FILE_ID_TEXTURE = 2800000
const FILE_ID_MATERIAL = 2100000
const FILE_ID_MONO_SCRIPT = 11500000

/** 从文件名（不含扩展名）得到材质文件名：`<基名>_Hao2D.mat` */
export function materialNameOf(textureFileName: string): string {
  return `${stripExtension(textureFileName)}_Hao2D`
}

export function materialFileNameOf(textureFileName: string): string {
  return `${materialNameOf(textureFileName)}.mat`
}

/**
 * 稳定 GUID（32 位小写 hex）。
 *
 * 由种子（文件在工程内的相对名）确定性生成：**重复导出同一工程得到同一个 GUID**，
 * Unity 里已挂好的引用不会因为再导一次就失效 —— 这一点很关键，GUID 一变，
 * 场景 / 预制体上的引用就会变成 Missing。
 */
export function stableGuid(seed: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  let h3 = 0x9e3779b9
  let h4 = 0x85ebca6b
  for (let index = 0; index < seed.length; index++) {
    const code = seed.charCodeAt(index)
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ (code + index), 0x85ebca6b) >>> 0
    h3 = Math.imul(h3 ^ (code * 31 + index), 0xc2b2ae35) >>> 0
    h4 = Math.imul(h4 ^ (code * 7 + index), 0x27d4eb2f) >>> 0
  }
  const part = (value: number): string => (value >>> 0).toString(16).padStart(8, '0')
  return `${part(h1)}${part(h2)}${part(h3)}${part(h4)}`.slice(0, 32)
}

/** 从已有 .meta 文本里取 GUID（保留用户工程里既有的引用关系）；取不到返回空串 */
export function guidFromMeta(metaText: string | null | undefined): string {
  if (!metaText) return ''
  const match = metaText.match(/^guid:\s*([0-9a-fA-F]{32})\s*$/m)
  return match ? match[1].toLowerCase() : ''
}

/** 图集纹理的 .meta：不裁剪、不压 mipmap、Clamp + Bilinear、保留透明通道 */
export function textureMeta(guid: string): string {
  return `fileFormatVersion: 2
guid: ${guid}
TextureImporter:
  internalIDToNameTable: []
  externalObjects: {}
  serializedVersion: 13
  mipmaps:
    mipMapMode: 0
    enableMipMap: 0
    sRGBTexture: 1
    linearTexture: 0
    fadeOut: 0
    borderMipMap: 0
    mipMapsPreserveCoverage: 0
    alphaTestReferenceValue: 0.5
    mipMapFadeDistanceStart: 1
    mipMapFadeDistanceEnd: 3
  bumpmap:
    convertToNormalMap: 0
    externalNormalMap: 0
    heightScale: 0.25
    normalMapFilter: 0
    flipGreenChannel: 0
  isReadable: 0
  streamingMipmaps: 0
  streamingMipmapsPriority: 0
  vTOnly: 0
  ignoreMipmapLimit: 0
  grayScaleToAlpha: 0
  generateCubemap: 6
  cubemapConvolution: 0
  seamlessCubemap: 0
  textureFormat: 1
  maxTextureSize: 8192
  textureSettings:
    serializedVersion: 2
    filterMode: 1
    aniso: 1
    mipBias: 0
    wrapU: 1
    wrapV: 1
    wrapW: 1
  nPOTScale: 0
  lightmap: 0
  compressionQuality: 50
  spriteMode: 0
  spriteExtrude: 1
  spriteMeshType: 1
  alignment: 0
  spritePivot: {x: 0.5, y: 0.5}
  spritePixelsToUnits: 100
  spriteBorder: {x: 0, y: 0, z: 0, w: 0}
  spriteGenerateFallbackPhysicsShape: 1
  alphaUsage: 1
  alphaIsTransparency: 1
  spriteTessellationDetail: -1
  textureType: 0
  textureShape: 1
  singleChannelComponent: 0
  flipbookRows: 1
  flipbookColumns: 1
  maxTextureSizeSet: 0
  compressionQualitySet: 0
  textureFormatSet: 0
  ignorePngGamma: 0
  applyGammaDecoding: 0
  swizzle: 50462976
  cookieLightType: 0
  platformSettings:
  - serializedVersion: 3
    buildTarget: DefaultTexturePlatform
    maxTextureSize: 8192
    resizeAlgorithm: 0
    textureFormat: -1
    textureCompression: 0
    compressionQuality: 50
    crunchedCompression: 0
    allowsAlphaSplitting: 0
    overridden: 0
    ignorePlatformSupport: 0
    androidETC2FallbackOverride: 0
    forceMaximumCompressionQuality_BC6H_BC7: 0
  spriteSheet:
    serializedVersion: 2
    sprites: []
    outline: []
    physicsShape: []
    bones: []
    spriteID:
    internalID: 0
    vertices: []
    indices:
    edges: []
    weights: []
    secondaryTextures: []
    nameFileIdTable: {}
  spritePackingTag:
  pSDRemoveMatte: 0
  userData:
  assetBundleName:
  assetBundleVariant:
`
}

/** `.hao2d` 的 .meta：交给 Hao2D 的 ScriptedImporter 处理 */
export function hao2dMeta(guid: string): string {
  return `fileFormatVersion: 2
guid: ${guid}
ScriptedImporter:
  internalIDToNameTable: []
  externalObjects: {}
  serializedVersion: 2
  script: {fileID: ${FILE_ID_MONO_SCRIPT}, guid: ${HAO2D_IMPORTER_SCRIPT_GUID}, type: 3}
  userData:
  assetBundleName:
  assetBundleVariant:
`
}

/** 材质的 .meta */
export function materialMeta(guid: string): string {
  return `fileFormatVersion: 2
guid: ${guid}
NativeFormatImporter:
  externalObjects: {}
  mainObjectFileID: ${FILE_ID_MATERIAL}
  userData:
  assetBundleName:
  assetBundleVariant:
`
}

export interface MaterialOptions {
  /** 材质名（Unity 里显示的名字）：`<图集基名>_Hao2D` */
  name: string
  /** 图集纹理的 GUID */
  textureGuid: string
  /** 美术直接给的预乘 alpha 图才需要打开；普通图保持 0 */
  premultiplied?: boolean
}

/**
 * 材质 YAML（文本格式，Unity 会正常读取并按当前序列化模式重写）。
 *
 * shader 固定指向 `Hao2D/Sprite`，`_MainTex` 指向同目录的图集纹理 ——
 * 与 Hao2D 编辑器菜单「生成 / 更新并列材质」产出的材质一致。
 */
export function materialYaml(options: MaterialOptions): string {
  const premultiplied = options.premultiplied ?? HAO2D_DEFAULT_PREMULTIPLIED
  return `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!21 &${FILE_ID_MATERIAL}
Material:
  serializedVersion: 8
  m_Name: ${options.name}
  m_Shader: {fileID: ${FILE_ID_SHADER}, guid: ${HAO2D_SPRITE_SHADER_GUID}, type: 3}
  m_Parent: {fileID: 0}
  m_ModifiedSerializedProperties: 0
  m_ValidKeywords: []
  m_InvalidKeywords: []
  m_LightmapFlags: 4
  m_EnableInstancingVariants: 0
  m_DoubleSidedGI: 0
  m_CustomRenderQueue: -1
  stringTagMap: {}
  disabledShaderPasses: []
  m_LockedProperties:
  m_SavedProperties:
    serializedVersion: 3
    m_TexEnvs:
    - _AlphaTex:
        m_Texture: {fileID: 0}
        m_Scale: {x: 1, y: 1}
        m_Offset: {x: 0, y: 0}
    - _MainTex:
        m_Texture: {fileID: ${FILE_ID_TEXTURE}, guid: ${options.textureGuid}, type: 3}
        m_Scale: {x: 1, y: 1}
        m_Offset: {x: 0, y: 0}
    m_Ints: []
    m_Floats:
    - PixelSnap: 0
    - _EnableExternalAlpha: 0
    - _PremultipliedTexture: ${premultiplied ? 1 : 0}
    m_Colors:
    - _Color: {r: 1, g: 1, b: 1, a: 1}
    - _Flip: {r: 1, g: 1, b: 1, a: 1}
    - _RendererColor: {r: 1, g: 1, b: 1, a: 1}
  m_BuildTextureStacks: []
`
}

function stripExtension(name: string): string {
  const index = name.lastIndexOf('.')
  return index <= 0 ? name : name.slice(0, index)
}

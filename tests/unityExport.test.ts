import { describe, expect, it } from 'vitest'
import {
  HAO2D_IMPORTER_SCRIPT_GUID,
  HAO2D_SPRITE_SHADER_GUID,
  guidFromMeta,
  hao2dMeta,
  materialFileNameOf,
  materialMeta,
  materialNameOf,
  materialYaml,
  stableGuid,
  textureMeta
} from '@editor/services/unityExport'

describe('Unity 产物命名的硬约定', () => {
  it('材质名 = 图集基名 + _Hao2D（Hao2DConvertUtil.SiblingMaterialPath）', () => {
    expect(materialNameOf('hero_0.png')).toBe('hero_0_Hao2D')
    expect(materialFileNameOf('hero_0.png')).toBe('hero_0_Hao2D.mat')
    expect(materialNameOf('armature_12.png')).toBe('armature_12_Hao2D')
  })
})

describe('stableGuid', () => {
  it('固定 32 位小写 hex，且同一 seed 稳定复现', () => {
    const first = stableGuid('hero/hero_0.png')
    const second = stableGuid('hero/hero_0.png')
    expect(first).toHaveLength(32)
    expect(first).toMatch(/^[0-9a-f]{32}$/)
    expect(second).toBe(first)
  })

  it('不同文件 / 不同工程互不相同（避免 Unity 里 GUID 撞车）', () => {
    const set = new Set([
      stableGuid('hero/hero_0.png'),
      stableGuid('hero/hero_1.png'),
      stableGuid('boss/hero_0.png'),
      stableGuid('hero/hero_0_Hao2D.mat'),
      stableGuid('hero/hero.hao2d')
    ])
    expect(set.size).toBe(5)
  })
})

describe('guidFromMeta', () => {
  it('从已有 .meta 里取出 GUID（重复导出时沿用旧值）', () => {
    const meta = `fileFormatVersion: 2\nguid: 2e7029dcc3cee462daba22a335285dca\nTextureImporter:\n  isReadable: 0\n`
    expect(guidFromMeta(meta)).toBe('2e7029dcc3cee462daba22a335285dca')
  })

  it('大写会被规范化，拿不到时返回空串', () => {
    expect(guidFromMeta('guid: ABCDEF0123456789ABCDEF0123456789')).toBe('abcdef0123456789abcdef0123456789')
    expect(guidFromMeta('')).toBe('')
    expect(guidFromMeta('fileFormatVersion: 2\n')).toBe('')
    expect(guidFromMeta(null)).toBe('')
  })
})

describe('图集纹理 .meta', () => {
  const meta = textureMeta('2e7029dcc3cee462daba22a335285dca')

  it('带 GUID 且不裁剪、不压 mipmap、保留透明通道', () => {
    expect(meta).toContain('guid: 2e7029dcc3cee462daba22a335285dca')
    expect(meta).toContain('enableMipMap: 0')
    expect(meta).toContain('nPOTScale: 0')
    expect(meta).toContain('alphaIsTransparency: 1')
    expect(meta).toContain('wrapU: 1')
    expect(meta).toContain('filterMode: 1')
    expect(meta).toContain('overridden: 0')
  })
})

describe('材质 YAML', () => {
  const yaml = materialYaml({ name: 'hero_0_Hao2D', textureGuid: 'aa11bb22cc33dd44ee55ff6600112233' })

  it('shader 指向 Hao2D/Sprite（用 Hao2D Unity 包里的 GUID）', () => {
    expect(yaml).toContain('m_Name: hero_0_Hao2D')
    expect(yaml).toContain(`guid: ${HAO2D_SPRITE_SHADER_GUID}`)
    expect(yaml).toContain('fileID: 4800000')
  })

  it('_MainTex 引用图集纹理，普通 alpha 图不打开预乘', () => {
    expect(yaml).toContain('_MainTex:')
    expect(yaml).toContain('guid: aa11bb22cc33dd44ee55ff6600112233')
    expect(yaml).toContain('fileID: 2800000')
    expect(yaml).toContain('_PremultipliedTexture: 0')
    expect(yaml).toContain('_EnableExternalAlpha: 0')
    expect(yaml).toContain('- _Color: {r: 1, g: 1, b: 1, a: 1}')
  })

  it('需要预乘时能打开开关', () => {
    const premultiplied = materialYaml({ name: 'x_Hao2D', textureGuid: 'ff', premultiplied: true })
    expect(premultiplied).toContain('_PremultipliedTexture: 1')
  })
})

describe('.hao2d 与材质的 .meta', () => {
  it('.hao2d 交给 Hao2D 的 ScriptedImporter', () => {
    const meta = hao2dMeta('00112233445566778899aabbccddeeff')
    expect(meta).toContain('guid: 00112233445566778899aabbccddeeff')
    expect(meta).toContain('ScriptedImporter:')
    expect(meta).toContain(HAO2D_IMPORTER_SCRIPT_GUID)
    expect(meta).toContain('serializedVersion: 2')
  })

  it('材质用 NativeFormatImporter，主对象是 Material', () => {
    const meta = materialMeta('ffeeddccbbaa99887766554433221100')
    expect(meta).toContain('guid: ffeeddccbbaa99887766554433221100')
    expect(meta).toContain('NativeFormatImporter:')
    expect(meta).toContain('mainObjectFileID: 2100000')
  })
})

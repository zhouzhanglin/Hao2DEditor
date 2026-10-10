import { describe, expect, it } from 'vitest'
import {
  ASSET_DIR,
  assetRelativePath,
  copyAssets,
  isRealFilePath,
  isRelativePath,
  planAssetCopies,
  resolveImagePaths
} from '@editor/services/projectAssets'
import type { AuthoringImage } from '@core/model/authoring'
import type { BatchFile } from '@shared/ipcTypes'

function image(name: string, path: string, loose = true): AuthoringImage {
  return { name, path, width: 64, height: 64, loose }
}

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgo='

describe('isRealFilePath', () => {
  it('认得出磁盘路径', () => {
    expect(isRealFilePath('/Users/me/art/hero.png')).toBe(true)
    expect(isRealFilePath('C:\\art\\hero.png')).toBe(true)
    expect(isRealFilePath('images/hero.png')).toBe(true)
  })

  it('内联 / 网络资源不算磁盘文件', () => {
    expect(isRealFilePath(PNG_DATA_URL)).toBe(false)
    expect(isRealFilePath('blob:http://localhost/abc')).toBe(false)
    expect(isRealFilePath('https://cdn.example.com/hero.png')).toBe(false)
    expect(isRealFilePath('')).toBe(false)
  })
})

describe('isRelativePath', () => {
  it('工程内的相对路径', () => {
    expect(isRelativePath('images/hero.png')).toBe(true)
    expect(isRelativePath('art/hero.png')).toBe(true)
  })

  it('绝对路径与内联资源不算相对路径', () => {
    expect(isRelativePath('/Users/me/hero.png')).toBe(false)
    expect(isRelativePath('C:\\art\\hero.png')).toBe(false)
    expect(isRelativePath('C:/art/hero.png')).toBe(false)
    expect(isRelativePath(PNG_DATA_URL)).toBe(false)
    expect(isRelativePath('')).toBe(false)
  })
})

describe('assetRelativePath', () => {
  it('用工程内的图片名（已保证唯一）', () => {
    expect(assetRelativePath(image('hero.png', '/art/hero.png'))).toBe(`${ASSET_DIR}/hero.png`)
  })

  it('名字为空时退回源文件名', () => {
    expect(assetRelativePath(image('', '/art/hero.png'))).toBe(`${ASSET_DIR}/hero.png`)
  })
})

describe('planAssetCopies', () => {
  it('磁盘图片：生成复制任务 + 工程内写相对路径', () => {
    const source = image('hero.png', '/art/hero.png')
    const plan = planAssetCopies([source], '/proj')
    expect(plan.copies).toEqual([
      {
        from: '/art/hero.png',
        to: '/proj/images/hero.png',
        relative: 'images/hero.png'
      }
    ])
    expect(plan.images[0].path).toBe('images/hero.png')
    // 内存里的原对象不被就地修改（编辑器仍按绝对路径读图）
    expect(source.path).toBe('/art/hero.png')
    expect(plan.images[0]).not.toBe(source)
  })

  it('重复保存（源就是上次的成果）：不再复制，但仍写相对路径', () => {
    const plan = planAssetCopies([image('hero.png', '/proj/images/hero.png')], '/proj')
    expect(plan.copies).toEqual([])
    expect(plan.images[0].path).toBe('images/hero.png')
  })

  it('内联图片（dataURL）：原样保留，不复制', () => {
    const plan = planAssetCopies([image('inline.png', PNG_DATA_URL)], '/proj')
    expect(plan.copies).toEqual([])
    expect(plan.images[0].path).toBe(PNG_DATA_URL)
  })

  it('混排：只复制磁盘图片', () => {
    const plan = planAssetCopies(
      [image('a.png', '/art/a.png'), image('inline.png', PNG_DATA_URL), image('b.png', '/other/b.png')],
      '/proj'
    )
    expect(plan.copies.map((c) => c.relative)).toEqual(['images/a.png', 'images/b.png'])
    expect(plan.images.map((i) => i.path)).toEqual([
      'images/a.png',
      PNG_DATA_URL,
      'images/b.png'
    ])
  })
})

describe('resolveImagePaths', () => {
  it('相对路径按工程目录解析成绝对', () => {
    const [resolved] = resolveImagePaths([image('hero.png', 'images/hero.png')], '/proj')
    expect(resolved.path).toBe('/proj/images/hero.png')
  })

  it('绝对路径与内联资源保持不变', () => {
    const out = resolveImagePaths(
      [image('a.png', '/art/a.png'), image('inline.png', PNG_DATA_URL)],
      '/proj'
    )
    expect(out[0].path).toBe('/art/a.png')
    expect(out[1].path).toBe(PNG_DATA_URL)
  })

  it('没有工程目录（新建未保存）：原样返回', () => {
    const [out] = resolveImagePaths([image('hero.png', 'images/hero.png')], '')
    expect(out.path).toBe('images/hero.png')
  })
})

describe('copyAssets', () => {
  const plan = planAssetCopies([image('hero.png', '/art/hero.png')], '/proj')

  it('正常复制：内容写入目标路径', async () => {
    const written: BatchFile[] = []
    const result = await copyAssets(
      plan.copies,
      { readBinary: async () => new Uint8Array([1, 2, 3]) },
      {
        writeBatch: async (files) => {
          written.push(...files)
        }
      }
    )
    expect(result.copied).toBe(1)
    expect(result.warnings).toEqual([])
    expect(written).toHaveLength(1)
    expect(written[0].path).toBe('/proj/images/hero.png')
    expect(Array.from(written[0].bytes ?? [])).toEqual([1, 2, 3])
  })

  it('原图没了但 images/ 里已有副本：跳过且不算警告', async () => {
    const result = await copyAssets(
      plan.copies,
      {
        readBinary: async (path) =>
          path === '/proj/images/hero.png' ? new Uint8Array([9]) : new Uint8Array()
      },
      { writeBatch: async () => undefined }
    )
    expect(result.copied).toBe(0)
    expect(result.warnings).toEqual([])
  })

  it('原图和副本都读不到：记警告，不写文件', async () => {
    const result = await copyAssets(
      plan.copies,
      { readBinary: async () => new Uint8Array() },
      { writeBatch: async () => undefined }
    )
    expect(result.copied).toBe(0)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('hero.png')
  })

  it('写入失败：记警告，不影响保存流程', async () => {
    const result = await copyAssets(
      plan.copies,
      { readBinary: async () => new Uint8Array([1]) },
      {
        writeBatch: async () => {
          throw new Error('磁盘只读')
        }
      }
    )
    expect(result.copied).toBe(0)
    expect(result.warnings[0]).toContain('磁盘只读')
  })
})

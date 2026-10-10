import { describe, expect, it, vi } from 'vitest'
import { Texture } from 'pixi.js'

/** 可控的图片解码：手动决定「上一份图集页」什么时候解码完 */
const resolvers: Array<() => void> = []
const urls: string[] = []

vi.mock('@render/imageLoader', () => ({
  loadImageElement: (url: string) => {
    urls.push(url)
    return new Promise((resolve) => {
      resolvers.push(() => resolve({ width: 4, height: 4, naturalWidth: 4, naturalHeight: 4 }))
    })
  }
}))

import { TextureStore } from '@render/material'

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('TextureStore：换资源时的清理', () => {
  it('clear() 之后，上一份图集页迟到的解码结果不许复活（否则新项目会贴旧图）', async () => {
    const store = new TextureStore()
    void store.load('texture.png', 'old-url')
    await flush()
    expect(urls).toEqual(['old-url'])

    // 换项目：清空 + 重建（新建项目 / 导入资源走的就是这个顺序）
    store.clear()
    const fresh = store.load('texture.png', 'new-url')
    await flush()
    expect(urls).toEqual(['old-url', 'new-url'])

    // 旧的那次现在才解码完 → 必须丢弃
    resolvers[0]()
    await flush()
    expect(store.has('texture.png')).toBe(false)
    expect(store.get('texture.png')).toBe(Texture.WHITE)

    // 新的那次落地 → 生效
    resolvers[1]()
    await fresh
    expect(store.has('texture.png')).toBe(true)
    expect(store.get('texture.png')).not.toBe(Texture.WHITE)
  })

  it('delete() 之后同名重载：旧解码不会顶掉新图，加载标记也不会被误清', async () => {
    const store = new TextureStore()
    void store.load('page.png', 'a-url')
    await flush()

    store.delete('page.png') // 源路径变了
    const fresh = store.load('page.png', 'b-url')
    await flush()
    expect(urls).toEqual(['old-url', 'new-url', 'a-url', 'b-url'])

    resolvers[2]() // a-url 的结果迟到
    await flush()
    expect(store.has('page.png')).toBe(false)

    resolvers[3]() // b-url 的结果
    await fresh
    expect(store.has('page.png')).toBe(true)
  })
})

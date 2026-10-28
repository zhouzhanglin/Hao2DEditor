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

/**
 * 独立 describe：上面两组用例共用同一份 `urls` / `resolvers` 记账，断言里写死了下标与顺序，
 * 所以这条要放在它们**之后**、并且自己取句柄。
 */
describe('纹理销毁', () => {
  it('destroy 前先摘掉图源上的 change 监听（避开 pixi 的「destroyed while still bound」误报）', async () => {
    const store = new TextureStore()
    const loading = store.load('page.png', 'c-url')
    await flush()
    // 取本次加载的解码句柄（前面的用例已经消耗掉若干个，不能写死下标）
    resolvers[resolvers.length - 1]()
    await loading

    const texture = store.get('page.png')
    const source = texture.source
    // 模拟 pixi 批处理的 BindGroup：它就是这么监听图源的（见 BindGroup.setResource）
    let notified = 0
    source.on('change', () => {
      notified++
    })
    store.delete('page.png')

    // 监听在销毁前就被摘掉了 → 没人被通知，`onResourceChange` 也就不会打警告
    expect(notified).toBe(0)
    expect(texture.destroyed).toBe(true)
    expect(source.destroyed).toBe(true)
  })

})

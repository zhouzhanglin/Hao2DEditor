import { expect, test, vi } from 'vitest'

const { openExternal } = vi.hoisted(() => ({ openExternal: vi.fn(async (_url: string) => {}) }))
vi.mock('electron', () => ({ shell: { openExternal } }))

import { startHao2dPreview, stopPreviewSession } from '../src/main/previewServer'
import type { Hao2dPreviewSession } from '@shared/ipcTypes'

const session: Hao2dPreviewSession = {
  kind: 'hao2d',
  title: 'probe',
  pages: [],
  skeletons: [
    {
      id: 's0',
      name: 'probe',
      json: '{}',
      atlas: '{}',
      animations: [],
      skins: [],
      defaultAnimation: '',
      defaultSkin: ''
    }
  ]
}

/**
 * 打开浏览器是**渲染层**的职责（和「在浏览器打开」按钮同一条路径）。
 * 服务端这一层再开一次的话，用户会莫名其妙多出一个标签页，而且主进程那一路在部分
 * macOS 环境下还会被系统静默丢弃 —— 所以这里锁死「服务端只起服务，不动浏览器」。
 */
test('起预览只负责服务，自己不打开浏览器', async () => {
  openExternal.mockClear()
  const info = await startHao2dPreview(session)
  expect(info.url).toContain(`/p/${info.token}/`)
  expect(openExternal).not.toHaveBeenCalled()
  await stopPreviewSession()
})

test('反复起预览地址不变（已开着的页面靠 manifest rev 自动重载）', async () => {
  const first = await startHao2dPreview(session)
  const second = await startHao2dPreview(session)
  expect(second.url).toBe(first.url)
  expect(second.token).toBe(first.token)
  await stopPreviewSession()
})

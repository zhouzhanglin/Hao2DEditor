import { expect, test, vi } from 'vitest'

const { openExternal } = vi.hoisted(() => ({ openExternal: vi.fn(async (_url: string) => {}) }))
vi.mock('electron', () => ({ shell: { openExternal } }))

import {
  startHao2dPreview,
  startPreviewSession,
  startThreejsPreview,
  stopPreviewSession
} from '../src/main/previewServer'
import type { Hao2dPreviewSession, SpinePreviewSession, ThreejsPreviewSession } from '@shared/ipcTypes'

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

test('three.js 预览：页面 / 运行库 / 页面脚本都走 three.js 那一路（单文件离线可用）', async () => {
  const threeSession: ThreejsPreviewSession = { ...session, kind: 'threejs' }
  const info = await startThreejsPreview(threeSession)
  const base = info.url.endsWith('/') ? info.url : `${info.url}/`

  const page = await (await fetch(base)).text()
  expect(page).toContain('threejs-runtime.js?v=')
  // 占位符必须被内容指纹替换掉，否则浏览器会一直用缓存里的旧运行库
  expect(page).not.toContain('__THREEJS_RUNTIME_V__')
  expect(page).toContain('IHao2DView')

  const runtime = await (await fetch(`${base}threejs-runtime.js`)).text()
  expect(runtime).toContain('Hao2dThreeRuntime')
  expect(runtime).toContain('THREE')

  const app = await (await fetch(`${base}app.js`)).text()
  expect(app).toContain('Hao2dThreeRuntime.createStage')
  expect(app).toContain('setSlotAttachment')

  // three.js 预览不需要 pixi / spine 运行库
  expect((await fetch(`${base}pixi.js`)).status).toBe(404)
  expect((await fetch(`${base}spine-core.js`)).status).toBe(404)
  await stopPreviewSession()
})

test('预览页跟随编辑器语言：英文会话返回英文界面（页面 + app.js）', async () => {
  const info = await startHao2dPreview({ ...session, locale: 'en' })
  const base = info.url.endsWith('/') ? info.url : `${info.url}/`

  const page = await (await fetch(base)).text()
  expect(page).toContain('<html lang="en">')
  expect(page).toContain('Controls')
  expect(page).toContain('Slot / Equip')
  expect(page).toContain('Pause')
  expect(page).not.toContain('>控制<')
  expect(page).not.toContain('>插槽 / 换装<')

  const app = await (await fetch(`${base}app.js`)).text()
  expect(app).toContain("showStatus('Loading…')")
  expect(app).toContain("'This slot has no nested skeleton ('")
  expect(app).not.toContain('当前插槽没有子骨架')
  await stopPreviewSession()
})

test('three.js 预览页也跟随语言（标题 / 控件）', async () => {
  const info = await startThreejsPreview({ ...session, kind: 'threejs', locale: 'en' })
  const base = info.url.endsWith('/') ? info.url : `${info.url}/`
  const page = await (await fetch(base)).text()
  expect(page).toContain('Hao2D · Three.js Preview')
  expect(page).toContain('Nested skeleton')
  expect(page).not.toContain('Hao2D · Three.js 预览')
  await stopPreviewSession()
})

test('spine 预览页也跟随语言（标题 / 控件 / 脚本提示）', async () => {
  const spineSession: SpinePreviewSession = { ...session, kind: 'spine', locale: 'en' }
  const info = await startPreviewSession(spineSession)
  const base = info.url.endsWith('/') ? info.url : `${info.url}/`
  const page = await (await fetch(base)).text()
  expect(page).toContain('Hao2D Preview')
  expect(page).toContain('Controls')
  expect(page).toContain('Loading…')
  expect(page).not.toContain('>控制<')
  const app = await (await fetch(`${base}app.js`)).text()
  expect(app).toContain("'Loading '")
  await stopPreviewSession()
})

test('不传 locale 时仍是简中（默认行为不变）', async () => {
  const info = await startHao2dPreview(session)
  const base = info.url.endsWith('/') ? info.url : `${info.url}/`
  const page = await (await fetch(base)).text()
  expect(page).toContain('控制')
  expect(page).toContain('<html lang="zh-CN">')
  await stopPreviewSession()
})

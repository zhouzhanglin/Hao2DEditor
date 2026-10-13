import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { randomBytes } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { shell } from 'electron'
import type { SpinePreviewInfo, SpinePreviewSession, Hao2dPreviewSession } from '@shared/ipcTypes'
import { createLogger } from './logger'
import previewPage from './preview/page.html?raw'
import previewApp from './preview/app.js?raw'
import previewPageHao2d from './preview/page-hao2d.html?raw'
import hao2dApp from './preview/hao2dApp.js?raw'
// 官方运行时直接内联进主进程包：预览页完全不依赖外网与本地 node_modules（打包后也能用）
import spineCoreSource from '@esotericsoftware/spine-core/dist/iife/spine-core.min.js?raw'
// pixi 单独加载（不打包进运行库）：与 spine-core 同思路，独立文件、可长期缓存。
// 注意：pixi.js v8 的 `exports` 禁止直接 import 其 dist 子路径，主进程运行期 Node
// 又解析不到 `?raw`，故改为引入项目内 vendor 副本（由 scripts/copy-vendor.mjs 同步）。
import pixiSource from './preview/vendor/pixi.min.js?raw'
// hao2d 运行库（由 scripts/build-hao2d-runtime.mjs 生成；pixi 已拆出，这里只含 hao2d 自己的计算/渲染逻辑）
import hao2dRuntimeSource from './preview/hao2dRuntime.generated.js?raw'

const log = createLogger('预览')

/**
 * 预览服务：一个进程内常驻的 http 服务。
 *
 * 端口与 token 跟着**服务**走，而不是每次点「预览」都换：反复预览只是替换资源，地址始终不变 ——
 * 手机扫一次码就够了，之后在编辑器里改完再点预览，手机上刷新（甚至自动重载，见 manifest.rev）即可。
 */
let server: Server | null = null
let port = 0
let token = ''
let session: SpinePreviewSession | Hao2dPreviewSession | null = null
/** 会话版本号：每替换一次会话 +1，预览页据此自动重载 */
let revision = 0
/** 服务关闭时要一并断开的长连接（keep-alive 会让 close 迟迟不回调） */
const sockets = new Set<Socket>()

/** 局域网 IPv4（手机扫码用），常见私有网段排前面 */
function lanHosts(): string[] {
  const hosts: string[] = []
  for (const infos of Object.values(networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue
      hosts.push(info.address)
    }
  }
  const rank = (ip: string): number => {
    if (ip.startsWith('192.168.')) return 0
    if (ip.startsWith('10.')) return 1
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2
    return 3
  }
  return hosts.sort((a, b) => rank(a) - rank(b))
}

function send(res: ServerResponse, code: number, type: string, body: string | Uint8Array, cache = 'no-store'): void {
  const data = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body)
  res.writeHead(code, {
    'Content-Type': type,
    'Content-Length': data.length,
    'Cache-Control': cache
  })
  res.end(data)
}

function notFound(res: ServerResponse, reason: string): void {
  send(res, 404, 'text/plain; charset=utf-8', `${reason}\n`)
}

/** 图集页扩展名 → MIME */
function pageMime(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'webp') return 'image/webp'
  return 'image/png'
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  const active = session
  const prefix = `/p/${token}/`
  let pathname = '/'
  try {
    pathname = new URL(req.url ?? '/', 'http://localhost').pathname
  } catch {
    notFound(res, 'bad request')
    return
  }

  if (!active) {
    notFound(res, '预览已停止，请在编辑器里重新点击「预览」')
    return
  }
  // 少写一个斜杠也认
  if (pathname === `/p/${token}`) {
    res.writeHead(302, { Location: prefix })
    res.end()
    return
  }
  if (!pathname.startsWith(prefix)) {
    notFound(res, '链接已过期，请在编辑器里重新点击「预览」')
    return
  }

  const rest = pathname.slice(prefix.length)
  // spine 与 hao2d 共享同一份资源（页面 + ske/atlas 文本 + 图集页），只是渲染运行库不同
  const isHao2d = active.kind === 'hao2d'
  if (rest === '' || rest === 'index.html') {
    send(res, 200, 'text/html; charset=utf-8', isHao2d ? previewPageHao2d : previewPage)
    return
  }
  if (rest === 'spine-core.js') {
    if (isHao2d) {
      notFound(res, 'hao2d 预览不需要 spine 运行库')
      return
    }
    // 运行库内容由构建期内联，可长期缓存
    send(res, 200, 'text/javascript; charset=utf-8', spineCoreSource, 'public, max-age=86400')
    return
  }
  if (rest === 'hao2d-runtime.js') {
    if (!isHao2d) {
      notFound(res, 'spine 预览不需要 hao2d 运行库')
      return
    }
    // 运行库内容由构建期内联，可长期缓存
    send(res, 200, 'text/javascript; charset=utf-8', hao2dRuntimeSource, 'public, max-age=86400')
    return
  }
  if (rest === 'pixi.js') {
    if (!isHao2d) {
      notFound(res, 'spine 预览不需要 pixi 运行库')
      return
    }
    // pixi 单独提供（不在运行库里）；内容由构建期内联，可长期缓存
    send(res, 200, 'text/javascript; charset=utf-8', pixiSource, 'public, max-age=86400')
    return
  }
  if (rest === 'app.js') {
    // 页面逻辑同样是构建期内联的，但改代码要立刻生效，所以不缓存
    send(res, 200, 'text/javascript; charset=utf-8', isHao2d ? hao2dApp : previewApp)
    return
  }
  if (rest === 'manifest.json') {
    // 只给元信息：json / atlas 文本按需再取，省掉一次几 MB 的传输
    send(
      res,
      200,
      'application/json; charset=utf-8',
      JSON.stringify({
        title: active.title,
        // 版本号：预览页轮询这个字段，发现换了一版就自动重载（手机不用重新扫码）
        rev: revision,
        skeletons: active.skeletons.map((skeleton) => ({
          id: skeleton.id,
          name: skeleton.name,
          animations: skeleton.animations,
          skins: skeleton.skins,
          defaultAnimation: skeleton.defaultAnimation,
          defaultSkin: skeleton.defaultSkin
        }))
      })
    )
    return
  }
  if (rest.startsWith('s/')) {
    const file = rest.slice(2)
    const dot = file.lastIndexOf('.')
    const id = dot > 0 ? file.slice(0, dot) : file
    const skeleton = active.skeletons.find((entry) => entry.id === id)
    if (!skeleton) {
      notFound(res, `没有这个骨架：${id}`)
      return
    }
    // spine 预览请求 .json（spine json），hao2d 预览请求 .ske（内容是 hao2d ske 的 JSON 文本），两者都来自 skeleton.json 字段
    if (file.endsWith('.json') || file.endsWith('.ske')) {
      send(res, 200, 'application/json; charset=utf-8', skeleton.json)
      return
    }
    if (file.endsWith('.atlas')) {
      send(res, 200, 'text/plain; charset=utf-8', skeleton.atlas)
      return
    }
    notFound(res, `不支持的骨架资源：${file}`)
    return
  }
  if (rest.startsWith('pages/')) {
    const name = decodeURIComponent(rest.slice(6))
    const page = active.pages.find((entry) => entry.name === name)
    if (!page) {
      notFound(res, `没有这张图集页：${name}`)
      return
    }
    send(res, 200, pageMime(name), page.bytes, 'public, max-age=60')
    return
  }
  notFound(res, `未知路径：${rest}`)
}

async function ensureServer(): Promise<number> {
  if (server) return port
  const created = createServer((req, res) => {
    try {
      handle(req, res)
    } catch (err) {
      log.warn(`预览请求出错：${err instanceof Error ? err.message : String(err)}`)
      if (!res.headersSent) notFound(res, 'internal error')
    }
  })
  created.on('connection', (socket: Socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve, reject) => {
    created.once('error', reject)
    created.listen(0, '0.0.0.0', () => {
      created.off('error', reject)
      resolve()
    })
  })
  const address = created.address()
  port = typeof address === 'object' && address ? address.port : 0
  // token 只在这里生成：只要服务活着地址就不变（手机扫一次码就行，重启服务才换）
  token = randomBytes(9).toString('base64url')
  server = created
  log.info(`预览服务已启动，端口 ${port}`)
  return port
}

/** 起（或替换）预览会话；返回本机与局域网地址。open 为真时同时在系统浏览器里打开 */
async function serveSession(next: SpinePreviewSession | Hao2dPreviewSession, open: boolean): Promise<SpinePreviewInfo> {
  if (next.skeletons.length === 0) throw new Error('没有可预览的骨架')
  const fresh = !server
  session = next
  revision += 1
  await ensureServer()
  const base = `/p/${token}/`
  const info: SpinePreviewInfo = {
    url: `http://127.0.0.1:${port}${base}`,
    lanUrls: lanHosts().map((host) => `http://${host}:${port}${base}`),
    token
  }
  // 地址不变：已开着的页面会自己重载（manifest.rev），所以只在第一次预览时叫起浏览器
  if (open && fresh) await shell.openExternal(info.url)
  log.info(`预览已就绪（第 ${revision} 版）：${info.url}（局域网 ${info.lanUrls.length} 个地址）`)
  return info
}

export async function startPreviewSession(next: SpinePreviewSession, open: boolean): Promise<SpinePreviewInfo> {
  return serveSession(next, open)
}

export async function startHao2dPreview(next: Hao2dPreviewSession, open: boolean): Promise<SpinePreviewInfo> {
  return serveSession(next, open)
}

/** 停止预览：断开连接并释放端口与缓存 */
export async function stopPreviewSession(): Promise<void> {
  session = null
  token = ''
  const active = server
  server = null
  const oldPort = port
  port = 0
  if (!active) return
  for (const socket of sockets) socket.destroy()
  sockets.clear()
  await new Promise<void>((resolve) => active.close(() => resolve()))
  log.info(`预览服务已停止（原端口 ${oldPort}）`)
}

/** hao2d 预览与 spine 预览共用同一服务实例，停止逻辑完全一致 */
export async function stopHao2dPreview(): Promise<void> {
  return stopPreviewSession()
}

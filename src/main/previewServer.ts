import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { randomBytes } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import type {
  SpinePreviewInfo,
  SpinePreviewSession,
  Hao2dPreviewSession,
  ThreejsPreviewSession
} from '@shared/ipcTypes'
import { createLogger } from './logger'
import previewPage from './preview/page.html?raw'
import previewApp from './preview/app.js?raw'
import previewPageHao2d from './preview/page-hao2d.html?raw'
import hao2dApp from './preview/hao2dApp.js?raw'
import previewPageThreejs from './preview/page-threejs.html?raw'
import threejsApp from './preview/threejsApp.js?raw'
// 官方运行时直接内联进主进程包：预览页完全不依赖外网与本地 node_modules（打包后也能用）
import spineCoreSource from '@esotericsoftware/spine-core/dist/iife/spine-core.min.js?raw'
// pixi 单独加载（不打包进运行库）：与 spine-core 同思路，独立文件、可长期缓存。
// 注意：pixi.js v8 的 `exports` 禁止直接 import 其 dist 子路径，主进程运行期 Node
// 又解析不到 `?raw`，故改为引入项目内 vendor 副本（由 scripts/copy-vendor.mjs 同步）。
import pixiSource from './preview/vendor/pixi.min.js?raw'
// hao2d 运行库（由 scripts/build-hao2d-runtime.mjs 生成；pixi 已拆出，这里只含 hao2d 自己的计算/渲染逻辑）
import hao2dRuntimeSource from './preview/hao2dRuntime.generated.js?raw'
// three.js 版 hao2d 运行库（由 scripts/build-threejs-runtime.mjs 生成；three 已打包进单文件）
// 导出弹窗写盘时直接对同一份 generated.js 用 ?raw 引入，不经过主进程
import threejsRuntimeSource from './preview/threejsRuntime.generated.js?raw'
// 预览页的界面文案（页面与脚本都是主进程直出的静态文本，在这里按会话语言替换）
import { localizePreview } from './preview/previewI18n'

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
let session: SpinePreviewSession | Hao2dPreviewSession | ThreejsPreviewSession | null = null
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

/**
 * 内容指纹（FNV-1a，够用即可）：给 `<script src>` 拼一个 `?v=` 用。
 *
 * 为什么需要：预览地址里的 token 在服务存活期间**不变**，所以运行库的 URL 也不变。
 * 之前这些文件带 `max-age=86400`，浏览器会把**旧版本**的运行库缓存一整天 ——
 * 重新构建了预览运行库（hao2d-runtime.js）后，页面上看到的还是旧代码，
 * 表现成「改了没生效 / 预览还是老样子」。URL 里带上内容指纹后，内容一变 URL 就变，
 * 既能让浏览器立刻取到新代码，又能继续安心长缓存。
 */
function fingerprint(text: string, seed = 0x811c9dc5): string {
  let hash = seed >>> 0
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

/** 每个内联资源的指纹只算一次（主进程启动时不付大文件扫描的代价） */
const versions = new Map<string, string>()

function versionOf(key: string, source: string): string {
  const cached = versions.get(key)
  if (cached) return cached
  const value = fingerprint(source)
  versions.set(key, value)
  return value
}

/** 把页面里的 `__XXX_V__` 占位符换成对应资源的内容指纹（结果同样缓存） */
const pageHtmlCache = new Map<string, string>()

function pageHtml(kind: 'spine' | 'hao2d' | 'threejs'): string {
  const cached = pageHtmlCache.get(kind)
  if (cached) return cached
  const html =
    kind === 'hao2d'
      ? previewPageHao2d
          .replace('__PIXI_V__', versionOf('pixi', pixiSource))
          .replace('__HAO2D_RUNTIME_V__', versionOf('hao2d', hao2dRuntimeSource))
      : kind === 'threejs'
        ? previewPageThreejs.replace('__THREEJS_RUNTIME_V__', versionOf('threejs', threejsRuntimeSource))
        : previewPage.replace('__SPINE_CORE_V__', versionOf('spine', spineCoreSource))
  pageHtmlCache.set(kind, html)
  return html
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
  // 三种预览共享同一份资源（ske/atlas 文本 + 图集页），只是页面与渲染运行库不同
  const isHao2d = active.kind === 'hao2d'
  const isThreejs = active.kind === 'threejs'
  if (rest === '' || rest === 'index.html') {
    // 页面本身不缓存，里面的运行库 URL 带内容指纹（见 pageHtml / fingerprint）
    const kind = isThreejs ? 'threejs' : isHao2d ? 'hao2d' : 'spine'
    // 预览页是主进程直出的静态 HTML：按会话里的语言把界面文案换掉
    send(res, 200, 'text/html; charset=utf-8', localizePreview(pageHtml(kind), active.locale))
    return
  }
  if (rest === 'spine-core.js') {
    if (isHao2d || isThreejs) {
      notFound(res, '当前预览不需要 spine 运行库')
      return
    }
    // 运行库内容由构建期内联；URL 带内容指纹，可长期缓存
    send(res, 200, 'text/javascript; charset=utf-8', spineCoreSource, 'public, max-age=86400')
    return
  }
  if (rest === 'hao2d-runtime.js') {
    if (!isHao2d) {
      notFound(res, '当前预览不需要 hao2d / pixi 运行库')
      return
    }
    // 运行库内容由构建期内联；URL 带内容指纹，可长期缓存
    send(res, 200, 'text/javascript; charset=utf-8', hao2dRuntimeSource, 'public, max-age=86400')
    return
  }
  if (rest === 'threejs-runtime.js') {
    if (!isThreejs) {
      notFound(res, '当前预览不需要 three.js 运行库')
      return
    }
    // three 已打包进这份运行库（单文件，离线可用）
    send(res, 200, 'text/javascript; charset=utf-8', threejsRuntimeSource, 'public, max-age=86400')
    return
  }
  if (rest === 'pixi.js') {
    if (!isHao2d) {
      notFound(res, '当前预览不需要 pixi 运行库')
      return
    }
    // pixi 单独提供（不在运行库里）；URL 带内容指纹，可长期缓存
    send(res, 200, 'text/javascript; charset=utf-8', pixiSource, 'public, max-age=86400')
    return
  }
  if (rest === 'app.js') {
    // 页面逻辑同样是构建期内联的，但改代码要立刻生效，所以不缓存
    const app = isThreejs ? threejsApp : isHao2d ? hao2dApp : previewApp
    send(res, 200, 'text/javascript; charset=utf-8', localizePreview(app, active.locale))
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
          defaultSkin: skeleton.defaultSkin,
          // 嵌套子骨架：页面按 id 预取它们的 ske 文本（清单里不单独列出来给用户选）
          nested: skeleton.nested ?? []
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

/**
 * 起（或替换）预览会话；返回本机与局域网地址。
 *
 * **这里不打开浏览器**：打开动作由渲染层拿 `url` 自己调 `openExternal`（和「在浏览器打开」按钮
 * 同一条路径）。主进程这一路 `shell.openExternal` 在部分 macOS 环境下会被系统静默丢掉 ——
 * 服务明明起好了、浏览器却没反应，用户只能手动点按钮，所以干脆不在这里开。
 */
async function serveSession(
  next: SpinePreviewSession | Hao2dPreviewSession | ThreejsPreviewSession
): Promise<SpinePreviewInfo> {
  if (next.skeletons.length === 0) throw new Error('没有可预览的骨架')
  session = next
  revision += 1
  await ensureServer()
  const base = `/p/${token}/`
  const info: SpinePreviewInfo = {
    url: `http://127.0.0.1:${port}${base}`,
    lanUrls: lanHosts().map((host) => `http://${host}:${port}${base}`),
    token
  }
  log.info(`预览已就绪（第 ${revision} 版）：${info.url}（局域网 ${info.lanUrls.length} 个地址）`)
  return info
}

export async function startPreviewSession(next: SpinePreviewSession): Promise<SpinePreviewInfo> {
  return serveSession(next)
}

export async function startHao2dPreview(next: Hao2dPreviewSession): Promise<SpinePreviewInfo> {
  return serveSession(next)
}

/** three.js 运行库预览：与 hao2d 预览共用一份数据，只换页面与渲染运行库 */
export async function startThreejsPreview(next: ThreejsPreviewSession): Promise<SpinePreviewInfo> {
  return serveSession(next)
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

/** three.js 预览同样共用同一服务实例 */
export async function stopThreejsPreview(): Promise<void> {
  return stopPreviewSession()
}

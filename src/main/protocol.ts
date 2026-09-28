import { protocol, net } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createLogger } from './logger'
import { getAssetRoots, registerAssetRootFor } from './fileService'

const log = createLogger('protocol')

export const FILE_SCHEME = 'hao2d-file'
export const ASSET_SCHEME = 'hao2d-asset'

/** 必须在 app ready 之前调用 */
export function registerSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: FILE_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false }
    },
    {
      scheme: ASSET_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false }
    }
  ])
}

/**
 * 把绝对路径编码进 URL：hao2d-file://local/<base64url(path)>。
 * 解码后必须落在已登记的资源根之内，防止目录穿越。
 */
export function fileUrl(absPath: string): string {
  const encoded = Buffer.from(absPath, 'utf8').toString('base64url')
  return `${FILE_SCHEME}://local/${encoded}`
}

function decodePath(url: string): string {
  const stripped = url.slice(`${FILE_SCHEME}://`.length)
  const slash = stripped.indexOf('/')
  const payload = slash >= 0 ? stripped.slice(slash + 1) : stripped
  return Buffer.from(decodeURIComponent(payload), 'base64url').toString('utf8')
}

function isInsideRoots(target: string): boolean {
  const resolved = path.resolve(target)
  for (const root of getAssetRoots()) {
    if (resolved === root) return true
    if (resolved.startsWith(root + path.sep)) return true
  }
  return false
}

export function registerProtocolHandlers(): void {
  protocol.handle(FILE_SCHEME, (request) => {
    const target = decodePath(request.url)
    if (!isInsideRoots(target)) {
      log.warn(`拒绝访问资源根之外的路径：${target}`)
      return new Response('forbidden', { status: 403 })
    }
    return net.fetch(pathToFileURL(target).toString())
  })

  protocol.handle(ASSET_SCHEME, (request) => {
    const target = decodePath(request.url.replace(ASSET_SCHEME, FILE_SCHEME))
    registerAssetRootFor(path.dirname(target))
    return net.fetch(pathToFileURL(target).toString())
  })
}

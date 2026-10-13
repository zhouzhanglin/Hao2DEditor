import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { randomBytes } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { app, ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import { COMMAND_CHANNEL } from '@shared/commandTypes'
import type { CommandResponse, CommandServerInfo } from '@shared/commandTypes'
import { createLogger } from './logger'

const log = createLogger('命令服务')

/**
 * 本地命令服务：让 AI 工具用 HTTP / WebSocket 直接操作编辑器。
 *
 * 与预览服务同一套路，方向相反：服务在主进程（监听 127.0.0.1 随机端口，强制 token），
 * **执行在渲染进程**（命令请求走 IPC 转给窗口，文档状态只在那里）。
 *
 * 端点：GET /health、GET /commands（命令自描述）、POST /command、POST /batch、WS /ws。
 * 端口不固定，启动后把 `{ port, token, url, file }` 写进 userData/command-server.json，
 * AI 读它即可发现服务（路径也会打进启动日志）。
 */

const CALL_TIMEOUT_MS = 20_000
const BODY_LIMIT = 4 * 1024 * 1024

let server: Server | null = null
let wss: WebSocketServer | null = null
let port = 0
let token = ''
let info: CommandServerInfo | null = null
let windowGetter: () => BrowserWindow | null = () => null
/** 关闭时要一并断开的长连接（keep-alive / WS 会让 server.close 迟迟不回调） */
const sockets = new Set<Socket>()

interface PendingEntry {
  finish: (response: Omit<CommandResponse, 'id'>) => void
}

const pending = new Map<number, PendingEntry>()
let nextId = 0

// ---------------- 渲染进程调用 ----------------

function onCommandResult(_event: unknown, response: CommandResponse): void {
  const entry = pending.get(response.id)
  if (!entry) return
  pending.delete(response.id)
  entry.finish(response)
}

/** 把一条命令转给渲染进程执行；窗口没开 / 超时都折成 ok:false 回给调用方 */
function callRenderer(name: string, args: unknown): Promise<Omit<CommandResponse, 'id'>> {
  const win = windowGetter()
  if (!win || win.isDestroyed()) {
    return Promise.resolve({ ok: false, changed: false, error: '编辑器窗口没打开，命令没人执行' })
  }
  const id = ++nextId
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      resolve({ ok: false, changed: false, error: `命令超时（${CALL_TIMEOUT_MS / 1000} 秒没回结果）` })
    }, CALL_TIMEOUT_MS)
    pending.set(id, {
      finish: (response) => {
        clearTimeout(timer)
        resolve(response)
      }
    })
    win.webContents.send(COMMAND_CHANNEL.request, { id, name, args })
  })
}

// ---------------- 批量与事务 ----------------

interface BatchEntry {
  name: string
  args?: unknown
}

export interface BatchStepResult {
  name: string
  ok: boolean
  changed?: boolean
  message?: string
  error?: string
  data?: unknown
}

export interface BatchOutcome {
  ok: boolean
  results: BatchStepResult[]
  /** 是否整体回滚了（失败、或整批都没有实际改动时） */
  rolledBack: boolean
  label?: string
}

/**
 * 逐条顺序执行（后面的命令看得到前面的结果）。
 *
 * `transaction: true`：先 beginTransaction 把整批合并成一条撤销记录；
 * 中途失败 → rollbackTransaction 整体回滚（不留半套状态，也不留撤销记录）；
 * 整批都没改东西 → 同样回滚，免得撤销栈里多一条空记录。
 */
async function runBatch(entries: readonly BatchEntry[], transaction: boolean, label?: string): Promise<BatchOutcome> {
  const results: BatchStepResult[] = []
  const batchLabel = label && label.trim() !== '' ? label.trim() : 'AI 批量操作'
  if (transaction) await callRenderer('beginTransaction', { label: batchLabel })

  let failed = false
  for (const entry of entries) {
    const result = await callRenderer(entry.name, entry.args)
    results.push({
      name: entry.name,
      ok: result.ok,
      changed: result.changed,
      ...(result.message !== undefined ? { message: result.message } : {}),
      ...(result.error !== undefined ? { error: result.error } : {}),
      ...(result.data !== undefined ? { data: result.data } : {})
    })
    if (!result.ok) {
      failed = true
      break
    }
  }

  if (!transaction) return { ok: !failed, results, rolledBack: false }

  const anyChanged = results.some((step) => step.ok && step.changed)
  if (failed || !anyChanged) {
    await callRenderer('rollbackTransaction', {})
    return { ok: !failed, results, rolledBack: true }
  }
  await callRenderer('endTransaction', {})
  return { ok: true, results, rolledBack: false, label: batchLabel }
}

/** 校验 `{ commands: [...] }`；不合法直接报人话 */
function parseBatchEntries(raw: unknown): BatchEntry[] {
  if (!Array.isArray(raw)) throw new Error('commands 必须是数组，例如 {"commands":[{"name":"addBone","args":{...}}]}')
  if (raw.length === 0) throw new Error('commands 是空的：至少放一条命令')
  return raw.map((item, index) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`commands[${index}] 必须是对象 { name, args }`)
    }
    const record = item as Record<string, unknown>
    const name = typeof record.name === 'string' ? record.name.trim() : ''
    if (!name) throw new Error(`commands[${index}] 缺少 name（命令名）`)
    return { name, args: record.args }
  })
}

// ---------------- HTTP ----------------

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body, null, 2), 'utf8')
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  })
  res.end(data)
}

function sendPreflight(res: ServerResponse): void {
  res.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, authorization, x-hao2d-token',
    'Access-Control-Max-Age': '600'
  })
  res.end()
}

/** token 三种带法都认：?token=、x-hao2d-token 头、Authorization: Bearer */
function authorized(req: IncomingMessage): boolean {
  if (token === '') return false
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (url.searchParams.get('token') === token) return true
  const header = req.headers['x-hao2d-token']
  if (typeof header === 'string' && header === token) return true
  const auth = req.headers.authorization
  if (typeof auth === 'string' && auth === `Bearer ${token}`) return true
  return false
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        reject(new Error('请求体过大（上限 4MB）'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET'
  if (method === 'OPTIONS') {
    sendPreflight(res)
    return
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (!authorized(req)) {
    sendJson(res, 401, {
      ok: false,
      error: 'token 不对（带 ?token=… / x-hao2d-token 头 / Authorization: Bearer …；token 见 command-server.json）'
    })
    return
  }

  try {
    if (method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { ok: true, service: 'hao2d-command', port, url: info?.url ?? '' })
      return
    }
    if (url.pathname === '/commands' && (method === 'GET' || method === 'POST')) {
      sendJson(res, 200, await callRenderer('__catalog', {}))
      return
    }
    if (method === 'POST' && url.pathname === '/command') {
      const body = (await readBody(req)) as Record<string, unknown>
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      if (!name) {
        sendJson(res, 200, { ok: false, changed: false, error: 'body 里要给命令名 name，例如 {"name":"listBones"}' })
        return
      }
      // 命令执行失败也回 200：ok / error 放在 body 里，AI 一眼能读全
      sendJson(res, 200, await callRenderer(name, body.args))
      return
    }
    if (method === 'POST' && url.pathname === '/batch') {
      const body = (await readBody(req)) as Record<string, unknown>
      const outcome = await runBatch(
        parseBatchEntries(body.commands),
        body.transaction === true,
        typeof body.label === 'string' ? body.label : undefined
      )
      sendJson(res, 200, outcome)
      return
    }
    if (method === 'GET' && url.pathname === '/events') {
      sendJson(res, 200, { ok: false, error: '事件流暂未提供：请用 POST /command 轮询，或连 WebSocket /ws' })
      return
    }
    sendJson(res, 404, {
      ok: false,
      error: `没有这个端点：${method} ${url.pathname}（可用：GET /health、GET /commands、POST /command、POST /batch、WS /ws）`
    })
  } catch (err) {
    sendJson(res, 200, { ok: false, changed: false, error: err instanceof Error ? err.message : String(err) })
  }
}

// ---------------- WebSocket ----------------

/** WS 消息：单条 `{ id?, name, args }`，或批量 `{ id?, batch: [...], transaction?, label? }` */
async function handleSocketMessage(socket: WebSocket, raw: string): Promise<void> {
  let message: unknown
  try {
    message = JSON.parse(raw)
  } catch {
    socket.send(JSON.stringify({ id: null, ok: false, error: '消息不是合法 JSON' }))
    return
  }
  const record = (message ?? {}) as Record<string, unknown>
  const id = typeof record.id === 'number' ? record.id : null
  try {
    if (Array.isArray(record.batch)) {
      const outcome = await runBatch(
        parseBatchEntries(record.batch),
        record.transaction === true,
        typeof record.label === 'string' ? record.label : undefined
      )
      socket.send(JSON.stringify({ id, ...outcome }))
      return
    }
    const name = typeof record.name === 'string' ? record.name.trim() : ''
    if (!name) {
      socket.send(JSON.stringify({ id, ok: false, error: '消息里要给 name（命令名），或 batch（命令数组）' }))
      return
    }
    socket.send(JSON.stringify({ id, ...(await callRenderer(name, record.args)) }))
  } catch (err) {
    socket.send(JSON.stringify({ id, ok: false, error: err instanceof Error ? err.message : String(err) }))
  }
}

// ---------------- 生命周期 ----------------

/** 发现文件：AI 从这里读端口与 token（路径固定，也在启动日志里） */
function discoveryFile(): string {
  return path.join(app.getPath('userData'), 'command-server.json')
}

/**
 * 启动命令服务。已在跑就直接返回现有信息。
 * 返回的 `url` / `token` 就是 AI 要用的；同时写入发现文件。
 */
export async function startCommandServer(getWindow: () => BrowserWindow | null): Promise<CommandServerInfo | null> {
  if (server && info) return info
  windowGetter = getWindow

  const created = createServer((req, res) => {
    void handleRequest(req, res)
  })
  created.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err)
    created.once('error', onError)
    // 只认本机回环：AI 与本机工具用 127.0.0.1 就够，不暴露到局域网
    created.listen(0, '127.0.0.1', () => {
      created.off('error', onError)
      resolve()
    })
  })

  const address = created.address()
  port = typeof address === 'object' && address !== null ? address.port : 0
  token = randomBytes(18).toString('base64url')
  server = created

  const socketServer = new WebSocketServer({ server: created, path: '/ws' })
  socketServer.on('connection', (socket, request) => {
    if (!authorized(request)) {
      socket.close(4401, 'token 无效')
      return
    }
    socket.on('message', (data) => {
      void handleSocketMessage(socket, data.toString())
    })
  })
  socketServer.on('error', (err) => {
    log.warn(`WebSocket 出错：${err instanceof Error ? err.message : String(err)}`)
  })
  wss = socketServer

  ipcMain.on(COMMAND_CHANNEL.result, onCommandResult)

  const file = discoveryFile()
  const payload: CommandServerInfo = { port, token, url: `http://127.0.0.1:${port}`, file }
  try {
    await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  } catch (err) {
    log.warn(`写发现文件失败（${file}）：${err instanceof Error ? err.message : String(err)}`)
  }
  info = payload
  log.info(`命令服务已启动：${payload.url}（地址与 token 见 ${file}）`)
  return payload
}

/** 停服务：断长连接、清 pending、删发现文件 */
export async function stopCommandServer(): Promise<void> {
  const active = server
  const activeInfo = info
  server = null
  info = null
  ipcMain.off(COMMAND_CHANNEL.result, onCommandResult)

  for (const [id, entry] of pending) {
    entry.finish({ ok: false, changed: false, error: '命令服务已停止' })
    pending.delete(id)
  }
  wss?.close()
  wss = null
  for (const socket of sockets) socket.destroy()
  sockets.clear()

  if (activeInfo) {
    try {
      await rm(activeInfo.file, { force: true })
    } catch {
      // 文件不在就算了
    }
  }
  if (!active) return
  await new Promise<void>((resolve) => {
    active.close(() => resolve())
  })
  log.info(`命令服务已停止（原端口 ${activeInfo?.port ?? port}）`)
}

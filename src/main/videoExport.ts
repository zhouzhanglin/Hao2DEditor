import { app } from 'electron'
import { spawn } from 'node:child_process'
import type { ChildProcessByStdio } from 'node:child_process'
import { chmodSync, existsSync, promises as fsp } from 'node:fs'
import type { Readable, Writable } from 'node:stream'
import path from 'node:path'
import { createLogger } from './logger'
import type { VideoExportOptions } from '@shared/ipcTypes'

const log = createLogger('video')

/** stderr 只留尾部这么多字节：ffmpeg 出错时最后的几行才是真原因 */
const STDERR_LIMIT = 2048

interface Session {
  id: string
  options: VideoExportOptions
  proc: ChildProcessByStdio<Writable, null, Readable>
  /** 最近收集到的 stderr（失败时回传给面板） */
  stderr: string
  /** spawn 失败 / 管道提前断开时的原因；非空后所有推帧都会失败 */
  error: string | null
  /** 进程退出的状态（finish 时等它） */
  exited: Promise<{ code: number | null; signal: string | null }>
}

const sessions = new Map<string, Session>()
let sequence = 0

/**
 * 找出可用的 ffmpeg 可执行文件。
 *
 * 查找顺序（先具体后兜底）：
 * 1. 环境变量 `HAO2D_FFMPEG`（临时换一个版本时用）；
 * 2. 随应用分发的二进制：`<resources>/ffmpeg/<mac|win|linux>/ffmpeg`（打包后 extraResources 里）；
 * 3. `ffmpeg-static` 可选依赖（装了就用，各平台预编译）；
 * 4. 系统 PATH 里的 `ffmpeg`（spawn 自己去解析，找不到会在 error 事件里报 ENOENT）。
 *
 * 为什么这么绕：ffmpeg 的二进制体积不小（60~80MB），有人希望用系统自带的、
 * 有人希望随包分发；路径写死任何一个都会让另一条路走不通。
 */
export function resolveFfmpegPath(): string {
  const env = process.env.HAO2D_FFMPEG
  if (env && existsSync(env)) return ensureExecutable(env)

  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const platDir = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux'
  const roots = app.isPackaged
    ? [process.resourcesPath, app.getAppPath()]
    : [path.join(app.getAppPath(), 'resources'), process.resourcesPath]
  for (const root of roots) {
    for (const candidate of [
      path.join(root, 'ffmpeg', platDir, exe),
      path.join(root, 'ffmpeg', exe),
      path.join(root, 'ffmpeg', platDir, 'ffmpeg')
    ]) {
      if (existsSync(candidate)) return ensureExecutable(candidate)
    }
  }

  try {
    // 可选依赖：没装会抛 MODULE_NOT_FOUND，按「继续往下找」处理
    const staticPath = require('ffmpeg-static') as string | null
    // 打包后这个模块在 app.asar 里，而 asar 里的文件**不能直接执行**（spawn 会 ENOENT/EACCES），
    // 必须指向 asarUnpack 出来的那份实体文件
    const unpacked = staticPath ? staticPath.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`) : null
    if (unpacked && existsSync(unpacked)) return ensureExecutable(unpacked)
    if (staticPath && existsSync(staticPath)) return ensureExecutable(staticPath)
  } catch {
    // 未安装 ffmpeg-static：正常，落到系统 PATH
  }
  return exe
}

/**
 * 确保二进制可执行。
 *
 * 为什么要补这一步：`npm install ffmpeg-static` 下载出来的文件常常是 `644`
 * （没执行位），spawn 会直接 EACCES —— 用户看到的是「导出失败」，实际只是 chmod 没做。
 * chmod 失败（只读磁盘 / 安装包内）就算了，spawn 那一层还会给出可读的错误。
 */
function ensureExecutable(bin: string): string {
  try {
    chmodSync(bin, 0o755)
  } catch {
    // 忽略：没权限改就让它去 spawn，错误在那边报得更具体
  }
  return bin
}

function expectEven(value: number, label: string): number {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${label} 必须是正整数`)
  if (n % 2 !== 0) throw new Error(`${label} 必须是偶数（H.264 要求）：收到 ${n}`)
  return n
}

/** 开会话：校验参数、建目录、spawn ffmpeg，返回会话 id */
export async function startVideoExport(options: VideoExportOptions): Promise<{ sessionId: string; ffmpeg: string }> {
  const outputPath = String(options.outputPath ?? '')
  if (!path.isAbsolute(outputPath)) throw new Error('输出路径必须是绝对路径')
  if (!/\.mp4$/i.test(outputPath)) throw new Error('输出文件必须是 .mp4')
  const width = expectEven(options.width, '视频宽度')
  const height = expectEven(options.height, '视频高度')
  const fps = Number(options.fps)
  if (!Number.isFinite(fps) || fps <= 0 || fps > 240) throw new Error(`帧率不合法：${options.fps}`)
  const crf = Math.min(40, Math.max(0, Math.round(Number(options.crf ?? 18))))

  await fsp.mkdir(path.dirname(outputPath), { recursive: true })

  const ffmpeg = resolveFfmpegPath()
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgba',
    '-s',
    `${width}x${height}`,
    '-r',
    String(fps),
    '-i',
    '-',
    '-an',
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    String(crf),
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    '-y',
    outputPath
  ]

  const proc = spawn(ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'] })
  const id = `video-${++sequence}`
  const session: Session = {
    id,
    options: { outputPath, width, height, fps, crf },
    proc,
    stderr: '',
    error: null,
    exited: new Promise((resolve) => {
      proc.on('close', (code, signal) => resolve({ code, signal }))
    })
  }

  proc.stderr?.setEncoding('utf8')
  proc.stderr?.on('data', (chunk: string) => {
    session.stderr = (session.stderr + chunk).slice(-STDERR_LIMIT)
  })
  proc.on('error', (error) => {
    // 最常见的两种：没装 ffmpeg（ENOENT）、没有执行权限（EACCES）
    session.error =
      (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? '没有找到 ffmpeg：把二进制放到 resources/ffmpeg/<平台>/ 下，或安装系统 ffmpeg（brew install ffmpeg）'
        : `启动 ffmpeg 失败：${error.message}`
    log.warn(session.error)
  })
  proc.stdin.on('error', (error) => {
    session.error = session.error ?? `写入 ffmpeg 失败：${error.message}`
  })

  sessions.set(id, session)
  log.info(`会话 ${id} 开始：${width}x${height}@${fps} → ${outputPath}（ffmpeg: ${ffmpeg}）`)
  return { sessionId: id, ffmpeg }
}

function requireSession(sessionId: string): Session {
  const session = sessions.get(sessionId)
  if (!session) throw new Error('视频导出会话不存在（可能已结束或被取消）')
  if (session.error) throw new Error(session.error)
  return session
}

/**
 * 推一帧。返回的 Promise 在**这一帧真正写进管道**后 resolve —— 渲染层 `await` 它，
 * 天然就有背压：编码跟不上时推帧会自动变慢，内存不会被帧堆满。
 */
export function pushVideoFrame(sessionId: string, frame: Uint8Array): Promise<void> {
  const session = requireSession(sessionId)
  const expected = session.options.width * session.options.height * 4
  if (frame.byteLength !== expected) {
    throw new Error(`帧数据长度不对：期望 ${expected}，收到 ${frame.byteLength}`)
  }
  return new Promise<void>((resolve, reject) => {
    session.proc.stdin.write(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength), (error) => {
      if (error) reject(new Error(`写入 ffmpeg 失败：${error.message}`))
      else resolve()
    })
  })
}

/** 收尾：关管道 + 等退出；失败时删掉半成品，把 stderr 尾部带回去 */
export async function finishVideoExport(sessionId: string): Promise<{ path: string }> {
  const session = sessions.get(sessionId)
  if (!session) throw new Error('视频导出会话不存在（可能已取消）')
  sessions.delete(sessionId)

  session.proc.stdin.end()
  // 兜底超时：ffmpeg 若卡在收尾（磁盘满 / 驱动异常），别让面板永远转圈
  const { code, signal } = await Promise.race([
    session.exited,
    new Promise<{ code: number | null; signal: string | null }>((resolve) =>
      setTimeout(() => resolve({ code: null, signal: 'timeout' }), 20000)
    )
  ])
  if (code === null && signal === 'timeout') {
    session.proc.kill('SIGKILL')
    await fsp.rm(session.options.outputPath, { force: true })
    throw new Error('ffmpeg 收尾超时（已强制结束并删除半成品）')
  }
  const outputPath = session.options.outputPath
  if (code !== 0) {
    await fsp.rm(outputPath, { force: true })
    const reason = session.error ?? session.stderr.trim() ?? `ffmpeg 退出码 ${String(code)}${signal ? ` (${signal})` : ''}`
    throw new Error(reason)
  }
  log.info(`会话 ${sessionId} 完成：${outputPath}`)
  return { path: outputPath }
}

/** 取消：杀掉进程 + 删半成品。会话不存在时静默成功（面板可能重复取消） */
export async function cancelVideoExport(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId)
  if (!session) return
  sessions.delete(sessionId)
  session.proc.kill('SIGKILL')
  await session.exited
  await fsp.rm(session.options.outputPath, { force: true })
  log.info(`会话 ${sessionId} 已取消`)
}

/** 进程退出前收尾：别留下孤儿 ffmpeg 进程 */
export function cancelAllVideoExports(): void {
  for (const session of sessions.values()) {
    session.proc.kill('SIGKILL')
  }
  sessions.clear()
}

import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { FILE_SCHEME } from './protocol'
import * as fs from './fileService'
import {
  startPreviewSession,
  stopPreviewSession,
  startHao2dPreview,
  stopHao2dPreview,
  startThreejsPreview,
  stopThreejsPreview
} from './previewServer'
import { commandServerInfo } from './commandServer'
import { markRendererReady } from './openRequests'
import { installMcpIntoClients } from './aiClientConfig'
import { installSkillToClients, openSkillsFolder, skillsInfo } from './aiSkills'
import { normalizeLocale, setLocale } from './i18n'
import { buildAppMenu } from './menu'
import {
  cancelVideoExport,
  finishVideoExport,
  pushVideoFrame,
  startVideoExport
} from './videoExport'
import { IPC } from '@shared/ipcTypes'
import type {
  BatchFile,
  Hao2dPreviewSession,
  OpenDialogOptions,
  SaveDialogOptions,
  SpinePreviewSession,
  ThreejsPreviewSession,
  VideoExportOptions
} from '@shared/ipcTypes'

function focusedWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
}

/** 用系统默认程序打开链接；只认 http(s) */
async function openExternal(url: string): Promise<void> {
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`不支持的链接：${url}`)
  }
  await shell.openExternal(parsed.toString())
}

export function registerIpcHandlers(): void {
  ipcMain.handle(IPC.openDialog, (_e, options: OpenDialogOptions | undefined) =>
    fs.safe(() => fs.openDialog(focusedWindow(), options ?? {}))
  )

  ipcMain.handle(IPC.saveDialog, (_e, options: SaveDialogOptions | undefined) =>
    fs.safe(() => fs.saveDialog(focusedWindow(), options ?? {}))
  )

  ipcMain.handle(IPC.readText, (_e, p: string) => fs.safe(() => fs.readText(p)))
  ipcMain.handle(IPC.readBinary, (_e, p: string) => fs.safe(() => fs.readBinary(p)))
  ipcMain.handle(IPC.writeText, (_e, p: string, text: string) =>
    fs.safe(() => fs.writeText(p, text))
  )
  ipcMain.handle(IPC.writeBinary, (_e, p: string, bytes: Uint8Array) =>
    fs.safe(() => fs.writeBinary(p, bytes))
  )
  ipcMain.handle(IPC.writeBatch, (_e, files: BatchFile[]) => fs.safe(() => fs.writeBatch(files)))
  ipcMain.handle(IPC.listDir, (_e, dir: string, recursive: boolean) =>
    fs.safe(() => fs.listDir(dir, Boolean(recursive)))
  )
  ipcMain.handle(IPC.exists, (_e, p: string) => fs.safe(() => fs.pathExists(p)))
  ipcMain.handle(IPC.deleteFile, (_e, p: string) => fs.safe(() => fs.deleteFile(p)))
  ipcMain.handle(IPC.imageInfo, (_e, paths: string[]) => fs.safe(() => fs.imageInfo(paths)))
  ipcMain.handle(IPC.registerAssetRoot, (_e, dir: string) =>
    fs.safe(() => fs.registerAssetRootFor(dir))
  )

  ipcMain.handle(IPC.recentList, () => fs.safe(() => fs.recentList()))
  ipcMain.handle(IPC.recentAdd, (_e, p: string) => fs.safe(() => fs.recentAdd(p)))
  ipcMain.handle(IPC.recentRemove, (_e, p: string) => fs.safe(() => fs.recentRemove(p)))
  ipcMain.handle(IPC.revealInFolder, (_e, p: string) => fs.safe(() => fs.revealInFolder(p)))

  ipcMain.handle(IPC.setTitle, (_e, title: string) =>
    fs.safe(() => {
      focusedWindow()?.setTitle(typeof title === 'string' && title.length > 0 ? title : 'Hao2D Editor')
    })
  )

  // 渲染层要加载本地图片时，把它的目录登记为资源根
  ipcMain.handle(`${FILE_SCHEME}:allow`, (_e, dir: string) =>
    fs.safe(() => fs.registerAssetRootFor(dir))
  )

  // 在线预览：起本地网页服务（spine.js 运行时播放），地址不变、可反复替换资源。
  // 打不打开浏览器由渲染层决定（它拿 url 走 IPC.openExternal），服务端只管起服务。
  ipcMain.handle(IPC.spinePreviewStart, (_e, session: SpinePreviewSession) =>
    fs.safe(() => startPreviewSession(session))
  )
  ipcMain.handle(IPC.spinePreviewStop, () => fs.safe(() => stopPreviewSession()))

  // 在线预览：导出运行时预览（hao2d 计算方式 + pixi.js 渲染），地址不变、可反复替换资源
  ipcMain.handle(IPC.hao2dPreviewStart, (_e, session: Hao2dPreviewSession) =>
    fs.safe(() => startHao2dPreview(session))
  )
  ipcMain.handle(IPC.hao2dPreviewStop, () => fs.safe(() => stopHao2dPreview()))

  // 在线预览：three.js 版 hao2d 运行库（数据与 hao2d 预览一致，页面 / 渲染运行库不同）
  ipcMain.handle(IPC.threejsPreviewStart, (_e, session: ThreejsPreviewSession) =>
    fs.safe(() => startThreejsPreview(session))
  )
  ipcMain.handle(IPC.threejsPreviewStop, () => fs.safe(() => stopThreejsPreview()))

  // 在线预览的「在浏览器打开」：只放行 http(s)，别让渲染层的字符串借系统去执行别的东西
  ipcMain.handle(IPC.openExternal, (_e, url: string) => fs.safe(() => openExternal(url)))

  // AI 接入：当前命令服务的 MCP 信息（是否在跑、带 token 的 MCP URL）
  ipcMain.handle(IPC.aiMcpInfo, () =>
    fs.safe(() => {
      const info = commandServerInfo()
      if (!info) return { running: false, mcpUrl: '', url: '', token: '' }
      return {
        running: true,
        mcpUrl: `${info.url}/mcp?token=${info.token}`,
        url: info.url,
        token: info.token
      }
    })
  )

  // AI 接入：把 MCP URL 写进已识别的 AI 客户端配置（一键安装）
  ipcMain.handle(IPC.aiInstallMcp, () => fs.safe(() => installMcpIntoClients(commandServerInfo())))

  // AI 接入：随包分发的 Skill（绑骨 / 打帧 / 导出流程的手册）——查位置、开目录、装进客户端
  ipcMain.handle(IPC.aiSkillsInfo, () => fs.safe(() => skillsInfo()))
  ipcMain.handle(IPC.aiOpenSkillsDir, () => fs.safe(() => openSkillsFolder()))
  ipcMain.handle(
    IPC.aiInstallSkill,
    (_e, options: { name?: string; dir?: string } | undefined) =>
      fs.safe(() => installSkillToClients(options ?? {}))
  )

  // 视频导出：渲染层逐帧推 RGBA，主进程用 ffmpeg 编成 mp4。
  // 推帧用 handle（invoke）而不是 send：渲染层 await 它才能拿到背压（见 videoExport.ts）
  ipcMain.handle(IPC.videoStart, (_e, options: VideoExportOptions) => fs.safe(() => startVideoExport(options)))
  ipcMain.handle(IPC.videoFrame, (_e, sessionId: string, frame: Uint8Array) =>
    fs.safe(() => pushVideoFrame(sessionId, frame))
  )
  ipcMain.handle(IPC.videoFinish, (_e, sessionId: string) => fs.safe(() => finishVideoExport(sessionId)))
  ipcMain.handle(IPC.videoCancel, (_e, sessionId: string) => fs.safe(() => cancelVideoExport(sessionId)))

  // 双击工程文件启动时，渲染层挂载后来取一次排队的路径（取完即清空，之后走事件推送）
  ipcMain.handle(IPC.consumeOpenRequests, () => fs.safe(() => markRendererReady()))

  // 语言：把系统语言标签交给渲染进程（首启判定界面语言用）
  ipcMain.handle(IPC.i18nSystemLocale, () => fs.safe(() => app.getLocale()))

  // 语言：渲染进程切语言后同步过来，主进程据此重建应用菜单
  ipcMain.handle(IPC.i18nSetLocale, (_e, locale: string) =>
    fs.safe(() => {
      setLocale(normalizeLocale(locale))
      buildAppMenu()
    })
  )
}

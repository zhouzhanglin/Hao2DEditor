import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC } from '@shared/ipcTypes'
import type {
  BatchFile,
  DirEntry,
  HaoBridge,
  ImageInfo,
  IpcResult,
  MenuCommand,
  OpenDialogOptions,
  SaveDialogOptions
} from '@shared/ipcTypes'
import { COMMAND_CHANNEL } from '@shared/commandTypes'
import type { CommandRequest, CommandResponse } from '@shared/commandTypes'

const FILE_SCHEME = 'hao2d-file'

function invoke<T>(channel: string, ...args: unknown[]): Promise<IpcResult<T>> {
  return ipcRenderer.invoke(channel, ...args) as Promise<IpcResult<T>>
}

const bridge: HaoBridge = {
  isElectron: true,
  platform: process.platform,

  getPathForFile: (file: File): string => {
    return webUtils.getPathForFile(file)
  },

  openDialog: (options?: OpenDialogOptions) => invoke<string[]>(IPC.openDialog, options),
  saveDialog: (options?: SaveDialogOptions) => invoke<string | null>(IPC.saveDialog, options),
  readText: (p: string) => invoke<string>(IPC.readText, p),
  readBinary: (p: string) => invoke<Uint8Array>(IPC.readBinary, p),
  writeText: (p: string, text: string) => invoke<void>(IPC.writeText, p, text),
  writeBinary: (p: string, bytes: Uint8Array) => invoke<void>(IPC.writeBinary, p, bytes),
  writeBatch: (files: BatchFile[]) => invoke<void>(IPC.writeBatch, files),
  listDir: (dir: string, recursive: boolean) => invoke<DirEntry[]>(IPC.listDir, dir, recursive),
  exists: (p: string) => invoke<boolean>(IPC.exists, p),
  deleteFile: (p: string) => invoke<boolean>(IPC.deleteFile, p),
  imageInfo: (paths: string[]) => invoke<ImageInfo[]>(IPC.imageInfo, paths),
  registerAssetRoot: (dir: string) => invoke<void>(IPC.registerAssetRoot, dir),
  recentList: () => invoke<string[]>(IPC.recentList),
  recentAdd: (path: string) => invoke<void>(IPC.recentAdd, path),
  revealInFolder: (path: string) => invoke<void>(IPC.revealInFolder, path),
  setTitle: (title: string) => invoke<void>(IPC.setTitle, title),

  startSpinePreview: (session) => invoke(IPC.spinePreviewStart, session),
  stopSpinePreview: () => invoke<void>(IPC.spinePreviewStop),
  startHao2dPreview: (session) => invoke(IPC.hao2dPreviewStart, session),
  stopHao2dPreview: () => invoke<void>(IPC.hao2dPreviewStop),
  openExternal: (url: string) => invoke<void>(IPC.openExternal, url),

  aiMcpInfo: () => invoke(IPC.aiMcpInfo),
  aiInstallMcp: () => invoke(IPC.aiInstallMcp),
  aiSkillsInfo: () => invoke(IPC.aiSkillsInfo),
  aiOpenSkillsDir: () => invoke(IPC.aiOpenSkillsDir),
  aiInstallSkill: (options) => invoke(IPC.aiInstallSkill, options),

  systemLocale: () => invoke<string>(IPC.i18nSystemLocale),
  setAppLocale: (locale: string) => invoke<void>(IPC.i18nSetLocale, locale),

  fileUrl: (absPath: string): string => {
    const encoded = xorEncode(absPath)
    return `${FILE_SCHEME}://local/${encoded}`
  },

  onMenuCommand: (cb: (command: MenuCommand) => void) => {
    const listener = (_e: unknown, command: MenuCommand): void => cb(command)
    ipcRenderer.on(IPC.menuCommand, listener)
    return () => {
      ipcRenderer.off(IPC.menuCommand, listener)
    }
  },

  onOpenProjectRequest: (cb: (path: string) => void) => {
    const listener = (_e: unknown, p: string): void => cb(p)
    ipcRenderer.on(IPC.openProjectRequest, listener)
    return () => {
      ipcRenderer.off(IPC.openProjectRequest, listener)
    }
  },

  onCommandRequest: (cb: (request: CommandRequest) => void) => {
    const listener = (_e: unknown, request: CommandRequest): void => cb(request)
    ipcRenderer.on(COMMAND_CHANNEL.request, listener)
    return () => {
      ipcRenderer.off(COMMAND_CHANNEL.request, listener)
    }
  },

  sendCommandResult: (response: CommandResponse) => {
    ipcRenderer.send(COMMAND_CHANNEL.result, response)
  }
}

/** 与主进程 protocol.ts 的 base64url 编码保持一致（不引入 Buffer） */
function xorEncode(input: string): string {
  const bytes = new TextEncoder().encode(input)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

contextBridge.exposeInMainWorld('hao', bridge)

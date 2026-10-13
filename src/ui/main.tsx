import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import '../styles/index.css'
import { useProjectStore } from '@editor/store/projectStore'
import { useSelectionStore } from '@editor/store/selectionStore'
import { useToolStore } from '@editor/store/toolStore'
import { useTimelineStore } from '@editor/store/timelineStore'
import { useModeStore } from '@editor/store/modeStore'
import { getPlatform } from '@editor/platform'
import {
  importDroppedPaths,
  lastProject,
  newProject,
  openProject,
  openProjectAt,
  saveProject
} from '@editor/services/projectIo'
import { catalog, executeCommand, installCommands } from '@editor/commands'
import { connectCommandBridge } from '@editor/services/commandBridge'

/**
 * 调试钩子：把 store、平台层与工程 IO 挂到全局，
 * 便于在浏览器控制台 / 自动化脚本里检查状态、跑通「保存 → 下次启动自动打开」这类流程。
 * （只读检查与自动化用，业务代码不要依赖它。）
 */
const debugTarget = globalThis as unknown as {
  __haoStores?: {
    project: typeof useProjectStore
    selection: typeof useSelectionStore
    tools: typeof useToolStore
    timeline: typeof useTimelineStore
    mode: typeof useModeStore
  }
  __haoPlatform?: ReturnType<typeof getPlatform>
  __haoProject?: {
    lastProject: typeof lastProject
    newProject: typeof newProject
    openProject: typeof openProject
    openProjectAt: typeof openProjectAt
    saveProject: typeof saveProject
    importDroppedPaths: typeof importDroppedPaths
  }
  /** 命令注册表：控制台里 `__haoCmd.execute('listBones')` 可直接试跑命令 */
  __haoCmd?: {
    execute: typeof executeCommand
    catalog: typeof catalog
  }
}
debugTarget.__haoStores = {
  project: useProjectStore,
  selection: useSelectionStore,
  tools: useToolStore,
  timeline: useTimelineStore,
  mode: useModeStore
}
debugTarget.__haoPlatform = getPlatform()
debugTarget.__haoProject = { lastProject, newProject, openProject, openProjectAt, saveProject, importDroppedPaths }

// 命令注册表：UI 与 AI（本地服务）共用同一套命令，启动时注册一次
installCommands()
debugTarget.__haoCmd = { execute: executeCommand, catalog }

// 接上主进程的本地命令服务：AI 发来的 HTTP / WebSocket 请求都会在这里执行
connectCommandBridge()

const container = document.getElementById('root')
if (!container) {
  console.error('[hao2d] 找不到 #root 挂载点')
} else {
  createRoot(container).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}

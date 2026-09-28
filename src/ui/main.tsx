import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import '../styles/index.css'
import { useProjectStore } from '@editor/store/projectStore'
import { useSelectionStore } from '@editor/store/selectionStore'
import { useToolStore } from '@editor/store/toolStore'
import { useTimelineStore } from '@editor/store/timelineStore'
import { useModeStore } from '@editor/store/modeStore'

/**
 * 调试钩子：把几个 store 挂到全局，便于在浏览器控制台 / 自动化脚本里检查编辑器状态。
 * （只读检查用，业务代码不要依赖它。）
 */
const debugTarget = globalThis as unknown as {
  __haoStores?: {
    project: typeof useProjectStore
    selection: typeof useSelectionStore
    tools: typeof useToolStore
    timeline: typeof useTimelineStore
    mode: typeof useModeStore
  }
}
debugTarget.__haoStores = {
  project: useProjectStore,
  selection: useSelectionStore,
  tools: useToolStore,
  timeline: useTimelineStore,
  mode: useModeStore
}

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

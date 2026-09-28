import type { EditorScene } from './scene'

/**
 * 当前激活的场景句柄。
 * 面板需要在没有 props 传递的情况下触发视口操作（适配视野、立即刷新、拾取），
 * 用模块级引用比层层透传更简单，且只有一个视口实例。
 */
let active: EditorScene | null = null
const listeners = new Set<(scene: EditorScene | null) => void>()

export function setActiveScene(scene: EditorScene | null): void {
  active = scene
  // 调试钩子：便于在浏览器控制台 / 自动化脚本里检查场景状态
  ;(globalThis as { __haoScene?: EditorScene | null }).__haoScene = scene
  for (const listener of listeners) listener(scene)
}

export function getActiveScene(): EditorScene | null {
  return active
}

export function onActiveSceneChange(listener: (scene: EditorScene | null) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

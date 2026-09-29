import { create } from 'zustand'
import type { EditorDocument } from '@core/model/authoring'
import { createEmptyDocument } from '@core/model/authoring'
import { History } from '../history'
import { repairAnimationDurations } from '../timeline/model'

export interface ProjectState {
  document: EditorDocument
  projectPath: string | null
  dirty: boolean
  /** 最近一次编译 / 导入产生的提示 */
  warnings: string[]
  canUndo: boolean
  canRedo: boolean
  undoLabel: string | null
  redoLabel: string | null

  setDocument: (document: EditorDocument, projectPath?: string | null, dirty?: boolean) => void
  /** 可撤销的编辑：mutate 在深拷贝的草稿上执行 */
  update: (label: string, mutate: (draft: EditorDocument) => void) => void
  /** 不可撤销的编辑（面板布局、视口状态等） */
  updateSilent: (mutate: (draft: EditorDocument) => void) => void
  /** 连续编辑（拖拽）事务 */
  beginTransaction: (label: string) => void
  endTransaction: () => void
  undo: () => void
  redo: () => void
  clearHistory: () => void
  setWarnings: (warnings: string[]) => void
  markSaved: (path: string) => void
  reset: () => void
}

const history = new History()

function cloneDocument(doc: EditorDocument): EditorDocument {
  if (typeof structuredClone === 'function') return structuredClone(doc)
  return JSON.parse(JSON.stringify(doc)) as EditorDocument
}

function syncFlags(state: ProjectState): Pick<ProjectState, 'canUndo' | 'canRedo' | 'undoLabel' | 'redoLabel'> {
  void state
  return {
    canUndo: history.canUndo || history.undoLabel !== null,
    canRedo: history.canRedo,
    undoLabel: history.undoLabel,
    redoLabel: history.redoLabel
  }
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  document: createEmptyDocument(),
  projectPath: null,
  dirty: false,
  warnings: [],
  canUndo: false,
  canRedo: false,
  undoLabel: null,
  redoLabel: null,

  setDocument: (document, projectPath, dirty = false) => {
    history.clear()
    // 打开工程 / 导入时的兜底修复：时长小于最后一个关键帧的动画会被裁掉末尾帧、
    // 播放只在极短区间循环（表现为「动画播放不了」）。修好后标记为未保存，方便写回。
    const repaired = cloneDocument(document)
    const repairedCount = repairAnimationDurations(repaired)
    set({
      document: repaired,
      projectPath: projectPath === undefined ? get().projectPath : projectPath,
      dirty: repairedCount > 0 || dirty,
      ...syncFlags(get())
    })
  },

  update: (label, mutate) => {
    const current = get().document
    history.push(label, current)
    const draft = cloneDocument(current)
    mutate(draft)
    set({ document: draft, dirty: true, ...syncFlags(get()) })
  },

  updateSilent: (mutate) => {
    const draft = cloneDocument(get().document)
    mutate(draft)
    set({ document: draft })
  },

  beginTransaction: (label) => {
    history.begin(label, get().document)
  },

  endTransaction: () => {
    history.end()
    set({ dirty: true, ...syncFlags(get()) })
  },

  undo: () => {
    const restored = history.undo(get().document)
    if (!restored) return
    set({ document: restored, dirty: true, ...syncFlags(get()) })
  },

  redo: () => {
    const restored = history.redo(get().document)
    if (!restored) return
    set({ document: restored, dirty: true, ...syncFlags(get()) })
  },

  clearHistory: () => {
    history.clear()
    set({ ...syncFlags(get()) })
  },

  setWarnings: (warnings) => set({ warnings }),

  markSaved: (path) => set({ projectPath: path, dirty: false }),

  reset: () => {
    history.clear()
    set({
      document: createEmptyDocument(),
      projectPath: null,
      dirty: false,
      warnings: [],
      ...syncFlags(get())
    })
  }
}))

export function currentDocument(): EditorDocument {
  return useProjectStore.getState().document
}

export function projectActions() {
  return useProjectStore.getState()
}

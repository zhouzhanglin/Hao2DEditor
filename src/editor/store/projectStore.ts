import { create } from 'zustand'
import type { EditorDocument } from '@core/model/authoring'
import { createAuthoringBone, createEmptyDocument } from '@core/model/authoring'
import { History } from '../history'
import type { ProjectSnapshot } from '../history'
import { repairAnimationDurations, repairDisplayNames } from '../timeline/model'

export interface ProjectState {
  /**
   * **当前编辑的骨架**（= `skeletons[activeSkeleton]`，与它是同一份内容）。
   *
   * 面板 / 工具 / 命令 / 编解码全都只认这一个字段，所以「一个项目多个骨架」不需要
   * 改动它们 —— 切换骨架 = 换掉这个引用。
   */
  document: EditorDocument
  /**
   * 项目里的**全部骨架**：骨骼 / 插槽 / 皮肤 / 图层 / 动画都在各自骨架内，
   * 而**图片资源池由所有骨架共享**（内存里指向同一个数组，见 `shareImages`）。
   */
  skeletons: EditorDocument[]
  /** 当前骨架在 `skeletons` 里的下标 */
  activeSkeleton: number
  /**
   * **项目名**（「新建项目」弹窗里填的，不能为空）。
   *
   * 与骨架名无关：导出时图集名与输出目录都用它（`<项目名>_atlas.json` / `<项目名>/`），
   * 每个骨架各自导出成 `<骨架名>_ske.json` / `<骨架名>.hao2d`。
   */
  projectName: string
  projectPath: string | null
  dirty: boolean
  /** 最近一次编译 / 导入产生的提示 */
  warnings: string[]
  canUndo: boolean
  canRedo: boolean
  undoLabel: string | null
  redoLabel: string | null

  /** 打开工程 / 导入资源：整体替换成「只有一个骨架」的项目 */
  setDocument: (document: EditorDocument, projectPath?: string | null, dirty?: boolean) => void
  /** 打开工程：整体替换成多骨架项目（`activeSkeleton` 是当前编辑的那个） */
  setProject: (
    skeletons: EditorDocument[],
    activeSkeleton?: number,
    projectPath?: string | null,
    dirty?: boolean
  ) => void
  /** 新建一个空骨架并切过去（图片池沿用当前的，动到的是「骨架」而不是资源） */
  addSkeleton: (name?: string) => void
  /** 删除某个骨架（至少保留一个） */
  removeSkeleton: (index: number) => void
  /** 重命名某个骨架（改它的 `armatureName`） */
  renameSkeleton: (index: number, name: string) => void
  /** 切换当前编辑的骨架 */
  setActiveSkeleton: (index: number) => void
  /** 设置项目名 / 保存路径（新建项目弹窗、打开工程后调用） */
  setProjectInfo: (info: { projectName?: string; projectPath?: string | null }) => void
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

/** 新项目的默认名（新建项目弹窗也用它做预填） */
export const DEFAULT_PROJECT_NAME = 'hao2dProject'

/**
 * 给新骨架补一根 `root`：空骨架连一根骨骼都没有时，没法「选中骨骼」继续搭，
 * 插槽也必须挂在骨骼上。参数与层级树的「新建骨骼」按钮一致（长度 0.4）。
 */
function withDefaultRoot(doc: EditorDocument): EditorDocument {
  doc.bones.push(createAuthoringBone({ name: 'root', parent: '', length: 0.4 }))
  return doc
}

/** 索引夹到合法范围（空列表按 0 处理） */
function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0
  return Math.min(Math.max(0, Math.round(index)), length - 1)
}

/** 替换第 index 个骨架，返回新数组（其余项保持原引用） */
function replaceSkeleton(
  skeletons: readonly EditorDocument[],
  index: number,
  doc: EditorDocument
): EditorDocument[] {
  const next = skeletons.slice()
  next[index] = doc
  return next
}

/**
 * 图片资源池由**所有骨架共享**：把当前骨架的 `images` 指给其它骨架。
 *
 * 用同一个数组引用（而不是「改完再拷贝同步」），因为面板 / 导入 / 导出读的都是
 * `document.images` —— 共享引用能保证「在 A 骨架导入的图，切到 B 骨架立刻也在」。
 * 每次深拷贝之后（`update` / `updateSilent` / 打开工程 / 新建骨架）都要重新对齐一次，
 * 否则会退化成两个互不相干的池子。
 */
function shareImages(skeletons: EditorDocument[], active: number): EditorDocument[] {
  const pool = skeletons[active]?.images ?? []
  let changed = false
  const next = skeletons.map((skeleton, index) => {
    if (index === active || skeleton.images === pool) return skeleton
    changed = true
    return { ...skeleton, images: pool }
  })
  return changed ? next : skeletons
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

/** 项目快照（撤销用）：整份骨架列表 + 当前骨架下标 */
function snapshotOf(state: ProjectState): ProjectSnapshot {
  return { document: state.document, skeletons: state.skeletons, activeSkeleton: state.activeSkeleton }
}

/** 快照 → store 片段。深拷贝之后各骨架的图片池是各自的副本，这里重新对齐回一个池子 */
function restoreSnapshot(snapshot: ProjectSnapshot, state: ProjectState): Partial<ProjectState> {
  const index = clampIndex(snapshot.activeSkeleton, snapshot.skeletons.length)
  const list = shareImages(snapshot.skeletons.slice(), index)
  return {
    document: list[index],
    skeletons: list,
    activeSkeleton: index,
    dirty: true,
    ...syncFlags(state)
  }
}

const initialDocument = createEmptyDocument()

export const useProjectStore = create<ProjectState>((set, get) => ({
  document: initialDocument,
  skeletons: [initialDocument],
  activeSkeleton: 0,
  projectName: DEFAULT_PROJECT_NAME,
  projectPath: null,
  dirty: false,
  warnings: [],
  canUndo: false,
  canRedo: false,
  undoLabel: null,
  redoLabel: null,

  setDocument: (document, projectPath, dirty = false) => {
    history.clear()
    // 打开工程 / 导入时的兜底修复：
    // 1. 时长小于最后一个关键帧 → 末尾帧被裁、播放只在极短区间循环（「动画播放不了」）
    // 2. displayIndex 帧与附件名长度不一致 → 运行期解析到空名，显示异常（「有的图丢失」）
    // 修好后标记为未保存，方便写回。
    const repaired = cloneDocument(document)
    const repairedCount = repairAnimationDurations(repaired) + repairDisplayNames(repaired)
    const previous = get()
    /*
     * 项目名**不跟着骨架名走**。
     *
     * 导出目录、图集名与图集页名都取项目名，一旦导入资源时被骨架名覆盖，导出产物就会
     * 变成「骨骼名_0.png」这种名字（重命名工程也救不回来，因为每次导入都会再覆盖一次）。
     * 只有一上来就导入、工程还没起过名（默认名 + 从未保存）的会话才用骨架名兜底，
     * 真正落地时 `finishImport` 还会优先采用被导入文件的名字。
     */
    const keepName = previous.projectPath !== null || previous.projectName !== DEFAULT_PROJECT_NAME
    set({
      document: repaired,
      skeletons: [repaired],
      activeSkeleton: 0,
      projectName: keepName ? previous.projectName : repaired.armatureName,
      projectPath: projectPath === undefined ? get().projectPath : projectPath,
      dirty: repairedCount > 0 || dirty,
      ...syncFlags(get())
    })
  },

  setProject: (skeletons, activeSkeleton = 0, projectPath, dirty = false) => {
    history.clear()
    // 与 setDocument 同一套兜底修复，逐个骨架跑一遍
    let repairedCount = 0
    const repaired = (skeletons.length > 0 ? skeletons : [createEmptyDocument()]).map((skeleton) => {
      const copy = cloneDocument(skeleton)
      repairedCount += repairAnimationDurations(copy) + repairDisplayNames(copy)
      return copy
    })
    const index = clampIndex(activeSkeleton, repaired.length)
    const list = shareImages(repaired, index)
    set({
      document: list[index],
      skeletons: list,
      activeSkeleton: index,
      // 兜底：调用方（打开工程）随后会用文件里的 projectName 覆盖
      projectName: list[index].armatureName,
      projectPath: projectPath === undefined ? get().projectPath : projectPath,
      dirty: repairedCount > 0 || dirty,
      ...syncFlags(get())
    })
  },

  addSkeleton: (name) => {
    const state = get()
    history.push('新建骨架', snapshotOf(state))
    const created = withDefaultRoot(createEmptyDocument(name ?? `骨架 ${state.skeletons.length + 1}`))
    // 新骨架沿用当前的帧率 / 视口 / 图片池：切过去时画面不跳，图片立刻可用
    created.frameRate = state.document.frameRate
    created.editorMeta.viewport = { ...state.document.editorMeta.viewport }
    created.images = state.document.images
    const list = [...state.skeletons, created]
    set({
      document: created,
      skeletons: list,
      activeSkeleton: list.length - 1,
      dirty: true,
      ...syncFlags(state)
    })
  },

  removeSkeleton: (index) => {
    const state = get()
    // 至少留一个：项目里没有骨架时编辑器的面板 / 视口都没有可编辑对象
    if (state.skeletons.length <= 1) return
    const at = clampIndex(index, state.skeletons.length)
    history.push('删除骨架', snapshotOf(state))
    const list = state.skeletons.filter((_, i) => i !== at)
    const active =
      at === state.activeSkeleton
        ? at - 1
        : at < state.activeSkeleton
          ? state.activeSkeleton - 1
          : state.activeSkeleton
    const next = clampIndex(active, list.length)
    set({ document: list[next], skeletons: list, activeSkeleton: next, dirty: true, ...syncFlags(state) })
  },

  renameSkeleton: (index, name) => {
    const state = get()
    const at = clampIndex(index, state.skeletons.length)
    const renamed = { ...state.skeletons[at], armatureName: name }
    history.push('重命名骨架', snapshotOf(state))
    const list = replaceSkeleton(state.skeletons, at, renamed)
    set({
      document: at === state.activeSkeleton ? renamed : state.document,
      skeletons: list,
      dirty: true,
      ...syncFlags(state)
    })
  },

  setActiveSkeleton: (index) => {
    const state = get()
    const at = clampIndex(index, state.skeletons.length)
    if (at === state.activeSkeleton) return
    // 只换引用，不动数据；撤销快照里带着 activeSkeleton，所以历史不用清
    set({ document: state.skeletons[at], activeSkeleton: at })
  },

  setProjectInfo: (info) => {
    set((state) => ({
      projectName: info.projectName ?? state.projectName,
      projectPath: info.projectPath === undefined ? state.projectPath : info.projectPath
    }))
  },

  update: (label, mutate) => {
    const state = get()
    history.push(label, snapshotOf(state))
    const draft = cloneDocument(state.document)
    mutate(draft)
    set({
      document: draft,
      // 草稿要写回骨架列表（下次切换回来才不会丢改动），并重新对齐共享图片池
      skeletons: shareImages(replaceSkeleton(state.skeletons, state.activeSkeleton, draft), state.activeSkeleton),
      dirty: true,
      ...syncFlags(state)
    })
  },

  updateSilent: (mutate) => {
    const state = get()
    const draft = cloneDocument(state.document)
    mutate(draft)
    set({
      document: draft,
      skeletons: shareImages(replaceSkeleton(state.skeletons, state.activeSkeleton, draft), state.activeSkeleton)
    })
  },

  beginTransaction: (label) => {
    history.begin(label, snapshotOf(get()))
  },

  endTransaction: () => {
    history.end()
    set({ dirty: true, ...syncFlags(get()) })
  },

  undo: () => {
    const state = get()
    const restored = history.undo(snapshotOf(state))
    if (!restored) return
    set(restoreSnapshot(restored, state))
  },

  redo: () => {
    const state = get()
    const restored = history.redo(snapshotOf(state))
    if (!restored) return
    set(restoreSnapshot(restored, state))
  },

  clearHistory: () => {
    history.clear()
    set({ ...syncFlags(get()) })
  },

  setWarnings: (warnings) => set({ warnings }),

  markSaved: (path) => set({ projectPath: path, dirty: false }),

  reset: () => {
    history.clear()
    // 新项目：默认名 + 一根 root（与「新建项目」流程一致）
    const fresh = withDefaultRoot(createEmptyDocument())
    set({
      document: fresh,
      skeletons: [fresh],
      activeSkeleton: 0,
      projectName: DEFAULT_PROJECT_NAME,
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

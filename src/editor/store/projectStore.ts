import { create } from 'zustand'
import type { AuthoringImage, EditorDocument } from '@core/model/authoring'
import { ROOT_BONE_NAME, createAuthoringBone, createEmptyDocument } from '@core/model/authoring'
import { History } from '../history'
import type { ProjectSnapshot } from '../history'
import { applyAtlasSplit, deleteImage, replaceImage } from '../commands/authoringCommands'
import type { AtlasSplitPlan } from '../commands/authoringCommands'
import { repairAnimationDurations, repairDisplayNames, repairEvents } from '../timeline/model'
import { validateNestGraph } from '@core/nesting/nest'
import { t } from '@i18n'
import { useSelectionStore } from './selectionStore'

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
  /**
   * **导入外部骨架**（Spine / DragonBones）到当前工程：把一批骨架追加进 `skeletons`，
   * 切到第一个新骨架，图片池与现有骨架合并后共享（同名不同文件自动改名并改写引用）。
   * 返回新骨架的下标；传入空数组时返回当前下标。
   *
   * 与 `setProject` 的区别：那是「整份替换」（新建工程 / 打开工程），这里是「并入」——
   * 当前工程已有的骨架、项目名、保存路径都不动。
   */
  appendSkeletons: (skeletons: EditorDocument[]) => number
  /**
   * 删除某个骨架（至少保留一个）。
   *
   * 被别的骨架嵌套引用（有 armature display 的 `subArmature` 指向它）时**拒绝删除**，
   * 返回 `ok: false` + 引用位置 —— 否则父骨架里就留下一个指空的嵌套 display。
   * 调用方必须看返回值：UI 要提示原因而不是报「已删除」，AI 命令要折成 ok:false。
   */
  removeSkeleton: (index: number) => { ok: boolean; message: string }
  /** 重命名某个骨架（改它的 `armatureName`） */
  renameSkeleton: (index: number, name: string) => void
  /** 删除图片（跨所有骨架清理引用，引用它的附件退化为纯色） */
  removeImage: (name: string) => void
  /** 替换图片：保持 name 不变，更新 path / width / height */
  replaceImage: (name: string, info: { path: string; width: number; height: number }) => void
  /**
   * 图集拆碎图：图片池里用碎图顶掉图集页，并把**所有骨架**里引用它的附件改指到碎图
   * （UV 从整页坐标换算到碎图坐标），一次撤销。
   *
   * 只动文档：剪裁 / 编码 / 写盘在 `services/atlasSplit.ts`，磁盘上的原图集文件不删
   * （只是从工程里移除，用户想删自己删）。
   */
  splitAtlas: (plan: AtlasSplitPlan, images: readonly AuthoringImage[]) => void
  /** 切换当前编辑的骨架 */
  setActiveSkeleton: (index: number) => void
  /** 设置项目名 / 保存路径（新建项目弹窗、打开工程后调用） */
  setProjectInfo: (info: { projectName?: string; projectPath?: string | null }) => void
  /** 写入导出图集缩放（静默，不进历史、不标脏：纯偏好，由导出时另存工程文件落地） */
  setExportScale: (scale: number) => void
  /**
   * 切换当前皮肤（空串 / `default` 都是默认皮肤）。
   *
   * 必须**同时**维护两个口径，缺一个就会「切了皮肤、重开工程又回到 default」：
   * - `editorMeta.activeSkin`：随工程文件落盘，打开工程时回填（见 `projectIo`）；
   * - `selectionStore.skin`：视口 / 资源面板当下真正渲染用的那个。
   *
   * 与 `setExportScale` 同属「编辑器状态」：不进撤销记录、不把工程标脏。
   */
  setActiveSkin: (skin: string) => void
  /** 可撤销的编辑：mutate 在深拷贝的草稿上执行 */
  update: (label: string, mutate: (draft: EditorDocument) => void) => void
  /**
   * 命令系统专用的可撤销编辑：**撤销记录在 mutate 成功之后才写**。
   *
   * 与 `update` 的唯一差别：mutate 返回 `false` 表示「这次什么都没改」，
   * 此时既不写历史、也不替换文档。命令参数来自外部（AI / HTTP），
   * 传错名字、附件类型不对是常态，用 `update` 会留下一堆无效撤销记录。
   *
   * 返回是否真的提交了改动；mutate 抛异常时直接上抛（调用方折成 ok:false 回给 AI）。
   */
  runCommand: (label: string, mutate: (draft: EditorDocument) => boolean | void) => boolean
  /** 不可撤销的编辑（面板布局、视口状态等） */
  updateSilent: (mutate: (draft: EditorDocument) => void) => void
  /** 连续编辑（拖拽）事务 */
  beginTransaction: (label: string) => void
  endTransaction: () => void
  /**
   * 放弃当前事务：把文档恢复到 `beginTransaction` 时的快照，不产生撤销记录。
   * 供 `/batch` 批量命令中途失败时整体回滚。
   */
  rollbackTransaction: () => boolean
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
 *
 * 它是**层级结构的根**（唯一的顶层骨骼）：新画的骨骼、拖进来的图片都挂在它下面，
 * 别的节点也不能从它里面拖出去与它平级（见 hierarchyCommands 的 validateBoneMove）。
 */
function withDefaultRoot(doc: EditorDocument): EditorDocument {
  doc.bones.push(createAuthoringBone({ name: ROOT_BONE_NAME, parent: '', length: 0.4 }))
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

/**
 * 给重名的图片找个不冲突的名字，**保留扩展名**（`atlas.png` → `atlas_2.png`）。
 *
 * 不用 `uniqueName` 直接加后缀：那会得到 `atlas.png_2`，导出图集 / 资源面板里的名字都很别扭。
 */
function uniqueImageName(existing: readonly string[], name: string): string {
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  let index = 2
  while (existing.includes(`${stem}_${index}${ext}`)) index++
  return `${stem}_${index}${ext}`
}

/**
 * 追加骨架时的图片池合并（导入外部骨架用）：现有池原样保留，新骨架的图按名字并入。
 *
 * - 同名同路径 = 同一张图，直接复用，不重复入池；
 * - 同名不同文件（两个工程都有一张 `atlas.png`）**改名**成 `atlas_2.png`，
 *   改名记进 `renamed`，由调用方改写新骨架里附件的 `image` 引用 ——
 *   不改引用的话，新骨架会指向老工程的同名图（画错贴图）。
 */
function mergeImagePools(
  existing: readonly AuthoringImage[],
  additions: readonly EditorDocument[]
): { pool: AuthoringImage[]; renamed: Map<string, string> } {
  const pool = [...existing]
  const byName = new Map(pool.map((image) => [image.name, image]))
  const renamed = new Map<string, string>()
  for (const document of additions) {
    // DragonBones 一份 JSON 的多个 armature 共享同一个 images 数组：并过的图在这里会被跳过
    for (const image of document.images) {
      const current = renamed.get(image.name) ?? image.name
      const same = byName.get(current)
      if (same) {
        if (same.path === image.path) continue
        const name = uniqueImageName([...byName.keys()], current)
        renamed.set(image.name, name)
        const copy = { ...image, name }
        byName.set(name, copy)
        pool.push(copy)
        continue
      }
      byName.set(current, image)
      pool.push(image)
    }
  }
  return { pool, renamed }
}

/**
 * 加载 / 导入时的嵌套引用兜底：清掉**自引用、成环、指向不存在骨架、超深**的 `subArmature`。
 *
 * 为什么放在 store 而不是各个入口：工程文件可能被手改、导入资源也可能带脏数据，
 * 只要进到内存就必须是「可渲染」的（否则视口递归渲染会死循环）。
 * 每个环只断开第一条边，尽量保留用户数据。
 */
function sanitizeNestRefs(skeletons: EditorDocument[]): { count: number; warnings: string[] } {
  const validation = validateNestGraph(skeletons)
  const names = new Set(skeletons.map((skeleton) => skeleton.armatureName))
  const warnings: string[] = []
  const reported = new Set<string>()
  const report = (text: string): void => {
    if (reported.has(text)) return
    reported.add(text)
    warnings.push(text)
  }

  const broken = new Set<string>() // `${from}\0${to}`
  for (const edge of validation.selfReferences) {
    broken.add(`${edge.from}\u0000${edge.to}`)
    report(t('插槽「{0}」的「{1}」引用了自身骨架，已断开', [edge.slot, edge.attachment]))
  }
  for (const edge of validation.missing) {
    broken.add(`${edge.from}\u0000${edge.to}`)
    report(
      t('骨架「{0}」的插槽「{1}」引用了不存在的骨架「{2}」，已断开', [edge.from, edge.slot, edge.to])
    )
  }
  for (const cycle of validation.cycles) {
    if (cycle.length >= 2) broken.add(`${cycle[0]}\u0000${cycle[1]}`)
    report(
      t('骨架嵌套存在循环引用（{0}），已断开「{1}」里的引用', [cycle.join(' → '), cycle[0]])
    )
  }
  const tooDeep = new Set(validation.tooDeep)
  for (const name of tooDeep) report(t('骨架「{0}」的嵌套层数超过上限，相关引用已断开', name))

  let count = 0
  for (const doc of skeletons) {
    for (const skin of doc.skins) {
      for (const slot of skin.slots) {
        for (const attachment of slot.attachments) {
          if (attachment.type !== 'armature') continue
          const target = attachment.subArmature
          if (!target) continue
          const invalid = !names.has(target) || broken.has(`${doc.armatureName}\u0000${target}`) || tooDeep.has(doc.armatureName)
          if (!invalid) continue
          attachment.subArmature = ''
          count++
        }
      }
    }
  }
  return { count, warnings }
}

/** 某骨架被哪些位置引用（删除骨架前的守卫） */
function nestReferencesTo(docs: readonly EditorDocument[], name: string): string[] {
  const out: string[] = []
  for (const doc of docs) {
    if (doc.armatureName === name) continue
    for (const skin of doc.skins) {
      for (const slot of skin.slots) {
        for (const attachment of slot.attachments) {
          if (attachment.type === 'armature' && attachment.subArmature === name) {
            out.push(`${doc.armatureName} / ${slot.slot} / ${attachment.name}`)
          }
        }
      }
    }
  }
  return out
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
    // 3. 同一时间点叠了多个事件帧 → 时间轴上看不出来，播放却全部触发（「事件帧重复」）
    // 修好后标记为未保存，方便写回。
    const repaired = cloneDocument(document)
    const repairedCount =
      repairAnimationDurations(repaired) + repairDisplayNames(repaired) + repairEvents(repaired)
    const nested = sanitizeNestRefs([repaired])
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
      dirty: repairedCount > 0 || nested.count > 0 || dirty,
      warnings: nested.warnings.length > 0 ? nested.warnings : get().warnings,
      ...syncFlags(get())
    })
  },

  setProject: (skeletons, activeSkeleton = 0, projectPath, dirty = false) => {
    history.clear()
    // 与 setDocument 同一套兜底修复，逐个骨架跑一遍
    let repairedCount = 0
    const repaired = (skeletons.length > 0 ? skeletons : [createEmptyDocument()]).map((skeleton) => {
      const copy = cloneDocument(skeleton)
      repairedCount +=
        repairAnimationDurations(copy) + repairDisplayNames(copy) + repairEvents(copy)
      return copy
    })
    const index = clampIndex(activeSkeleton, repaired.length)
    const list = shareImages(repaired, index)
    // 自引用 / 环 / 缺引用一律在进入内存时断开：视口是递归渲染的，脏数据会直接死循环
    const nested = sanitizeNestRefs(list)
    set({
      document: list[index],
      skeletons: list,
      activeSkeleton: index,
      // 兜底：调用方（打开工程）随后会用文件里的 projectName 覆盖
      projectName: list[index].armatureName,
      projectPath: projectPath === undefined ? get().projectPath : projectPath,
      dirty: repairedCount > 0 || nested.count > 0 || dirty,
      warnings: nested.warnings.length > 0 ? nested.warnings : get().warnings,
      ...syncFlags(get())
    })
  },

  addSkeleton: (name) => {
    const state = get()
    history.push('新建骨架', snapshotOf(state))
    const created = withDefaultRoot(
      createEmptyDocument(name ?? t('骨架 {0}', state.skeletons.length + 1))
    )
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

  appendSkeletons: (skeletons) => {
    const state = get()
    if (skeletons.length === 0) return state.activeSkeleton
    history.push('导入骨架', snapshotOf(state))
    // 与 setProject 同一套兜底修复，只跑新增的这几个（现有骨架已经在内存里修过了）
    const additions = skeletons.map((skeleton) => {
      const copy = cloneDocument(skeleton)
      repairAnimationDurations(copy)
      repairDisplayNames(copy)
      repairEvents(copy)
      return copy
    })
    /*
     * 骨架名是嵌套引用（`attachment.subArmature`）与导出的唯一键：与现有骨架重名会让
     * 「引用谁」变得不确定（运行期按 `armatureName` 解析），导入时自动加后缀；
     * 同一批新骨架之间重名同理。改名后把这批骨架里的嵌套 display 一起改指过去。
     */
    const taken = state.skeletons.map((skeleton) => skeleton.armatureName)
    const skeletonRenames = new Map<string, string>()
    /** 改名提示：静默改用户数据最难排查，这里要和导入结果一起报到状态栏 */
    const notes: string[] = []
    for (const skeleton of additions) {
      const base = skeleton.armatureName
      if (!taken.includes(base)) {
        taken.push(base)
        continue
      }
      let suffix = 2
      while (taken.includes(`${base}_${suffix}`)) suffix++
      const name = `${base}_${suffix}`
      skeletonRenames.set(base, name)
      notes.push(t('骨架「{0}」与现有骨架重名，已重命名为「{1}」', [base, name]))
      taken.push(name)
      skeleton.armatureName = name
    }
    if (skeletonRenames.size > 0) {
      for (const skeleton of additions) {
        for (const skin of skeleton.skins) {
          for (const slot of skin.slots) {
            for (const attachment of slot.attachments) {
              if (attachment.type !== 'armature') continue
              const next = skeletonRenames.get(attachment.subArmature)
              if (next) attachment.subArmature = next
            }
          }
        }
      }
    }

    const { pool, renamed } = mergeImagePools(state.document.images, additions)
    for (const [oldName, newName] of renamed) {
      notes.push(t('图片「{0}」与现有图片重名，已重命名为「{1}」', [oldName, newName]))
    }
    for (const document of additions) {
      if (renamed.size > 0) {
        for (const skin of document.skins) {
          for (const slot of skin.slots) {
            for (const attachment of slot.attachments) {
              const next = renamed.get(attachment.image)
              if (next) attachment.image = next
            }
          }
        }
      }
      document.images = pool
    }
    // 现有骨架也指向同一个池（`shareImages` 的同一约定），否则切回旧骨架看不到新导入的图
    const list: EditorDocument[] = [
      ...state.skeletons.map((skeleton) => (skeleton.images === pool ? skeleton : { ...skeleton, images: pool })),
      ...additions
    ]
    // 新旧骨架之间也可能有嵌套引用（DragonBones 的多 armature），整份再校验一次
    const nested = sanitizeNestRefs(list)
    const notice = [...notes, ...nested.warnings]
    const index = state.skeletons.length
    set({
      document: list[index],
      skeletons: list,
      activeSkeleton: index,
      // 项目名 / 保存路径沿用当前工程：这是「并入」而不是新建工程
      dirty: true,
      warnings: notice.length > 0 ? notice : get().warnings,
      ...syncFlags(get())
    })
    return index
  },

  removeSkeleton: (index) => {
    const state = get()
    // 至少留一个：项目里没有骨架时编辑器的面板 / 视口都没有可编辑对象
    if (state.skeletons.length <= 1) return { ok: false, message: t('项目里至少保留一个骨架') }
    const at = clampIndex(index, state.skeletons.length)
    const target = state.skeletons[at]?.armatureName ?? ''
    // 被别的骨架嵌套引用时不允许删除（否则父骨架里就留下一个指空的嵌套 display）
    const referencedBy = nestReferencesTo(state.skeletons, target)
    if (referencedBy.length > 0) {
      return {
        ok: false,
        message: t('骨架「{0}」正在被引用，先删除这些嵌套 display：{1}', [
          target,
          referencedBy.join(t('、'))
        ])
      }
    }
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
    return { ok: true, message: t('已删除骨架「{0}」（图片池未动）', target) }
  },

  renameSkeleton: (index, name) => {
    const state = get()
    const at = clampIndex(index, state.skeletons.length)
    const trimmed = name.trim()
    const old = state.skeletons[at]?.armatureName ?? ''
    if (!trimmed || trimmed === old) return
    // 名字是嵌套引用的唯一键：重名会让「引用谁」变得不确定，直接拒绝
    if (state.skeletons.some((skeleton, i) => i !== at && skeleton.armatureName === trimmed)) {
      set({ warnings: [t('已存在名为「{0}」的骨架，请换一个名字', trimmed)] })
      return
    }
    history.push('重命名骨架', snapshotOf(state))
    // 跨骨架级联：所有指向旧名的 `subArmature` 一起改，否则父骨架里的引用会指空
    const list = state.skeletons.map((skeleton, i) => {
      const cascade = i !== at && skeleton.skins.some((skin) =>
        skin.slots.some((slot) => slot.attachments.some((a) => a.type === 'armature' && a.subArmature === old))
      )
      if (i !== at && !cascade) return skeleton
      const copy = cloneDocument(skeleton)
      if (i === at) copy.armatureName = trimmed
      if (cascade) {
        for (const skin of copy.skins) {
          for (const slot of skin.slots) {
            for (const attachment of slot.attachments) {
              if (attachment.type === 'armature' && attachment.subArmature === old) attachment.subArmature = trimmed
            }
          }
        }
      }
      return copy
    })
    const shared = shareImages(list, state.activeSkeleton)
    set({
      document: shared[state.activeSkeleton],
      skeletons: shared,
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

  removeImage: (name) => {
    const state = get()
    if (!state.document.images.some((image) => image.name === name)) return
    history.push('删除图片', snapshotOf(state))
    // 图片池被所有骨架共享：逐个骨架深拷贝后清理，再重新对齐回同一个池子
    const list = state.skeletons.map((skeleton) => {
      const draft = cloneDocument(skeleton)
      deleteImage(draft, name)
      return draft
    })
    const withPool = shareImages(list, state.activeSkeleton)
    set({
      document: withPool[state.activeSkeleton],
      skeletons: withPool,
      dirty: true,
      ...syncFlags(state)
    })
  },

  replaceImage: (name, info) => {
    const state = get()
    if (!state.document.images.some((image) => image.name === name)) return
    history.push('替换图片', snapshotOf(state))
    const list = state.skeletons.map((skeleton) => {
      const draft = cloneDocument(skeleton)
      replaceImage(draft, name, info)
      return draft
    })
    const withPool = shareImages(list, state.activeSkeleton)
    set({
      document: withPool[state.activeSkeleton],
      skeletons: withPool,
      dirty: true,
      ...syncFlags(state)
    })
  },

  splitAtlas: (plan, images) => {
    const state = get()
    if (!state.document.images.some((image) => image.name === plan.atlas)) return
    history.push('图集转碎图', snapshotOf(state))
    // 与 removeImage / replaceImage 同一套路：附件在各骨架里各有一份，逐个深拷贝后改写
    const list = state.skeletons.map((skeleton) => {
      const draft = cloneDocument(skeleton)
      applyAtlasSplit(draft, plan, images)
      return draft
    })
    const withPool = shareImages(list, state.activeSkeleton)
    set({
      document: withPool[state.activeSkeleton],
      skeletons: withPool,
      dirty: true,
      ...syncFlags(state)
    })
  },

  setProjectInfo: (info) => {
    set((state) => ({
      projectName: info.projectName ?? state.projectName,
      projectPath: info.projectPath === undefined ? state.projectPath : info.projectPath
    }))
  },

  setExportScale: (scale) => {
    const state = get()
    const list = state.skeletons.map((skeleton) => ({
      ...skeleton,
      editorMeta: { ...skeleton.editorMeta, exportScale: scale }
    }))
    set({ skeletons: list, document: list[state.activeSkeleton] })
  },

  setActiveSkin: (raw) => {
    // `default` 在工程文件里就写成空串（`editorMeta.activeSkin` 的既有约定，见 createDefaultMeta）
    const skin = raw === 'default' ? '' : raw
    // 文档没变就别白克隆一份（点同一个皮肤不产生任何写入）
    if (get().document.editorMeta.activeSkin !== skin) {
      get().updateSilent((draft) => {
        draft.editorMeta.activeSkin = skin
      })
    }
    useSelectionStore.getState().select({ skin })
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

  runCommand: (label, mutate) => {
    const state = get()
    const before = snapshotOf(state)
    const draft = cloneDocument(state.document)
    /*
     * 先在草稿上跑完再决定要不要记账。
     * 抛异常时直接上抛：撤销栈没动过，文档也没被替换，编辑器保持原样。
     */
    if (mutate(draft) === false) return false
    history.push(label, before)
    set({
      document: draft,
      // 同 update：草稿写回骨架列表，并重新对齐共享图片池
      skeletons: shareImages(replaceSkeleton(state.skeletons, state.activeSkeleton, draft), state.activeSkeleton),
      dirty: true,
      ...syncFlags(state)
    })
    return true
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

  rollbackTransaction: () => {
    const snapshot = history.takePending()
    if (!snapshot) return false
    set(restoreSnapshot(snapshot, get()))
    return true
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

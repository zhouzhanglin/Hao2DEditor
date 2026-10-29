import { useCallback, useEffect, useRef, useState } from 'react'
import DockLayout from './layout/DockLayout'
import Splitter from './layout/Splitter'
import MenuBar from './layout/MenuBar'
import SkeletonBar from './layout/SkeletonBar'
import StatusBar from './panels/StatusBar'
import InspectorPanel from './panels/InspectorPanel'
import AssetPanel from './panels/AssetPanel'
import SlotOrderPanel from './panels/SlotOrderPanel'
import CurvePanel from './panels/CurvePanel'
import KeyframeValueBar from './panels/KeyframeValueBar'
import TimelinePanel from './timeline/TimelinePanel'
import HierarchyTree from './tree/HierarchyTree'
import ViewportCanvas from './viewport/ViewportCanvas'
import ModeSwitch from './viewport/ModeSwitch'
import MeshSubtoolBar from './viewport/MeshSubtoolBar'
import WeightSubtoolBar from './viewport/WeightSubtoolBar'
import PropertyKeyBar from './viewport/PropertyKeyBar'
import ViewportOverlays from './viewport/ViewportOverlays'
import ViewportTools from './viewport/ViewportTools'
import PanelShell from './widgets/PanelShell'
import { pickAnimationForAnimate, useModeStore } from '@editor/store/modeStore'
import type { EditorMode } from '@editor/store/modeStore'
import { useProjectStore } from '@editor/store/projectStore'
import { executeCommand } from '@editor/commands'
import { createSampleDocument } from '@core/sample'
import { useSelectionStore } from '@editor/store/selectionStore'
import { isMeshEditTool, useToolStore } from '@editor/store/toolStore'
import type { EditorTool, GizmoMode } from '@editor/store/toolStore'
import { useTimelineStore } from '@editor/store/timelineStore'
import { playheadTime } from '@editor/store/playheadStore'
import { useShallow } from 'zustand/react/shallow'
import { t, useLocale } from '@i18n'

/** W/E/R/T → 骨骼变换工具（与小坐标轴工具条从上到下一致） */
const GIZMO_KEYS: Record<string, GizmoMode> = { w: 'move', e: 'rotate', r: 'scale', t: 'shear' }

/** 变换工具名（随语言切换，故做成函数而非模块级常量表） */
function gizmoLabel(mode: GizmoMode): string {
  return t({ move: '移动', rotate: '旋转', scale: '缩放', shear: '斜切' }[mode])
}

/** 状态栏里的视口统计（见下面轮询：值不变时必须返回同一个对象） */
interface ViewportStats {
  bones: number
  slots: number
  constraints: number
  vertices: number
  triangles: number
  texturesLoaded: number
  texturesTotal: number
}

/**
 * 按键逐个比较（而不是手写字段列表）：以后往 `ViewportStats` 里加字段，
 * 比较会自动覆盖 —— 漏字段的后果就是「数字变了状态栏不更新」，那是很难发现的坑。
 */
function sameViewportStats(a: ViewportStats, b: ViewportStats): boolean {
  const keys = Object.keys(a) as Array<keyof ViewportStats>
  for (const key of keys) {
    if (a[key] !== b[key]) return false
  }
  return true
}

/** 当前焦点是否在可编辑文本元素内（输入框 / 文本域 / contentEditable） */
function activeEditableElement(): HTMLElement | null {
  const el = typeof document !== 'undefined' ? document.activeElement : null
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el
  if (el instanceof HTMLElement && el.isContentEditable) return el
  return null
}

/**
 * V/B/M/G/D → 编辑工具（与视口工具面板一致）。
 * M 与 D 是同一个顶点工具的两种模式别名：Pose 态叫「网格」、Animate 态叫「FFD 顶点」。
 */
const TOOL_KEYS: Record<string, EditorTool> = {
  v: 'select',
  p: 'pose',
  b: 'bone',
  m: 'ffd',
  g: 'weight',
  d: 'ffd',
  n: 'mask'
}
/** 编辑工具名与用途说明（随语言切换，故做成函数而非模块级常量表） */
function toolLabel(tool: EditorTool): string {
  return t(
    {
      select: '选择',
      pose: 'Pose（拖顶点改贴图 / 拖骨骼改绑定）',
      bone: '画骨骼（拖拽连续绑定）',
      weight: '权重刷',
      ffd: '网格 / FFD 顶点',
      mask: '遮罩（多边形裁剪）'
    }[tool]
  )
}

/** 左下「资源与皮肤」面板的初始高度与拖拽范围（高度可拖长，图片多时不用只靠滚动） */
const ASSET_PANEL_HEIGHT = 190
const ASSET_PANEL_MIN = 120
const ASSET_PANEL_MAX = 520
const ASSET_PANEL_KEY = 'hao2d:asset-panel-height'

/** 「slot 层级」面板高度（显示 / 调整插槽绘制顺序，Animate 态写绘制顺序帧） */
const SLOT_ORDER_HEIGHT = 170
const SLOT_ORDER_MIN = 90
const SLOT_ORDER_MAX = 420
const SLOT_ORDER_KEY = 'hao2d:slot-order-height'

/** Animate 态左栏「曲线」面板高度（占原「资源与皮肤」的位置，独立记忆） */
const CURVE_PANEL_HEIGHT = 250
const CURVE_PANEL_MIN = 150
const CURVE_PANEL_MAX = 560
const CURVE_PANEL_KEY = 'hao2d:curve-panel-height'

function loadPanelHeight(key: string, fallback: number, min: number, max: number): number {
  if (typeof localStorage === 'undefined') return fallback
  const stored = Number(localStorage.getItem(key))
  if (!Number.isFinite(stored) || stored <= 0) return fallback
  return Math.min(max, Math.max(min, stored))
}
import { getPlatform } from '@editor/platform'
import { hasExternalFiles } from '@ui/widgets/dragDrop'
import { setActiveScene, getActiveScene } from '@editor/activeScene'
import type { EditorScene } from '@editor/scene'
import {
  createProjectAt,
  importDragonBonesFlow,
  importImagesFlow,
  importSpineFlow,
  lastProject,
  openProject,
  openProjectAt,
  saveProject,
  setImportTargetDialogOpener
} from '@editor/services/projectIo'
import type { ImportTarget } from '@editor/services/projectIo'
import ExportDialog from '@ui/widgets/ExportDialog'
import type { ExportMode } from '@ui/widgets/ExportDialog'
import NewProjectDialog from '@ui/widgets/NewProjectDialog'
import SettingsDialog from '@ui/widgets/SettingsDialog'
import AiIntegrationDialog from '@ui/widgets/AiIntegrationDialog'
import PsdImportDialog from '@ui/widgets/PsdImportDialog'
import StageDialog from '@ui/widgets/StageDialog'
import ImportTargetDialog from '@ui/widgets/ImportTargetDialog'
import { importPsdLayers, pickAndParsePsd, setPsdDialogOpener } from '@editor/services/psdImport'
import type { ParsedPsd } from '@importers/psdImport'
import { deleteSelectedTrack, keyframeNow, removeSelectedKeys } from '@editor/timeline/actions'
import { PPU, deleteMeshVertex } from '@editor/commands/authoringCommands'
import { deleteSelectedMaskPoint, undoMaskDraftPoint, undoMeshBoundaryPoint } from '@editor/tools/authoringTools'
import { copySelection, pasteSelection, duplicateSelection } from '@editor/commands/clipboardCommands'

export default function App() {
  // 订阅界面语言：切换语言时整棵子树重渲染，所有 t() 重新求值
  useLocale()
  const mode = useModeStore((s) => s.mode)
  const setModeRaw = useModeStore((s) => s.setMode)
  const doc = useProjectStore((s) => s.document)
  const projectName = useProjectStore((s) => s.projectName)
  const projectPath = useProjectStore((s) => s.projectPath)
  const dirty = useProjectStore((s) => s.dirty)
  const warnings = useProjectStore((s) => s.warnings)
  const selection = useSelectionStore()
  const tools = useToolStore()
  // 细粒度订阅：App 只用这三个字段 + 三个 action。
  // 原来订阅整个 store —— 擦洗时每次都把整棵树（含所有面板）重渲染一遍
  const timeline = useTimelineStore(
    useShallow((s) => ({
      currentAnimation: s.currentAnimation,
      selectedKeys: s.selectedKeys,
      selectedTrack: s.selectedTrack,
      setAnimation: s.setAnimation,
      setPlaying: s.setPlaying,
      togglePlaying: s.togglePlaying
    }))
  )

  const [hint, setHint] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState<string | null>(null)
  const [zoom, setZoom] = useState(100)
  const [stats, setStats] = useState<ViewportStats>({
    bones: 0,
    slots: 0,
    constraints: 0,
    vertices: 0,
    triangles: 0,
    texturesLoaded: 0,
    texturesTotal: 0
  })
  const [assetHeight, setAssetHeight] = useState(() => loadPanelHeight(ASSET_PANEL_KEY, ASSET_PANEL_HEIGHT, ASSET_PANEL_MIN, ASSET_PANEL_MAX))
  const [slotOrderHeight, setSlotOrderHeight] = useState(() => loadPanelHeight(SLOT_ORDER_KEY, SLOT_ORDER_HEIGHT, SLOT_ORDER_MIN, SLOT_ORDER_MAX))
  const [curveHeight, setCurveHeight] = useState(() => loadPanelHeight(CURVE_PANEL_KEY, CURVE_PANEL_HEIGHT, CURVE_PANEL_MIN, CURVE_PANEL_MAX))
  /** 导出弹窗（选目录 / 调图集缩放 / 预览）：null = 未打开 */
  const [exportMode, setExportMode] = useState<ExportMode | null>(null)
  /** 全局设置弹窗（与工程无关、跨工程保留）：false = 未打开 */
  const [settingsOpen, setSettingsOpen] = useState(false)
  /** AI 接入弹窗：false = 未打开 */
  const [aiOpen, setAiOpen] = useState(false)
  /** 「导入 PSD」弹窗：null = 未打开；解析结果（图层树 + 每层画布）在这里暂存 */
  const [psdImport, setPsdImport] = useState<ParsedPsd | null>(null)
  /** 舞台参考图弹窗 */
  const [stageOpen, setStageOpen] = useState(false)

  // PSD 弹窗的统一打开入口：「导入 PSD」菜单 / 「导入图片」选到 .psd / 拖入 .psd 都经服务层回调到这里
  useEffect(() => {
    setPsdDialogOpener(setPsdImport)
    return () => setPsdDialogOpener(null)
  }, [])

  /**
   * 「导入到哪儿」弹窗（Spine / DragonBones）：
   * `resolve` 就是服务层 `importSpineFlow` / `importDragonBonesFlow` 里那个 Promise 的回调 ——
   * 选中或关闭即兑现（null = 取消）。
   */
  const [importTargetRequest, setImportTargetRequest] = useState<{
    kind: string
    resolve: (target: ImportTarget | null) => void
  } | null>(null)

  // 与服务层共用同一个弹窗：菜单、拖入都经这个 opener 打开（同 PSD 那套）
  useEffect(() => {
    setImportTargetDialogOpener(
      (kind) =>
        new Promise<ImportTarget | null>((resolve) => {
          setImportTargetRequest({ kind, resolve })
        })
    )
    return () => setImportTargetDialogOpener(null)
  }, [])

  /** 结束一次「导入到哪儿」询问：null = 取消（导入流程会返回「已取消导入」） */
  const settleImportTarget = useCallback(
    (target: ImportTarget | null) => {
      importTargetRequest?.resolve(target)
      setImportTargetRequest(null)
    },
    [importTargetRequest]
  )

  // TEMP-WIKI-SHOT: 截图调试钩子，截完即删
  useEffect(() => {
    ;(window as unknown as Record<string, unknown>).__hao2d = {
      loadSample: () => useProjectStore.getState().setDocument(createSampleDocument(), null, false),
      cmd: (name: string, args?: unknown) => executeCommand(name, args),
      openImport: (kind: string) => setImportTargetRequest({ kind, resolve: () => {} }),
    }
  }, [])

  const booted = useRef(false)

  const flash = useCallback((message: string) => {
    setHint(message)
    window.setTimeout(() => setHint(undefined), 2600)
  }, [])

  /** 拖拽左侧分隔条：向上拖（delta < 0）把面板拉高，并记住高度 */
  const resizeAssetPanel = useCallback((delta: number) => {
    setAssetHeight((previous) => {
      const next = Math.min(ASSET_PANEL_MAX, Math.max(ASSET_PANEL_MIN, previous - delta))
      if (typeof localStorage !== 'undefined') localStorage.setItem(ASSET_PANEL_KEY, String(Math.round(next)))
      return next
    })
  }, [])

  const resizeSlotOrderPanel = useCallback((delta: number) => {
    setSlotOrderHeight((previous) => {
      const next = Math.min(SLOT_ORDER_MAX, Math.max(SLOT_ORDER_MIN, previous - delta))
      if (typeof localStorage !== 'undefined') localStorage.setItem(SLOT_ORDER_KEY, String(Math.round(next)))
      return next
    })
  }, [])

  /** Animate 态左栏分隔条：拖的是「曲线」面板高度（与「资源与皮肤」各自记忆） */
  const resizeCurvePanel = useCallback((delta: number) => {
    setCurveHeight((previous) => {
      const next = Math.min(CURVE_PANEL_MAX, Math.max(CURVE_PANEL_MIN, previous - delta))
      if (typeof localStorage !== 'undefined') localStorage.setItem(CURVE_PANEL_KEY, String(Math.round(next)))
      return next
    })
  }, [])

  // 「重置布局」把面板高度一并复位，和其它分栏保持一致
  useEffect(() => {
    const reset = (): void => {
      setAssetHeight(ASSET_PANEL_HEIGHT)
      setSlotOrderHeight(SLOT_ORDER_HEIGHT)
      setCurveHeight(CURVE_PANEL_HEIGHT)
    }
    window.addEventListener('hao2d:reset-layout', reset)
    return () => window.removeEventListener('hao2d:reset-layout', reset)
  }, [])

  // 工程切换（打开 / 最近列表 / 拖入 .hao2d.proj）后重置视口：
  // 上个会话的缩放与偏移若残留，屏幕中心就不再是世界原点，拖图落点会和「看到的原点」对不上
  const viewResetForPath = useRef<string | null | undefined>(undefined)
  /** 视口重置到「原点居中 + 适配内容」：新建 / 打开工程后调用，避免缩放偏移残留 */
  const resetSceneView = useCallback(() => {
    getActiveScene()?.fit()
  }, [])
  useEffect(() => {
    if (viewResetForPath.current === undefined) {
      // 首次挂载不重置（场景自己会做初始适配），只记录基准
      viewResetForPath.current = projectPath
      return
    }
    if (viewResetForPath.current === projectPath) return
    viewResetForPath.current = projectPath
    resetSceneView()
  }, [projectPath, resetSceneView])

  /**
   * 骨架切换 / 新建 / 删除时的收尾。
   *
   * 选中项、待绑定状态、时间轴动画名、视口都指向**旧骨架**里的对象或名字，
   * 不清掉会出现「选中的骨骼已经不存在」这类幽灵状态。
   */
  const resetForSkeletonChange = useCallback(() => {
    // 皮肤是**每个骨架各记一套**的（`editorMeta.activeSkin`）：`clear` 会保留上一套皮肤名，
    // 切过来得换成新骨架自己的，否则切骨架后视口显示的还是旧骨架的皮肤
    const skin = useProjectStore.getState().document.editorMeta.activeSkin
    useSelectionStore.getState().clear()
    useSelectionStore.getState().select({ skin })
    useToolStore.getState().setPendingWeightBone(null)
    useTimelineStore.getState().setAnimation(null)
    resetSceneView()
  }, [resetSceneView])

  const switchSkeleton = useCallback(
    (index: number) => {
      const store = useProjectStore.getState()
      if (index === store.activeSkeleton) return
      const name = store.skeletons[index]?.armatureName ?? String(index)
      store.setActiveSkeleton(index)
      resetForSkeletonChange()
      flash(t('已切换到骨架「{0}」', name))
    },
    [flash, resetForSkeletonChange]
  )

  const addSkeleton = useCallback(() => {
    useProjectStore.getState().addSkeleton()
    resetForSkeletonChange()
    const name = useProjectStore.getState().document.armatureName
    flash(t('已新建骨架「{0}」：图片池与其它骨架共享', name))
  }, [flash, resetForSkeletonChange])

  const renameSkeleton = useCallback(
    (index: number, name: string) => {
      useProjectStore.getState().renameSkeleton(index, name)
      flash(t('骨架已重命名为「{0}」', name))
    },
    [flash]
  )

  const removeSkeleton = useCallback(
    (index: number) => {
      const store = useProjectStore.getState()
      if (store.skeletons.length <= 1) {
        flash(t('项目里至少保留一个骨架'))
        return
      }
      // 被别的骨架嵌套引用时 store 会拒绝删除：照实提示原因，且不做「切换骨架」那套收尾
      // （停播 / 清选中 / 重置视口）。以前不看返回值，明明没删也报「已删除」，还会把编辑状态清掉
      const result = store.removeSkeleton(index)
      if (!result.ok) {
        flash(result.message)
        return
      }
      resetForSkeletonChange()
      flash(result.message)
    },
    [flash, resetForSkeletonChange]
  )

  /**
   * 切换 Pose / Animate 的**唯一入口**（Tab、菜单命令、视口左上角的 ModeSwitch 都走这里），
   * 内部连带完成「当前动画」的进出场，否则视口会挂着动画继续按当前帧求值：
   *
   * - 进 Animate：手头没有选中的动画时，恢复上次离开时选的那个（其次第一个；
   *   都没有则保持「（未选择动画）」）。已有选中就不动，避免覆盖用户手选。
   * - 出 Animate：先记住当前动画、把时间轴切回「（未选择动画）」，再切 Pose。
   * - 绑骨骼 / 权重刷改的是绑定姿态，Animate 下视口面板不显示它们：切过去时把工具
   *   收回「选择」，避免留下一个看不见却还在吃鼠标的工具；FFD 在动画态合法，不回收。
   */
  const setMode = useCallback(
    (next: EditorMode): void => {
      const timelineState = useTimelineStore.getState()
      const modeState = useModeStore.getState()
      if (next === 'animate') {
        if (!timelineState.currentAnimation) {
          // 动画列表从 store 现取：本回调是 useCallback，闭包里的 doc 可能过期
          const picked = pickAnimationForAnimate(
            useProjectStore.getState().document.animations.map((item) => item.name),
            modeState.lastAnimation
          )
          if (picked) timelineState.setAnimation(picked)
        }
        setModeRaw('animate')
        const tool = useToolStore.getState().tool
        if (tool !== 'select' && tool !== 'ffd') {
          useToolStore.getState().setTool('select')
          flash(t('Animate 状态已切回选择工具（FFD 顶点仍可用）'))
        }
        return
      }
      modeState.setLastAnimation(timelineState.currentAnimation)
      timelineState.setAnimation(null)
      setModeRaw('pose')
    },
    [flash, setModeRaw]
  )

  /**
   * 首次进入：不再载入内置示例，而是**自动打开上次的工程**。
   * 最近列表由主进程持久化（打开与保存都会写入），这里只取第一条并确认文件还在；
   * 没有历史、或文件已被移动/删除时保持空白工程，用户从「新建 / 打开 / 导入」开始。
   */
  useEffect(() => {
    if (booted.current) return
    booted.current = true
    void (async () => {
      const path = await lastProject()
      if (!path) {
        flash(t('新建空白工程：可导入图片或 Spine / DragonBones 资源开始'))
        return
      }
      const result = await openProjectAt(path)
      flash(result.ok ? t('已打开上次的工程：{0}', result.message.replace(/^已打开\s*/, '')) : result.message)
    })()
  }, [flash])

  const onSceneReady = useCallback(
    (scene: EditorScene) => {
      setActiveScene(scene)
      scene.setTint({ r: 1, g: 1, b: 1, a: 1 })
    },
    []
  )

  // 轮询视口统计（不在每帧触发 React 重渲染）
  useEffect(() => {
    const timer = window.setInterval(() => {
      const scene = getActiveScene()
      if (!scene) return
      const mesh = scene.meshResult
      const images = useProjectStore.getState().document.images
      const next: ViewportStats = {
        bones: scene.runtime?.asset.bones.length ?? 0,
        slots: scene.runtime?.asset.slots.length ?? 0,
        constraints: scene.runtime?.asset.constraints.length ?? 0,
        vertices: mesh?.vertexCount ?? 0,
        triangles: mesh ? Math.floor(mesh.groups.reduce((sum, g) => sum + g.indexCount, 0) / 3) : 0,
        // 纹理就绪度：缺图时视口会把附件画成白色，这里直接暴露出来
        // （只统计工程里的图片，仓库里可能还留着已删图或探针加载的纹理）
        texturesLoaded: images.filter((image) => scene.textures.has(image.name)).length,
        texturesTotal: images.length
      }
      /*
       * **值没变就返回同一个对象**，让 React 直接 bailout。
       *
       * `setStats` 传新对象时 React 无从跳过 —— 而 App 是根组件，一次 set 会把整棵 UI
       * 连同 `InspectorPanel` / `HierarchyTree` / `DopeSheet`（几十行轨道、上千个关键帧节点）
       * 全部重渲染一遍。播放时这些统计根本不变化（骨架数、顶点数、三角形数都是静态的），
       * 于是每 250ms 白掉一次帧 —— 表现就是「动画在走，但每隔几百毫秒顿一下」。
       */
      setStats((prev) => (sameViewportStats(prev, next) ? prev : next))
      /*
       * 缩放读数 = **屏幕像素 ÷ 图像像素**，所以要先除 PPU。
       *
       * `viewport.zoom` 的单位是「每个世界单位画多少屏幕像素」，而 1 世界单位 = PPU(=100)
       * 图像像素（见 importers/uv 与 Viewport 的空场景默认值）—— 100% 表示 1 图像像素
       * 正好画 1 屏幕像素。直接 `zoom * 100` 会把「像素/单位」当成百分比，读数大 100 倍。
       */
      // 同一个数值时 React 会自动 bailout（Object.is），不需要额外比较
      setZoom(Math.round((scene.viewport.zoom / PPU) * 100))
    }, 250)
    return () => window.clearInterval(timer)
  }, [])

  // 编译告警提示
  const lastWarnings = useRef<string>('')
  useEffect(() => {
    if (warnings.length === 0) return
    const joined = warnings.join('|')
    if (joined === lastWarnings.current) return
    lastWarnings.current = joined
    flash(warnings[0])
  }, [warnings, flash])

  /** 统一的异步命令执行：显示进度、结束后回显结果（失败只提示，不改动当前工程） */
  const run = useCallback(
    (task: Promise<{ ok: boolean; message: string }> | { ok: boolean; message: string }, label?: string) => {
      setBusy(label ?? t('处理中…'))
      return Promise.resolve(task)
        .then((result) => {
          if (result.message) flash(result.message)
        })
        .finally(() => setBusy(null))
    },
    [flash]
  )

  /** 「导入 PSD」弹窗确认：先关弹窗再导入（run 负责进度与结果提示） */
  const confirmPsdImport = useCallback(
    (selectedIds: ReadonlySet<string>, addToScene: boolean) => {
      const parsed = psdImport
      if (!parsed) return
      setPsdImport(null)
      void run(importPsdLayers(parsed, selectedIds, addToScene), t('正在导入 PSD…'))
    },
    [psdImport, run]
  )

  /** 「新建项目」弹窗：项目名与保存位置都要用户确认（项目名不能为空） */
  const [newProjectOpen, setNewProjectOpen] = useState(false)

  /** 弹窗确认：清空工程 → 记住项目名与保存位置 → 立刻写出工程文件 → 回 Pose 态 + 视口复位 */
  const createProject = useCallback(
    (name: string, dir: string, frameRate?: number) => {
      setNewProjectOpen(false)
      const task = createProjectAt(name, dir, frameRate)
      run(task, t('正在新建项目…'))
      task.then((result) => {
        if (!result.ok) return
        // 新建后回到 Pose（绑定）态，视口原点居中、缩放 100%（空场景默认即 PPU）
        setMode('pose')
        resetSceneView()
      })
    },
    [run, resetSceneView, setMode]
  )

  const handleCommand = useCallback(
    (command: string) => {
      switch (command) {
        case 'project:new':
          setNewProjectOpen(true)
          return
        case 'project:open':
          run(openProject()).then(resetSceneView)
          return
        case 'project:save':
          run(saveProject(false))
          return
        case 'project:saveAs':
          run(saveProject(true))
          return
        case 'project:importSpine':
          run(importSpineFlow(), t('正在导入 Spine 资源…'))
          return
        case 'project:importDragonBones':
          run(importDragonBonesFlow(), t('正在导入 DragonBones 资源…'))
          return
        case 'project:importImages':
          run(importImagesFlow(), t('正在导入图片…'))
          return
        case 'project:importPsd':
          run(pickAndParsePsd(), t('正在读取 PSD…'))
          return
        case 'project:exportRuntime':
          // 两个导出命令都走弹窗：选目录、调图集缩放 / 页尺寸、先看预览再导出
          setExportMode('runtime')
          return
        case 'project:exportHao2d':
          setExportMode('unity')
          return
        case 'project:exportSpine':
          setExportMode('spine')
          return
        case 'app:settings':
          setSettingsOpen(true)
          return
        case 'app:aiIntegration':
          setAiOpen(true)
          return
        case 'edit:undo': {
          /*
           * 「自己绘制边界」画到一半：这一下撤销的是**上一个边界点**（不是文档命令）。
           * 那几个点只是临时预览、不进历史，而此刻历史栈顶往往是「转为网格」这类把网格造出来的
           * 命令 —— 真撤销掉，正在画的边界就没了依附的网格。所以这个状态下整条撤销都先问它
           *（连点都没落下时也吃掉，只提示一句）。
           */
          const scene = getActiveScene()
          // 遮罩草稿点 / 网格边界草稿点都只是视口预览，优先于文档撤销
          if (scene && undoMaskDraftPoint(scene, flash)) return
          if (scene && undoMeshBoundaryPoint(scene, flash)) return
          useProjectStore.getState().undo()
          flash(t('已撤销'))
          return
        }
        case 'edit:redo':
          useProjectStore.getState().redo()
          flash(t('已重做'))
          return
        case 'edit:delete': {
          const scene = getActiveScene()
          // 遮罩工具选中控制点时，Delete / Backspace 删除该点
          if (scene && deleteSelectedMaskPoint(scene, flash)) return
          flash(t('删除操作请使用层级树里的删除按钮'))
          return
        }
        case 'edit:copy': {
          // 焦点在输入框：交给浏览器原生文本复制，避免破坏文本编辑
          if (activeEditableElement()) {
            document.execCommand('copy')
            return
          }
          const count = copySelection()
          if (count > 0) flash(t('已复制 {0} 项', count))
          return
        }
        case 'edit:paste': {
          if (activeEditableElement()) {
            document.execCommand('paste')
            return
          }
          const count = pasteSelection()
          flash(count > 0 ? t('已粘贴 {0} 项', count) : t('没有可粘贴的内容'))
          return
        }
        case 'edit:duplicate': {
          if (activeEditableElement()) return
          const count = duplicateSelection()
          if (count > 0) flash(t('已复制生成 {0} 项', count))
          return
        }
        case 'edit:selectAll': {
          if (activeEditableElement()) {
            document.execCommand('selectAll')
            return
          }
          const doc = useProjectStore.getState().document
          if (doc.bones.length > 0) useSelectionStore.getState().selectBones(doc.bones.map((b) => b.name))
          return
        }
        case 'view:fitViewport':
          getActiveScene()?.fit()
          flash(t('已适配视野'))
          return
        case 'view:resetLayout':
          window.dispatchEvent(new Event('hao2d:reset-layout'))
          return
        case 'mode:toggle':
          // 联动都在 setMode 里（动画进出场 + 工具回收），这里只决定切到哪一边
          setMode(mode === 'pose' ? 'animate' : 'pose')
          return
        case 'anim:playPause': {
          if (mode !== 'animate') {
            flash(t('播放控制仅在 Animate 状态可用（Tab 切换）'))
            return
          }
          const timeline = useTimelineStore.getState()
          if (!timeline.currentAnimation) {
            // 未选动画时点播放：自动选中第一个动画，避免「点了没反应」
            if (doc.animations.length === 0) {
              flash(t('当前工程还没有动画，可点时间轴上的「+ 动画」新建'))
              return
            }
            timeline.setAnimation(doc.animations[0].name)
            flash(t('已自动选择动画「{0}」', doc.animations[0].name))
            timeline.setPlaying(true)
            return
          }
          timeline.togglePlaying()
          return
        }
        // 菜单发的是 anim:keySelected（见 menuTemplate），快捷键 K 发的是 anim:keyframe，同一实现
        case 'anim:keyframe':
        case 'anim:keySelected': {
          if (mode !== 'animate') {
            flash(t('打关键帧只在 Animate 状态可用（Tab 切换）'))
            return
          }
          const result = keyframeNow()
          flash(result.message)
          return
        }
        case 'anim:deleteKeys': {
          const result = removeSelectedKeys()
          if (result.ok) flash(result.message)
          return
        }
        case 'anim:nextFrame':
        case 'anim:prevFrame': {
          if (mode !== 'animate') return
          const state = useTimelineStore.getState()
          const scene = getActiveScene()
          const duration = scene?.duration ?? 1
          const step = (doc.frameRate > 0 ? 1 / doc.frameRate : 1 / 30) * (command === 'anim:nextFrame' ? 1 : -1)
          // 用播放头时钟取当前位置：主 store 的 time 在播放期间是低频的，
          // 拿它会从「上次同步的位置」出发，逐帧会跳错
          const next = Math.max(0, Math.min(duration, playheadTime() + step))
          // 不要截到 4 位小数：1.1333333 → 1.1333 会落在该帧关键帧时间之前，采样退回上一帧
          state.setTime(next)
          return
        }
        default:
          flash(t('该命令将在对应模块接入后生效'))
      }
    },
    [doc.frameRate, flash, mode, run, setMode, resetSceneView]
  )

  useEffect(() => {
    globalThis.document.title = `${projectName}${dirty ? ' *' : ''} — Hao2D Editor`
    return getPlatform().onMenuCommand(handleCommand)
  }, [projectName, dirty, handleCommand])

  // 快捷键
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable === true
      if (typing) return

      const mod = event.metaKey || event.ctrlKey
      if (event.key === 'Escape') {
        // 结束「绑定骨骼」状态：那期间视口的点击会被拾取骨骼吃掉
        if (useToolStore.getState().pendingWeightBone) {
          useToolStore.getState().setPendingWeightBone(null)
          flash(t('已结束绑定骨骼'))
        } else if (useSelectionStore.getState().vertices.length > 0) {
          // 取消顶点选择（与 Spine 权重工具的 space / esc 同义；这里 space 已经是播放/暂停）
          useSelectionStore.getState().selectVertices([])
          flash(t('已取消顶点选择'))
        }
      } else if (event.key === 'Tab') {
        event.preventDefault()
        handleCommand('mode:toggle')
      } else if (event.code === 'Space') {
        event.preventDefault()
        handleCommand('anim:playPause')
      } else if (event.key === 'f' || event.key === 'F') {
        handleCommand('view:fitViewport')
      } else if (event.key === 'k' || event.key === 'K') {
        handleCommand('anim:keyframe')
      } else if (!mod && TOOL_KEYS[event.key.toLowerCase()]) {
        // V/B/S/M/G/D/C：切换编辑工具（与视口工具面板、顶部工具条一致）
        const next = TOOL_KEYS[event.key.toLowerCase()]
        useToolStore.getState().setTool(next)
        flash(t('工具：{0}（{1}）', [toolLabel(next), event.key.toUpperCase()]))
      } else if (!mod && GIZMO_KEYS[event.key.toLowerCase()]) {
        // W/E/R/T：切换骨骼变换小坐标轴（移动 / 旋转 / 缩放 / 斜切）
        const next = GIZMO_KEYS[event.key.toLowerCase()]
        const before = useToolStore.getState().tool
        useToolStore.getState().setGizmo(next)
        const switched = useToolStore.getState().tool !== before
        flash(t('骨骼工具：{0}（{1}）{2}', [gizmoLabel(next), event.key.toUpperCase(), switched ? t('· 已退出绘制工具') : '']))
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        // 优先：视口里选中了网格顶点（网格 / FFD 工具点选）→ 删顶点。
        // 顶点属于**绑定网格**，只在 Pose 态能改（Animate 态拖顶点写的是 FFD 帧，顶点本身没动）
        const pick = useSelectionStore.getState()
        if (pick.vertices.length > 0) {
          if (useModeStore.getState().mode !== 'pose') {
            flash(t('删除顶点改的是绑定网格：请切到 Pose 状态'))
          } else {
            // 选中的是**共享缓冲**下标，必须换算成附件自己的顶点下标（跨插槽合并过）；
            // 顺带以它为准确定是哪个插槽 / 附件 —— 点选顶点不会改「选中的附件」
            const ref = getActiveScene()?.vertexRefAt(pick.vertices[0]) ?? null
            if (!ref) {
              flash(t('顶点信息已过期：请在视口里重新点选顶点'))
            } else {
              let removed = false
              useProjectStore.getState().update(t('删除网格顶点'), (draft) => {
                removed = deleteMeshVertex(draft, ref.slot, ref.attachment, ref.vertex)
              })
              if (removed) useSelectionStore.getState().selectVertices([])
              flash(
                removed
                  ? t('已删除「{0}」的顶点 #{1}', [ref.attachment, ref.vertex])
                  : t('删除失败：顶点不存在或网格至少需要保留 3 个顶点')
              )
            }
          }
          return
        }
        // 选中了具体关键帧 → 删帧；只点选了某条通道 → 删整条通道
        const timeline = useTimelineStore.getState()
        if (timeline.selectedKeys.length === 0 && timeline.selectedTrack) {
          flash(deleteSelectedTrack().message)
        } else {
          handleCommand('anim:deleteKeys')
        }
      } else if (event.key === 'ArrowLeft') {
        handleCommand('anim:prevFrame')
      } else if (event.key === 'ArrowRight') {
        handleCommand('anim:nextFrame')
      } else if (mod && event.key.toLowerCase() === 'a') {
        /*
         * Ctrl/Cmd+A：全选当前网格的顶点（Spine 权重工具的 ctrl+A 同款）。
         * 只在「顶点有意义的工具」（权重刷 / 网格 / 顶点）且选中网格附件时接管，
         * 别的场合不拦默认行为 —— 否则选中骨骼时按 Ctrl+A 会白亮一圈顶点。
         */
        const pick = useSelectionStore.getState()
        const tool = useToolStore.getState().tool
        const scene = getActiveScene()
        const mesh = scene?.meshResult
        if (!scene || !mesh || pick.kind !== 'attachment' || !(tool === 'weight' || isMeshEditTool(tool))) return
        // 选中的是**共享缓冲**下标：反查每个下标属于哪个插槽 / 附件，只收这个网格的
        const indices: number[] = []
        for (let index = 0; index < mesh.vertexCount; index++) {
          const ref = scene.vertexRefAt(index)
          if (ref && ref.slot === pick.slot && ref.attachment === pick.attachment) indices.push(index)
        }
        if (indices.length === 0) return
        event.preventDefault()
        useSelectionStore.getState().selectVertices(indices)
        flash(t('已选中「{0}」的全部 {1} 个顶点', [pick.attachment, indices.length]))
      } else if (mod && event.key.toLowerCase() === 's') {
        event.preventDefault()
        handleCommand(event.shiftKey ? 'project:saveAs' : 'project:save')
      } else if (mod && event.key.toLowerCase() === 'o') {
        event.preventDefault()
        handleCommand('project:open')
      } else if (mod && event.key.toLowerCase() === 'i') {
        event.preventDefault()
        handleCommand('project:importImages')
      } else if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        handleCommand(event.shiftKey ? 'edit:redo' : 'edit:undo')
      } else if (mod && event.key.toLowerCase() === 'c') {
        event.preventDefault()
        handleCommand('edit:copy')
      } else if (mod && event.key.toLowerCase() === 'v') {
        event.preventDefault()
        handleCommand('edit:paste')
      } else if (mod && event.key.toLowerCase() === 'd') {
        event.preventDefault()
        handleCommand('edit:duplicate')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [handleCommand])

  const selectionText =
    selection.kind === 'bone'
      ? selection.bones.length > 1
        ? t('{0} 根骨骼（主选中「{1}」）', [selection.bones.length, selection.bone])
        : t('骨骼「{0}」', selection.bone)
      : selection.kind === 'slot'
        ? t('插槽「{0}」', selection.slot)
        : selection.kind === 'attachment'
          ? t('附件「{0}」', selection.attachment)
          : selection.kind === 'constraint'
            ? t('约束「{0}」', selection.constraint)
            : // 没选中对象时状态栏留空：当前是 Pose 还是 Animate 由视口左上角的切换按钮表示，
              // 这里再写一遍只是重复
              ''

  return (
    <div
      className="relative h-full w-full"
      // 从系统拖入文件不再导入（导入走菜单）。但仍必须挡掉浏览器 / Electron 的**默认行为**：
      // 不拦的话拖入图片 / json 会把整个应用页面导航替换成那个文件，只能重开窗口。
      //
      // 注意：**只对外部文件**把 dropEffect 设成 none。dropEffect 是 dataTransfer 上的共享属性，
      // 内部拖拽（图片 / 树节点 / 层序）在子元素上设了 move/copy，事件冒泡到这里若被一律抹成
      // 'none'，浏览器就认定「这里不接受放置」，松手时**不会派发 drop**（表现为拖动有提示、松手没反应）。
      onDragOver={(event) => {
        event.preventDefault()
        if (hasExternalFiles(event.dataTransfer)) event.dataTransfer.dropEffect = 'none'
      }}
      onDrop={(event) => event.preventDefault()}
    >
      <DockLayout
        menuBar={
          <MenuBar
            documentName={projectName}
            dirty={dirty}
            projectPath={projectPath}
            onCommand={handleCommand}
            onOpenRecent={(path) => run(openProjectAt(path))}
          />
        }
        toolbar={
          <SkeletonBar
            onSwitch={switchSkeleton}
            onAdd={addSkeleton}
            onRename={renameSkeleton}
            onRemove={removeSkeleton}
            onStatus={flash}
          />
        }
        left={
          <>
            <PanelShell title={t('层级结构')} grow>
              <HierarchyTree onStatus={flash} />
            </PanelShell>
            {/* 分隔条：向上拖把「slot 层级」拉高（高度会记住） */}
            <Splitter direction="vertical" onResize={resizeSlotOrderPanel} />
            <PanelShell
              title={t('slot 层级')}
              grow={false}
              style={{ height: slotOrderHeight }}
              actions={
                <span className="text-3xs text-content-lo">
                  {mode === 'animate' ? t('调整会写入绘制顺序帧') : t('绘制顺序（setup）')}
                </span>
              }
            >
              <SlotOrderPanel onStatus={flash} />
            </PanelShell>
            {/* 分隔条：向上拖把底部面板拉长（高度会记住）。
                Animate 态这块位置让给「曲线」，资源与皮肤只在 Pose 态显示 */}
            <Splitter direction="vertical" onResize={mode === 'animate' ? resizeCurvePanel : resizeAssetPanel} />
            {mode === 'animate' ? (
              <PanelShell
                title={t('曲线')}
                grow={false}
                style={{ height: curveHeight }}
                actions={<span className="text-3xs text-content-lo">{t('选中关键帧后拖控制点')}</span>}
              >
                <CurvePanel />
              </PanelShell>
            ) : (
              <PanelShell title={t('资源与皮肤')} grow={false} style={{ height: assetHeight }}>
                <AssetPanel
                  onImport={() => handleCommand('project:importImages')}
                  onStatus={flash}
                />
              </PanelShell>
            )}
          </>
        }
        center={
          <div className="hao-panel m-[3px] flex flex-1 flex-col overflow-hidden">
            {/* 标题栏只写「视口」：当前是 Pose 还是 Animate 由视口左上角的切换按钮表示，这里再写一遍是重复 */}
            <div className="flex h-[26px] shrink-0 items-center border-b border-line bg-ink-700 px-2">
              <span className="hao-panel-title">{t('视口')}</span>
            </div>
            <div className="relative flex min-h-0 flex-1">
              <ViewportCanvas onSceneReady={onSceneReady} onStatus={flash} />
              <ModeSwitch mode={mode} onChange={setMode} />
              {/* 右上角浮动面板：骨骼 / 约束开关 + 缩放与适配视野（原菜单栏下面那一行搬到这里） */}
              <ViewportOverlays
                zoom={zoom}
                overlay={tools.overlay}
                onToggleOverlay={tools.toggleOverlay}
                onFitViewport={() => handleCommand('view:fitViewport')}
              />
              <ViewportTools onStatus={flash} onOpenStage={() => setStageOpen(true)} />
              {/* 左下角网格子工具条：只在「网格工具 + Pose 态」出现（见 MeshSubtoolBar 内部判断） */}
              <MeshSubtoolBar onStatus={flash} />
              {/* 左下角权重刷子工具条：只在「权重刷 + Pose 态」出现，与网格子工具条互斥 */}
              <WeightSubtoolBar onStatus={flash} />
              {/* 左下角属性打帧条：Animate 态下给选中骨骼 / 插槽的每条通道一个「打一帧」入口 */}
              <PropertyKeyBar onStatus={flash} />
              {/* 关键帧的值：贴在视口正下方中间，改值时光看画面即可（仅 Animate 态出现） */}
              {mode === 'animate' ? <KeyframeValueBar /> : null}
              {/* 空白工程提示：不再自带示例角色，首次启动给个上手指引 */}
              {doc.bones.length === 0 && doc.images.length === 0 ? (
                <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-1 text-center">
                  <span className="text-panel text-content-lo">{t('空白工程')}</span>
                  <span className="text-3xs text-content-lo/70">
                    {t('顶部菜单「导入图片 / 导入 Spine / 导入 DragonBones」开始，或「打开」已有工程')}
                  </span>
                </div>
              ) : null}
            </div>
          </div>
        }
        // Animate 态下右栏（属性）显示的绑定数据没意义，整栏收起，
        // 把空间让给视口与时间轴
        right={
          mode === 'animate' ? null : (
            <>
              {/* hao-inspector：面板内的按钮统一换成「实心蓝 + 白字」，与工具条开关同色（见 styles/index.css） */}
              <PanelShell
                title={t('属性')}
                grow
                bodyClassName="hao-inspector"
                actions={<span className="text-3xs text-content-lo">{t('当前选中对象')}</span>}
              >
                <InspectorPanel onStatus={flash} />
              </PanelShell>
            </>
          )
        }
        timeline={mode === 'animate' ? <TimelinePanel onStatus={flash} /> : null}
        statusBar={
          <StatusBar
            stats={stats}
            selection={selectionText}
            hint={hint}
            busy={busy}
          />
        }
      />

      {exportMode ? (
        <ExportDialog mode={exportMode} onClose={() => setExportMode(null)} onStatus={flash} />
      ) : null}

      {newProjectOpen ? (
        <NewProjectDialog onClose={() => setNewProjectOpen(false)} onConfirm={createProject} />
      ) : null}

      {settingsOpen ? <SettingsDialog onClose={() => setSettingsOpen(false)} /> : null}

      {aiOpen ? <AiIntegrationDialog onClose={() => setAiOpen(false)} /> : null}

      {psdImport ? (
        <PsdImportDialog parsed={psdImport} onConfirm={confirmPsdImport} onClose={() => setPsdImport(null)} />
      ) : null}
      {importTargetRequest ? (
        <ImportTargetDialog
          kind={importTargetRequest.kind}
          dirty={dirty}
          onChoose={settleImportTarget}
          onClose={() => settleImportTarget(null)}
        />
      ) : null}
      {stageOpen ? <StageDialog onClose={() => setStageOpen(false)} onStatus={flash} /> : null}
    </div>
  )
}

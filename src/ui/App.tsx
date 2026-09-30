import { useCallback, useEffect, useRef, useState } from 'react'
import DockLayout from './layout/DockLayout'
import Splitter from './layout/Splitter'
import MenuBar from './layout/MenuBar'
import Toolbar from './layout/Toolbar'
import StatusBar from './panels/StatusBar'
import InspectorPanel from './panels/InspectorPanel'
import AssetPanel from './panels/AssetPanel'
import SlotOrderPanel from './panels/SlotOrderPanel'
import ToolOptionsPanel from './panels/ToolOptionsPanel'
import TimelinePanel from './timeline/TimelinePanel'
import HierarchyTree from './tree/HierarchyTree'
import ViewportCanvas from './viewport/ViewportCanvas'
import ModeSwitch from './viewport/ModeSwitch'
import ViewportTools from './viewport/ViewportTools'
import PanelShell from './widgets/PanelShell'
import { useModeStore } from '@editor/store/modeStore'
import type { EditorMode } from '@editor/store/modeStore'
import { useProjectStore } from '@editor/store/projectStore'
import { useSelectionStore } from '@editor/store/selectionStore'
import { useToolStore } from '@editor/store/toolStore'
import type { EditorTool, GizmoMode } from '@editor/store/toolStore'
import { useTimelineStore } from '@editor/store/timelineStore'

/** W/E/R/T → 骨骼变换工具（与小坐标轴工具条从上到下一致） */
const GIZMO_KEYS: Record<string, GizmoMode> = { w: 'move', e: 'rotate', r: 'scale', t: 'shear' }
const GIZMO_LABEL: Record<GizmoMode, string> = { move: '移动', rotate: '旋转', scale: '缩放', shear: '斜切' }

/**
 * V/B/M/G/D → 编辑工具（与视口工具面板一致）。
 * M 与 D 是同一个顶点工具的两种模式别名：Pose 态叫「网格」、Animate 态叫「FFD 顶点」。
 */
const TOOL_KEYS: Record<string, EditorTool> = {
  v: 'select',
  b: 'bone',
  m: 'ffd',
  g: 'weight',
  d: 'ffd'
}
const TOOL_LABEL: Record<EditorTool, string> = {
  select: '选择',
  bone: '画骨骼（拖拽连续绑定）',
  weight: '权重刷',
  ffd: '网格 / FFD 顶点'
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
  importDragonBonesFlow,
  importImagesFlow,
  importSpineFlow,
  lastProject,
  newProject,
  openProject,
  openProjectAt,
  saveProject
} from '@editor/services/projectIo'
import ExportDialog from '@ui/widgets/ExportDialog'
import type { ExportMode } from '@ui/widgets/ExportDialog'
import { deleteSelectedTrack, keyframeNow, removeSelectedKeys } from '@editor/timeline/actions'

export default function App() {
  const mode = useModeStore((s) => s.mode)
  const setModeRaw = useModeStore((s) => s.setMode)
  const doc = useProjectStore((s) => s.document)
  const projectPath = useProjectStore((s) => s.projectPath)
  const dirty = useProjectStore((s) => s.dirty)
  const warnings = useProjectStore((s) => s.warnings)
  const selection = useSelectionStore()
  const tools = useToolStore()
  const timeline = useTimelineStore()

  const [hint, setHint] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState<string | null>(null)
  const [zoom, setZoom] = useState(100)
  const [stats, setStats] = useState({
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
  /** 导出弹窗（选目录 / 调图集缩放 / 预览）：null = 未打开 */
  const [exportMode, setExportMode] = useState<ExportMode | null>(null)
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

  // 「重置布局」把面板高度一并复位，和其它分栏保持一致
  useEffect(() => {
    const reset = (): void => {
      setAssetHeight(ASSET_PANEL_HEIGHT)
      setSlotOrderHeight(SLOT_ORDER_HEIGHT)
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
   * 切换 Pose / Animate。绑骨骼 / 权重刷这些改的是绑定姿态，Animate 下视口面板不显示它们，
   * 切过去时把工具收回「选择」，避免留下一个看不见却还在吃鼠标的工具。
   * FFD 顶点在动画态是合法操作（写 deform 关键帧），不做回收。
   */
  const setMode = useCallback(
    (next: EditorMode): void => {
      setModeRaw(next)
      const tool = useToolStore.getState().tool
      if (next === 'animate' && tool !== 'select' && tool !== 'ffd') {
        useToolStore.getState().setTool('select')
        flash('Animate 状态已切回选择工具（FFD 顶点仍可用）')
      }
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
        flash('新建空白工程：可导入图片或 Spine / DragonBones 资源开始')
        return
      }
      const result = await openProjectAt(path)
      flash(result.ok ? `已打开上次的工程：${result.message.replace(/^已打开\s*/, '')}` : result.message)
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
      setStats({
        bones: scene.runtime?.asset.bones.length ?? 0,
        slots: scene.runtime?.asset.slots.length ?? 0,
        constraints: scene.runtime?.asset.constraints.length ?? 0,
        vertices: mesh?.vertexCount ?? 0,
        triangles: mesh ? Math.floor(mesh.groups.reduce((sum, g) => sum + g.indexCount, 0) / 3) : 0,
        // 纹理就绪度：缺图时视口会把附件画成白色，这里直接暴露出来
        // （只统计工程里的图片，仓库里可能还留着已删图或探针加载的纹理）
        texturesLoaded: images.filter((image) => scene.textures.has(image.name)).length,
        texturesTotal: images.length
      })
      setZoom(Math.round(scene.viewport.zoom * 100))
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
      setBusy(label ?? '处理中…')
      return Promise.resolve(task)
        .then((result) => {
          if (result.message) flash(result.message)
        })
        .finally(() => setBusy(null))
    },
    [flash]
  )

  const handleCommand = useCallback(
    (command: string) => {
      switch (command) {
        case 'project:new':
          run(newProject()).then(resetSceneView)
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
          run(importSpineFlow(), '正在导入 Spine 资源…')
          return
        case 'project:importDragonBones':
          run(importDragonBonesFlow(), '正在导入 DragonBones 资源…')
          return
        case 'project:importImages':
          run(importImagesFlow(), '正在导入图片…')
          return
        case 'project:exportRuntime':
          // 两个导出命令都走弹窗：选目录、调图集缩放 / 页尺寸、先看预览再导出
          setExportMode('runtime')
          return
        case 'project:exportHao2d':
          setExportMode('unity')
          return
        case 'edit:undo':
          useProjectStore.getState().undo()
          flash('已撤销')
          return
        case 'edit:redo':
          useProjectStore.getState().redo()
          flash('已重做')
          return
        case 'edit:delete':
          flash('删除操作请使用层级树里的删除按钮')
          return
        case 'view:fitViewport':
          getActiveScene()?.fit()
          flash('已适配视野')
          return
        case 'view:resetLayout':
          window.dispatchEvent(new Event('hao2d:reset-layout'))
          return
        case 'mode:toggle':
          setMode(mode === 'pose' ? 'animate' : 'pose')
          return
        case 'anim:playPause': {
          if (mode !== 'animate') {
            flash('播放控制仅在 Animate 状态可用（Tab 切换）')
            return
          }
          const timeline = useTimelineStore.getState()
          if (!timeline.currentAnimation) {
            // 未选动画时点播放：自动选中第一个动画，避免「点了没反应」
            if (doc.animations.length === 0) {
              flash('当前工程还没有动画，可点时间轴上的「+ 动画」新建')
              return
            }
            timeline.setAnimation(doc.animations[0].name)
            flash(`已自动选择动画「${doc.animations[0].name}」`)
            timeline.setPlaying(true)
            return
          }
          timeline.togglePlaying()
          return
        }
        case 'anim:keyframe': {
          if (mode !== 'animate') {
            flash('打关键帧只在 Animate 状态可用（Tab 切换）')
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
          const next = Math.max(0, Math.min(duration, state.time + step))
          state.setTime(Number(next.toFixed(4)))
          return
        }
        default:
          flash('该命令将在对应模块接入后生效')
      }
    },
    [doc.frameRate, flash, mode, run, setMode]
  )

  useEffect(() => {
    globalThis.document.title = `${doc.armatureName}${dirty ? ' *' : ''} — Hao2D Editor`
    return getPlatform().onMenuCommand(handleCommand)
  }, [doc.armatureName, dirty, handleCommand])

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
      if (event.key === 'Tab') {
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
        flash(`工具：${TOOL_LABEL[next]}（${event.key.toUpperCase()}）`)
      } else if (!mod && GIZMO_KEYS[event.key.toLowerCase()]) {
        // W/E/R/T：切换骨骼变换小坐标轴（移动 / 旋转 / 缩放 / 斜切）
        const next = GIZMO_KEYS[event.key.toLowerCase()]
        const before = useToolStore.getState().tool
        useToolStore.getState().setGizmo(next)
        const switched = useToolStore.getState().tool !== before
        flash(`骨骼工具：${GIZMO_LABEL[next]}（${event.key.toUpperCase()}）${switched ? '· 已退出绘制工具' : ''}`)
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
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
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [handleCommand])

  const selectionText =
    selection.kind === 'bone'
      ? `骨骼「${selection.bone}」`
      : selection.kind === 'slot'
        ? `插槽「${selection.slot}」`
        : selection.kind === 'attachment'
          ? `附件「${selection.attachment}」`
          : selection.kind === 'constraint'
            ? `约束「${selection.constraint}」`
            : mode === 'pose'
              ? 'Pose 状态'
              : 'Animate 状态'

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
            documentName={doc.armatureName}
            dirty={dirty}
            mode={mode}
            projectPath={projectPath}
            onCommand={handleCommand}
            onFitViewport={() => handleCommand('view:fitViewport')}
            onOpenRecent={(path) => run(openProjectAt(path))}
          />
        }
        toolbar={
          <Toolbar
            zoom={zoom}
            overlay={tools.overlay}
            onToggleOverlay={tools.toggleOverlay}
            onFitViewport={() => handleCommand('view:fitViewport')}
          />
        }
        left={
          <>
            <PanelShell
              title="层级结构"
              grow
              actions={<span className="text-3xs text-content-lo" title="单棵树：插槽挂在宿主骨骼下，约束挂在驱动骨骼下">图标区分类型</span>}
            >
              <HierarchyTree onStatus={flash} />
            </PanelShell>
            {/* 分隔条：向上拖把「slot 层级」拉高（高度会记住） */}
            <Splitter direction="vertical" onResize={resizeSlotOrderPanel} />
            <PanelShell
              title="slot 层级"
              grow={false}
              style={{ height: slotOrderHeight }}
              actions={
                <span className="text-3xs text-content-lo">
                  {mode === 'animate' ? '调整会写入绘制顺序帧' : '绘制顺序（setup）'}
                </span>
              }
            >
              <SlotOrderPanel onStatus={flash} />
            </PanelShell>
            {/* 分隔条：向上拖把「资源与皮肤」拉长（高度会记住） */}
            <Splitter direction="vertical" onResize={resizeAssetPanel} />
            <PanelShell
              title="资源与皮肤"
              grow={false}
              style={{ height: assetHeight }}
              actions={<span className="text-3xs text-content-lo">拖动上方分隔条调高</span>}
            >
              <AssetPanel
                onImport={() => handleCommand('project:importImages')}
                onStatus={flash}
              />
            </PanelShell>
          </>
        }
        center={
          <div className="hao-panel m-[3px] flex flex-1 flex-col overflow-hidden">
            <div className="flex h-[26px] shrink-0 items-center justify-between border-b border-line bg-ink-700 px-2">
              <span className="hao-panel-title">视口</span>
              <span className="text-3xs text-content-lo">
                {mode === 'pose' ? 'Pose · 绑定状态（编辑 setup）' : 'Animate · 动画编辑状态'}
              </span>
            </div>
            <div className="relative flex min-h-0 flex-1">
              <ViewportCanvas onSceneReady={onSceneReady} onStatus={flash} />
              <ModeSwitch mode={mode} onChange={setMode} />
              <ViewportTools onStatus={flash} />
              {/* 空白工程提示：不再自带示例角色，首次启动给个上手指引 */}
              {doc.bones.length === 0 && doc.images.length === 0 ? (
                <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-1 text-center">
                  <span className="text-panel text-content-lo">空白工程</span>
                  <span className="text-3xs text-content-lo/70">
                    顶部菜单「导入图片 / 导入 Spine / 导入 DragonBones」开始，或「打开」已有工程
                  </span>
                </div>
              ) : null}
            </div>
          </div>
        }
        // Animate 态下右栏（属性检查器 / 工具选项）显示的绑定数据没意义，整栏收起，
        // 把空间让给视口与时间轴
        right={
          mode === 'animate' ? null : (
            <>
              <PanelShell
                title="属性检查器"
                grow
                actions={<span className="text-3xs text-content-lo">当前选中对象</span>}
              >
                <InspectorPanel onStatus={flash} />
              </PanelShell>
              <PanelShell title="工具选项" grow={false} bodyClassName="max-h-[300px]">
                <ToolOptionsPanel onStatus={flash} />
              </PanelShell>
            </>
          )
        }
        timeline={mode === 'animate' ? <TimelinePanel onStatus={flash} /> : null}
        statusBar={
          <StatusBar
            stats={stats}
            selection={selectionText}
            animationName={mode === 'animate' ? timeline.currentAnimation : null}
            time={timeline.time}
            frameRate={doc.frameRate}
            hint={hint}
            busy={busy}
          />
        }
      />

      {exportMode ? (
        <ExportDialog mode={exportMode} onClose={() => setExportMode(null)} onStatus={flash} />
      ) : null}
    </div>
  )
}

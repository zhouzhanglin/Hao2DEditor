import { useCallback, useEffect, useRef, useState } from 'react'
import DockLayout from './layout/DockLayout'
import MenuBar from './layout/MenuBar'
import Toolbar from './layout/Toolbar'
import StatusBar from './panels/StatusBar'
import InspectorPanel from './panels/InspectorPanel'
import KeyframeCard from './panels/KeyframeCard'
import AssetPanel from './panels/AssetPanel'
import ToolOptionsPanel from './panels/ToolOptionsPanel'
import TimelinePanel from './timeline/TimelinePanel'
import HierarchyTree from './tree/HierarchyTree'
import ViewportCanvas from './viewport/ViewportCanvas'
import ModeSwitch from './viewport/ModeSwitch'
import PanelShell from './widgets/PanelShell'
import { useModeStore } from '@editor/store/modeStore'
import { useProjectStore } from '@editor/store/projectStore'
import { useSelectionStore } from '@editor/store/selectionStore'
import { useToolStore } from '@editor/store/toolStore'
import { useTimelineStore } from '@editor/store/timelineStore'
import { getPlatform } from '@editor/platform'
import { setActiveScene, getActiveScene } from '@editor/activeScene'
import type { EditorScene } from '@editor/scene'
import {
  importDragonBonesFlow,
  importDroppedPaths,
  importImagesFlow,
  importSpineFlow,
  loadSample,
  newProject,
  openProject,
  openProjectAt,
  saveProject
} from '@editor/services/projectIo'
import { exportHao2d, exportRuntimeData } from '@editor/services/exportService'
import { keyframeNow, removeSelectedKeys } from '@editor/timeline/actions'

export default function App() {
  const mode = useModeStore((s) => s.mode)
  const setMode = useModeStore((s) => s.setMode)
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
  const [stats, setStats] = useState({ bones: 0, slots: 0, constraints: 0, vertices: 0, triangles: 0 })
  const [dragging, setDragging] = useState(false)
  const booted = useRef(false)

  const flash = useCallback((message: string) => {
    setHint(message)
    window.setTimeout(() => setHint(undefined), 2600)
  }, [])

  // 首次进入：载入内置示例，让视口有内容可看
  useEffect(() => {
    if (booted.current) return
    booted.current = true
    if (doc.bones.length === 0 && doc.images.length === 0) {
      loadSample()
      flash('已载入内置示例角色，可从这里开始编辑或导入自己的资源')
    }
  }, [doc.bones.length, doc.images.length, flash])

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
      setStats({
        bones: scene.runtime?.asset.bones.length ?? 0,
        slots: scene.runtime?.asset.slots.length ?? 0,
        constraints: scene.runtime?.asset.constraints.length ?? 0,
        vertices: mesh?.vertexCount ?? 0,
        triangles: mesh ? Math.floor(mesh.groups.reduce((sum, g) => sum + g.indexCount, 0) / 3) : 0
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
      void Promise.resolve(task)
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
          run(newProject())
          return
        case 'project:open':
          run(openProject())
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
          run(exportRuntimeData(), '正在打包图集并导出运行时数据…')
          return
        case 'project:exportHao2d':
          run(exportHao2d(), '正在导出 .hao2d…')
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
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        handleCommand('anim:deleteKeys')
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

  const onDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault()
      setDragging(false)
      const files = Array.from(event.dataTransfer.files)
      if (files.length === 0) return
      const platform = getPlatform()
      void Promise.all(files.map((file) => platform.pathForDroppedFile(file)))
        .then((paths) => importDroppedPaths(paths.filter(Boolean)))
        .then((result) => {
          if (result.message) flash(result.message)
        })
    },
    [flash]
  )

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
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
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
            mode={mode}
            tool={tools.tool}
            zoom={zoom}
            overlay={tools.overlay}
            onToolChange={tools.setTool}
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
              <HierarchyTree />
            </PanelShell>
            <PanelShell title="资源与皮肤" grow={false} bodyClassName="h-[190px]">
              <AssetPanel />
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
            </div>
          </div>
        }
        right={
          <>
            <PanelShell
              title="属性检查器"
              grow
              actions={timeline.selectedKeys.length > 0 ? <span className="text-3xs text-accent">关键帧</span> : null}
            >
              <KeyframeCard onStatus={flash} />
              <InspectorPanel onStatus={flash} />
            </PanelShell>
            <PanelShell title="工具选项" grow={false} bodyClassName="max-h-[300px]">
              <ToolOptionsPanel onStatus={flash} />
            </PanelShell>
          </>
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

      {dragging ? (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-accent/5 backdrop-blur-[1px]">
          <div className="rounded border border-accent/50 bg-ink-800/90 px-4 py-3 text-panel text-accent animate-fade-in">
            松开即可导入：Spine / DragonBones JSON、.atlas 图集或碎图
          </div>
        </div>
      ) : null}
    </div>
  )
}

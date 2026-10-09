import { useEffect, useState } from 'react'
import {
  Bone,
  ChevronDown,
  Crosshair,
  FilePlus2,
  FolderOpen,
  History,
  Import,
  Package,
  Save,
  Share2,
  Undo2,
  Redo2
} from 'lucide-react'
import type { EditorMode } from '@editor/store/modeStore'
import { recentProjects } from '@editor/services/projectIo'

export interface MenuBarProps {
  documentName: string
  dirty: boolean
  /** 当前编辑状态，仅用于菜单栏上的状态徽标（切换入口在视口左上角） */
  mode: EditorMode
  projectPath: string | null
  onCommand: (command: string) => void
  onFitViewport: () => void
  onOpenRecent: (path: string) => void
}

const QUICK_ACTIONS = [
  { command: 'project:new', label: '新建', icon: FilePlus2, hint: '新建工程 (Ctrl+N)' },
  { command: 'project:open', label: '打开', icon: FolderOpen, hint: '打开工程 (Ctrl+O)' },
  { command: 'project:save', label: '保存', icon: Save, hint: '保存工程 (Ctrl+S)' },
  { command: 'project:importImages', label: '导入图片', icon: Import, hint: '导入或拖入碎图 (Ctrl+I)' }
]

/**
 * 导出：两个并排入口（运行时 / Unity）收进一个「导出」下拉。
 * 菜单栏横向本来就紧张 —— 两个按钮各占一位，窄窗口下会把中间的文件名挤没。
 */
const EXPORT_ACTIONS = [
  {
    command: 'project:exportRuntime',
    label: '导出运行时',
    icon: Share2,
    hint: '导出 {名称}_ske.json + {名称}_atlas.json + 图集 png (Ctrl+E)'
  },
  {
    command: 'project:exportHao2d',
    label: '导出 Unity',
    icon: Package,
    hint: '导出给 Unity 的 .hao2d + 图集 png + 材质 (Ctrl+Shift+E)'
  }
]

/** 顶部菜单栏：品牌 + 文档名 + 快捷动作 + Pose/Animate 二段式开关。 */
/** 最近打开的工程：点击直接打开（来自主进程持久化的列表） */
function RecentMenu({ onOpen }: { onOpen: (path: string) => void }) {
  const [open, setOpen] = useState(false)
  const [list, setList] = useState<string[]>([])

  useEffect(() => {
    if (!open) return
    let alive = true
    void recentProjects().then((items) => {
      if (alive) setList(items)
    })
    return () => {
      alive = false
    }
  }, [open])

  return (
    <div className="relative">
      <button
        type="button"
        title="最近打开的工程"
        className="hao-btn border-transparent bg-transparent"
        onClick={() => setOpen((value) => !value)}
      >
        <History size={13} />
        <ChevronDown size={10} />
      </button>
      {open ? (
        <>
          <button
            type="button"
            className="fixed inset-0 z-40 cursor-default"
            aria-label="关闭最近列表"
            onClick={() => setOpen(false)}
          />
          <div className="hao-window-no-drag absolute left-0 top-[26px] z-50 w-[320px] rounded border border-line bg-ink-800 py-1 shadow-lg shadow-black/40">
            {list.length === 0 ? (
              <p className="px-3 py-2 text-3xs text-content-lo">还没有最近打开的工程</p>
            ) : (
              list.map((path) => (
                <button
                  key={path}
                  type="button"
                  className="block w-full truncate px-3 py-1 text-left text-3xs text-content-mid hover:bg-ink-700 hover:text-content-hi cursor-pointer"
                  title={path}
                  onClick={() => {
                    setOpen(false)
                    onOpen(path)
                  }}
                >
                  {path}
                </button>
              ))
            )}
          </div>
        </>
      ) : null}
    </div>
  )
}

/** 导出下拉：运行时 / Unity 两个入口。交互与 RecentMenu 一致（点外部关闭） */
function ExportMenu({ onCommand }: { onCommand: (command: string) => void }) {
  const [open, setOpen] = useState(false)

  return (
    <div className="relative">
      <button
        type="button"
        title="导出"
        onClick={() => setOpen((value) => !value)}
        className={['hao-btn border-transparent bg-transparent', open ? 'text-content-hi' : ''].join(' ')}
      >
        <Share2 size={13} />
        <span>导出</span>
        <ChevronDown size={10} />
      </button>
      {open ? (
        <>
          <button
            type="button"
            className="fixed inset-0 z-40 cursor-default"
            aria-label="关闭导出菜单"
            onClick={() => setOpen(false)}
          />
          <div className="hao-window-no-drag absolute left-0 top-[26px] z-50 w-[260px] rounded border border-line bg-ink-800 py-1 shadow-lg shadow-black/40">
            {EXPORT_ACTIONS.map(({ command, label, icon: Icon, hint }) => (
              <button
                key={command}
                type="button"
                title={hint}
                className="block w-full cursor-pointer px-3 py-1 text-left text-3xs text-content-mid hover:bg-ink-700 hover:text-content-hi"
                onClick={() => {
                  setOpen(false)
                  onCommand(command)
                }}
              >
                <span className="flex items-center gap-2">
                  <Icon size={12} className="shrink-0" />
                  <span className="truncate">{label}</span>
                </span>
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  )
}

/**
 * 顶部菜单栏。
 *
 * 根元素带 `hao-window-drag`：窗口用 `titleBarStyle: 'hiddenInset'`（标题栏被隐藏），
 * 不显式声明拖动区的话**整个窗口都拖不动**（详见 src/styles/index.css 里的说明与来源）。
 * 里面的按钮等交互控件由样式中的 `no-drag` 规则自动排除，点击不受影响。
 */
export default function MenuBar({
  documentName,
  dirty,
  mode,
  projectPath,
  onCommand,
  onFitViewport,
  onOpenRecent
}: MenuBarProps) {
  return (
    <header className="hao-window-drag flex h-[30px] items-center gap-2 border-b border-line bg-ink-800 pl-[86px] pr-2">
      <div className="flex items-center gap-1.5">
        <Bone size={14} className="text-accent" />
        <span className="text-panel font-semibold tracking-wide text-content-hi">Hao2D</span>
        <span className="text-3xs text-content-lo">Editor</span>
      </div>

      <div className="mx-1 h-[16px] w-px bg-line" />

      <div className="flex items-center gap-0.5">
        {QUICK_ACTIONS.map(({ command, label, icon: Icon, hint }) => (
          <button
            key={command}
            type="button"
            title={hint}
            onClick={() => onCommand(command)}
            className="hao-btn border-transparent bg-transparent"
          >
            <Icon size={13} />
            <span>{label}</span>
          </button>
        ))}
        <ExportMenu onCommand={onCommand} />
        <RecentMenu onOpen={(path) => onOpenRecent(path)} />
        <div className="mx-0.5 h-[16px] w-px bg-line" />
        <button
          type="button"
          title="撤销 (Ctrl+Z)"
          onClick={() => onCommand('edit:undo')}
          className="hao-tool-button"
        >
          <Undo2 size={14} />
        </button>
        <button
          type="button"
          title="重做 (Ctrl+Shift+Z)"
          onClick={() => onCommand('edit:redo')}
          className="hao-tool-button"
        >
          <Redo2 size={14} />
        </button>
        <button
          type="button"
          title="适配视野 (F)"
          onClick={onFitViewport}
          className="hao-tool-button"
        >
          <Crosshair size={14} />
        </button>
      </div>

      <div className="flex min-w-0 flex-1 items-center justify-center gap-2">
        <span className="truncate text-panel text-content-mid">{documentName}</span>
        {dirty ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" title="有未保存修改" /> : null}
        {projectPath ? (
          <span className="max-w-[420px] truncate text-3xs text-content-lo">{projectPath}</span>
        ) : null}
      </div>

      <div className="flex items-center gap-1.5">
        <span
          className={[
            'flex h-[20px] items-center gap-1 rounded-[5px] px-2 text-2xs font-medium',
            mode === 'animate' ? 'bg-accent-deep text-white' : 'bg-white/[0.07] text-content-mid'
          ].join(' ')}
          title="当前编辑状态（切换按钮在视口左上角）"
        >
          {mode === 'pose' ? 'Pose' : 'Animate'}
        </span>
        <button
          type="button"
          title="重置面板布局"
          onClick={() => window.dispatchEvent(new Event('hao2d:reset-layout'))}
          className="hao-tool-button"
        >
          <ChevronDown size={13} />
        </button>
      </div>
    </header>
  )
}

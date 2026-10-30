import { useEffect, useState } from 'react'
import {
  ArrowUpRight,
  ChevronDown,
  FilePlus2,
  Film,
  FolderOpen,
  History,
  Import,
  Package,
  Save,
  Share2,
  Undo2,
  Redo2
} from 'lucide-react'
import { getPlatform } from '@editor/platform'
import { recentProjects } from '@editor/services/projectIo'
import { t } from '@i18n'

/**
 * 标题栏左上角的 logo：直接用应用图标素材（`src/public/app-icon.png`，与标签页图标同一张）。
 * 用 `document.baseURI` 拼相对地址，dev（http 服务）与打包后（file://）都能取到。
 */
const APP_ICON = new URL('app-icon.png', document.baseURI).href

export interface MenuBarProps {
  documentName: string
  dirty: boolean
  projectPath: string | null
  onCommand: (command: string) => void
  onOpenRecent: (path: string) => void
}

/** 顶部快捷动作（文案随语言切换，故做成函数而非模块级常量表） */
function quickActions() {
  return [
    { command: 'project:new', label: t('新建项目'), icon: FilePlus2, hint: t('新建项目 (Ctrl+N)') },
    { command: 'project:open', label: t('打开'), icon: FolderOpen, hint: t('打开工程 (Ctrl+O)') },
    { command: 'project:save', label: t('保存'), icon: Save, hint: t('保存工程 (Ctrl+S)') },
    { command: 'project:importImages', label: t('导入图片'), icon: Import, hint: t('导入或拖入碎图 / PSD (Ctrl+I)') }
  ]
}

/**
 * 导出：两个并排入口（运行时 / Unity）收进一个「导出」下拉。
 * 菜单栏横向本来就紧张 —— 两个按钮各占一位，窄窗口下会把中间的文件名挤没。
 * 文案随语言切换，故做成函数而非模块级常量表。
 */
function exportActions() {
  return [
    {
      command: 'project:exportRuntime',
      label: t('导出运行时'),
      icon: Share2,
      hint: t('导出 {名称}_ske.json + {名称}_atlas.json + 图集 png (Ctrl+E)')
    },
    {
      command: 'project:exportHao2d',
      label: t('导出 Unity'),
      icon: Package,
      hint: t('导出给 Unity 的 .hao2d + 图集 png + 材质 (Ctrl+Shift+E)')
    },
    {
      command: 'project:exportSpine',
      label: t('导出 Spine'),
      icon: Package,
      hint: t('导出 Spine 4.3 骨骼数据：{名称}.json + {名称}.atlas + 图集 png (Ctrl+Alt+E)')
    },
    {
      command: 'project:exportVideo',
      label: t('导出视频'),
      icon: Film,
      hint: t('把当前动画渲染成 mp4 视频：可选画幅 / 背景色 / 取景，按工程帧率导出')
    }
  ]
}

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
        title={t('最近打开的工程')}
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
            aria-label={t('关闭最近列表')}
            onClick={() => setOpen(false)}
          />
          <div className="hao-window-no-drag absolute left-0 top-[26px] z-50 w-[320px] rounded border border-line bg-ink-800 py-1 shadow-lg shadow-black/40">
            {list.length === 0 ? (
              <p className="px-3 py-2 text-3xs text-content-lo">{t('还没有最近打开的工程')}</p>
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
        title={t('导出')}
        onClick={() => setOpen((value) => !value)}
        className={['hao-btn border-transparent bg-transparent', open ? 'text-content-hi' : ''].join(' ')}
      >
        <Share2 size={13} />
        <span>{t('导出')}</span>
        <ChevronDown size={10} />
      </button>
      {open ? (
        <>
          <button
            type="button"
            className="fixed inset-0 z-40 cursor-default"
            aria-label={t('关闭导出菜单')}
            onClick={() => setOpen(false)}
          />
          <div className="hao-window-no-drag absolute left-0 top-[26px] z-50 w-[260px] rounded border border-line bg-ink-800 py-1 shadow-lg shadow-black/40">
            {exportActions().map(({ command, label, icon: Icon, hint }) => (
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
 *
 * 左侧那 86px 空位是给 macOS 的窗口按钮（交通灯）让位的（见 src/main/index.ts 的
 * `trafficLightPosition`）。Windows / Linux 走系统原生标题栏（`titleBarStyle: 'default'`），
 * 窗口按钮不在这一行上 —— 那里就不留空位，品牌与快捷动作整体往前挪。
 */
export default function MenuBar({
  documentName,
  dirty,
  projectPath,
  onCommand,
  onOpenRecent
}: MenuBarProps) {
  /*
   * 交通灯只在 macOS 下才会浮到菜单栏上；Windows / Linux（原生标题栏）与浏览器模式
   * （dev:web，本来就没有窗口按钮）都用普通内边距，别白占掉左边一块。
   */
  const leftInset = getPlatform().platform === 'darwin' ? 'pl-[86px]' : 'pl-2'
  return (
    <header
      className={`hao-window-drag flex h-[30px] items-center gap-2 border-b border-line bg-ink-800 ${leftInset} pr-2`}
    >
      <div className="flex items-center gap-1.5">
        {/* 应用图标本身是「深色圆角块 + 骨骼拼成的橙色 H」，直接当 logo 用；禁止拖拽，免得抢掉窗口拖动 */}
        <img src={APP_ICON} alt="" width={18} height={18} draggable={false} className="shrink-0" />
        <span className="text-panel font-semibold tracking-wide text-content-hi">Hao2D</span>
        <span className="text-3xs text-content-lo">Editor</span>
      </div>

      <div className="mx-1 h-[16px] w-px bg-line" />

      <div className="flex items-center gap-0.5">
        {quickActions().map(({ command, label, icon: Icon, hint }) => (
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
          title={t('撤销 (Ctrl+Z)')}
          onClick={() => onCommand('edit:undo')}
          className="hao-tool-button"
        >
          <Undo2 size={14} />
        </button>
        <button
          type="button"
          title={t('重做 (Ctrl+Shift+Z)')}
          onClick={() => onCommand('edit:redo')}
          className="hao-tool-button"
        >
          <Redo2 size={14} />
        </button>
      </div>

      <div className="flex min-w-0 flex-1 items-center justify-center gap-2">
        <span className="truncate text-panel text-content-mid">{documentName}</span>
        {dirty ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" title={t('有未保存修改')} /> : null}
        {/*
          工程路径 → 右侧小箭头 = 在系统文件管理器里打开工程所在目录
          （`revealInFolder` 走 shell.showItemInFolder，Finder / 资源管理器会打开目录并选中 .proj）。
          工程还没存盘（`projectPath` 为空）时**整个箭头不显示**：那时根本没有目录可开。
        */}
        {projectPath ? (
          <span className="flex min-w-0 items-center gap-0.5">
            <span className="max-w-[420px] truncate text-3xs text-content-lo">{projectPath}</span>
            <button
              type="button"
              className="hao-tool-button h-[18px] w-[18px] shrink-0"
              title={t('打开项目文件夹')}
              onClick={() => {
                void getPlatform()
                  .revealInFolder(projectPath)
                  .catch((error: unknown) => console.error('[hao2d] 打开项目文件夹失败', error))
              }}
            >
              <ArrowUpRight size={11} />
            </button>
          </span>
        ) : null}
      </div>

      {/*
        右上角原来有一个「重置面板布局」按钮（一个箭头图标，看着像下拉菜单）。
        功能与「视图 → 重置面板布局」（`view:resetLayout`）完全重复，且图标表意很误导，
        所以整块删掉 —— 要重置布局走菜单即可，分隔条随时可以手拖。
      */}
    </header>
  )
}

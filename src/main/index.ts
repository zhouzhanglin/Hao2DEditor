import { app, BrowserWindow, nativeImage, shell } from 'electron'
import path from 'node:path'
import { createLogger } from './logger'
import { registerSchemes, registerProtocolHandlers } from './protocol'
import { registerIpcHandlers } from './ipc'
import { buildAppMenu } from './menu'
import { setLocale, systemLocale } from './i18n'
import { startCommandServer, stopCommandServer } from './commandServer'
import { cancelAllVideoExports } from './videoExport'
import { findProjectArg, isRendererReady, queueOpenProject, resetRendererReady } from './openRequests'
import { IPC } from '@shared/ipcTypes'

const log = createLogger('main')

let mainWindow: BrowserWindow | null = null

/**
 * 开发期的应用图标（打包后由 electron-builder 注入的 icon.icns / icon.ico 接管）。
 * dev 下 `app.getAppPath()` 就是工程根目录，图标在 `build/` 里；
 * 打包产物只含 `out/**`，所以这里在 isPackaged 时直接返回 undefined，不指向不存在的路径。
 */
function devIconPath(): string | undefined {
  if (app.isPackaged) return undefined
  return path.join(app.getAppPath(), 'build', 'icon.png')
}

/**
 * 「用编辑器打开这个工程」（双击文件 / 拖到 Dock 图标 / 命令行带路径）。
 *
 * 渲染层已就绪就直接推事件；否则先排队，等它挂载后自己来取（见 openRequests.ts）。
 * 无论哪种情况都把窗口叫到前面 —— 双击文件的用户期待看到编辑器。
 */
function handleOpenProjectFile(filePath: string): void {
  if (!filePath) return
  // 窗口被关掉后（macOS 关窗不退出）又双击工程：先把窗口建回来，否则路径只能躺在队列里
  if (!mainWindow && app.isReady()) createWindow()
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    if (isRendererReady()) {
      mainWindow.webContents.send(IPC.openProjectRequest, filePath)
      return
    }
  }
  queueOpenProject(filePath)
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 1280,
    minHeight: 800,
    show: false,
    backgroundColor: '#101018',
    // macOS 忽略此项（Dock 图标另设，见下面的 setIcon）；Windows / Linux 用它给任务栏图标
    icon: devIconPath(),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    // 交通灯与顶部 30px 高的菜单栏（MenuBar）垂直居中：按钮直径 12pt → y = (30 − 12) / 2 = 9
    trafficLightPosition: { x: 14, y: 9 },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      /**
       * 窗口切到后台 / 被遮挡时**不要节流**。
       *
       * 默认 Chromium 会把 rAF 与定时器降频甚至停掉：视口定格在绑定姿态、播放时钟不走，
       * 于是后台截图（AI 预览、录屏工具、系统截图）只能拍到一张静止画面。
       * 编辑器需要「看不见时也照常推进动画」，所以关掉节流（配合 ViewportCanvas 里
       * 页面不可见时改用 setTimeout 的兜底调度）。
       */
      backgroundThrottling: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
    log.info('窗口已就绪')
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // 渲染层重新加载（刷新 / HMR）后要重新走「取一次队列 + 之后推事件」的握手
  mainWindow.webContents.on('did-start-loading', () => resetRendererReady())

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    mainWindow.loadURL(devUrl)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

registerSchemes()

// 菜单栏 / 「关于」显示的应用名。dev 下 Electron 默认叫 "Electron"，
// 必须在 ready 之前显式改名，否则 macOS app 菜单标题会一直是 "Electron"。
app.setName('Hao2D')

/*
 * 双击 `.hao2dproj`：macOS 通过 `open-file` 事件把路径交过来，而**首次启动（双击打开）
 * 时这个事件会在 ready 之前就到达** —— 监听必须注册在模块顶层，放进 whenReady 里会漏掉。
 */
app.on('open-file', (event, filePath) => {
  event.preventDefault()
  handleOpenProjectFile(filePath)
})

/*
 * 单实例：双击第二个工程文件时不该再开一个编辑器窗口（两个进程抢同一份工程 = 互相覆盖）。
 * 拿不到锁的实例直接退出，把 argv 交给已运行的那一个。
 */
const singleInstanceLock = app.requestSingleInstanceLock()
if (!singleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    const filePath = findProjectArg(argv)
    if (filePath) handleOpenProjectFile(filePath)
    else if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })
  // Windows / Linux：双击打开的文件路径就在启动参数里（macOS 走上面的 open-file）
  const startupFile = process.platform === 'darwin' ? null : findProjectArg(process.argv)
  if (startupFile) queueOpenProject(startupFile)
}

app.whenReady().then(() => {
  registerProtocolHandlers()
  registerIpcHandlers()
  // 首次构建菜单先按系统语言（渲染进程读到存档后会再同步一次，见 ipc.ts 的 i18n:setLocale）
  setLocale(systemLocale())
  // macOS 的 Dock 图标：dev 下默认显示 Electron 自带图标，换成应用图标
  const iconPath = devIconPath()
  if (process.platform === 'darwin' && iconPath) {
    const icon = nativeImage.createFromPath(iconPath)
    if (!icon.isEmpty()) app.dock?.setIcon(icon)
  }
  buildAppMenu()
  createWindow()

  // 本地命令服务：AI / 脚本用 HTTP / WebSocket 操作编辑器
  // 地址与 token 写进 userData/command-server.json，也会打进日志
  void startCommandServer(() => mainWindow)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('will-quit', () => {
  void stopCommandServer()
  // 还开着的视频导出会话：杀掉子进程，别留下孤儿 ffmpeg
  cancelAllVideoExports()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

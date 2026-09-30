import { app, BrowserWindow, shell } from 'electron'
import path from 'node:path'
import { createLogger } from './logger'
import { registerSchemes, registerProtocolHandlers } from './protocol'
import { registerIpcHandlers } from './ipc'
import { buildAppMenu } from './menu'

const log = createLogger('main')

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 1280,
    minHeight: 800,
    show: false,
    backgroundColor: '#101018',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    // 交通灯与顶部 30px 高的菜单栏（MenuBar）垂直居中：按钮直径 12pt → y = (30 − 12) / 2 = 9
    trafficLightPosition: { x: 14, y: 9 },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
    log.info('窗口已就绪')
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

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

app.whenReady().then(() => {
  registerProtocolHandlers()
  registerIpcHandlers()
  buildAppMenu()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

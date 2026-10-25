import { join } from 'node:path'
import { app, BrowserWindow, Menu, shell, Tray } from 'electron'
import { emitEvent, type IpcInvokeEventLike, type IpcRegistrar } from '@platform/ipc/main/ipc'
import { MINERU_API_TOKEN_URL, TUTORIAL_PAPER_SOURCE_URL } from '@shared/tutorialSample'
import type { WindowState } from '@shared/types'
import { windowChannels } from '../contract/window'

/** The single frameless main window and its tray icon. Closing hides the window; only the tray quits. */
export class AppShell {
  mainWindow: BrowserWindow | null = null
  isQuitting = false
  private tray: Tray | null = null

  constructor(private readonly bundleDirectory: string) {}

  get rendererEntryPath(): string {
    return join(this.bundleDirectory, '../renderer/index.html')
  }

  createMainWindow(onRendererGone: () => void): void {
    Menu.setApplicationMenu(null)
    const mainWindow = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 1100,
      minHeight: 700,
      show: false,
      title: '',
      icon: this.iconPath(),
      frame: false,
      roundedCorners: true,
      thickFrame: true,
      autoHideMenuBar: true,
      backgroundColor: '#f7f2e8',
      webPreferences: {
        preload: join(this.bundleDirectory, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true
      }
    })
    this.mainWindow = mainWindow
    mainWindow.webContents.on('destroyed', onRendererGone)
    mainWindow.webContents.on('render-process-gone', onRendererGone)
    mainWindow.webContents.on('page-title-updated', (event) => event.preventDefault())
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (url === 'https://github.com/Kumiko-kmk/Copilotix' || url === TUTORIAL_PAPER_SOURCE_URL || url === MINERU_API_TOKEN_URL) void shell.openExternal(url)
      return { action: 'deny' }
    })
    mainWindow.once('ready-to-show', () => this.mainWindow?.show())
    mainWindow.on('maximize', () => this.emitWindowState())
    mainWindow.on('unmaximize', () => this.emitWindowState())
    mainWindow.on('close', (event) => {
      if (!this.isQuitting) {
        event.preventDefault()
        this.mainWindow?.hide()
      }
    })
    if (process.env.ELECTRON_RENDERER_URL) {
      void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
    } else {
      void mainWindow.loadFile(this.rendererEntryPath)
    }
  }

  createTray(): void {
    this.tray = new Tray(this.iconPath())
    this.tray.setToolTip('Copilotix')
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '打开 Copilotix', click: () => this.show() },
        {
          label: '退出',
          click: () => {
            this.isQuitting = true
            app.quit()
          }
        }
      ])
    )
    this.tray.on('double-click', () => this.show())
  }

  show(): void {
    if (!this.mainWindow) return
    this.mainWindow.show()
    this.mainWindow.focus()
  }

  private iconPath(): string {
    return app.isPackaged ? join(process.resourcesPath, 'icon.png') : join(this.bundleDirectory, '../../resources/icon.png')
  }

  private emitWindowState(): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return
    emitEvent(this.mainWindow.webContents, windowChannels.stateChanged, windowState(this.mainWindow))
  }

  /** The window behind an IPC request, which must be the main window. */
  requestWindow(event: IpcInvokeEventLike): BrowserWindow {
    const window = BrowserWindow.fromWebContents(event.sender as Electron.WebContents)
    if (!window || window !== this.mainWindow) throw new Error('窗口操作来源无效')
    return window
  }
}

function windowState(window: BrowserWindow): WindowState {
  return { maximized: window.isMaximized() }
}

export function registerWindowIpc(ipc: IpcRegistrar, appShell: AppShell): void {
  ipc.handle(windowChannels.state, (event) => windowState(appShell.requestWindow(event)))
  ipc.handle(windowChannels.action, (event, action) => {
    const window = appShell.requestWindow(event)
    if (action === 'minimize') window.minimize()
    else if (action === 'toggle-maximize') {
      if (window.isMaximized()) window.unmaximize()
      else window.maximize()
    }
    else if (action === 'close') window.close()
    else throw new Error('不支持的窗口操作')
    return windowState(window)
  })
}

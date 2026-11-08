import { join } from 'node:path'
import { app, BrowserWindow, Menu, shell, Tray } from 'electron'
import type { EventChannel } from '@platform/ipc/contract/channels'
import { emitEvent, type IpcInvokeEventLike, type IpcRegistrar } from '@platform/ipc/main/ipc'
import { MINERU_API_TOKEN_URL, TUTORIAL_PAPER_SOURCE_URL } from '@features/library/contract/tutorialSample'
import type { WindowState } from '../contract/window'
import { windowChannels } from '../contract/window'

/**
 * The frameless main window, the reader windows opened from it, and the tray icon. Closing the main
 * window hides it and only the tray quits; a reader window closes for good.
 */
export class AppShell {
  mainWindow: BrowserWindow | null = null
  isQuitting = false
  private tray: Tray | null = null
  /** Reader windows by WebContents id, with the paper each was opened for. */
  private readonly readerWindows = new Map<number, { window: BrowserWindow; documentId: string }>()

  constructor(private readonly bundleDirectory: string) {}

  get rendererEntryPath(): string {
    return join(this.bundleDirectory, '../renderer/index.html')
  }

  createMainWindow(onRendererGone: () => void): void {
    Menu.setApplicationMenu(null)
    const mainWindow = this.createWindow(1440, 900)
    this.mainWindow = mainWindow
    mainWindow.webContents.on('destroyed', onRendererGone)
    mainWindow.webContents.on('render-process-gone', onRendererGone)
    mainWindow.on('close', (event) => {
      if (!this.isQuitting) {
        event.preventDefault()
        this.mainWindow?.hide()
      }
    })
  }

  /** A paper in a window of its own; the renderer asks which paper through `initialDocument`. */
  openDocumentWindow(documentId: string): void {
    const window = this.createWindow(1200, 860)
    const id = window.webContents.id
    this.readerWindows.set(id, { window, documentId })
    window.on('closed', () => this.readerWindows.delete(id))
  }

  initialDocument(event: IpcInvokeEventLike): string | null {
    const window = this.requestWindow(event)
    return this.readerWindows.get(window.webContents.id)?.documentId ?? null
  }

  /** Every live window of the app, the main one first. */
  windows(): BrowserWindow[] {
    return [this.mainWindow, ...[...this.readerWindows.values()].map((entry) => entry.window)]
      .filter((window): window is BrowserWindow => Boolean(window) && !window!.isDestroyed())
  }

  /** Library and background-work events reach every window showing papers. */
  broadcast<Payload>(channel: EventChannel<Payload>, value: Payload): void {
    for (const window of this.windows()) emitEvent(window.webContents, channel, value)
  }

  /** Native dialogs belong to the window the user is working in. */
  dialogParent(): BrowserWindow {
    const focused = BrowserWindow.getFocusedWindow()
    return focused && this.windows().includes(focused) ? focused : this.mainWindow!
  }

  createTray(): void {
    this.tray = new Tray(this.iconPath())
    this.tray.setToolTip(app.getName())
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `打开 ${app.getName()}`, click: () => this.show() },
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

  private createWindow(width: number, height: number): BrowserWindow {
    const window = new BrowserWindow({
      width,
      height,
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
    window.webContents.on('page-title-updated', (event) => event.preventDefault())
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (url === 'https://github.com/Kumiko-kmk/Copilotix' || url === TUTORIAL_PAPER_SOURCE_URL || url === MINERU_API_TOKEN_URL) void shell.openExternal(url)
      return { action: 'deny' }
    })
    window.once('ready-to-show', () => window.show())
    window.on('maximize', () => this.emitWindowState(window))
    window.on('unmaximize', () => this.emitWindowState(window))
    if (process.env.ELECTRON_RENDERER_URL) {
      void window.loadURL(process.env.ELECTRON_RENDERER_URL)
    } else {
      void window.loadFile(this.rendererEntryPath)
    }
    return window
  }

  private iconPath(): string {
    return app.isPackaged ? join(process.resourcesPath, 'icon.png') : join(this.bundleDirectory, '../../resources/icon.png')
  }

  private emitWindowState(window: BrowserWindow): void {
    if (window.isDestroyed()) return
    emitEvent(window.webContents, windowChannels.stateChanged, windowState(window))
  }

  /** The window behind an IPC request, which must be one of the app's own. */
  requestWindow(event: IpcInvokeEventLike): BrowserWindow {
    const window = BrowserWindow.fromWebContents(event.sender as Electron.WebContents)
    if (!window || !this.windows().includes(window)) throw new Error('窗口操作来源无效')
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
  ipc.handle(windowChannels.openDocument, (_event, documentId) => { appShell.openDocumentWindow(documentId) })
  ipc.handle(windowChannels.initialDocument, (event) => appShell.initialDocument(event))
}

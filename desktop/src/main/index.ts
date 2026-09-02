import { copyFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  net,
  Notification,
  protocol,
  shell,
  Tray
} from 'electron'
import { TaskRepository } from './database'
import { WindowsCredentialVault } from './credentialVault'
import { SettingsService } from './settingsService'
import { OfficialMinerUClient } from './parserClient'
import { ElectronFileUploader } from './fileUploader'
import { createAssetResponse } from './assetProtocol'
import { TaskService } from './taskService'
import { JsonLineLogger } from './logger'
import { createTranslationProviders } from './translation/providers'
import type {
  CreateTasksRequest,
  DeleteTaskRequest,
  ReplaceReaderAnnotationsRequest,
  SaveAsRequest,
  SettingsUpdate,
  TranslationProviderId,
  WindowAction,
  WindowState
} from '@shared/types'

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'mineru-asset',
    privileges: { secure: true, standard: true, supportFetchAPI: true, corsEnabled: true, stream: true }
  }
])

app.setName('MinerU')
const isolatedUserData = process.env.NODE_ENV === 'test' ? process.env.MINERU_E2E_USER_DATA : undefined
app.setPath('userData', isolatedUserData || join(app.getPath('appData'), 'MinerU-Translation'))

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false
let repository: TaskRepository | null = null

async function bootstrap(): Promise<void> {
  await app.whenReady()
  const userData = app.getPath('userData')
  await mkdir(userData, { recursive: true })
  repository = new TaskRepository(join(userData, 'mineru-desktop.sqlite3'))
  const vault = new WindowsCredentialVault()
  const settings = new SettingsService(repository, vault, join(app.getPath('documents'), 'MinerU'))
  const fetcher = (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
    net.fetch(input instanceof URL ? input.toString() : input, init)
  const parserClient = new OfficialMinerUClient(fetcher, new ElectronFileUploader())
  const logger = new JsonLineLogger(join(userData, 'mineru-desktop.log'))
  const tasks = new TaskService(repository, settings, vault, parserClient, fetcher, logger)

  protocol.handle('mineru-asset', (request) => createAssetResponse(request, (taskId, path) => tasks.resolveAsset(taskId, path)))

  registerIpc(tasks, settings, vault, parserClient, fetcher)
  createMainWindow()
  createTray()

  tasks.on('changed', (taskList) => mainWindow?.webContents.send('tasks:changed', taskList))
  tasks.on('notification', (taskId: string, status: 'completed' | 'partial' | 'failed') => {
    const task = repository?.getTask(taskId)
    if (!task || !Notification.isSupported()) return
    const notification = new Notification({
      title: status === 'failed' ? 'MinerU 任务失败' : status === 'partial' ? 'MinerU 部分翻译完成' : 'MinerU 任务完成',
      body: task.name
    })
    notification.on('click', () => {
      showMainWindow()
      mainWindow?.webContents.send('tasks:open', taskId)
    })
    notification.show()
  })

  app.on('activate', showMainWindow)
}

function createMainWindow(): void {
  Menu.setApplicationMenu(null)
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    title: '',
    icon: getRuntimeIconPath(),
    frame: false,
    roundedCorners: true,
    thickFrame: true,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#15171b' : '#f7f8fa',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })
  mainWindow.webContents.on('page-title-updated', (event) => event.preventDefault())
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url === 'https://github.com/Kumiko-kmk/MinerU') void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('maximize', emitWindowState)
  mainWindow.on('unmaximize', emitWindowState)
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function createTray(): void {
  tray = new Tray(getRuntimeIconPath())
  tray.setToolTip('MinerU')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开 MinerU', click: showMainWindow },
      {
        label: '退出',
        click: () => {
          isQuitting = true
          app.quit()
        }
      }
    ])
  )
  tray.on('double-click', showMainWindow)
}

function getRuntimeIconPath(): string {
  return app.isPackaged ? join(process.resourcesPath, 'icon.png') : join(__dirname, '../../resources/icon.png')
}

function showMainWindow(): void {
  if (!mainWindow) return
  mainWindow.show()
  mainWindow.focus()
}

function currentWindowState(window: BrowserWindow): WindowState {
  return { maximized: window.isMaximized() }
}

function emitWindowState(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('window:state-changed', currentWindowState(mainWindow))
}

function requestWindow(event: Electron.IpcMainInvokeEvent): BrowserWindow {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window || window !== mainWindow) throw new Error('窗口操作来源无效')
  return window
}

function registerIpc(
  tasks: TaskService,
  settings: SettingsService,
  vault: WindowsCredentialVault,
  parserClient: OfficialMinerUClient,
  fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
): void {
  ipcMain.handle('window:state', (event) => currentWindowState(requestWindow(event)))
  ipcMain.handle('window:action', (event, action: WindowAction) => {
    const window = requestWindow(event)
    if (action === 'minimize') window.minimize()
    else if (action === 'toggle-maximize') window.isMaximized() ? window.unmaximize() : window.maximize()
    else if (action === 'close') window.close()
    else throw new Error('不支持的窗口操作')
    return currentWindowState(window)
  })
  ipcMain.handle('settings:get', () => settings.get())
  ipcMain.handle('settings:save', (_event, update: SettingsUpdate) => settings.save(update))
  ipcMain.handle('settings:test-parser', async (_event, inputToken?: string) => {
    const token = inputToken?.trim() || (await vault.get('parser-token'))
    return parserClient.verifyToken(token)
  })
  ipcMain.handle('settings:test-translation', async (_event, providerId: TranslationProviderId) => {
    try {
      const current = await settings.get()
      const provider = createTranslationProviders(current, vault, fetcher).get(providerId)
      if (!provider || !(await provider.isAvailable())) return { ok: false, message: '缺少 API Key 或翻译源不可用' }
      const translated = await provider.translate('Academic paper')
      return { ok: Boolean(translated), message: translated ? `连接成功：${translated}` : '翻译源返回空结果' }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('dialog:output-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  ipcMain.handle('dialog:pdfs', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    })
    return result.canceled ? [] : tasks.inspectPdfs(result.filePaths)
  })
  ipcMain.handle('dialog:inspect-pdfs', (_event, paths: string[]) => tasks.inspectPdfs(paths.filter((path) => path.toLowerCase().endsWith('.pdf'))))
  ipcMain.handle('tasks:list', () => tasks.list())
  ipcMain.handle('tasks:create', (_event, request: CreateTasksRequest) => tasks.create(request))
  ipcMain.handle('tasks:retry', (_event, taskId: string) => tasks.retry(taskId))
  ipcMain.handle('tasks:delete', (_event, request: DeleteTaskRequest) => tasks.delete(request.taskId, request.deleteFiles))
  ipcMain.handle('document:get', (_event, taskId: string) => tasks.getDocument(taskId))
  ipcMain.handle('reader-annotations:get', (_event, taskId: string) => repository?.listReaderAnnotations(taskId) ?? [])
  ipcMain.handle('reader-annotations:replace', (_event, request: ReplaceReaderAnnotationsRequest) => {
    if (!repository) throw new Error('数据库尚未初始化')
    return repository.replaceReaderAnnotations(request)
  })
  ipcMain.handle('document:open-output', async (_event, taskId: string) => {
    const task = repository?.getTask(taskId)
    if (!task) throw new Error('任务不存在')
    const result = await shell.openPath(task.outputDir)
    if (result) throw new Error(result)
  })
  ipcMain.handle('document:save-as', async (_event, request: SaveAsRequest) => {
    const task = repository?.getTask(request.taskId)
    if (!task) throw new Error('任务不存在')
    const source =
      request.kind === 'original-markdown'
        ? join(task.outputDir, 'full.md')
        : request.kind === 'translated-markdown'
          ? join(task.outputDir, 'full.zh-CN.md')
          : null
    const extension = request.kind === 'result-zip' ? 'zip' : 'md'
    const exportStem = task.title?.trim() || task.name.replace(/\.pdf$/i, '')
    const result = await dialog.showSaveDialog(mainWindow!, {
      defaultPath: join(app.getPath('downloads'), `${exportStem}${request.kind === 'translated-markdown' ? '.zh-CN' : ''}.${extension}`),
      filters: [{ name: extension.toUpperCase(), extensions: [extension] }]
    })
    if (result.canceled || !result.filePath) return null
    if (source) await copyFile(source, result.filePath)
    else await tasks.createResultZip(task.id, result.filePath)
    return result.filePath
  })
}

app.on('before-quit', () => {
  isQuitting = true
})

app.on('window-all-closed', () => {
  // Keep the background queue alive in the tray on Windows.
})

app.on('quit', () => repository?.close())

void bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack || error.message : String(error)
  console.error(message)
  dialog.showErrorBox('MinerU 启动失败', message)
  app.quit()
})

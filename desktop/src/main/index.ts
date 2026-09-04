import { copyFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeTheme,
  net,
  Notification,
  protocol,
  shell,
  Tray
} from 'electron'
import type { TaskRepositoryCompat } from './taskRepositoryCompat'
import { RpcTaskRepository } from './rpcTaskRepository'
import { RpcTaskCompute } from './rpcTaskCompute'
import { WindowsCredentialVault } from './credentialVault'
import { SettingsService } from './settingsService'
import { OfficialMinerUClient } from './parserClient'
import { ElectronFileUploader } from './fileUploader'
import { createAssetResponse } from './assetProtocol'
import { TaskService } from './taskService'
import { JsonLineLogger } from './logger'
import { createTranslationProviders } from './translation/providers'
import { registerValidatedHandler, sendValidatedEvent, type IpcInvokeEventLike } from './ipc'
import {
  appSettingsSchema,
  healthResultSchema,
  noRequestSchema,
  outputDirectorySchema,
  parserTokenSchema,
  providerIdRequestSchema,
  settingsUpdateSchema,
  voidResponseSchema,
  windowActionSchema,
  windowStateSchema
} from '@shared/ipcSchemas'
import {
  deleteDocumentRequestSchema,
  documentChangeEventSchema,
  documentDetailsSchema,
  documentIdRequestSchema,
  documentSummarySchema,
  importDocumentsIpcRequestSchema,
  listReaderAnnotationsRequestSchema,
  mutateReaderAnnotationsRequestSchema,
  readerAnnotationSnapshotSchema,
  saveDocumentAsRequestSchema,
  saveDocumentAsResultSchema,
  type DocumentSummary
} from '@shared/ipcSchemas'
import type { WindowState } from '@shared/types'
import { computeDocumentChange, projectDocumentDetails, projectDocumentSummary } from './documentProjection'
import { UtilitySupervisor } from './utilitySupervisor'
import { forkUtilityProcess } from './electronUtilityFork'
import { RpcJobRepository } from './rpcJobRepository'
import { JobScheduler } from './jobScheduler'
import { ParseJobRunner } from './parseJobRunner'
import { TranslationJobRunner } from './translationJobRunner'
import { PathPolicy } from './pathPolicy'
import { formatPackagedSmokeMarker, shouldRunPackagedSmoke } from '@shared/packagedSmoke'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false
let repository: TaskRepositoryCompat | null = null
let documentRevision = 0
let documentSummaries = new Map<string, DocumentSummary>()
let utilitySupervisor: UtilitySupervisor | null = null
let utilityShutdownPromise: Promise<void> | null = null
let jobScheduler: JobScheduler | null = null

const packagedSmokeMode = shouldRunPackagedSmoke(process.argv, app.isPackaged)

if (packagedSmokeMode) {
  writePackagedSmokeMarker()
} else {
  startNormalApp()
}

async function bootstrap(): Promise<void> {
  await app.whenReady()
  utilitySupervisor = new UtilitySupervisor({
    entryPath: join(__dirname, '../utility/index.js'),
    fork: forkUtilityProcess,
    bootstrap: {
      databasePath: join(app.getPath('userData'), 'mineru-desktop-v2.sqlite3'),
      outputRoot: join(app.getPath('documents'), 'MinerU')
    }
  })
  await utilitySupervisor.start()
  const jobRepository = new RpcJobRepository(utilitySupervisor)
  jobScheduler = new JobScheduler(jobRepository)
  const userData = app.getPath('userData')
  await mkdir(userData, { recursive: true })
  repository = new RpcTaskRepository(utilitySupervisor)
  const vault = new WindowsCredentialVault()
  const settings = new SettingsService(repository, vault, join(app.getPath('documents'), 'MinerU'))
  const fetcher = (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
    net.fetch(input instanceof URL ? input.toString() : input, init)
  const parserClient = new OfficialMinerUClient(fetcher, new ElectronFileUploader())
  const logger = new JsonLineLogger(join(userData, 'mineru-desktop.log'))
  const compute = new RpcTaskCompute(utilitySupervisor)
  const pathPolicy = new PathPolicy()
  const tasks = new TaskService(repository, settings, vault, parserClient, fetcher, logger, compute, pathPolicy, {
    jobRepository,
    scheduler: jobScheduler
  })
  documentSummaries = new Map((await tasks.list()).map((task) => {
    const summary = projectDocumentSummary(task)
    return [summary.id, summary] as const
  }))
  documentRevision = 0

  protocol.handle('mineru-asset', (request) => createAssetResponse(request, (taskId, path) => tasks.resolveAsset(taskId, path)))

  registerIpc(tasks, settings, vault, parserClient, fetcher)
  createMainWindow()
  createTray()

  tasks.on('changed', (taskList) => {
    const computation = computeDocumentChange(
      documentSummaries,
      taskList.map(projectDocumentSummary),
      documentRevision
    )
    documentSummaries = computation.next
    if (computation.event && mainWindow) {
      documentRevision = computation.event.revision
      sendValidatedEvent(mainWindow.webContents, 'documents:changed', documentChangeEventSchema, computation.event)
    } else if (computation.event) {
      documentRevision = computation.event.revision
    }
  })
  tasks.on('notification', async (taskId: string, status: 'completed' | 'partial' | 'failed') => {
    const task = await repository?.getTask(taskId)
    if (!task || !Notification.isSupported()) return
    const notification = new Notification({
      title: status === 'failed' ? 'MinerU 任务失败' : status === 'partial' ? 'MinerU 部分翻译完成' : 'MinerU 任务完成',
      body: task.name
    })
    notification.on('click', () => {
      showMainWindow()
      if (mainWindow) sendValidatedEvent(mainWindow.webContents, 'documents:open', documentIdRequestSchema, taskId)
    })
    notification.show()
  })

  jobScheduler.registerRunner('parse', new ParseJobRunner({
    repository,
    jobRepository,
    settingsService: settings,
    vault,
    parserClient,
    compute,
    pathPolicy,
    logger
  }))
  jobScheduler.registerRunner('translate', new TranslationJobRunner({
    repository,
    settingsService: settings,
    vault,
    fetcher,
    compute,
    pathPolicy,
    logger
  }))
  await jobScheduler.start()

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
  sendValidatedEvent(mainWindow.webContents, 'window:state-changed', windowStateSchema, currentWindowState(mainWindow))
}

function requestWindow(event: IpcInvokeEventLike): BrowserWindow {
  const window = BrowserWindow.fromWebContents(event.sender as Electron.WebContents)
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
  const validationOptions = {
    getMainWindow: () => mainWindow,
    rendererEntryPath: join(__dirname, '../renderer/index.html'),
    rendererOrigin: process.env.ELECTRON_RENDERER_URL
  }

  registerValidatedHandler('window:state', noRequestSchema, windowStateSchema, (event) => currentWindowState(requestWindow(event)), validationOptions)
  registerValidatedHandler('window:action', windowActionSchema, windowStateSchema, (event, action) => {
    const window = requestWindow(event)
    if (action === 'minimize') window.minimize()
    else if (action === 'toggle-maximize') {
      if (window.isMaximized()) window.unmaximize()
      else window.maximize()
    }
    else if (action === 'close') window.close()
    else throw new Error('不支持的窗口操作')
    return currentWindowState(window)
  }, validationOptions)
  registerValidatedHandler('settings:get', noRequestSchema, appSettingsSchema, () => settings.get(), validationOptions)
  registerValidatedHandler('settings:save', settingsUpdateSchema, appSettingsSchema, (_event, update) => settings.save(update), validationOptions)
  registerValidatedHandler('settings:test-parser', parserTokenSchema, healthResultSchema, async (_event, inputToken) => {
    const token = inputToken?.trim() || (await vault.get('parser-token'))
    return parserClient.verifyToken(token)
  }, validationOptions)
  registerValidatedHandler('settings:test-translation', providerIdRequestSchema, healthResultSchema, async (_event, providerId) => {
    try {
      const current = await settings.get()
      const provider = createTranslationProviders(current, vault, fetcher).get(providerId)
      if (!provider || !(await provider.isAvailable())) return { ok: false, message: '缺少 API Key 或翻译源不可用' }
      const translated = await provider.translate('Academic paper')
      return { ok: Boolean(translated), message: translated ? `连接成功：${translated}` : '翻译源返回空结果' }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }, validationOptions)
  registerValidatedHandler('dialog:output-directory', noRequestSchema, outputDirectorySchema, async () => {
    const result = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  }, validationOptions)
  registerValidatedHandler('documents:import', importDocumentsIpcRequestSchema, documentSummarySchema.array(), async (_event, request) => {
    let paths = request.paths
    if (paths === undefined) {
      const result = await dialog.showOpenDialog(mainWindow!, {
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'PDF', extensions: ['pdf'] }]
      })
      if (result.canceled) return []
      paths = result.filePaths
    }
    const created = await tasks.importPaths(paths.filter((path) => path.toLowerCase().endsWith('.pdf')), request.options)
    return created.map(projectDocumentSummary)
  }, validationOptions)
  registerValidatedHandler('documents:list', noRequestSchema, documentSummarySchema.array(), async () => {
    if (documentSummaries.size === 0) {
      const current = repository?.listDocumentSummaries
        ? await repository.listDocumentSummaries()
        : (await tasks.list()).map(projectDocumentSummary)
      documentSummaries = new Map(current.map((summary) => [summary.id, summary] as const))
    }
    return [...documentSummaries.values()]
  }, validationOptions)
  registerValidatedHandler('documents:retry', documentIdRequestSchema, voidResponseSchema, (_event, documentId) => {
    return tasks.retry(documentId)
  }, validationOptions)
  registerValidatedHandler('documents:delete', deleteDocumentRequestSchema, voidResponseSchema, (_event, request) => {
    return tasks.delete(request.documentId, request.deleteFiles)
  }, validationOptions)
  registerValidatedHandler('documents:get', documentIdRequestSchema, documentDetailsSchema, async (_event, documentId) => {
    return projectDocumentDetails(await tasks.getDocument(documentId))
  }, validationOptions)
  registerValidatedHandler('documents:open-output', documentIdRequestSchema, voidResponseSchema, async (_event, documentId) => {
    const task = await repository?.getTask(documentId)
    if (!task) throw new Error('文档不存在')
    const result = await shell.openPath(task.outputDir)
    if (result) throw new Error(result)
  }, validationOptions)
  registerValidatedHandler('documents:save-as', saveDocumentAsRequestSchema, saveDocumentAsResultSchema, async (_event, request) => {
    const task = await repository?.getTask(request.documentId)
    if (!task) throw new Error('文档不存在')
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
    if (result.canceled || !result.filePath) return { saved: false }
    if (source) await copyFile(source, result.filePath)
    else await tasks.createResultZip(task.id, result.filePath)
    return { saved: true }
  }, validationOptions)
  registerValidatedHandler('reader-annotations:list', listReaderAnnotationsRequestSchema, readerAnnotationSnapshotSchema, async (_event, request) => {
    if (!repository?.listDocumentAnnotations) throw new Error('数据库尚未初始化')
    return repository.listDocumentAnnotations(request)
  }, validationOptions)
  registerValidatedHandler('reader-annotations:mutate', mutateReaderAnnotationsRequestSchema, readerAnnotationSnapshotSchema, async (_event, request) => {
    if (!repository?.mutateDocumentAnnotations) throw new Error('数据库尚未初始化')
    return repository.mutateDocumentAnnotations(request)
  }, validationOptions)
}

function startupErrorCode(error: unknown): 'CORE_TIMEOUT' | 'CORE_UNAVAILABLE' | 'CORE_PROTOCOL_ERROR' {
  const code = error && typeof error === 'object' && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined
  return code === 'CORE_TIMEOUT' || code === 'CORE_PROTOCOL_ERROR' || code === 'CORE_UNAVAILABLE'
    ? code
    : 'CORE_UNAVAILABLE'
}

function startNormalApp(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'mineru-asset',
      privileges: { secure: true, standard: true, supportFetchAPI: true, corsEnabled: true, stream: true }
    }
  ])

  app.setName('MinerU')
  const isolatedUserData = process.env.NODE_ENV === 'test' ? process.env.MINERU_E2E_USER_DATA : undefined
  app.setPath('userData', isolatedUserData || join(app.getPath('appData'), 'MinerU-Translation-v2'))

  app.on('before-quit', (event) => {
    isQuitting = true
    if (!utilitySupervisor || utilitySupervisor.isStopped() || utilityShutdownPromise) return
    event.preventDefault()
    utilityShutdownPromise = (jobScheduler?.shutdown() ?? Promise.resolve()).catch(() => undefined).then(() => utilitySupervisor!.shutdown()).catch(() => undefined).then(() => {
      app.quit()
    })
  })

  app.on('window-all-closed', () => {
    // Keep the background queue alive in the tray on Windows.
  })

  void bootstrap().catch((error: unknown) => {
    // Keep startup diagnostics free of stack traces, local paths and credentials.
    const code = startupErrorCode(error)
    console.error(`MinerU startup failed [${code}]`)
    // Playwright and other headless checks must not wait on a native modal.
    if (process.env.NODE_ENV !== 'test') dialog.showErrorBox('MinerU 启动失败', '核心服务无法启动，请重试。')
    app.quit()
  })
}

function writePackagedSmokeMarker(): void {
  try {
    const marker = formatPackagedSmokeMarker({
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron ?? ''
    })
    process.stdout.write(marker, 'utf8', (error) => {
      app.exit(error ? 1 : 0)
    })
  } catch {
    app.exit(1)
  }
}

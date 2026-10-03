import { sanitizeTitleStem } from '@shared/titleNaming'
import { TUTORIAL_PAPER_BYTES, TUTORIAL_PAPER_SHA256, TUTORIAL_PAPER_SOURCE_URL, MINERU_API_TOKEN_URL } from '@shared/tutorialSample'
import { verifiedTutorialPaperPath } from './tutorialSample'
import { libraryRequestSchema, libraryResultSchema } from '@shared/librarySchemas'
import { LibraryAccessGate } from './libraryAccessGate'
import { acquirePrimaryInstance } from './singleInstance'
import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  net,
  Notification,
  protocol,
  session,
  shell,
  Tray
} from 'electron'
import type { TaskRepositoryCompat } from './taskRepositoryCompat'
import { RpcTaskRepository } from './rpcTaskRepository'
import { RpcTaskCompute } from './rpcTaskCompute'
import { WindowsCredentialVault } from './credentialVault'
import { SettingsService } from './settingsService'
import { OfficialParserClient } from './parserClient'
import { ElectronFileUploader } from './fileUploader'
import { createAssetResponse } from './assetProtocol'
import { TaskService } from './taskService'
import { JsonLineLogger } from './logger'
import { probeOpenAiCompatibleCredential } from './translation/providers'
import { refreshNetworkProxy } from './networkProxy'
import { registerValidatedHandler, sendValidatedEvent, type IpcInvokeEventLike } from './ipc'
import {
  appSettingsSchema,
  credentialValidationRequestSchema,
  credentialValidationResultSchema,
  noRequestSchema,
  outputDirectorySchema,
  settingsSaveResultSchema,
  settingsUpdateSchema,
  storageInfoSchema,
  usageAnalyticsSchema,
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
  tutorialImportRequestSchema,
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
import { RagContentIndexJobRunner } from './ragContentIndexJobRunner'
import { RpcRagContentIndexer } from './rpcRagContentIndexer'
import { PathPolicy } from './pathPolicy'
import { formatPackagedSmokeMarker, shouldRunPackagedSmoke } from '@shared/packagedSmoke'
import { inspectStorage } from './storageService'
import { resolveUtilityEntryPath } from './utilityEntryPath'
import { UsageAnalyticsService } from './usageAnalyticsService'
import { runUninstallCleanup, UNINSTALL_CLEANUP_ARG } from './uninstallCleanup'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false
let repository: TaskRepositoryCompat | null = null
let documentRevision = 0
let documentSummaries = new Map<string, DocumentSummary>()
let utilitySupervisor: UtilitySupervisor | null = null
let utilityShutdownPromise: Promise<void> | null = null
let jobScheduler: JobScheduler | null = null
let startupPhase = 'module-load'
const libraryGate = new LibraryAccessGate()

const packagedSmokeMode = shouldRunPackagedSmoke(process.argv, app.isPackaged)

if (app.isPackaged && process.argv.includes(UNINSTALL_CLEANUP_ARG)) {
  void runUninstallCleanup()
} else if (packagedSmokeMode) {
  void runPackagedSmoke()
} else {
  startNormalApp()
}

async function bootstrap(): Promise<void> {
  startupPhase = 'app-ready'
  await app.whenReady()
  startupPhase = 'core-start'
  utilitySupervisor = new UtilitySupervisor({
    entryPath: resolveUtilityEntryPath({
      isPackaged: app.isPackaged,
      bundleDirectory: __dirname,
      resourcesPath: process.resourcesPath
    }),
    fork: forkUtilityProcess,
    bootstrap: {
      databasePath: join(app.getPath('userData'), 'copilotix-desktop-v2.sqlite3'),
      outputRoot: join(app.getPath('documents'), 'Copilotix')
    }
  })
  await utilitySupervisor.start()
  startupPhase = 'repository-init'
  const jobRepository = new RpcJobRepository(utilitySupervisor)
  jobScheduler = new JobScheduler(jobRepository)
  jobScheduler.registerRunner('rag-content-index', new RagContentIndexJobRunner(new RpcRagContentIndexer(utilitySupervisor)))
  const userData = app.getPath('userData')
  await mkdir(userData, { recursive: true })
  repository = new RpcTaskRepository(utilitySupervisor)
  const vault = new WindowsCredentialVault()
  const fetcher = (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
    net.fetch(input instanceof URL ? input.toString() : input, init)
  const parserClient = new OfficialParserClient(fetcher, new ElectronFileUploader())
  const settings = new SettingsService(repository, vault, join(app.getPath('documents'), 'Copilotix'), {
    parser: async (value) => {
      await refreshNetworkProxy(session.defaultSession)
      return parserClient.verifyToken(value)
    },
    provider: async (name, value, current) => {
      await refreshNetworkProxy(session.defaultSession)
      return probeOpenAiCompatibleCredential(name, current, value, fetcher)
    }
  })
  startupPhase = 'settings-init'
  await settings.initialize()
  const logger = new JsonLineLogger(join(userData, 'copilotix-desktop.log'))
  const usageAnalytics = new UsageAnalyticsService(join(userData, 'usage-analytics-v1.json'))
  const compute = new RpcTaskCompute(utilitySupervisor)
  const pathPolicy = new PathPolicy()
  const tasks = new TaskService(repository, settings, vault, parserClient, fetcher, logger, compute, pathPolicy, {
    jobRepository,
    scheduler: jobScheduler
  })
  startupPhase = 'documents-load'
  documentSummaries = new Map((await repository.listDocumentSummaries!()).map((summary) => [summary.id, summary] as const))
  documentRevision = 0

  startupPhase = 'protocol-register'
  protocol.handle('copilotix-asset', (request) => createAssetResponse(request, (taskId, path) => tasks.resolveAsset(taskId, path)))

  registerIpc(tasks, settings, usageAnalytics)
  startupPhase = 'window-create'
  createMainWindow()
  startupPhase = 'tray-create'
  createTray()

  let documentChangeTail = Promise.resolve()
  tasks.on('changed', () => {
    documentChangeTail = documentChangeTail.then(async () => {
      const current = await repository!.listDocumentSummaries!()
      const computation = computeDocumentChange(documentSummaries, current, documentRevision)
      documentSummaries = computation.next
      if (computation.event) {
        documentRevision = computation.event.revision
        if (mainWindow) sendValidatedEvent(mainWindow.webContents, 'documents:changed', documentChangeEventSchema, computation.event)
      }
    }).catch(() => logger.error('documents.refresh.failed', {}))
  })
  tasks.on('notification', async (taskId: string, status: 'completed' | 'partial' | 'failed') => {
    const task = await repository?.getTask(taskId)
    if (!task || !Notification.isSupported()) return
    const notification = new Notification({
      title: status === 'failed' ? 'Copilotix 任务失败' : status === 'partial' ? 'Copilotix 部分翻译完成' : 'Copilotix 任务完成',
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
    logger,
    usageAnalytics,
    concurrency: {
      upload: jobScheduler.getConcurrency().upload,
      download: jobScheduler.getConcurrency().normalize,
      extract: jobScheduler.getConcurrency().normalize,
      normalize: jobScheduler.getConcurrency().normalize
    }
  }))
  jobScheduler.registerRunner('translate', new TranslationJobRunner({
    repository,
    settingsService: settings,
    vault,
    fetcher,
    compute,
    pathPolicy,
    logger,
    usageAnalytics
  }))
  startupPhase = 'scheduler-start'
  await jobScheduler.start()

  app.on('activate', showMainWindow)
  startupPhase = 'ready'
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
    backgroundColor: '#f7f2e8',
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
    if (url === 'https://github.com/Kumiko-kmk/Copilotix' || url === TUTORIAL_PAPER_SOURCE_URL || url === MINERU_API_TOKEN_URL) void shell.openExternal(url)
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
  tray.setToolTip('Copilotix')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开 Copilotix', click: showMainWindow },
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
  usageAnalytics: UsageAnalyticsService
): void {
  const validationOptions = {
    gate: libraryGate,
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
  registerValidatedHandler('library:manage', libraryRequestSchema, libraryResultSchema, async (_event, request) => {
    if (!utilitySupervisor || !jobScheduler) throw new Error('文档库尚未初始化')
    const title = request.action === 'backup' ? '选择备份保存目录' : request.action === 'restore' ? '选择包含 manifest.json 的备份目录' : '选择空目录迁移文档库'
    const selected = await dialog.showOpenDialog(mainWindow!, { title, properties: ['openDirectory', 'createDirectory'] })
    if (selected.canceled || !selected.filePaths[0]) return { status: 'cancelled' as const, restartRequired: false }
    if (request.action !== 'backup') {
      const confirmation = await dialog.showMessageBox(mainWindow!, {
        type: 'warning', title,
        message: request.action === 'restore' ? '用所选备份替换当前文档库？' : '将全部文档迁移到所选目录？',
        detail: request.action === 'restore'
          ? '恢复前会完整备份当前文档库。现有文件会保留，API 密钥不变；完成后自动重启。仅支持相同数据库版本的备份。'
          : '全部文档复制并校验成功后才切换位置，原文件保留。完成后自动重启。',
        buttons: ['取消', '继续'], defaultId: 0, cancelId: 0, noLink: true
      })
      if (confirmation.response !== 1) return { status: 'cancelled' as const, restartRequired: false }
    }
    await utilitySupervisor.request('library:check', {})
    await jobScheduler.shutdown()
    try {
      const result = await utilitySupervisor.request('library:manage', { ...request, path: selected.filePaths[0] }, { timeoutMs: 2 * 60 * 60 * 1000 })
      if (result.restartRequired) {
        libraryGate.requireRestart()
        setTimeout(() => { app.relaunch(); app.quit() }, 1200)
      }
      return result
    } finally {
      if (!libraryGate.restarting) await jobScheduler.start()
    }
  }, validationOptions)
  registerValidatedHandler('settings:get', noRequestSchema, appSettingsSchema, () => settings.get(), validationOptions)
  registerValidatedHandler('settings:save', settingsUpdateSchema, settingsSaveResultSchema, (_event, update) => settings.save(update), validationOptions)
  registerValidatedHandler('settings:validate-credential', credentialValidationRequestSchema, credentialValidationResultSchema, (_event, request) => settings.validateCredential(request.name, request.value), validationOptions)
  registerValidatedHandler('dialog:output-directory', noRequestSchema, outputDirectorySchema, async () => {
    const result = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  }, validationOptions)
  registerValidatedHandler('storage:info', noRequestSchema, storageInfoSchema, async () => {
    const current = await settings.get()
    return inspectStorage(current.outputRoot)
  }, validationOptions)
  registerValidatedHandler('analytics:usage', noRequestSchema, usageAnalyticsSchema, async () => {
    return usageAnalytics.snapshot(await tasks.list())
  }, validationOptions)
  registerValidatedHandler('storage:open-location', noRequestSchema, voidResponseSchema, async () => {
    const current = await settings.get()
    await mkdir(current.outputRoot, { recursive: true })
    const result = await shell.openPath(current.outputRoot)
    if (result) throw new Error(result)
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
  registerValidatedHandler('tutorial:import-paper', tutorialImportRequestSchema, documentSummarySchema.nullable(), async (_event, request) => {
    const samplePath = await verifiedTutorialPaperPath({
      isPackaged: app.isPackaged,
      bundleDirectory: __dirname,
      resourcesPath: process.resourcesPath
    })
    const selection = await dialog.showOpenDialog(mainWindow!, {
      defaultPath: samplePath,
      properties: ['openFile'],
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    })
    if (selection.canceled || !selection.filePaths[0]) return null
    const selectedPath = selection.filePaths[0]
    if ((await stat(selectedPath)).size !== TUTORIAL_PAPER_BYTES) throw new Error('新手教程请选择窗口中预选的内置论文 Attention Is All You Need')
    const selectedHash = createHash('sha256').update(await readFile(selectedPath)).digest('hex')
    if (selectedHash !== TUTORIAL_PAPER_SHA256) throw new Error('新手教程请选择窗口中预选的内置论文 Attention Is All You Need')
    const created = await tasks.importPaths([selectedPath], { createDuplicates: request.createDuplicate, useOriginalFilename: false })
    if (created[0]) return projectDocumentSummary(created[0])
    const existing = (await tasks.list()).find((task) => task.sourceHash === TUTORIAL_PAPER_SHA256)
    if (!existing) throw new Error('内置教程论文导入失败')
    return projectDocumentSummary(existing)
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
    const details = projectDocumentDetails(await tasks.getDocument(documentId))
    const summary = await repository?.getDocumentSummary?.(documentId)
    return summary ? { ...details, summary } : details
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
    const exportStem = sanitizeTitleStem(task.title?.trim() || task.name.replace(/\.pdf$/i, '')) ?? `paper-${task.id.slice(0, 8)}`
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
      scheme: 'copilotix-asset',
      privileges: { secure: true, standard: true, supportFetchAPI: true, corsEnabled: true, stream: true }
    }
  ])

  app.setName('Copilotix')
  const isolatedUserData = process.env.NODE_ENV === 'test' ? process.env.COPILOTIX_E2E_USER_DATA : undefined
  app.setPath('userData', isolatedUserData || join(app.getPath('appData'), 'Copilotix-Translation-v2'))
  if (!acquirePrimaryInstance(app, () => mainWindow)) return

  app.on('before-quit', (event) => {
    if (libraryGate.busy) { event.preventDefault(); return }
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
    console.error(`Copilotix startup failed [${code}] phase=${startupPhase}`)
    if (process.env.COPILOTIX_STARTUP_DIAGNOSTICS === 'true') {
      console.error(error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error))
    }
    // Playwright and other headless checks must not wait on a native modal.
    if (process.env.NODE_ENV !== 'test') {
      const message = (startupPhase === 'core-start' || startupPhase === 'repository-init')
        ? '核心服务或文档数据库无法初始化。请勿删除原数据库或使用更旧版本反复尝试。升级前快照（如已生成）保存在下方目录，名称含 pre-migration；恢复方法见文档库管理指南。\n\n' + app.getPath('userData')
        : '核心服务无法启动，请重试。'
      dialog.showErrorBox('Copilotix 启动失败', message)
    }
    app.quit()
  })
}

async function runPackagedSmoke(): Promise<void> {
  let smokeRoot: string | undefined
  let supervisor: UtilitySupervisor | undefined
  try {
    await app.whenReady()
    smokeRoot = await mkdtemp(join(app.getPath('temp'), 'copilotix-packaged-smoke-'))
    supervisor = new UtilitySupervisor({
      entryPath: resolveUtilityEntryPath({
        isPackaged: app.isPackaged,
        bundleDirectory: __dirname,
        resourcesPath: process.resourcesPath
      }),
      fork: forkUtilityProcess,
      bootstrap: {
        databasePath: join(smokeRoot, 'smoke.sqlite3'),
        outputRoot: smokeRoot
      }
    })
    await supervisor.start()
    await supervisor.request('ping', {})
    const marker = formatPackagedSmokeMarker({
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron ?? ''
    })
    await supervisor.shutdown()
    supervisor = undefined
    await rm(smokeRoot, { recursive: true, force: true })
    smokeRoot = undefined
    process.stdout.write(marker, 'utf8', (error) => app.exit(error ? 1 : 0))
  } catch {
    await supervisor?.shutdown().catch(() => undefined)
    if (smokeRoot) await rm(smokeRoot, { recursive: true, force: true }).catch(() => undefined)
    app.exit(1)
  }
}

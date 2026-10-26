import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { app, dialog, nativeImage, net, protocol, session, shell } from 'electron'
import { createAssetResponse } from '@platform/assets/main/assetProtocol'
import { DEFAULT_CODEX_SETTINGS } from '@platform/codex/contract/codex'
import { registerCodexIpc } from '@platform/codex/main/ipc'
import { CodexRuntime } from '@platform/codex/runtime/codexRuntime'
import { credentialServiceForRuntime, WindowsCredentialVault } from '@platform/credentials/main/credentialVault'
import { PathPolicy } from '@platform/files/runtime/pathPolicy'
import { createIpcRegistrar, emitEvent } from '@platform/ipc/main/ipc'
import { JobScheduler } from '@platform/jobs/main/jobScheduler'
import { RpcJobRepository } from '@platform/jobs/main/rpcJobRepository'
import { JsonLineLogger } from '@platform/log/main/logger'
import { refreshNetworkProxy } from '@platform/network/main/networkProxy'
import { forkUtilityProcess } from '@platform/rpc/main/electronUtilityFork'
import { resolveUtilityEntryPath } from '@platform/rpc/main/utilityEntryPath'
import { UtilitySupervisor } from '@platform/rpc/main/utilitySupervisor'
import { registerPaperChatHandlers, ChatProvider, ModelGateway, PaperChatService, RagContentIndexJobRunner, RpcRagContentIndexer } from '@features/chat/main'
import { figureInsightChannels, paperInsightChannels } from '@features/insight/contract/ipc'
import { registerFigureInsightHandlers, registerPaperInsightHandlers, FigureInsightService, loadFullBriefContext, PaperInsightService } from '@features/insight/main'
import { libraryChannels } from '@features/library/contract/ipc'
import { DocumentFeed, registerLibraryIpc, registerTaskNotifications, RpcTaskCompute, RpcTaskRepository, TaskService } from '@features/library/main'
import { registerParsingIpc, ElectronFileUploader, ParseJobRunner, OfficialParserClient } from '@features/parsing/main'
import { registerReaderIpc, type ReaderIpcDeps, FigureDisplayStore } from '@features/reader/main'
import { registerSettingsIpc, SettingsService, UsageAnalyticsService } from '@features/settings/main'
import { registerTranslationIpc, probeOpenAiCompatibleCredential, TranslationJobRunner } from '@features/translation/main'
import { createZoteroExportService, createZoteroImportService, registerZoteroExportHandler, registerZoteroHandlers } from '@features/zotero/main'
import { paperChatImageInput } from '@features/chat/contract/paperChatFigures'
import { coreProtocol } from '../contract/coreRpc'
import { appShell, libraryGate, services, startup } from './services'
import { registerWindowIpc } from './window'

/** Starts Utility, composes every module's services and registers their IPC, then opens the window. */
export async function bootstrap(): Promise<void> {
  startup.phase = 'app-ready'
  await app.whenReady()
  startup.phase = 'core-start'
  const utility = new UtilitySupervisor({
    protocol: coreProtocol,
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
  services.utility = utility
  await utility.start()
  startup.phase = 'repository-init'
  const jobRepository = new RpcJobRepository(utility)
  const jobScheduler = new JobScheduler(jobRepository)
  services.scheduler = jobScheduler
  jobScheduler.registerRunner('rag-content-index', new RagContentIndexJobRunner(new RpcRagContentIndexer(utility)))
  const userData = app.getPath('userData')
  await mkdir(userData, { recursive: true })
  const repository = new RpcTaskRepository(utility)
  const vault = new WindowsCredentialVault(credentialServiceForRuntime({
    isPackaged: app.isPackaged,
    nodeEnv: process.env.NODE_ENV,
    e2eUserData: process.env.COPILOTIX_E2E_USER_DATA
  }))
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
  startup.phase = 'settings-init'
  await settings.initialize()
  const logger = new JsonLineLogger(join(userData, 'copilotix-desktop.log'))
  const usageAnalytics = new UsageAnalyticsService(join(userData, 'usage-analytics-v1.json'))
  const codex = new CodexRuntime(join(userData, 'codex-runtime'), async () => (await settings.get()).codex ?? DEFAULT_CODEX_SETTINGS, (event, details) => logger.info(event, details))
  services.codex = codex
  const chatProvider = new ChatProvider(fetcher, { invalidate: (provider) => settings.invalidateCredential(provider) })
  const modelGateway = new ModelGateway(chatProvider, codex)
  const providerKey = (provider: 'qwen' | 'deepseek' | 'codex'): Promise<string | null> =>
    provider === 'codex' ? Promise.resolve(null) : vault.get(provider === 'qwen' ? 'qwen-api-key' : 'deepseek-api-key')
  const canStartBackground = (): boolean => !libraryGate.busy && !libraryGate.restarting && !appShell.isQuitting
  const toRenderer = (): Electron.WebContents | null => appShell.mainWindow && !appShell.mainWindow.webContents.isDestroyed() ? appShell.mainWindow.webContents : null
  const figureInsight = new FigureInsightService({
    settings: () => settings.get(),
    key: providerKey,
    descriptor: (request, signal) => utility.request('compute:figure-insight-descriptor', request, { signal, timeoutMs: 30_000 }),
    get: request => utility.request('figureInsight:get', request),
    save: request => utility.request('figureInsight:save', request, { timeoutMs: 30_000 }),
    stream: input => modelGateway.stream(input),
    encodeImage: async png => {
      if (png.length <= 2 * 1024 * 1024) return { bytes: png, mimeType: 'image/png' }
      const image = nativeImage.createFromBuffer(png)
      if (image.isEmpty()) throw new Error('无法编码整图')
      const jpeg = image.toJPEG(98)
      return jpeg.length < png.length ? { bytes: jpeg, mimeType: 'image/jpeg', jpegQuality: 98 } : { bytes: png, mimeType: 'image/png' }
    },
    recordUsage: (provider, usage) => usageAnalytics.recordTokens(provider, usage),
    canStart: canStartBackground,
    changed: (request, state) => {
      const contents = toRenderer()
      if (contents) emitEvent(contents, figureInsightChannels.changed, { ...request, state })
    }
  })
  services.figureInsight = figureInsight
  const paperChat = new PaperChatService({
    saveTurn: (documentId, turn) => utility.request('chat:save-turn', { documentId, turn }),
    load: (request) => utility.request('chat:load', request),
    session: (documentId) => utility.request('chat:session', { documentId }),
    saveSession: (documentId, session) => utility.request('chat:save-session', { documentId, session }),
    deleteTurn: (request) => utility.request('chat:delete-turn', request),
    clear: (documentId) => utility.request('chat:clear', { documentId }),
    settings: () => settings.get(),
    key: providerKey,
    buildContext: (request, signal) => utility.request('chat:build-context', request, { signal, timeoutMs: 10_000 }),
    stream: (input) => modelGateway.stream(input),
    recordUsage: (provider, usage) => usageAnalytics.recordTokens(provider, usage),
    log: (details) => logger.info('paper-chat', details),
    figure: (request, signal) => utility.request('compute:paper-chat-figure', request, { signal, timeoutMs: 30_000 }),
    imageInput: async (provider, model) => provider === 'codex'
      ? paperChatImageInput('codex', model, (await codex.cached((await settings.get()).codex ?? DEFAULT_CODEX_SETTINGS))?.models)
      : paperChatImageInput(provider, model),
    // Same transport encoding as figure insight: large PNG crops travel as JPEG 98, the file is untouched.
    encodeImage: async (bytes, mimeType) => {
      if (mimeType !== 'image/png' || bytes.length <= 2 * 1024 * 1024) return { bytes, mimeType }
      const jpeg = nativeImage.createFromBuffer(bytes).toJPEG(98)
      return jpeg.length && jpeg.length < bytes.length ? { bytes: jpeg, mimeType: 'image/jpeg' } : { bytes, mimeType }
    }
  })
  services.paperChat = paperChat
  const paperInsight = new PaperInsightService({
    settings: () => settings.get(),
    key: providerKey,
    get: (documentId) => utility.request('insight:get', { documentId }),
    context: (documentId, signal) => loadFullBriefContext(documentId, signal, () => utility.request('insight:brief-source', { documentId }, { signal, timeoutMs: 10_000 })),
    save: (documentId, brief, anchors) => utility.request('insight:save-brief', { documentId, brief, anchors }),
    stream: (input) => modelGateway.stream(input),
    recordUsage: (provider, usage) => usageAnalytics.recordTokens(provider, usage),
    canStart: canStartBackground,
    log: (details) => logger.info('paper-insight', details),
    changed: (documentId, state) => {
      const contents = toRenderer()
      if (contents) emitEvent(contents, paperInsightChannels.changed, { documentId, state })
    }
  })
  services.paperInsight = paperInsight
  jobScheduler.on('job-changed', (job) => { void paperInsight.onJobChanged(job).catch(() => logger.info('paper-insight', { status: 'refresh-failed' })) })
  const compute = new RpcTaskCompute(utility)
  const pathPolicy = new PathPolicy()
  const tasks = new TaskService(repository, settings, compute, pathPolicy, {
    logger,
    jobRepository,
    scheduler: jobScheduler
  })
  startup.phase = 'documents-load'
  const feed = new DocumentFeed(repository, (event) => {
    if (appShell.mainWindow) emitEvent(appShell.mainWindow.webContents, libraryChannels.changed, event)
  }, () => logger.error('documents.refresh.failed', {}))
  await feed.load()

  startup.phase = 'protocol-register'
  protocol.handle('copilotix-asset', (request) => createAssetResponse(request, (taskId, path) => tasks.resolveAsset(taskId, path)))

  const ipc = createIpcRegistrar({
    gate: libraryGate,
    getMainWindow: () => appShell.mainWindow,
    rendererEntryPath: appShell.rendererEntryPath,
    rendererOrigin: process.env.ELECTRON_RENDERER_URL
  })
  const mainWindow = (): Electron.BrowserWindow => appShell.mainWindow!
  registerPaperInsightHandlers(paperInsight, ipc)
  registerFigureInsightHandlers(figureInsight, ipc)
  registerZoteroHandlers(createZoteroImportService({ tasks, repository, tempRoot: app.getPath('temp') }), ipc)
  registerPaperChatHandlers(paperChat, async (documentId) => {
    const status = await utility.request('chat:ensure-index', { documentId })
    jobScheduler.wake()
    return status
  }, ipc)
  registerWindowIpc(ipc, appShell)
  registerLibraryIpc(ipc, {
    tasks,
    repository,
    feed,
    gate: libraryGate,
    scheduler: jobScheduler,
    mainWindow,
    bundleDirectory: __dirname,
    utility: {
      categories: (request) => utility.request('compute:library-categories', request, { timeoutMs: 120_000 }),
      check: () => utility.request('library:check', {}),
      manage: (request) => utility.request('library:manage', request, { timeoutMs: 2 * 60 * 60 * 1000 })
    },
    maintenance: {
      pause: async () => { await paperInsight.pause(); await figureInsight.pause() },
      settle: () => paperChat.settle(),
      resume: () => { paperInsight.resume(); figureInsight.resume() }
    },
    deleteDocument: (documentId, deleteFiles) => figureInsight.deleteDocument(documentId, () => paperInsight.deleteDocument(documentId, async () => {
      await paperChat.settleDocument(documentId)
      return tasks.delete(documentId, deleteFiles)
    }))
  })
  registerCodexIpc(ipc, {
    codex: () => codex,
    chooseExecutable: async () => {
      const result = await dialog.showOpenDialog(mainWindow(), { title: '选择 codex.exe', properties: ['openFile'], filters: [{ name: 'Codex', extensions: ['exe'] }] })
      return result.canceled ? null : result.filePaths[0] ?? null
    }
  })
  registerSettingsIpc(ipc, {
    settings,
    usageAnalytics,
    listTasks: () => tasks.list(),
    afterSave: (before, update, result) => {
      if (before.enabledTranslationProviders.join(',') !== result.settings.enabledTranslationProviders.join(',') || before.translationProvider !== result.settings.translationProvider || update.credentialMutations?.qwen || update.credentialMutations?.deepseek) paperChat.cancelAll()
      const next = result.settings
      if (before.enabledTranslationProviders.join(',') !== next.enabledTranslationProviders.join(',')
        || before.translationProvider !== next.translationProvider
        || before.qwenChatModel !== next.qwenChatModel
        || before.deepseekChatModel !== next.deepseekChatModel
        || update.credentialMutations?.qwen || update.credentialMutations?.deepseek) { paperInsight.cancelAll(); figureInsight.cancelAll() }
    },
    chooseDirectory: async () => {
      const result = await dialog.showOpenDialog(mainWindow(), { properties: ['openDirectory', 'createDirectory'] })
      return result.canceled ? null : (result.filePaths[0] ?? null)
    },
    openPath: (path) => shell.openPath(path)
  })
  registerTranslationIpc(ipc, tasks)
  registerParsingIpc(ipc, tasks)
  const notes: ReaderIpcDeps['notes'] = () => ({
    list: (request) => utility.request('notes:list', request),
    upsert: (request) => utility.request('notes:upsert', request),
    delete: (request) => utility.request('notes:delete', request)
  })
  registerReaderIpc(ipc, {
    figureDisplay: new FigureDisplayStore(async (documentId) => (await repository.getTask(documentId))?.outputDir ?? null),
    notes,
    annotations: () => repository,
    applyEdit: (request) => utility.request('markdown-edits:apply', request, { timeoutMs: 30_000 }),
    resolvedEdits: (documentId) => tasks.resolvedEdits(documentId),
    cacheFigure: (request) => tasks.cacheFigure(request)
  })
  registerZoteroExportHandler(createZoteroExportService({
    repository,
    tasks,
    insight: (documentId) => paperInsight.get(documentId),
    notes: (documentId) => notes().list({ documentId })
  }), ipc)

  startup.phase = 'window-create'
  appShell.createMainWindow(() => paperChat.cancelAll())
  startup.phase = 'tray-create'
  appShell.createTray()

  tasks.on('changed', feed.refresh)
  registerTaskNotifications(tasks, repository, {
    showWindow: () => appShell.show(),
    openDocument: (documentId) => { if (appShell.mainWindow) emitEvent(appShell.mainWindow.webContents, libraryChannels.open, documentId) }
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
    codex,
    repository,
    settingsService: settings,
    vault,
    fetcher,
    compute,
    pathPolicy,
    logger,
    usageAnalytics
  }))
  startup.phase = 'scheduler-start'
  await jobScheduler.start()

  app.on('activate', () => appShell.show())
  startup.phase = 'ready'
}

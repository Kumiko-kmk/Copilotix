import { paperBriefSaveSchema } from '@shared/paperBrief/contracts'
import { PaperInsightStore } from './persistence/paperInsightStore'
import { FigureInsightStore } from './persistence/figureInsightStore'
import { PaperChatFigureStore } from './persistence/paperChatFigureStore'
import { MarkdownEditStore } from './persistence/markdownEditStore'
import { markdownEditRequestSchema } from '@shared/markdownEdits'
import { paperChatFigureRequestSchema } from '@shared/paperChatFigures'
import { figureInsightRequestSchema, figureInsightSaveSchema } from '@shared/figureInsight'
import { paperInsightRequestSchema } from '@shared/paperInsight'
import { libraryCategoriesRequestSchema } from '@shared/libraryCategories'
import { LibraryCategoryService } from './libraryCategoryService'
import { paperChatStatusRequestSchema, paperContextRequestSchema } from '@shared/paperChatSchemas'
import { paperChatDeleteTurnSchema, paperChatDocumentRequestSchema, paperChatLoadRequestSchema, paperChatSaveTurnSchema, paperChatSaveSessionSchema } from '@shared/paperChatStorageSchemas'
import { PaperChatStore } from './persistence/paperChatStore'
import { ReaderNoteStore } from './persistence/readerNoteStore'
import { readerNoteDeleteSchema, readerNoteUpsertSchema, readerNotesRequestSchema } from '@shared/readerNotes'
import { PaperContextBuilder, PaperContextError } from './paperContextBuilder'
import { assertLibraryIdle, manageLibrary } from './libraryMaintenance'
import { libraryCoreRequestSchema } from '@shared/librarySchemas'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { copyFile, lstat, mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { prepareReaderMarkdown, isLocalMarkdownImage } from '@shared/standardMarkdown'
import { dirname, extname, isAbsolute, join, relative } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { CoreListCursor, CoreOperation } from '@shared/coreRpcSchemas'
import {
  CORE_LIST_PAGE_MAX_ROWS,
  coreDatabaseInitPayloadSchema,
  coreListPagePayloadSchema,
  coreJobEnqueuePayloadSchema,
  coreJobIdPayloadSchema,
  coreJobListPayloadSchema,
  coreJobClaimPayloadSchema,
  coreJobHeartbeatPayloadSchema,
  coreJobProgressPayloadSchema,
  coreJobCompletePayloadSchema,
  coreJobFailOrRetryPayloadSchema,
  coreJobCancelPayloadSchema,
  coreJobManualRetryPayloadSchema,
  coreJobRecoverExpiredPayloadSchema,
  coreJobEventsPayloadSchema,
  coreSettingsMigrationPayloadSchema,
  coreDocumentMetadataPayloadSchema,
  coreImportPdfPayloadSchema,
  coreRepairTextLayerPayloadSchema,
  coreRagContentIndexPayloadSchema,
  coreTranslationPlanOpenPayloadSchema,
  coreTranslationPlanListPayloadSchema,
  coreTranslationPlanCachePayloadSchema,
  coreTranslationPlanApplyPayloadSchema,
  coreTranslationPlanFailPayloadSchema,
  coreTranslationPlanFinalizePayloadSchema
} from '@shared/coreRpcSchemas'
import type { BlockMapping, CopilotixTask } from '@shared/types'
import { alignMarkdownBlocks } from '@shared/markdownBlocks'
import { appSettingsSchema } from '@shared/ipcSchemas'
import { MAX_PDF_BYTES } from '@shared/constants'
import { MAX_PDF_CROP_BYTES } from '@shared/pdfImport'
import { displayPaperTitle, extractPaperTitle } from '@shared/titleNaming'
import { BLOCK_MAPPING_VERSION, buildBlockMappings } from '@core/blockMapping'
import { applyTextLayerRepairs, findTextLayerCandidates, planTextLayerRepairs, TEXT_LAYER_REPAIR_VERSION, type TextLayerRepairReport } from '@shared/textLayerRepair'
import { readPdfTextLayer } from './compute/pdfTextLayer'
import { CoreUtilityOperationError, type CoreUtilityOperationHandler } from '../coreUtilityRuntime'
import { V2Database } from './persistence/v2Database'
import { V2TaskRepositoryCompat } from './persistence/v2TaskRepositoryCompat'
import { SqliteJobRepository, SqliteJobRepositoryError } from './persistence/sqliteJobRepository'
import { SqliteRagRepository, SqliteRagRepositoryError } from './persistence/sqliteRagRepository'
import { PathPolicy } from '@runtime/pathPolicy'
import { MarkdownTranslationPlanManager } from './compute/markdownTranslationPlan'
import { withoutFirstPage } from './compute/pdfPageRemoval'
import { RagContentIndexError, RagContentIndexService } from './compute/ragContentIndexService'

type UtilityHandlerMap = Partial<Record<CoreOperation, CoreUtilityOperationHandler>>

interface UtilityPersistenceState {
  database?: V2Database
  repository?: V2TaskRepositoryCompat
  jobRepository?: SqliteJobRepository
  ragRepository?: SqliteRagRepository
  ragContentIndexService?: RagContentIndexService
  translationPlanManager?: MarkdownTranslationPlanManager
  databasePath?: string
  outputRoot?: string
}

/**
 * Compose explicit persistence/compute operations for the utility process.
 * This module has no renderer, credential, network, or main-process imports.
 */
export function createUtilityOperationHandlers(state: UtilityPersistenceState = {}): {
  handlers: UtilityHandlerMap
  flush: () => Promise<void>
  close: () => Promise<void>
} {
  // Core runtime handlers may run concurrently. Operations that touch SQLite
  // are queued on FIFO lanes: quick data operations on one, long file-heavy
  // compute (import, normalize, translation plans, indexing) on another, so a
  // long paper can no longer hold heartbeats, listings and annotation writes
  // behind it. Interleaving the two lanes is safe because every SQLite
  // transaction is synchronous. Lifecycle operations (init/flush/close and
  // library maintenance) are exclusive: they wait for and block both lanes,
  // so no query can cross a close boundary.
  let dataTail = Promise.resolve()
  let computeTail = Promise.resolve()
  const settled = (promise: Promise<unknown>): Promise<void> => promise.then(() => undefined, () => undefined)
  const runOnLane = <T>(lane: OperationLane, operation: () => T | Promise<T>): Promise<T> => {
    if (lane === 'exclusive') {
      const next = Promise.all([dataTail, computeTail]).then(operation, operation)
      dataTail = computeTail = settled(next)
      return next
    }
    const next = (lane === 'data' ? dataTail : computeTail).then(operation, operation)
    if (lane === 'data') dataTail = settled(next)
    else computeTail = settled(next)
    return next
  }

  const requireRepository = (): V2TaskRepositoryCompat => {
    if (!state.repository) throw new CoreUtilityOperationError('CORE_UNAVAILABLE', 'Core database is not initialized', true)
    return state.repository
  }
  const requireDatabase = (): V2Database => {
    if (!state.database) throw new CoreUtilityOperationError('CORE_UNAVAILABLE', 'Core database is not initialized', true)
    return state.database
  }
  const requireJobRepository = (): SqliteJobRepository => {
    if (!state.jobRepository) throw new CoreUtilityOperationError('CORE_UNAVAILABLE', 'Core database is not initialized', true)
    return state.jobRepository
  }
  const requireRagRepository = (): SqliteRagRepository => {
    if (!state.ragRepository) throw new CoreUtilityOperationError('CORE_UNAVAILABLE', 'Core database is not initialized', true)
    return state.ragRepository
  }
  const requireRagContentIndexService = (): RagContentIndexService => {
    if (!state.ragContentIndexService) throw new CoreUtilityOperationError('CORE_UNAVAILABLE', 'Core database is not initialized', true)
    return state.ragContentIndexService
  }
  const requireTranslationPlanManager = (): MarkdownTranslationPlanManager => {
    if (!state.repository) throw new CoreUtilityOperationError('CORE_UNAVAILABLE', 'Core database is not initialized', true)
    if (!state.translationPlanManager) {
      state.translationPlanManager = new MarkdownTranslationPlanManager(
        state.repository,
        new PathPolicy(),
        state.outputRoot ? { outputRoot: state.outputRoot } : {}
      )
    }
    return state.translationPlanManager
  }
  const chatStore = new PaperChatStore((id) => requireRepository().getTask(id)?.outputDir ?? null)
  const noteStore = new ReaderNoteStore((id) => requireRepository().getTask(id)?.outputDir ?? null)
  const editStore = new MarkdownEditStore((id) => requireRepository().getTask(id)?.outputDir ?? null)
  const insightStore = () => new PaperInsightStore(requireRepository())
  const figureInsightStore = () => new FigureInsightStore(requireRepository())
  const categories = new LibraryCategoryService(insightStore, requireRepository)
  const handlers: UtilityHandlerMap = {
    'figureInsight:get': request => figureInsightStore().get(figureInsightRequestSchema.parse(request.payload)),
    'compute:figure-insight-descriptor': (request, signal) => figureInsightStore().descriptor(figureInsightRequestSchema.parse(request.payload), signal),
    'figureInsight:save': request => figureInsightStore().save(figureInsightSaveSchema.parse(request.payload)),
    // Reads every paper's text on first use: compute lane, so quick data requests are not held up.
    'compute:library-categories': (request, signal) => categories.page(libraryCategoriesRequestSchema.parse(request.payload).after ?? 0, signal),
    'insight:get': (request) => insightStore().get(paperInsightRequestSchema.parse(request.payload).documentId),
    'insight:save-brief': (request) => { const { documentId, brief, anchors } = paperBriefSaveSchema.parse(request.payload); return insightStore().saveBrief(documentId, brief, anchors) },
    'insight:brief-source': (request) => insightStore().briefSource(paperInsightRequestSchema.parse(request.payload).documentId),
    'chat:load': (request) => { const { documentId, before } = paperChatLoadRequestSchema.parse(request.payload); return chatStore.load(documentId, before) },
    'chat:save-turn': (request) => { const { documentId, turn } = paperChatSaveTurnSchema.parse(request.payload); return chatStore.saveTurn(documentId, turn) },
    'chat:session': (request) => chatStore.session(paperChatDocumentRequestSchema.parse(request.payload).documentId),
    'chat:save-session': (request) => { const { documentId, session } = paperChatSaveSessionSchema.parse(request.payload); return chatStore.saveSession(documentId, session) },
    'chat:delete-turn': (request) => chatStore.deleteTurn(paperChatDeleteTurnSchema.parse(request.payload)),
    'chat:clear': (request) => chatStore.clear(paperChatDocumentRequestSchema.parse(request.payload).documentId),
    'markdown-edits:apply': (request) => editStore.apply(markdownEditRequestSchema.parse(request.payload)),
    'notes:list': (request) => noteStore.list(readerNotesRequestSchema.parse(request.payload).documentId),
    'notes:upsert': (request) => { const { documentId, note } = readerNoteUpsertSchema.parse(request.payload); return noteStore.upsert(documentId, note) },
    'notes:delete': (request) => { const { documentId, noteId } = readerNoteDeleteSchema.parse(request.payload); return noteStore.delete(documentId, noteId) },
    'chat:ensure-index': (request, signal) => {
      signal.throwIfAborted()
      const { documentId } = paperChatStatusRequestSchema.parse(request.payload)
      requireRepository().ensureContentIndex(documentId)
      const rag = requireRagRepository()
      const k = rag.getDocumentKnowledge(documentId) ?? rag.ensureDocumentKnowledge(documentId)
      return { state: k?.localState ?? 'unindexed', progress: k?.localProgress ?? 0, contentRevisionId: k?.activeContentRevisionId ?? null }
    },
    'chat:build-context': async (request, signal) => {
      const input = paperContextRequestSchema.parse(request.payload)
      // An unreadable edit layer falls back to the parsed text; saving an edit reports the problem.
      const edits = await editStore.read(input.documentId).catch(() => null)
      const order = edits?.order ? await editStore.readingOrder(input.documentId).catch(() => null) : null
      return new PaperContextBuilder(requireRagRepository()).build(input, signal, edits, order)
    },
    'compute:paper-chat-figure': (request, signal) => new PaperChatFigureStore(requireRepository(), figureInsightStore()).source(paperChatFigureRequestSchema.parse(request.payload), signal),
    'library:check': () => { assertLibraryIdle(requireDatabase()); return { idle: true } },
    'library:manage': async (request, signal) => {
      if (!state.databasePath) throw new Error('文档库尚未初始化')
      const result = await manageLibrary(requireDatabase(), state.databasePath, libraryCoreRequestSchema.parse(request.payload), signal)
      if (result.restartRequired) state.translationPlanManager = undefined
      return result
    },
    ping: () => ({ pong: true }),
    'database:init': async (request) => {
      const payload = coreDatabaseInitPayloadSchema.parse(request.payload)
      validateBootstrapPaths(payload.databasePath, payload.outputRoot)
      if (state.databasePath === payload.databasePath && state.outputRoot === payload.outputRoot && state.repository && state.jobRepository && state.ragRepository && state.ragContentIndexService) return { initialized: true }
      closeState(state)
      try {
        await mkdir(dirname(payload.databasePath), { recursive: true })
        state.outputRoot = payload.outputRoot
        state.database = new V2Database(payload.databasePath)
        state.repository = new V2TaskRepositoryCompat(state.database, new PathPolicy())
        state.jobRepository = new SqliteJobRepository(state.database)
        state.ragRepository = new SqliteRagRepository(state.database)
        state.ragContentIndexService = new RagContentIndexService(state.database, state.ragRepository, new PathPolicy())
        state.translationPlanManager = new MarkdownTranslationPlanManager(state.repository, new PathPolicy(), { outputRoot: payload.outputRoot })
        state.databasePath = payload.databasePath
        return { initialized: true }
      } catch (error) {
        closeState(state)
        throw error
      }
    },
    'database:flush': () => {
      const database = requireDatabase()
      database.connection.exec('PRAGMA wal_checkpoint(PASSIVE)')
      return { flushed: true }
    },
    'database:close': () => {
      closeState(state)
      return { closed: true }
    },
    'settings:get': (request) => {
      const repository = requireRepository()
      const payload = request.payload as { outputRoot: string }
      const settings = appSettingsSchema.parse(repository.getSettings(payload.outputRoot))
      if (state.outputRoot !== settings.outputRoot) {
        state.outputRoot = settings.outputRoot
        state.translationPlanManager = undefined
      }
      return settings
    },
    'settings:save': (request) => {
      const repository = requireRepository()
      const settings = appSettingsSchema.parse((request.payload as { settings: unknown }).settings)
      repository.saveSettings(settings)
      if (state.outputRoot !== settings.outputRoot) {
        state.outputRoot = settings.outputRoot
        state.translationPlanManager = undefined
      }
      return settings
    },
    'settings:migration-get': (request) => {
      const payload = coreSettingsMigrationPayloadSchema.parse(request.payload)
      return { applied: requireRepository().getMigrationMarker?.(payload.id) ?? false }
    },
    'settings:migration-mark': (request) => {
      const payload = coreSettingsMigrationPayloadSchema.parse(request.payload)
      requireRepository().markMigration?.(payload.id)
      return { applied: true }
    },
    'tasks:list': (request) => {
      const { after } = coreListPagePayloadSchema.parse(request.payload)
      return byteBoundedPage((cursor, limit) => requireRepository().listTasksPage(cursor, limit), after ?? null)
    },
    'tasks:get': (request) => requireRepository().getTask((request.payload as { id: string }).id),
    'tasks:find-by-hash': (request) => requireRepository().findByHash((request.payload as { hash: string }).hash),
    'tasks:insert-many': (request) => {
      requireRepository().insertTasks((request.payload as { tasks: CopilotixTask[] }).tasks)
      return { changed: true }
    },
    'tasks:delete': (request) => {
      requireRepository().deleteTask((request.payload as { id: string }).id)
      return { changed: true }
    },
    'jobs:enqueue': (request) => requireJobRepository().enqueue(coreJobEnqueuePayloadSchema.parse(request.payload)),
    'jobs:get': (request) => requireJobRepository().get(coreJobIdPayloadSchema.parse(request.payload).id),
    'jobs:list': (request) => requireJobRepository().list(coreJobListPayloadSchema.parse(request.payload)),
    'jobs:claim-batch': (request) => requireJobRepository().claimBatch(coreJobClaimPayloadSchema.parse(request.payload)),
    'jobs:heartbeat': (request) => requireJobRepository().heartbeat(coreJobHeartbeatPayloadSchema.parse(request.payload)),
    'jobs:update-progress': (request) => requireJobRepository().updateProgressAndCheckpoint(coreJobProgressPayloadSchema.parse(request.payload)),
    'jobs:complete': (request) => requireJobRepository().complete(coreJobCompletePayloadSchema.parse(request.payload)),
    'jobs:fail-or-retry': (request) => requireJobRepository().failOrRetry(coreJobFailOrRetryPayloadSchema.parse(request.payload)),
    'jobs:cancel': (request) => requireJobRepository().cancel(coreJobCancelPayloadSchema.parse(request.payload)),
    'jobs:manual-retry': (request) => requireJobRepository().manualRetry(coreJobManualRetryPayloadSchema.parse(request.payload)),
    'jobs:recover-expired': (request) => requireJobRepository().recoverExpired(coreJobRecoverExpiredPayloadSchema.parse(request.payload)),
    'jobs:list-events': (request) => requireJobRepository().listEvents(coreJobEventsPayloadSchema.parse(request.payload).jobId),
    'documents:list': (request) => {
      const { after } = coreListPagePayloadSchema.parse(request.payload)
      return byteBoundedPage((cursor, limit) => requireRepository().listDocumentSummariesPage(cursor, limit), after ?? null)
    },
    'documents:get-summary': (request) => requireRepository().getDocumentSummary((request.payload as { id: string }).id),
    'documents:update-metadata': (request) => {
      const payload = coreDocumentMetadataPayloadSchema.parse(request.payload)
      requireRepository().updateDocumentMetadata(payload.id, payload.patch)
      return { changed: true }
    },
    'artifacts:record-revision': (request) => {
      const payload = request.payload as { taskId: string; kind: Parameters<V2TaskRepositoryCompat['recordArtifactRevision']>[1]; path: string; checksum: string; metadata?: Record<string, unknown>; jobId?: string }
      requireRepository().recordArtifactRevision(payload.taskId, payload.kind, payload.path, payload.checksum, payload.metadata ?? {}, payload.jobId)
      return { changed: true }
    },
    'annotations:list-snapshot': (request) => {
      const payload = request.payload as Parameters<V2TaskRepositoryCompat['listDocumentAnnotations']>[0]
      return requireRepository().listDocumentAnnotations(payload)
    },
    'annotations:mutate': (request) => requireRepository().mutateDocumentAnnotations((request.payload as { request: Parameters<V2TaskRepositoryCompat['mutateDocumentAnnotations']>[0] }).request),
    'compute:hash-file': async (request) => ({ sha256: await hashFile((request.payload as { path: string }).path) }),
    'compute:import-pdf': async (request, signal) => {
      const payload = coreImportPdfPayloadSchema.parse(request.payload)
      return importPdf(payload.sourcePath, payload.documentId, state, signal, payload.skipFirstPage === true)
    },
    'compute:normalize-parser': async (request, signal) => {
      const payload = request.payload as { task: CopilotixTask; extractedDir: string; jobId?: string }
      return normalizeParserOutput(payload.task, payload.extractedDir, requireRepository(), payload.jobId, signal)
    },
    'compute:repair-text-layer': async (request, signal) => {
      const payload = coreRepairTextLayerPayloadSchema.parse(request.payload)
      return repairParsedTextLayer(payload.taskId, requireRepository(), signal)
    },
    'compute:rebuild-mappings': async (request) => {
      const payload = request.payload as { taskId: string; outputDir: string }
      await rebuildMappings(payload.taskId, payload.outputDir, requireRepository())
      return { rebuilt: true }
    },
    'compute:rag-content-index': async (request, signal) => {
      const payload = coreRagContentIndexPayloadSchema.parse(request.payload)
      return requireRagContentIndexService().index(payload, signal)
    },
    'compute:translation-plan-open': async (request) => {
      const payload = coreTranslationPlanOpenPayloadSchema.parse(request.payload)
      return requireTranslationPlanManager().open(payload.taskId, payload.jobId)
    },
    'compute:translation-plan-list': async (request) => {
      const payload = coreTranslationPlanListPayloadSchema.parse(request.payload)
      return requireTranslationPlanManager().listWork(payload.taskId, payload.jobId, payload.cursor, payload.limit)
    },
    'compute:translation-plan-cache': async (request) => {
      const payload = coreTranslationPlanCachePayloadSchema.parse(request.payload)
      return requireTranslationPlanManager().tryCache(payload.taskId, payload.jobId, payload.unitId, payload.provider, payload.model)
    },
    'compute:translation-plan-apply': async (request) => {
      const payload = coreTranslationPlanApplyPayloadSchema.parse(request.payload)
      return requireTranslationPlanManager().apply(
        payload.taskId,
        payload.jobId,
        payload.unitId,
        payload.responsePath,
        payload.provider ?? null,
        payload.model ?? null
      )
    },
    'compute:translation-plan-fail': async (request) => {
      const payload = coreTranslationPlanFailPayloadSchema.parse(request.payload)
      return requireTranslationPlanManager().fail(payload.taskId, payload.jobId, payload.unitId, payload.error)
    },
    'compute:translation-plan-finalize': async (request) => {
      const payload = coreTranslationPlanFinalizePayloadSchema.parse(request.payload)
      return requireTranslationPlanManager().finalize(payload.taskId, payload.jobId)
    }
  }

  for (const [operation, handler] of Object.entries(handlers) as Array<[CoreOperation, CoreUtilityOperationHandler]>) {
    const lane = operationLane(operation)
    if (!lane) continue
    handlers[operation] = (request, signal) => runOnLane(lane, () => handler(request, signal)).catch((error: unknown) => {
      if (operation === 'library:manage' || operation === 'library:check') {
        const message = error instanceof Error ? error.message : '文档库操作失败，请检查目录权限与磁盘空间。'
        throw new CoreUtilityOperationError('LIBRARY_MAINTENANCE_FAILED', message, false)
      }
      if (error instanceof SqliteJobRepositoryError || error instanceof SqliteRagRepositoryError || error instanceof RagContentIndexError || error instanceof PaperContextError) {
        throw new CoreUtilityOperationError(error.code, error.message, error.retryable)
      }
      throw error
    })
  }

  return {
    handlers,
    flush: () => runOnLane('exclusive', () => {
      if (state.database) state.database.connection.exec('PRAGMA wal_checkpoint(PASSIVE)')
    }),
    close: () => runOnLane('exclusive', () => closeState(state))
  }
}

/** Leaves ample room under the 1 MiB envelope for JSON framing. */
const LIST_PAGE_MAX_BYTES = 512 * 1024

/**
 * Read up to CORE_LIST_PAGE_MAX_ROWS rows after `after`, then keep only as
 * many as fit the byte budget (always at least one). Rows that did not fit
 * are read again for the next page.
 */
export function byteBoundedPage<T extends { id: string; createdAt: string }>(
  readPage: (after: CoreListCursor | null, limit: number) => T[],
  after: CoreListCursor | null,
  maxBytes = LIST_PAGE_MAX_BYTES
): { items: T[]; next: CoreListCursor | null } {
  const rows = readPage(after, CORE_LIST_PAGE_MAX_ROWS)
  const items: T[] = []
  let bytes = 0
  for (const row of rows) {
    const size = Buffer.byteLength(JSON.stringify(row), 'utf8')
    if (items.length > 0 && bytes + size > maxBytes) break
    items.push(row)
    bytes += size
  }
  const last = items.at(-1)
  const hasMore = items.length < rows.length || rows.length === CORE_LIST_PAGE_MAX_ROWS
  return { items, next: hasMore && last ? { createdAt: last.createdAt, id: last.id } : null }
}

type OperationLane = 'exclusive' | 'data' | 'compute'

const EXCLUSIVE_OPERATIONS: ReadonlySet<CoreOperation> = new Set(['database:init', 'database:flush', 'database:close', 'library:check', 'library:manage'])

/** Unlisted operations (ping, cancel, hash-file) never touch SQLite and run freely. */
function operationLane(operation: CoreOperation): OperationLane | null {
  if (EXCLUSIVE_OPERATIONS.has(operation)) return 'exclusive'
  if (operation === 'compute:hash-file' || !operation.includes(':')) return null
  return operation.startsWith('compute:') ? 'compute' : 'data'
}

function closeState(state: UtilityPersistenceState): void {
  try {
    state.translationPlanManager = undefined
    state.repository = undefined
    state.jobRepository = undefined
    state.ragRepository = undefined
    state.ragContentIndexService = undefined
  } finally {
    try { state.database?.close() } finally {
      state.database = undefined
      state.databasePath = undefined
      state.outputRoot = undefined
    }
  }
}

function validateBootstrapPaths(databasePath: string, outputRoot: string): void {
  for (const value of [databasePath, outputRoot]) {
    if (!isAbsolute(value) || value.length > 32_768 || value.includes('\0') || value.split(/[\\/]+/u).includes('..')) {
      throw new CoreUtilityOperationError('CORE_PROTOCOL_ERROR', 'Invalid core bootstrap configuration', false)
    }
  }
}

async function hashFile(path: string): Promise<string> {
  if (!isAbsolute(path) || path.length > 32_768 || path.includes('\0')) throw new CoreUtilityOperationError('CORE_PROTOCOL_ERROR', 'Invalid compute path', false)
  const hash = createHash('sha256')
  await new Promise<void>((resolvePromise, reject) => {
    const input = createReadStream(path)
    input.on('data', (chunk) => hash.update(chunk))
    input.on('end', resolvePromise)
    input.on('error', reject)
  })
  return hash.digest('hex')
}

async function importPdf(
  sourcePath: string,
  documentId: string,
  state: UtilityPersistenceState,
  signal: AbortSignal,
  skipFirstPage = false
): Promise<{ sha256: string; size: number }> {
  if (!isAbsolute(sourcePath) || sourcePath.length > 32_768 || sourcePath.includes('\0') || extname(sourcePath).toLowerCase() !== '.pdf') {
    throw new CoreUtilityOperationError('CORE_PROTOCOL_ERROR', 'Invalid PDF import request', false)
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(documentId)) {
    throw new CoreUtilityOperationError('CORE_PROTOCOL_ERROR', 'Invalid document identifier', false)
  }
  if (!state.outputRoot || !isAbsolute(state.outputRoot) || state.outputRoot.length > 32_768 || state.outputRoot.includes('\0')) {
    throw new CoreUtilityOperationError('CORE_UNAVAILABLE', 'Core output directory is unavailable', true)
  }

  let sourceInfo
  try {
    sourceInfo = await lstat(sourcePath)
  } catch {
    throw new CoreUtilityOperationError('CORE_NOT_FOUND', 'PDF source is unavailable', false)
  }
  if (!sourceInfo.isFile()) throw new CoreUtilityOperationError('CORE_PROTOCOL_ERROR', 'PDF source must be a regular file', false)
  if (sourceInfo.size === 0) throw new CoreUtilityOperationError('CORE_PROTOCOL_ERROR', 'PDF source is empty', false)
  if (sourceInfo.size > MAX_PDF_BYTES) throw new CoreUtilityOperationError('CORE_LIMIT_EXCEEDED', 'PDF exceeds the supported size limit', false)
  const policy = new PathPolicy()
  await mkdir(state.outputRoot, { recursive: true })
  const documentsRoot = policy.resolveChild(state.outputRoot, 'documents-v2')
  await mkdir(documentsRoot, { recursive: true })
  const documentRoot = policy.resolveChild(documentsRoot, documentId)
  await mkdir(documentRoot, { recursive: true })
  const verifiedDocumentRoot = policy.resolveChild(documentsRoot, documentId)
  const destination = join(verifiedDocumentRoot, 'original.pdf')
  const partial = `${destination}.partial-${documentId}`
  await removeIfPresent(partial)
  await rejectExisting(destination)

  if (skipFirstPage) {
    // The rewritten bytes are what the document keeps, so they are what gets hashed and recorded.
    if (sourceInfo.size > MAX_PDF_CROP_BYTES) throw new CoreUtilityOperationError('CORE_PDF_REWRITE_FAILED', 'PDF is too large to rewrite', false)
    let published = false
    try {
      const rewritten = await withoutFirstPage(await readFile(sourcePath, { signal }))
      signal.throwIfAborted()
      const handle = await open(partial, 'wx')
      try {
        await handle.writeFile(rewritten)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(partial, destination)
      published = true
      return { sha256: createHash('sha256').update(rewritten).digest('hex'), size: rewritten.byteLength }
    } finally {
      if (!published) await removeIfPresent(partial)
    }
  }

  const hash = createHash('sha256')
  let size = 0
  let header = Buffer.alloc(0)
  let published = false
  try {
    const hashing = new Transform({
      transform(chunk, _encoding, callback) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        size += buffer.length
        if (header.length < 1024) header = Buffer.concat([header, buffer.subarray(0, 1024 - header.length)])
        if (size > MAX_PDF_BYTES) {
          callback(new CoreUtilityOperationError('CORE_LIMIT_EXCEEDED', 'PDF exceeds the supported size limit', false))
          return
        }
        hash.update(buffer)
        callback(null, buffer)
      }
    })
    await pipeline(
      createReadStream(sourcePath),
      hashing,
      createWriteStream(partial, { flags: 'wx' }),
      { signal }
    )
    if (size === 0 || !/%PDF-\d\.\d/u.test(header.toString('latin1'))) {
      throw new CoreUtilityOperationError('CORE_PROTOCOL_ERROR', 'Invalid PDF header', false)
    }
    const handle = await open(partial, 'r+')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(partial, destination)
    published = true
    return { sha256: hash.digest('hex'), size }
  } finally {
    if (!published) await removeIfPresent(partial)
  }
}

async function rejectExisting(path: string): Promise<void> {
  try {
    await lstat(path)
  } catch (error) {
    if (isNotFound(error)) return
    throw error
  }
  throw new CoreUtilityOperationError('CORE_CONFLICT', 'PDF destination already exists', false)
}

async function removeIfPresent(path: string): Promise<void> {
  await rm(path, { force: true }).catch(() => undefined)
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT')
}

async function normalizeParserOutput(
  task: CopilotixTask,
  extractedDir: string,
  repository: V2TaskRepositoryCompat,
  jobId?: string,
  signal?: AbortSignal
): Promise<{ normalized: true; displayTitle: string | null; pageCount: number }> {
  assertTaskPath(task.outputDir)
  assertTaskPath(extractedDir)
  await mkdir(task.outputDir, { recursive: true })
  const pathPolicy = new PathPolicy()
  const extractedRoot = pathPolicy.resolveChild(task.outputDir, extractedDir)
  const files = await walkFiles(extractedRoot, pathPolicy)
  const markdown = files.find((path) => extname(path).toLowerCase() === '.md')
  const layout = files.find((path) => /(?:layout|middle)\.json$/iu.test(path))
  const contentList = files.find((path) => /content_list(?:_v2)?\.json$/iu.test(path))
  if (!markdown || !layout) throw new CoreUtilityOperationError('CORE_UNAVAILABLE', 'Copilotix result is incomplete', false)

  const suffix = jobId && /^[A-Za-z0-9._-]+$/u.test(jobId) ? jobId : 'legacy'
  const stagingRoot = pathPolicy.resolveChild(task.outputDir, `.normalize.partial-${suffix}`)
  await rm(stagingRoot, { recursive: true, force: true })
  await mkdir(stagingRoot, { recursive: true })
  const staged = async (source: string, targetRelativePath: string): Promise<string> => {
    const target = pathPolicy.resolveChild(stagingRoot, targetRelativePath)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(source, target)
    return target
  }
  const revisions: Array<{ taskId: string; kind: Parameters<V2TaskRepositoryCompat['recordArtifactRevision']>[1]; path: string; checksum: string; jobId?: string }> = []
  const imageFiles: Array<{ stagedPath: string; relativePath: string }> = []
  try {
    const markdownStaged = await staged(markdown, 'full.md')
    const layoutStaged = await staged(layout, 'layout.json')
    const artifactSources: Array<{ kind: Parameters<V2TaskRepositoryCompat['recordArtifactRevision']>[1]; relativePath: string; stagedPath: string }> = [
      { kind: 'parsed_markdown', relativePath: 'full.md', stagedPath: markdownStaged },
      { kind: 'layout', relativePath: 'layout.json', stagedPath: layoutStaged }
    ]
    if (contentList) artifactSources.push({ kind: 'content_list', relativePath: 'content_list.json', stagedPath: await staged(contentList, 'content_list.json') })

    for (const file of files) {
      const rel = relative(extractedRoot, file)
      if (!/[/\\]images?[/\\]/iu.test(file) && !/\.(png|jpe?g|webp|gif|svg)$/iu.test(file)) continue
      imageFiles.push({ stagedPath: await staged(file, rel), relativePath: rel })
    }

    let layoutData = JSON.parse(await readFile(layoutStaged, 'utf8')) as unknown
    // Before Markdown preparation, so repaired spans match the parser's own text.
    const repaired = await repairFromTextLayer(layoutData, await readFile(markdownStaged, 'utf8'), pathPolicy.resolveChild(task.outputDir, 'original.pdf'), signal)
    let reportStaged: string | null = null
    if (repaired) {
      layoutData = repaired.layout
      if (repaired.report.repairs.length > 0) {
        await writeFile(layoutStaged, JSON.stringify(repaired.layout), 'utf8')
        await writeFile(markdownStaged, repaired.markdown, 'utf8')
      }
      reportStaged = pathPolicy.resolveChild(stagingRoot, TEXT_LAYER_REPORT)
      await writeFile(reportStaged, JSON.stringify(repaired.report, null, 2), 'utf8')
    }
    const mappings = buildBlockMappings(task.id, layoutData)
    const pageCount = mappings.reduce((maximum, mapping) => Math.max(maximum, ...mapping.boxes.map((box) => box.pageIndex + 1), 0), 0)
    const markdownText = prepareReaderMarkdown(await readFile(markdownStaged, 'utf8'), (url) => {
      if (!isLocalMarkdownImage(url)) return url
      const asset = pathPolicy.resolveChild(extractedRoot, join(dirname(markdown), decodeURIComponent(url.split(/[?#]/u)[0]!)))
      return relative(extractedRoot, asset).replace(/\\/gu, '/').split('/').map(encodeURIComponent).join('/')
    })
    await writeFile(markdownStaged, markdownText, 'utf8')
    const extractedTitle = extractPaperTitle(markdownText, mappings)
    const displayTitle = extractedTitle ? displayPaperTitle(extractedTitle) : null
    const blockStaged = pathPolicy.resolveChild(stagingRoot, 'block_list.json')
    await writeFile(blockStaged, JSON.stringify({ version: BLOCK_MAPPING_VERSION, mappings }, null, 2), 'utf8')
    artifactSources.push({ kind: 'block_mappings', relativePath: 'block_list.json', stagedPath: blockStaged })

    for (const artifact of artifactSources) {
      const destination = pathPolicy.resolveChild(task.outputDir, artifact.relativePath)
      const checksum = await hashFile(artifact.stagedPath)
      await publishStagedFile(artifact.stagedPath, destination, checksum)
      revisions.push({ taskId: task.id, kind: artifact.kind, path: destination, checksum, jobId })
    }
    for (const image of imageFiles) {
      const destination = pathPolicy.resolveChild(task.outputDir, image.relativePath)
      await publishStagedFile(image.stagedPath, destination, await hashFile(image.stagedPath))
    }
    if (reportStaged) await publishStagedFile(reportStaged, pathPolicy.resolveChild(task.outputDir, TEXT_LAYER_REPORT), await hashFile(reportStaged))
    repository.recordArtifactRevisions(revisions)
    return { normalized: true, displayTitle, pageCount }
  } finally {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** Provenance of text-layer repairs; not an artifact revision, readers never depend on it. */
const TEXT_LAYER_REPORT = 'text-layer-repair.json'

/**
 * Replace fragmented parser lines with the PDF text layer. Returns null when
 * the layout has no fragmented lines. A PDF that cannot be read leaves every
 * candidate unresolved instead of failing the parse.
 */
async function repairFromTextLayer(layout: unknown, markdown: string, pdfPath: string, signal?: AbortSignal, protectedBlocks: readonly string[] = []): Promise<{ layout: unknown; markdown: string; report: TextLayerRepairReport } | null> {
  const candidates = findTextLayerCandidates(layout)
  if (candidates.length === 0) return null
  try {
    const pages = [...new Map(candidates.map((candidate) => [candidate.pageIndex, { pageIndex: candidate.pageIndex, pageSize: candidate.pageSize }])).values()]
    const layer = await readPdfTextLayer(pdfPath, pages, signal)
    let result = applyTextLayerRepairs(layout, markdown, planTextLayerRepairs(candidates, layer), protectedBlocks)
    // A repaired span can make its neighbour locatable in the Markdown; settle here
    // instead of publishing (and re-preparing the reader) once per pass.
    for (let pass = 0; pass < 3 && result.report.repairs.length > 0; pass += 1) {
      const next = applyTextLayerRepairs(result.layout, result.markdown, planTextLayerRepairs(findTextLayerCandidates(result.layout), layer), protectedBlocks)
      if (next.report.repairs.length === 0) break
      result = { ...next, report: { ...next.report, repairs: [...result.report.repairs, ...next.report.repairs] } }
    }
    return result
  } catch (error) {
    if (signal?.aborted) throw error
    return { layout, markdown, report: { version: TEXT_LAYER_REPAIR_VERSION, repairs: [], unresolved: candidates } }
  }
}

/**
 * Parsed Markdown of blocks the user edited or deleted in the reader
 * (`edits/markdown-edits.v1.json`). The user's text always wins, so the repair
 * leaves these blocks alone. Each entry is located like the reader does: its
 * recorded position when mappings or base hash still match, else the one block
 * with the same mappings, else the one with the same base hash. Null when the
 * file exists but cannot be read.
 */
async function userEditedBlocks(outputDir: string, documentId: string, markdown: string): Promise<string[] | null> {
  const pathPolicy = new PathPolicy()
  let raw: string
  try {
    raw = await readFile(pathPolicy.resolveChild(outputDir, 'edits/markdown-edits.v1.json'), 'utf8')
  } catch (error) {
    return isNotFound(error) ? [] : null
  }
  try {
    const file = JSON.parse(raw) as { version?: unknown; documentId?: unknown; blocks?: unknown }
    if (file.version !== 1 || file.documentId !== documentId || !Array.isArray(file.blocks)) return null
    const mappings = (JSON.parse(await readFile(pathPolicy.resolveChild(outputDir, 'block_list.json'), 'utf8')) as { mappings?: unknown }).mappings
    const blocks = alignMarkdownBlocks(markdown, Array.isArray(mappings) ? mappings as BlockMapping[] : [])
    const hashes = blocks.map((block) => createHash('sha256').update(block.markdown).digest('hex'))
    const sameIds = (left: readonly string[], right: readonly string[]): boolean => left.length > 0 && [...left].sort().join('\u0000') === [...right].sort().join('\u0000')
    const result: string[] = []
    for (const entry of file.blocks as Array<{ index?: number; mappingIds?: string[]; baseHash?: string; original?: unknown; deletedAt?: unknown }>) {
      if (!entry.original && !entry.deletedAt) continue
      const ids = Array.isArray(entry.mappingIds) ? entry.mappingIds : []
      const at = typeof entry.index === 'number' ? blocks[entry.index] : undefined
      const unique = (matches: number[]): number | undefined => matches.length === 1 ? matches[0] : undefined
      const found = at && (sameIds(at.mappingIds, ids) || hashes[entry.index!] === entry.baseHash) ? entry.index!
        : unique(blocks.flatMap((block, index) => sameIds(block.mappingIds, ids) ? [index] : []))
          ?? unique(hashes.flatMap((hash, index) => hash === entry.baseHash ? [index] : []))
      // An edit that cannot be placed protects nothing here, as in the reader (orphan).
      if (found !== undefined) result.push(blocks[found]!.markdown)
    }
    return result
  } catch {
    return null
  }
}

/**
 * Repair an already published parse in place (user-initiated; old papers are
 * never re-parsed automatically). Markdown is published first and the layout
 * last, so an interrupted run is completed by the next one.
 */
async function repairParsedTextLayer(taskId: string, repository: V2TaskRepositoryCompat, signal?: AbortSignal): Promise<{ repaired: number; unresolved: number }> {
  const task = repository.getTask(taskId)
  if (!task) throw new CoreUtilityOperationError('CORE_NOT_FOUND', 'Document not found', false)
  assertTaskPath(task.outputDir)
  const pathPolicy = new PathPolicy()
  const path = (name: string): string => pathPolicy.resolveChild(task.outputDir, name)
  const layout = JSON.parse(await readFile(path('layout.json'), 'utf8')) as unknown
  const markdown = await readFile(path('full.md'), 'utf8')
  const protectedBlocks = await userEditedBlocks(task.outputDir, taskId, markdown)
  // An edits file that cannot be read must not be overruled: leave the paper as it is.
  if (protectedBlocks === null) return { repaired: 0, unresolved: 0 }
  const repaired = await repairFromTextLayer(layout, markdown, path('original.pdf'), signal, protectedBlocks)
  if (!repaired || repaired.report.repairs.length === 0) return { repaired: 0, unresolved: repaired?.report.unresolved.length ?? 0 }
  signal?.throwIfAborted()
  const stagingRoot = path(`.text-layer-repair.partial-${randomUUID()}`)
  await mkdir(stagingRoot, { recursive: true })
  try {
    let previous: TextLayerRepairReport['repairs'] = []
    try {
      const existing = JSON.parse(await readFile(path(TEXT_LAYER_REPORT), 'utf8')) as Partial<TextLayerRepairReport>
      if (existing.version === TEXT_LAYER_REPAIR_VERSION && Array.isArray(existing.repairs)) previous = existing.repairs
    } catch {
      // No earlier report.
    }
    const files: Array<{ kind: 'parsed_markdown' | 'layout' | 'block_mappings' | null; name: string; content: string }> = [
      { kind: 'parsed_markdown', name: 'full.md', content: repaired.markdown },
      { kind: 'block_mappings', name: 'block_list.json', content: JSON.stringify({ version: BLOCK_MAPPING_VERSION, mappings: buildBlockMappings(taskId, repaired.layout) }, null, 2) },
      { kind: 'layout', name: 'layout.json', content: JSON.stringify(repaired.layout) },
      { kind: null, name: TEXT_LAYER_REPORT, content: JSON.stringify({ ...repaired.report, repairs: [...previous, ...repaired.report.repairs] }, null, 2) }
    ]
    const revisions: Array<{ kind: 'parsed_markdown' | 'layout' | 'block_mappings'; path: string; checksum: string }> = []
    for (const file of files) {
      const staged = pathPolicy.resolveChild(stagingRoot, file.name)
      await writeFile(staged, file.content, 'utf8')
      const checksum = await hashFile(staged)
      await publishStagedFile(staged, path(file.name), checksum)
      if (file.kind) revisions.push({ kind: file.kind, path: path(file.name), checksum })
    }
    repository.recordTextLayerRepair(taskId, revisions, { textLayerRepair: TEXT_LAYER_REPAIR_VERSION, repairs: repaired.report.repairs.length })
    return { repaired: repaired.report.repairs.length, unresolved: repaired.report.unresolved.length }
  } finally {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function rebuildMappings(taskId: string, outputDir: string, repository: V2TaskRepositoryCompat): Promise<void> {
  assertTaskPath(outputDir)
  const layoutPath = join(outputDir, 'layout.json')
  const blockPath = join(outputDir, 'block_list.json')
  const mappings = buildBlockMappings(taskId, JSON.parse(await readFile(layoutPath, 'utf8')) as unknown)
  const stagedPath = join(outputDir, `.block_list.partial-${randomUUID()}.json`)
  try {
    await writeFile(stagedPath, JSON.stringify({ version: BLOCK_MAPPING_VERSION, mappings }, null, 2), 'utf8')
    const checksum = await hashFile(stagedPath)
    await publishStagedFile(stagedPath, blockPath, checksum)
    const task = repository.getTask(taskId)
    if (task) repository.recordArtifactRevision(taskId, 'block_mappings', blockPath, checksum)
  } finally {
    await rm(stagedPath, { force: true }).catch(() => undefined)
  }
}

async function publishStagedFile(stagedPath: string, destination: string, checksum: string): Promise<void> {
  try {
    const existing = await lstat(destination)
    if (!existing.isFile()) throw new CoreUtilityOperationError('CORE_PROTOCOL_ERROR', 'Artifact destination is not a regular file', false)
    if (await hashFile(destination) === checksum) {
      await rm(stagedPath, { force: true })
      return
    }
  } catch (error) {
    if (!isNotFound(error)) throw error
  }
  await mkdir(dirname(destination), { recursive: true })
  await syncFile(stagedPath)
  await rename(stagedPath, destination)
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, 'r+')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function walkFiles(root: string, pathPolicy: PathPolicy): Promise<string[]> {
  const result: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    pathPolicy.resolveChild(root, entry.name)
    const info = await lstat(path)
    if (info.isSymbolicLink()) throw new CoreUtilityOperationError('CORE_PROTOCOL_ERROR', 'Artifact staging contains a symbolic link', false)
    if (info.isDirectory()) result.push(...await walkFiles(path, pathPolicy))
    else if (info.isFile()) result.push(path)
    else throw new CoreUtilityOperationError('CORE_PROTOCOL_ERROR', 'Artifact staging contains an unsupported file', false)
  }
  return result
}

function assertTaskPath(path: string): void {
  if (!isAbsolute(path) || path.length > 32_768 || path.includes('\0')) throw new CoreUtilityOperationError('CORE_PROTOCOL_ERROR', 'Invalid utility path', false)
}

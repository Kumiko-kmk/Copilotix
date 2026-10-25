import { createInsightOperations } from '@features/insight/utility'
import { MarkdownEditStore } from './persistence/markdownEditStore'
import { markdownEditRequestSchema } from '@shared/markdownEdits'
import { libraryCategoriesRequestSchema } from '@shared/libraryCategories'
import { LibraryCategoryService } from './libraryCategoryService'
import { ReaderNoteStore } from './persistence/readerNoteStore'
import { readerNoteDeleteSchema, readerNoteUpsertSchema, readerNotesRequestSchema } from '@shared/readerNotes'
import { createChatOperations, PaperContextError, RagContentIndexError, RagContentIndexService, SqliteRagRepository, SqliteRagRepositoryError } from '@features/chat/utility'
import { assertLibraryIdle, manageLibrary } from './libraryMaintenance'
import { libraryCoreRequestSchema } from '@shared/librarySchemas'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { CoreListCursor } from '@shared/coreRpcSchemas'
import type { CoreOperation } from '@app/contract/coreRpc'
import {
  CORE_LIST_PAGE_MAX_ROWS,
  coreListPagePayloadSchema,
  coreSettingsMigrationPayloadSchema,
  coreDocumentMetadataPayloadSchema,
  coreImportPdfPayloadSchema
} from '@shared/coreRpcSchemas'
import { coreDatabaseInitPayloadSchema } from '@platform/rpc/contract/protocol'
import {
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
  coreJobEventsPayloadSchema
} from '@platform/jobs/contract/rpc'
import type { CopilotixTask } from '@shared/types'
import { appSettingsSchema } from '@shared/ipcSchemas'
import { MAX_PDF_BYTES } from '@shared/constants'
import { MAX_PDF_CROP_BYTES } from '@shared/pdfImport'
import { CoreUtilityOperationError, type CoreUtilityOperationHandler } from '@platform/rpc/utility/coreUtilityRuntime'
import { V2Database } from '@platform/database/utility/v2Database'
import { V2TaskRepositoryCompat } from './persistence/v2TaskRepositoryCompat'
import { SqliteJobRepository, SqliteJobRepositoryError } from '@platform/jobs/utility/sqliteJobRepository'
import { PathPolicy } from '@platform/files/runtime/pathPolicy'
import { createTranslationOperations, MarkdownTranslationPlanManager } from '@features/translation/utility'
import { withoutFirstPage } from './compute/pdfPageRemoval'
import { createParsingOperations, hashFile, isNotFound } from '@features/parsing/utility'

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
  const noteStore = new ReaderNoteStore((id) => requireRepository().getTask(id)?.outputDir ?? null)
  const editStore = new MarkdownEditStore((id) => requireRepository().getTask(id)?.outputDir ?? null)
  const insight = createInsightOperations(requireRepository)
  const { insightStore, figureInsightStore } = insight
  const categories = new LibraryCategoryService(insightStore, requireRepository)
  const chat = createChatOperations({
    repository: requireRepository,
    ragRepository: requireRagRepository,
    ragIndex: requireRagContentIndexService,
    edits: editStore,
    figureInsightStore
  })
  const translation = createTranslationOperations(requireTranslationPlanManager)
  const parsing = createParsingOperations(requireRepository)
  const handlers: UtilityHandlerMap = {
    ...insight.handlers,
    // Reads every paper's text on first use: compute lane, so quick data requests are not held up.
    'compute:library-categories': (request, signal) => categories.page(libraryCategoriesRequestSchema.parse(request.payload).after ?? 0, signal),
    ...chat.handlers,
    'markdown-edits:apply': (request) => editStore.apply(markdownEditRequestSchema.parse(request.payload)),
    'notes:list': (request) => noteStore.list(readerNotesRequestSchema.parse(request.payload).documentId),
    'notes:upsert': (request) => { const { documentId, note } = readerNoteUpsertSchema.parse(request.payload); return noteStore.upsert(documentId, note) },
    'notes:delete': (request) => { const { documentId, noteId } = readerNoteDeleteSchema.parse(request.payload); return noteStore.delete(documentId, noteId) },
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
    ...parsing.handlers,
    ...translation.handlers
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

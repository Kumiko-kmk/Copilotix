import { createLibraryOperations, assertLibraryIdle, manageLibrary, V2TaskRepositoryCompat } from '@features/library/utility'
import { createInsightOperations } from '@features/insight/utility'
import { createReaderOperations } from '@features/reader/utility'
import { createChatOperations, PaperContextError, RagContentIndexError, RagContentIndexService, SqliteRagRepository, SqliteRagRepositoryError } from '@features/chat/utility'
import { libraryCoreRequestSchema } from '@features/library/contract/librarySchemas'
import { mkdir } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import type { CoreOperation } from '@app/contract/coreRpc'
import { coreSettingsMigrationPayloadSchema } from '@features/settings/contract/rpc'
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
import { appSettingsSchema } from '@shared/ipcSchemas'
import { CoreUtilityOperationError, type CoreUtilityOperationHandler } from '@platform/rpc/utility/coreUtilityRuntime'
import { V2Database } from '@platform/database/utility/v2Database'
import { SqliteJobRepository, SqliteJobRepositoryError } from '@platform/jobs/utility/sqliteJobRepository'
import { PathPolicy } from '@platform/files/runtime/pathPolicy'
import { createTranslationOperations, MarkdownTranslationPlanManager } from '@features/translation/utility'
import { createParsingOperations } from '@features/parsing/utility'

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
  const reader = createReaderOperations(requireRepository)
  const editStore = reader.editStore
  const insight = createInsightOperations(requireRepository)
  const { insightStore, figureInsightStore } = insight
  const library = createLibraryOperations({ repository: requireRepository, outputRoot: () => state.outputRoot, insightStore })
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
    ...library.handlers,
    ...chat.handlers,
    ...reader.handlers,
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

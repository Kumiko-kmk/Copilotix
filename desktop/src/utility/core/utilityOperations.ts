import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { copyFile, lstat, mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { CoreOperation } from '@shared/coreRpcSchemas'
import {
  coreDatabaseInitPayloadSchema,
  coreTaskPatchSchema,
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
  coreKnowledgeGetPayloadSchema,
  coreSemanticConsentPayloadSchema,
  coreEnsureEmbeddingPayloadSchema,
  coreSettingsMigrationPayloadSchema,
  coreDocumentMetadataPayloadSchema,
  coreImportPdfPayloadSchema,
  coreRagContentIndexPayloadSchema,
  coreTranslationBatchCommitPayloadSchema,
  coreTranslationPlanOpenPayloadSchema,
  coreTranslationPlanListPayloadSchema,
  coreTranslationPlanCachePayloadSchema,
  coreTranslationPlanApplyPayloadSchema,
  coreTranslationPlanFailPayloadSchema,
  coreTranslationPlanFinalizePayloadSchema
} from '@shared/coreRpcSchemas'
import type { CopilotixTask } from '@shared/types'
import { appSettingsSchema } from '@shared/ipcSchemas'
import { MAX_PDF_BYTES } from '@shared/constants'
import { extractPaperTitle, sanitizeTitleStem } from '@shared/titleNaming'
import { BLOCK_MAPPING_VERSION, buildBlockMappings } from '@core/blockMapping'
import { CoreUtilityOperationError, type CoreUtilityOperationHandler } from '../coreUtilityRuntime'
import { V2Database } from './persistence/v2Database'
import { V2TaskRepositoryCompat } from './persistence/v2TaskRepositoryCompat'
import { SqliteJobRepository, SqliteJobRepositoryError } from './persistence/sqliteJobRepository'
import { SqliteRagRepository, SqliteRagRepositoryError } from './persistence/sqliteRagRepository'
import { RagDomainService } from './ragDomainService'
import { PathPolicy } from './persistence/pathPolicy'
import { MarkdownTranslationPlanManager } from './compute/markdownTranslationPlan'
import { RagContentIndexError, RagContentIndexService } from './compute/ragContentIndexService'

type UtilityHandlerMap = Partial<Record<CoreOperation, CoreUtilityOperationHandler>>

interface UtilityPersistenceState {
  database?: V2Database
  repository?: V2TaskRepositoryCompat
  jobRepository?: SqliteJobRepository
  ragRepository?: SqliteRagRepository
  ragService?: RagDomainService
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
  // Core runtime handlers may run concurrently.  Keep every operation that
  // touches the SQLite connection on one async lane so init/close/flush can
  // never race an in-flight query or let a new query cross a close boundary.
  let persistenceTail = Promise.resolve()
  const serializePersistence = <T>(operation: () => T | Promise<T>): Promise<T> => {
    const next = persistenceTail.then(operation, operation)
    persistenceTail = next.then(() => undefined, () => undefined)
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
  const requireRagService = (): RagDomainService => {
    if (!state.ragService) throw new CoreUtilityOperationError('CORE_UNAVAILABLE', 'Core database is not initialized', true)
    return state.ragService
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
  const handlers: UtilityHandlerMap = {
    ping: () => ({ pong: true }),
    'database:init': async (request) => {
      const payload = coreDatabaseInitPayloadSchema.parse(request.payload)
      validateBootstrapPaths(payload.databasePath, payload.outputRoot)
      if (state.databasePath === payload.databasePath && state.outputRoot === payload.outputRoot && state.repository && state.jobRepository && state.ragService && state.ragContentIndexService) return { initialized: true }
      closeState(state)
      try {
        await mkdir(dirname(payload.databasePath), { recursive: true })
        state.outputRoot = payload.outputRoot
        state.database = new V2Database(payload.databasePath)
        state.repository = new V2TaskRepositoryCompat(state.database, new PathPolicy())
        state.repository.reconcileContentIndexVersion()
        state.jobRepository = new SqliteJobRepository(state.database)
        state.ragRepository = new SqliteRagRepository(state.database)
        state.ragService = new RagDomainService(state.database, state.ragRepository, state.jobRepository)
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
      state.outputRoot = settings.outputRoot
      state.translationPlanManager = undefined
      return settings
    },
    'settings:save': (request) => {
      const repository = requireRepository()
      const settings = appSettingsSchema.parse((request.payload as { settings: unknown }).settings)
      repository.saveSettings(settings)
      state.outputRoot = settings.outputRoot
      state.translationPlanManager = undefined
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
    'tasks:list': () => requireRepository().listTasks(),
    'tasks:get': (request) => requireRepository().getTask((request.payload as { id: string }).id),
    'tasks:find-by-hash': (request) => requireRepository().findByHash((request.payload as { hash: string }).hash),
    'tasks:insert': (request) => {
      requireRepository().insertTask((request.payload as { task: CopilotixTask }).task)
      return { changed: true }
    },
    'tasks:insert-many': (request) => {
      requireRepository().insertTasks((request.payload as { tasks: CopilotixTask[] }).tasks)
      return { changed: true }
    },
    'tasks:update': (request) => {
      const payload = request.payload as { id: string; patch: Partial<CopilotixTask> }
      return requireRepository().updateTask(payload.id, coreTaskPatchSchema.parse(payload.patch))
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
    'documents:list': () => requireRepository().listDocumentSummaries(),
    'documents:get-summary': (request) => requireRepository().getDocumentSummary((request.payload as { id: string }).id),
    'documents:update-metadata': (request) => {
      const payload = coreDocumentMetadataPayloadSchema.parse(request.payload)
      requireRepository().updateDocumentMetadata(payload.id, payload.patch)
      return { changed: true }
    },
    'knowledge:get': (request) => {
      const payload = coreKnowledgeGetPayloadSchema.parse(request.payload)
      return requireRagService().getKnowledge(payload.documentId)
    },
    'knowledge:set-semantic-consent': (request) => {
      const payload = coreSemanticConsentPayloadSchema.parse(request.payload)
      return requireRagService().setSemanticConsent(payload.documentId, payload.consent, payload.now)
    },
    'knowledge:ensure-embed': (request) => {
      const payload = coreEnsureEmbeddingPayloadSchema.parse(request.payload)
      return requireRagService().ensureEmbeddingJob(payload)
    },
    'artifacts:get-latest': (request) => {
      const payload = request.payload as { documentId: string; kind: Parameters<V2TaskRepositoryCompat['getLatestArtifactReference']>[1] }
      return requireRepository().getLatestArtifactReference(payload.documentId, payload.kind)
    },
    'artifacts:record-revision': (request) => {
      const payload = request.payload as { taskId: string; kind: Parameters<V2TaskRepositoryCompat['recordArtifactRevision']>[1]; path: string; checksum: string; metadata?: Record<string, unknown>; jobId?: string }
      requireRepository().recordArtifactRevision(payload.taskId, payload.kind, payload.path, payload.checksum, payload.metadata ?? {}, payload.jobId)
      return { changed: true }
    },
    'translation:block-upsert': (request) => {
      requireRepository().upsertTranslationBlock((request.payload as { block: Parameters<V2TaskRepositoryCompat['upsertTranslationBlock']>[0] }).block)
      return { changed: true }
    },
    'translation:batch-commit': (request) => {
      requireRepository().commitTranslationBatch(coreTranslationBatchCommitPayloadSchema.parse(request.payload))
      return { changed: true }
    },
    'translation:blocks-list': (request) => {
      const payload = request.payload as { taskId: string; jobId?: string }
      return requireRepository().listTranslationBlocks(payload.taskId, payload.jobId)
    },
    'translation:run-update': (request) => {
      const payload = request.payload as { taskId: string; total: number; completed: number; failed: number }
      requireRepository().updateTranslationRun(payload.taskId, payload.total, payload.completed, payload.failed)
      return { changed: true }
    },
    'translation:cache-get': (request) => ({ translated: requireRepository().getCache((request.payload as { cacheKey: string }).cacheKey) }),
    'translation:cache-put': (request) => {
      const payload = request.payload as { cacheKey: string; translated: string; provider: string; model: string }
      requireRepository().putCache(payload.cacheKey, payload.translated, payload.provider, payload.model)
      return { changed: true }
    },
    'annotations:list': (request) => requireRepository().listReaderAnnotations((request.payload as { taskId: string }).taskId),
    'annotations:replace': (request) => requireRepository().replaceReaderAnnotations((request.payload as { request: Parameters<V2TaskRepositoryCompat['replaceReaderAnnotations']>[0] }).request),
    'annotations:list-snapshot': (request) => {
      const payload = request.payload as Parameters<V2TaskRepositoryCompat['listDocumentAnnotations']>[0]
      return requireRepository().listDocumentAnnotations(payload)
    },
    'annotations:mutate': (request) => requireRepository().mutateDocumentAnnotations((request.payload as { request: Parameters<V2TaskRepositoryCompat['mutateDocumentAnnotations']>[0] }).request),
    'compute:hash-file': async (request) => ({ sha256: await hashFile((request.payload as { path: string }).path) }),
    'compute:import-pdf': async (request, signal) => {
      const payload = coreImportPdfPayloadSchema.parse(request.payload)
      return importPdf(payload.sourcePath, payload.documentId, state, signal)
    },
    'compute:normalize-parser': async (request) => {
      const payload = request.payload as { task: CopilotixTask; extractedDir: string; jobId?: string }
      return normalizeParserOutput(payload.task, payload.extractedDir, requireRepository(), payload.jobId)
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

  const persistenceOperations: readonly CoreOperation[] = [
    'database:init', 'database:flush', 'database:close',
    'settings:get', 'settings:save', 'settings:migration-get', 'settings:migration-mark',
    'tasks:list', 'tasks:get', 'tasks:find-by-hash', 'tasks:insert', 'tasks:insert-many', 'tasks:update', 'tasks:delete',
    'jobs:enqueue', 'jobs:get', 'jobs:list', 'jobs:claim-batch', 'jobs:heartbeat', 'jobs:update-progress',
    'jobs:complete', 'jobs:fail-or-retry', 'jobs:cancel', 'jobs:manual-retry', 'jobs:recover-expired', 'jobs:list-events',
    'documents:list', 'documents:get-summary', 'documents:update-metadata', 'artifacts:get-latest', 'artifacts:record-revision',
    'knowledge:get', 'knowledge:set-semantic-consent', 'knowledge:ensure-embed',
    'translation:block-upsert', 'translation:batch-commit', 'translation:blocks-list', 'translation:run-update',
    'translation:cache-get', 'translation:cache-put',
    'annotations:list', 'annotations:replace', 'annotations:list-snapshot', 'annotations:mutate',
    'compute:import-pdf', 'compute:normalize-parser', 'compute:rebuild-mappings',
    'compute:rag-content-index',
    'compute:translation-plan-open', 'compute:translation-plan-list', 'compute:translation-plan-cache',
    'compute:translation-plan-apply', 'compute:translation-plan-fail', 'compute:translation-plan-finalize'
  ]
  for (const operation of persistenceOperations) {
    const handler = handlers[operation]
    if (!handler) continue
    handlers[operation] = (request, signal) => serializePersistence(() => handler(request, signal)).catch((error: unknown) => {
      if (error instanceof SqliteJobRepositoryError || error instanceof SqliteRagRepositoryError || error instanceof RagContentIndexError) {
        throw new CoreUtilityOperationError(error.code, error.message, error.retryable)
      }
      throw error
    })
  }

  return {
    handlers,
    flush: () => serializePersistence(() => {
      if (state.database) state.database.connection.exec('PRAGMA wal_checkpoint(PASSIVE)')
    }),
    close: () => serializePersistence(() => closeState(state))
  }
}

function closeState(state: UtilityPersistenceState): void {
  try {
    state.translationPlanManager = undefined
    state.repository = undefined
    state.jobRepository = undefined
    state.ragService = undefined
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
  signal: AbortSignal
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

  const hash = createHash('sha256')
  let size = 0
  let published = false
  try {
    const hashing = new Transform({
      transform(chunk, _encoding, callback) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        size += buffer.length
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
  jobId?: string
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

    const layoutData = JSON.parse(await readFile(layoutStaged, 'utf8')) as unknown
    const mappings = buildBlockMappings(task.id, layoutData)
    const pageCount = mappings.reduce((maximum, mapping) => Math.max(maximum, ...mapping.boxes.map((box) => box.pageIndex + 1), 0), 0)
    const markdownText = await readFile(markdownStaged, 'utf8')
    const extractedTitle = extractPaperTitle(markdownText, mappings)
    const displayTitle = extractedTitle ? sanitizeTitleStem(extractedTitle) : null
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
    repository.recordArtifactRevisions(revisions)
    return { normalized: true, displayTitle, pageCount }
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

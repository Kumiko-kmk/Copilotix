import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative } from 'node:path'
import type { CoreOperation } from '@shared/coreRpcSchemas'
import {
  coreDatabaseInitPayloadSchema,
  coreTaskPatchSchema
} from '@shared/coreRpcSchemas'
import type { MinerUTask } from '@shared/types'
import { appSettingsSchema } from '@shared/ipcSchemas'
import { CoreUtilityOperationError, type CoreUtilityOperationHandler } from '../coreUtilityRuntime'
import { V2Database } from './persistence/v2Database'
import { V2TaskRepositoryCompat } from './persistence/v2TaskRepositoryCompat'
import { PathPolicy } from './persistence/pathPolicy'
import { BLOCK_MAPPING_VERSION, buildUtilityBlockMappings } from './compute/blockMapping'

type UtilityHandlerMap = Partial<Record<CoreOperation, CoreUtilityOperationHandler>>

interface UtilityPersistenceState {
  database?: V2Database
  repository?: V2TaskRepositoryCompat
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
  const handlers: UtilityHandlerMap = {
    ping: () => ({ pong: true }),
    'database:init': async (request) => {
      const payload = coreDatabaseInitPayloadSchema.parse(request.payload)
      validateBootstrapPaths(payload.databasePath, payload.outputRoot)
      if (state.databasePath === payload.databasePath && state.repository) return { initialized: true }
      closeState(state)
      await mkdir(dirname(payload.databasePath), { recursive: true })
      state.database = new V2Database(payload.databasePath)
      state.repository = new V2TaskRepositoryCompat(state.database, new PathPolicy())
      state.databasePath = payload.databasePath
      state.outputRoot = payload.outputRoot
      return { initialized: true }
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
      return appSettingsSchema.parse(repository.getSettings(payload.outputRoot))
    },
    'settings:save': (request) => {
      const repository = requireRepository()
      const settings = appSettingsSchema.parse((request.payload as { settings: unknown }).settings)
      repository.saveSettings(settings)
      return settings
    },
    'tasks:list': () => requireRepository().listTasks(),
    'tasks:get': (request) => requireRepository().getTask((request.payload as { id: string }).id),
    'tasks:find-by-hash': (request) => requireRepository().findByHash((request.payload as { hash: string }).hash),
    'tasks:insert': (request) => {
      requireRepository().insertTask((request.payload as { task: MinerUTask }).task)
      return { changed: true }
    },
    'tasks:insert-many': (request) => {
      requireRepository().insertTasks((request.payload as { tasks: MinerUTask[] }).tasks)
      return { changed: true }
    },
    'tasks:update': (request) => {
      const payload = request.payload as { id: string; patch: Partial<MinerUTask> }
      return requireRepository().updateTask(payload.id, coreTaskPatchSchema.parse(payload.patch))
    },
    'tasks:delete': (request) => {
      requireRepository().deleteTask((request.payload as { id: string }).id)
      return { changed: true }
    },
    'documents:list': () => requireRepository().listDocumentSummaries(),
    'documents:get-summary': (request) => requireRepository().getDocumentSummary((request.payload as { id: string }).id),
    'artifacts:get-latest': (request) => {
      const payload = request.payload as { documentId: string; kind: Parameters<V2TaskRepositoryCompat['getLatestArtifactReference']>[1] }
      return requireRepository().getLatestArtifactReference(payload.documentId, payload.kind)
    },
    'artifacts:record-revision': (request) => {
      const payload = request.payload as { taskId: string; kind: Parameters<V2TaskRepositoryCompat['recordArtifactRevision']>[1]; path: string; checksum: string; metadata?: Record<string, unknown> }
      requireRepository().recordArtifactRevision(payload.taskId, payload.kind, payload.path, payload.checksum, payload.metadata ?? {})
      return { changed: true }
    },
    'translation:block-upsert': (request) => {
      requireRepository().upsertTranslationBlock((request.payload as { block: Parameters<V2TaskRepositoryCompat['upsertTranslationBlock']>[0] }).block)
      return { changed: true }
    },
    'translation:blocks-list': (request) => requireRepository().listTranslationBlocks((request.payload as { taskId: string }).taskId),
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
    'compute:normalize-parser': async (request) => {
      const payload = request.payload as { task: MinerUTask; extractedDir: string }
      await normalizeParserOutput(payload.task, payload.extractedDir, requireRepository())
      return { normalized: true }
    },
    'compute:rebuild-mappings': async (request) => {
      const payload = request.payload as { taskId: string; outputDir: string }
      await rebuildMappings(payload.taskId, payload.outputDir, requireRepository())
      return { rebuilt: true }
    }
  }

  const persistenceOperations: readonly CoreOperation[] = [
    'database:init', 'database:flush', 'database:close',
    'settings:get', 'settings:save',
    'tasks:list', 'tasks:get', 'tasks:find-by-hash', 'tasks:insert', 'tasks:insert-many', 'tasks:update', 'tasks:delete',
    'documents:list', 'documents:get-summary', 'artifacts:get-latest', 'artifacts:record-revision',
    'translation:block-upsert', 'translation:blocks-list', 'translation:run-update',
    'translation:cache-get', 'translation:cache-put',
    'annotations:list', 'annotations:replace', 'annotations:list-snapshot', 'annotations:mutate',
    'compute:normalize-parser', 'compute:rebuild-mappings'
  ]
  for (const operation of persistenceOperations) {
    const handler = handlers[operation]
    if (!handler) continue
    handlers[operation] = (request, signal) => serializePersistence(() => handler(request, signal))
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
  try { state.repository = undefined } finally {
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

async function normalizeParserOutput(task: MinerUTask, extractedDir: string, repository: V2TaskRepositoryCompat): Promise<void> {
  assertTaskPath(task.outputDir)
  assertTaskPath(extractedDir)
  const files = await walkFiles(extractedDir)
  const markdown = files.find((path) => extname(path).toLowerCase() === '.md')
  const layout = files.find((path) => /(?:layout|middle)\.json$/iu.test(path))
  const contentList = files.find((path) => /content_list(?:_v2)?\.json$/iu.test(path))
  if (!markdown || !layout) throw new CoreUtilityOperationError('CORE_UNAVAILABLE', 'MinerU result is incomplete', false)
  await mkdir(task.outputDir, { recursive: true })
  const markdownPath = join(task.outputDir, 'full.md')
  const layoutPath = join(task.outputDir, 'layout.json')
  await copyFile(markdown, markdownPath)
  await copyFile(layout, layoutPath)
  repository.recordArtifactRevision(task.id, 'parsed_markdown', markdownPath, await hashFile(markdownPath))
  repository.recordArtifactRevision(task.id, 'layout', layoutPath, await hashFile(layoutPath))
  if (contentList) {
    const contentPath = join(task.outputDir, 'content_list.json')
    await copyFile(contentList, contentPath)
    repository.recordArtifactRevision(task.id, 'content_list', contentPath, await hashFile(contentPath))
  }
  for (const file of files) {
    const rel = relative(extractedDir, file)
    if (!/[/\\]images?[/\\]/iu.test(file) && !/\.(png|jpe?g|webp|gif|svg)$/iu.test(file)) continue
    const target = join(task.outputDir, rel)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(file, target)
  }
  const layoutData = JSON.parse(await readFile(layoutPath, 'utf8')) as unknown
  const mappings = buildUtilityBlockMappings(task.id, layoutData)
  const blockPath = join(task.outputDir, 'block_list.json')
  await writeFile(blockPath, JSON.stringify({ version: BLOCK_MAPPING_VERSION, mappings }, null, 2), 'utf8')
  repository.recordArtifactRevision(task.id, 'block_mappings', blockPath, await hashFile(blockPath))
}

async function rebuildMappings(taskId: string, outputDir: string, repository: V2TaskRepositoryCompat): Promise<void> {
  assertTaskPath(outputDir)
  const layoutPath = join(outputDir, 'layout.json')
  const blockPath = join(outputDir, 'block_list.json')
  const mappings = buildUtilityBlockMappings(taskId, JSON.parse(await readFile(layoutPath, 'utf8')) as unknown)
  await writeFile(blockPath, JSON.stringify({ version: BLOCK_MAPPING_VERSION, mappings }, null, 2), 'utf8')
  const task = repository.getTask(taskId)
  if (task) repository.recordArtifactRevision(taskId, 'block_mappings', blockPath, await hashFile(blockPath))
}

async function walkFiles(root: string): Promise<string[]> {
  const result: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) result.push(...await walkFiles(path))
    else if (entry.isFile()) result.push(path)
  }
  return result
}

function assertTaskPath(path: string): void {
  if (!isAbsolute(path) || path.length > 32_768 || path.includes('\0')) throw new CoreUtilityOperationError('CORE_PROTOCOL_ERROR', 'Invalid utility path', false)
}

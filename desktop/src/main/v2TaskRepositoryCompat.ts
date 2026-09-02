import { randomUUID } from 'node:crypto'
import { join, relative } from 'node:path'
import type { ArtifactKind } from '@core/types'
import type { PathPolicyPort } from '@core/ports'
import type {
  AppSettings,
  MinerUTask,
  ReaderAnnotation,
  ReplaceReaderAnnotationsRequest,
  TaskStatus,
  TranslationBlockRecord
} from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/constants'
import type { TaskRepositoryCompat } from './taskRepositoryCompat'
import { PathPolicy, resolveLexicalWithinRoot } from './pathPolicy'
import { V2Database } from './v2Database'

export interface CompatDocumentRow {
  id: string
  original_filename: string
  display_title: string | null
  storage_path: string
  source_checksum: string
  parser_model: 'vlm' | 'pipeline'
  translation_provider: 'qwen' | 'deepseek' | 'bing' | 'transmart'
  created_at: string
  updated_at: string
}

type V2JobKind = 'parse' | 'translate'
type V2JobStatus = 'queued' | 'running' | 'retry-wait' | 'succeeded' | 'partial' | 'failed' | 'cancelled'

export interface CompatJobRow {
  id: string
  document_id: string
  depends_on_job_id: string | null
  kind: V2JobKind
  status: V2JobStatus
  progress: number
  priority: number
  attempt: number
  max_attempts: number
  payload_json: string
  checkpoint_json: string
  available_at: string
  lease_owner: string | null
  lease_expires_at: string | null
  error_code: string | null
  error_message: string | null
  started_at: string | null
  finished_at: string | null
  created_at: string
  updated_at: string
}

const TERMINAL: ReadonlySet<V2JobStatus> = new Set(['succeeded', 'partial', 'failed', 'cancelled'])

/** Temporary phase-2 compatibility adapter; remove when services use core ports directly in phase 3. */
export class V2TaskRepositoryCompat implements TaskRepositoryCompat {
  constructor(
    private readonly database: V2Database,
    private readonly pathPolicy: PathPolicyPort = new PathPolicy()
  ) {}

  close(): void {
    this.database.close()
  }

  getSettings(outputRoot: string): AppSettings {
    const rows = this.database.connection.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>
    const stored = Object.fromEntries(rows.map((row) => [row.key, JSON.parse(row.value)])) as Partial<AppSettings>
    return {
      ...DEFAULT_SETTINGS,
      outputRoot: stored.outputRoot ?? outputRoot,
      parserModel: stored.parserModel === 'pipeline' ? 'pipeline' : 'vlm',
      forceOcr: stored.forceOcr ?? DEFAULT_SETTINGS.forceOcr,
      formulaEnabled: stored.formulaEnabled ?? DEFAULT_SETTINGS.formulaEnabled,
      tableEnabled: stored.tableEnabled ?? DEFAULT_SETTINGS.tableEnabled,
      ocrLanguage: stored.ocrLanguage ?? DEFAULT_SETTINGS.ocrLanguage,
      translationProvider: stored.translationProvider ?? DEFAULT_SETTINGS.translationProvider,
      qwenBaseUrl: stored.qwenBaseUrl ?? DEFAULT_SETTINGS.qwenBaseUrl,
      qwenModel: stored.qwenModel ?? DEFAULT_SETTINGS.qwenModel,
      deepseekBaseUrl: stored.deepseekBaseUrl ?? DEFAULT_SETTINGS.deepseekBaseUrl,
      deepseekModel: stored.deepseekModel ?? DEFAULT_SETTINGS.deepseekModel,
      hasParserToken: false,
      qwenHasApiKey: false,
      deepseekHasApiKey: false
    }
  }

  saveSettings(settings: AppSettings): void {
    const hidden = new Set(['hasParserToken', 'qwenHasApiKey', 'deepseekHasApiKey'])
    this.database.transaction(() => {
      const statement = this.database.connection.prepare(
        'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
      )
      for (const [key, value] of Object.entries(settings)) if (!hidden.has(key)) statement.run(key, JSON.stringify(value))
    })
  }

  listTasks(): MinerUTask[] {
    const ids = this.database.connection.prepare('SELECT id FROM documents ORDER BY created_at DESC').all() as Array<{ id: string }>
    return ids.map(({ id }) => this.getTask(id)).filter((task): task is MinerUTask => task !== null)
  }

  getTask(id: string): MinerUTask | null {
    return this.readProjection(id)
  }

  findByHash(hash: string): MinerUTask | null {
    const row = this.database.connection.prepare(
      'SELECT id FROM documents WHERE source_checksum = ? ORDER BY created_at DESC LIMIT 1'
    ).get(hash) as { id: string } | undefined
    return row ? this.readProjection(row.id) : null
  }

  insertTask(task: MinerUTask): void {
    this.database.transaction(() => this.insertTaskUnsafe(task))
  }

  insertTasks(tasks: MinerUTask[]): void {
    this.database.transaction(() => {
      for (const task of tasks) this.insertTaskUnsafe(task)
    })
  }

  updateTask(id: string, patch: Partial<MinerUTask>): MinerUTask {
    this.database.transaction(() => {
      const current = this.readProjection(id)
      if (!current) throw new Error(`Task not found: ${id}`)
      const next: MinerUTask = { ...current, ...patch, id, updatedAt: new Date().toISOString() }
      this.database.connection.prepare(`
        UPDATE documents SET display_title=?, parser_model=?, translation_provider=?, updated_at=? WHERE id=?
      `).run(next.title, next.parserModel, next.translationProvider, next.updatedAt, id)
      this.syncJobsUnsafe(next)
    })
    return this.readProjection(id) ?? (() => { throw new Error(`Task not found: ${id}`) })()
  }

  deleteTask(id: string): void {
    this.database.transaction(() => {
      this.database.connection.prepare('DELETE FROM documents WHERE id = ?').run(id)
    })
  }

  upsertTranslationBlock(block: TranslationBlockRecord): void {
    this.database.transaction(() => {
      const job = this.latestJob(block.taskId, 'translate')
      if (!job) throw new Error('翻译作业尚未创建')
      this.database.connection.prepare(`
        INSERT INTO translation_blocks(
          job_id,block_id,source_hash,source_markdown,translated_markdown,provider,model,status,error
        ) VALUES(?,?,?,?,?,?,?,?,?)
        ON CONFLICT(job_id,block_id) DO UPDATE SET
          source_hash=excluded.source_hash,
          source_markdown=excluded.source_markdown,
          translated_markdown=excluded.translated_markdown,
          provider=excluded.provider,
          model=excluded.model,
          status=excluded.status,
          error=excluded.error
      `).run(job.id, block.blockId, block.sourceHash, block.sourceMarkdown, block.translatedMarkdown,
        block.provider, block.model, block.status, block.error)
    })
  }

  listTranslationBlocks(taskId: string): TranslationBlockRecord[] {
    const job = this.latestJob(taskId, 'translate')
    if (!job) return []
    return this.database.connection.prepare(`
      SELECT ? as taskId, block_id as blockId, source_hash as sourceHash,
        source_markdown as sourceMarkdown, translated_markdown as translatedMarkdown,
        provider, model, status, error
      FROM translation_blocks WHERE job_id = ? ORDER BY rowid
    `).all(taskId, job.id) as unknown as TranslationBlockRecord[]
  }

  updateTranslationRun(taskId: string, total: number, completed: number, failed: number): void {
    this.database.transaction(() => {
      const job = this.latestJob(taskId, 'translate')
      if (!job) throw new Error('翻译作业尚未创建')
      const checkpoint = {
        ...parseObject(job.checkpoint_json),
        totalBlocks: total,
        completedBlocks: completed,
        failedBlocks: failed
      }
      this.database.connection.prepare('UPDATE jobs SET checkpoint_json=?, updated_at=? WHERE id=?')
        .run(JSON.stringify(checkpoint), new Date().toISOString(), job.id)
    })
  }

  getCache(cacheKey: string): string | null {
    const row = this.database.connection.prepare('SELECT translated_markdown FROM translation_cache WHERE cache_key=?').get(cacheKey) as { translated_markdown: string } | undefined
    return row?.translated_markdown ?? null
  }

  putCache(cacheKey: string, translated: string, provider: string, model: string): void {
    this.database.transaction(() => {
      this.database.connection.prepare(`
        INSERT INTO translation_cache(cache_key,translated_markdown,provider,model,created_at)
        VALUES(?,?,?,?,?)
        ON CONFLICT(cache_key) DO UPDATE SET translated_markdown=excluded.translated_markdown,
          provider=excluded.provider,model=excluded.model,created_at=excluded.created_at
      `).run(cacheKey, translated, provider, model, new Date().toISOString())
    })
  }

  listReaderAnnotations(taskId: string): ReaderAnnotation[] {
    return this.database.connection.prepare(`
      SELECT id,document_id as taskId,view,kind,color,block_key as blockKey,
        start_offset as startOffset,end_offset as endOffset,quote,prefix,suffix,
        created_at as createdAt,updated_at as updatedAt
      FROM reader_annotations
      WHERE document_id=? AND (
        (view='original' AND artifact_id=(
          SELECT id FROM artifacts WHERE document_id=? AND kind='parsed_markdown'
          ORDER BY revision DESC LIMIT 1
        )) OR
        (view='translated' AND artifact_id=(
          SELECT id FROM artifacts WHERE document_id=? AND kind='translated_markdown'
          ORDER BY revision DESC LIMIT 1
        ))
      )
      ORDER BY view,block_key,start_offset,end_offset,id
    `).all(taskId, taskId, taskId) as unknown as ReaderAnnotation[]
  }

  replaceReaderAnnotations(request: ReplaceReaderAnnotationsRequest): ReaderAnnotation[] {
    return this.database.transaction(() => {
      const document = this.readDocument(request.taskId)
      if (!document) throw new Error('任务不存在')
      const artifactKind: ArtifactKind = request.view === 'translated' ? 'translated_markdown' : 'parsed_markdown'
      const artifact = this.latestArtifact(request.taskId, artifactKind)
      if (!artifact) throw new Error('当前文档尚无可标注的产物')
      validateAnnotations(request)
      const now = new Date().toISOString()
      const set = this.database.connection.prepare(`
        SELECT id,revision FROM annotation_sets
        WHERE document_id=? AND artifact_id=? AND view=?
      `).get(request.taskId, artifact.id, request.view) as { id: string; revision: number } | undefined
      const setId = set?.id ?? randomUUID()
      const revision = (set?.revision ?? 0) + 1
      if (set) {
        this.database.connection.prepare('UPDATE annotation_sets SET revision=?,updated_at=? WHERE id=?')
          .run(revision, now, set.id)
      } else {
        this.database.connection.prepare(`
          INSERT INTO annotation_sets(id,document_id,artifact_id,view,revision,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?)
        `).run(setId, request.taskId, artifact.id, request.view, revision, now, now)
      }
      this.database.connection.prepare('DELETE FROM reader_annotations WHERE annotation_set_id=?').run(setId)
      const insert = this.database.connection.prepare(`
        INSERT INTO reader_annotations(
          id,document_id,artifact_id,annotation_set_id,view,kind,color,block_key,
          start_offset,end_offset,quote,prefix,suffix,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `)
      for (const annotation of request.annotations) {
        insert.run(annotation.id, request.taskId, artifact.id, setId, request.view, annotation.kind, annotation.color,
          annotation.blockKey, annotation.startOffset, annotation.endOffset, annotation.quote, annotation.prefix,
          annotation.suffix, annotation.createdAt || now, now)
      }
      return this.listReaderAnnotations(request.taskId)
    })
  }

  recordArtifactRevision(taskId: string, kind: ArtifactKind, path: string, checksum: string, metadata: Record<string, unknown> = {}): void {
    this.database.transaction(() => {
      const document = this.readDocument(taskId)
      if (!document) throw new Error('任务不存在')
      const jobKind: V2JobKind = kind === 'translated_markdown' || kind === 'manifest' ? 'translate' : 'parse'
      const job = this.latestJob(taskId, jobKind)
      if (!job) throw new Error('产物对应的作业不存在')
      const relativePath = this.toRelativeArtifactPath(document.storage_path, path)
      const existing = this.database.connection.prepare(`
        SELECT id,relative_path,content_hash FROM artifacts
        WHERE document_id=? AND kind=? AND created_by_job_id=? LIMIT 1
      `).get(taskId, kind, job.id) as { id: string; relative_path: string; content_hash: string } | undefined
      if (existing) {
        if (existing.relative_path === relativePath && existing.content_hash === checksum) return
        throw new Error('ARTIFACT_COMMIT_CONFLICT')
      }
      const latest = this.database.connection.prepare(
        'SELECT COALESCE(MAX(revision),0) as revision FROM artifacts WHERE document_id=? AND kind=?'
      ).get(taskId, kind) as { revision: number }
      this.database.connection.prepare(`
        INSERT INTO artifacts(
          id,document_id,created_by_job_id,kind,revision,relative_path,content_hash,metadata_json,created_at
        ) VALUES(?,?,?,?,?,?,?,?,?)
      `).run(randomUUID(), taskId, job.id, kind, latest.revision + 1, relativePath, checksum, JSON.stringify(metadata), new Date().toISOString())
    })
  }

  private insertTaskUnsafe(task: MinerUTask): void {
    this.database.connection.prepare(`
      INSERT INTO documents(
        id,original_filename,display_title,storage_path,source_checksum,
        parser_model,translation_provider,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?)
    `).run(task.id, task.originalName || task.name, task.title, task.outputDir, task.sourceHash,
      task.parserModel, task.translationProvider, task.createdAt, task.updatedAt)
    const parseJobId = randomUUID()
    this.createJobUnsafe({
      id: parseJobId, documentId: task.id, dependsOnJobId: null, kind: 'parse', status: 'queued', progress: task.progress,
      checkpoint: checkpointForTask(task), createdAt: task.createdAt, updatedAt: task.updatedAt,
      errorCode: null, errorMessage: null, startedAt: null, finishedAt: null
    })
    this.appendEventUnsafe(parseJobId, null, 'queued', { phase: task.status })
    this.insertArtifactUnsafe(task.id, parseJobId, 'source_pdf', this.toRelativeArtifactPath(task.outputDir, task.sourcePath), task.sourceHash, task.createdAt)
  }

  private syncJobsUnsafe(task: MinerUTask): void {
    const parse = this.latestJob(task.id, 'parse')
    const translate = this.latestJob(task.id, 'translate')
    const now = task.updatedAt
    const translatePhase = task.status === 'translating' || task.status === 'completed' || task.status === 'partial' || (task.status === 'failed' && Boolean(translate))
    const parseStatus: V2JobStatus = task.status === 'failed' && !translate
      ? 'failed'
      : translatePhase || task.status === 'completed' || task.status === 'partial'
        ? 'succeeded'
        : task.status === 'uploading' || task.status === 'parsing'
          ? 'running'
          : 'succeeded'
    const parseCheckpoint = {
      ...(parse ? parseObject(parse.checkpoint_json) : {}),
      ...checkpointForTask(task),
      phase: task.status
    }
    if (parse) {
      this.updateJobUnsafe(parse, parseStatus, task.progress, parseCheckpoint,
        parseStatus === 'failed' ? 'TASK_FAILED' : null, parseStatus === 'failed' ? task.error : null, now)
    } else {
      this.createJobUnsafe({
        id: randomUUID(), documentId: task.id, dependsOnJobId: null, kind: 'parse', status: parseStatus, progress: task.progress,
        checkpoint: parseCheckpoint, createdAt: now, updatedAt: now,
        errorCode: parseStatus === 'failed' ? 'TASK_FAILED' : null, errorMessage: parseStatus === 'failed' ? task.error : null,
        startedAt: null, finishedAt: TERMINAL.has(parseStatus) ? now : null
      })
    }

    if (!translatePhase) return
    const translationStatus: V2JobStatus = task.status === 'translating' ? 'running' : task.status === 'partial' ? 'partial' : task.status === 'failed' ? 'failed' : 'succeeded'
    if (translate) {
      this.updateJobUnsafe(translate, translationStatus, task.progress, parseObject(translate.checkpoint_json),
        translationStatus === 'failed' ? 'TRANSLATION_FAILED' : null,
        translationStatus === 'failed' || translationStatus === 'partial' ? task.error : null, now)
    } else {
      const id = randomUUID()
      this.createJobUnsafe({
        id, documentId: task.id, dependsOnJobId: parse?.id ?? null, kind: 'translate', status: translationStatus, progress: task.progress,
        checkpoint: {}, createdAt: now, updatedAt: now,
        errorCode: translationStatus === 'failed' ? 'TRANSLATION_FAILED' : null,
        errorMessage: translationStatus === 'failed' || translationStatus === 'partial' ? task.error : null,
        startedAt: translationStatus === 'running' ? now : null,
        finishedAt: TERMINAL.has(translationStatus) ? now : null
      })
      this.appendEventUnsafe(id, null, translationStatus, {})
    }
  }

  private createJobUnsafe(input: {
    id: string
    documentId: string
    dependsOnJobId: string | null
    kind: V2JobKind
    status: V2JobStatus
    progress: number
    checkpoint: Record<string, unknown>
    createdAt: string
    updatedAt: string
    errorCode: string | null
    errorMessage: string | null
    startedAt: string | null
    finishedAt: string | null
  }): void {
    this.database.connection.prepare(`
      INSERT INTO jobs(
        id,document_id,depends_on_job_id,kind,status,progress,priority,attempt,max_attempts,payload_json,checkpoint_json,
        available_at,lease_owner,lease_expires_at,error_code,error_message,started_at,finished_at,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(input.id, input.documentId, input.dependsOnJobId, input.kind, input.status, input.progress, 0, 0, 5, '{}',
      JSON.stringify(input.checkpoint), input.updatedAt, null, null, input.errorCode, input.errorMessage,
      input.startedAt, input.finishedAt, input.createdAt, input.updatedAt)
  }

  private updateJobUnsafe(
    current: CompatJobRow,
    status: V2JobStatus,
    progress: number,
    checkpoint: Record<string, unknown>,
    errorCode: string | null,
    errorMessage: string | null,
    updatedAt: string
  ): void {
    const startedAt = current.started_at ?? (status === 'running' ? updatedAt : null)
    const finishedAt = TERMINAL.has(status) ? (current.finished_at ?? updatedAt) : null
    this.database.connection.prepare(`
      UPDATE jobs SET status=?,progress=?,checkpoint_json=?,error_code=?,error_message=?,started_at=?,finished_at=?,updated_at=? WHERE id=?
    `).run(status, progress, JSON.stringify(checkpoint), errorCode, errorMessage, startedAt, finishedAt, updatedAt, current.id)
    if (current.status !== status) this.appendEventUnsafe(current.id, current.status, status, { progress })
  }

  private appendEventUnsafe(jobId: string, fromState: V2JobStatus | null, toState: V2JobStatus, detail: Record<string, unknown>): void {
    const row = this.database.connection.prepare('SELECT COALESCE(MAX(sequence),0) as sequence FROM job_events WHERE job_id=?').get(jobId) as { sequence: number }
    this.database.connection.prepare(`
      INSERT INTO job_events(id,job_id,sequence,from_state,to_state,detail_json,created_at)
      VALUES(?,?,?,?,?,?,?)
    `).run(randomUUID(), jobId, row.sequence + 1, fromState, toState, JSON.stringify(detail), new Date().toISOString())
  }

  private insertArtifactUnsafe(documentId: string, jobId: string, kind: ArtifactKind, relativePath: string, contentHash: string, createdAt: string): void {
    this.database.connection.prepare(`
      INSERT INTO artifacts(id,document_id,created_by_job_id,kind,revision,relative_path,content_hash,metadata_json,created_at)
      VALUES(?,?,?,?,1,?,?,?,?)
    `).run(randomUUID(), documentId, jobId, kind, relativePath, contentHash, '{}', createdAt)
  }

  private toRelativeArtifactPath(storagePath: string, path: string): string {
    const resolvedPath = this.pathPolicy.resolveChild(storagePath, path)
    return toRelativePath(storagePath, resolvedPath)
  }

  private readDocument(id: string): CompatDocumentRow | null {
    const row = this.database.connection.prepare('SELECT * FROM documents WHERE id=?').get(id) as CompatDocumentRow | undefined
    return row ?? null
  }

  private latestJob(documentId: string, kind: V2JobKind): CompatJobRow | null {
    const row = this.database.connection.prepare(`
      SELECT * FROM jobs WHERE document_id=? AND kind=? ORDER BY updated_at DESC,id DESC LIMIT 1
    `).get(documentId, kind) as CompatJobRow | undefined
    return row ?? null
  }

  private latestArtifact(documentId: string, kind: ArtifactKind): { id: string; revision: number } | null {
    const row = this.database.connection.prepare(`
      SELECT id,revision FROM artifacts WHERE document_id=? AND kind=? ORDER BY revision DESC LIMIT 1
    `).get(documentId, kind) as { id: string; revision: number } | undefined
    return row ?? null
  }

  private readProjection(id: string): MinerUTask | null {
    const document = this.readDocument(id)
    if (!document) return null
    const jobs = this.database.connection.prepare(`
      SELECT * FROM jobs WHERE document_id=? ORDER BY updated_at DESC,id DESC
    `).all(id) as unknown as CompatJobRow[]
    return projectCompatTask(document, jobs)
  }
}

export function projectCompatTask(document: CompatDocumentRow, jobs: readonly CompatJobRow[]): MinerUTask {
  const parse = latestJobOfKind(jobs, 'parse')
  const translate = latestJobOfKind(jobs, 'translate')
  const latest = selectProjectionJob(parse, translate)
  const status = latest ? projectTaskStatus(latest) : 'uploading'
  const checkpoint = parse ? parseObject(parse.checkpoint_json) : {}
  return {
    id: document.id,
    originalName: document.original_filename,
    title: document.display_title,
    name: document.display_title ? `${document.display_title}.pdf` : document.original_filename,
    sourcePath: join(document.storage_path, 'original.pdf'),
    sourceHash: document.source_checksum,
    outputDir: document.storage_path,
    status,
    progress: latest?.progress ?? 0,
    parserModel: document.parser_model,
    translationProvider: document.translation_provider,
    remoteBatchId: stringOrNull(checkpoint.remoteBatchId),
    remoteDataId: stringOrNull(checkpoint.remoteDataId),
    remoteResultUrl: stringOrNull(checkpoint.remoteResultUrl),
    error: latest?.error_message ?? null,
    createdAt: document.created_at,
    updatedAt: document.updated_at
  }
}

function latestJobOfKind(jobs: readonly CompatJobRow[], kind: V2JobKind): CompatJobRow | undefined {
  return jobs
    .filter((job) => job.kind === kind)
    .reduce<CompatJobRow | undefined>((latest, job) => {
      if (!latest || job.updated_at > latest.updated_at || (job.updated_at === latest.updated_at && job.id > latest.id)) {
        return job
      }
      return latest
    }, undefined)
}

function selectProjectionJob(parse: CompatJobRow | undefined, translate: CompatJobRow | undefined): CompatJobRow | undefined {
  if (!parse) return translate
  if (!translate) return parse
  if (parse.updated_at > translate.updated_at) return parse
  if (translate.updated_at > parse.updated_at) return translate
  return parse.status === 'queued' || parse.status === 'running' || parse.status === 'retry-wait' ? parse : translate
}

export function projectTaskStatus(job: CompatJobRow): TaskStatus {
  if (job.kind === 'translate') {
    if (job.status === 'succeeded') return 'completed'
    if (job.status === 'partial') return 'partial'
    if (job.status === 'failed' || job.status === 'cancelled') return 'failed'
    return 'translating'
  }
  if (job.status === 'failed' || job.status === 'cancelled') return 'failed'
  if (job.status === 'succeeded') return 'completed'
  return parseObject(job.checkpoint_json).phase === 'uploading' ? 'uploading' : 'parsing'
}

function checkpointForTask(task: MinerUTask): Record<string, unknown> {
  return {
    phase: task.status,
    remoteBatchId: task.remoteBatchId,
    remoteDataId: task.remoteDataId,
    remoteResultUrl: task.remoteResultUrl
  }
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

function toRelativePath(storagePath: string, path: string): string {
  const flavor = process.platform === 'win32' ? 'win32' : 'posix'
  const resolvedPath = resolveLexicalWithinRoot(storagePath, path, flavor)
  const normalized = relative(storagePath, resolvedPath).replaceAll('\\', '/')
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.includes('\0')) {
    throw new Error('产物路径必须是文档根目录下的相对路径')
  }
  return normalized
}

function validateAnnotations(request: ReplaceReaderAnnotationsRequest): void {
  if (!Array.isArray(request.annotations) || request.annotations.length > 50_000) throw new Error('阅读标注数量无效')
  const ids = new Set<string>()
  for (const annotation of request.annotations) {
    const validColor = annotation.kind === 'highlight'
      ? new Set(['yellow', 'green', 'blue', 'pink', 'purple']).has(annotation.color ?? '')
      : annotation.color === null
    if (
      annotation.taskId !== request.taskId || annotation.view !== request.view || ids.has(annotation.id) ||
      !new Set(['highlight', 'underline']).has(annotation.kind) || !validColor || !annotation.id ||
      !annotation.blockKey || !Number.isInteger(annotation.startOffset) || !Number.isInteger(annotation.endOffset) ||
      annotation.startOffset < 0 || annotation.endOffset <= annotation.startOffset ||
      !annotation.quote || annotation.quote.length !== annotation.endOffset - annotation.startOffset ||
      annotation.prefix.length > 32 || annotation.suffix.length > 32
    ) throw new Error('阅读标注数据无效')
    ids.add(annotation.id)
  }
}

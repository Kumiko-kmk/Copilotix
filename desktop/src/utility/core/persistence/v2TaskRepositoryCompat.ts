import { randomUUID } from 'node:crypto'
import type { StatementSync } from 'node:sqlite'
import { join, relative } from 'node:path'
import type { ArtifactKind, TranslationBatchBlock, TranslationBatchCommit } from '@core/types'
import type { PathPolicyPort } from './pathPolicy'
import type {
  AppSettings,
  MinerUTask,
  ReaderAnnotation,
  ReplaceReaderAnnotationsRequest,
  TaskStatus,
  TranslationBlockRecord,
  TranslationProviderId
} from '@shared/types'
import {
  documentAnnotationSchema,
  mutateReaderAnnotationsRequestSchema,
  readerAnnotationSnapshotSchema,
  type DocumentSummary,
  type MutateReaderAnnotationsRequest,
  type ReaderAnnotationSnapshot
} from '@shared/ipcSchemas'
import { DEFAULT_SETTINGS } from '@shared/constants'
import type { ArtifactReference } from './taskRepositoryCompat'
import { PathPolicy, resolveLexicalWithinRoot } from './pathPolicy'
import { V2Database } from './v2Database'
import { projectDocumentSummary } from './documentProjection'

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

export interface DocumentMetadataPatch {
  displayTitle?: string | null
}

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

export interface TranslationJobBinding {
  taskId: string
  jobId: string
  attempt: number
  outputDir: string
  translationProvider: TranslationProviderId
  checkpoint: Record<string, unknown>
  status: V2JobStatus
}

export interface ArtifactRevisionInput {
  taskId: string
  kind: ArtifactKind
  path: string
  checksum: string
  metadata?: Record<string, unknown>
  jobId?: string
}

const TERMINAL: ReadonlySet<V2JobStatus> = new Set(['succeeded', 'partial', 'failed', 'cancelled'])
const MAX_TRANSLATION_BATCH_ITEMS = 32
const MAX_TRANSLATION_BATCH_BYTES = 768 * 1024
const MAX_TRANSLATION_FIELD_BYTES = 262_144

export class CompatDomainError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'CompatDomainError'
  }
}

/** Temporary phase-2 compatibility adapter; remove when services use core ports directly in phase 3. */
/** Utility-owned implementation. Main talks to this class only through RPC. */
export class V2TaskRepositoryCompat {
  private readonly translationJobById: StatementSync
  private readonly translationBlockUpsert: StatementSync
  private readonly translationCacheUpsert: StatementSync
  private readonly translationCheckpointUpdate: StatementSync
  private readonly translationBlocksByJob: StatementSync

  constructor(
    private readonly database: V2Database,
    private readonly pathPolicy: PathPolicyPort = new PathPolicy()
  ) {
    this.translationJobById = database.connection.prepare(
      "SELECT * FROM jobs WHERE id=? AND document_id=? AND kind='translate'"
    )
    this.translationBlockUpsert = database.connection.prepare(`
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
    `)
    this.translationCacheUpsert = database.connection.prepare(`
      INSERT INTO translation_cache(cache_key,translated_markdown,provider,model,created_at)
      VALUES(?,?,?,?,?)
      ON CONFLICT(cache_key) DO UPDATE SET translated_markdown=excluded.translated_markdown,
        provider=excluded.provider,model=excluded.model,created_at=excluded.created_at
    `)
    this.translationCheckpointUpdate = database.connection.prepare(
      'UPDATE jobs SET checkpoint_json=?, updated_at=? WHERE id=?'
    )
    this.translationBlocksByJob = database.connection.prepare(`
      SELECT ? as taskId, job_id as jobId, block_id as blockId, source_hash as sourceHash,
        source_markdown as sourceMarkdown, translated_markdown as translatedMarkdown,
        provider, model, status, error
      FROM translation_blocks WHERE job_id = ? ORDER BY rowid
    `)
  }

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

  /**
   * Return the only filesystem binding a translation plan may use.  Keeping
   * this lookup narrow prevents callers from accepting an arbitrary output
   * directory or a parse job that happens to share the same document.
   */
  requireTranslationJobBinding(taskId: string, jobId: string): TranslationJobBinding {
    const document = this.readDocument(taskId)
    if (!document) throw new CompatDomainError('TRANSLATION_TASK_NOT_FOUND', '翻译任务不存在')
    const job = this.translationJobById.get(jobId, taskId) as CompatJobRow | undefined
    if (!job) throw new CompatDomainError('TRANSLATION_JOB_NOT_FOUND', '翻译作业不存在')
    return {
      taskId,
      jobId,
      attempt: job.attempt,
      outputDir: document.storage_path,
      translationProvider: document.translation_provider,
      checkpoint: parseObject(job.checkpoint_json),
      status: job.status
    }
  }

  listDocumentSummaries(): DocumentSummary[] {
    return this.listTasks().map((task) => projectDocumentSummary(task))
  }

  getDocumentSummary(id: string): DocumentSummary | null {
    const task = this.getTask(id)
    return task ? projectDocumentSummary(task) : null
  }

  getLatestArtifactReference(documentId: string, kind: ArtifactKind): ArtifactReference | null {
    const row = this.database.connection.prepare(`
      SELECT id,document_id,kind,revision,relative_path,content_hash,metadata_json
      FROM artifacts
      WHERE document_id=? AND kind=?
      ORDER BY revision DESC
      LIMIT 1
    `).get(documentId, kind) as {
      id: string
      document_id: string
      kind: ArtifactKind
      revision: number
      relative_path: string
      content_hash: string
      metadata_json: string
    } | undefined
    if (!row) return null
    return {
      id: row.id,
      documentId: row.document_id,
      kind: row.kind,
      revision: row.revision,
      relativePath: row.relative_path,
      contentHash: row.content_hash,
      metadata: parseObject(row.metadata_json)
    }
  }

  listDocumentAnnotations(request: { documentId: string; view: 'original' | 'translated' }): ReaderAnnotationSnapshot {
    return this.database.transaction(() => {
      const normalized = {
        documentId: request.documentId,
        view: request.view
      }
      const artifactKind: ArtifactKind = request.view === 'translated' ? 'translated_markdown' : 'parsed_markdown'
      const artifact = this.getLatestArtifactReference(request.documentId, artifactKind)
      if (!artifact) throw new CompatDomainError('ANNOTATION_ARTIFACT_NOT_FOUND', '当前文档尚无可标注的产物')
      return this.readDocumentAnnotationSnapshotUnsafe(normalized.documentId, artifact, normalized.view)
    })
  }

  mutateDocumentAnnotations(request: MutateReaderAnnotationsRequest): ReaderAnnotationSnapshot {
    const normalized = mutateReaderAnnotationsRequestSchema.parse(request)
    return this.database.transaction(() => {
      const document = this.readDocument(normalized.documentId)
      if (!document) throw new CompatDomainError('DOCUMENT_NOT_FOUND', '文档不存在')
      const artifactKind: ArtifactKind = normalized.view === 'translated' ? 'translated_markdown' : 'parsed_markdown'
      const artifact = this.getLatestArtifactReference(normalized.documentId, artifactKind)
      if (!artifact || artifact.id !== normalized.artifactId) {
        throw new CompatDomainError('ANNOTATION_CONFLICT', '标注对应的文档产物已更新，请重新加载')
      }

      const currentSet = this.database.connection.prepare(`
        SELECT id,revision FROM annotation_sets
        WHERE document_id=? AND artifact_id=? AND view=?
      `).get(normalized.documentId, normalized.artifactId, normalized.view) as {
        id: string
        revision: number
      } | undefined
      const currentRevision = currentSet?.revision ?? 0
      if (currentRevision !== normalized.expectedRevision) {
        throw new CompatDomainError('ANNOTATION_CONFLICT', '标注版本已变化，请重新加载')
      }

      this.assertAnnotationRowsAvailable(normalized)
      if (normalized.upserts.length === 0 && normalized.deleteIds.length === 0) {
        return this.readDocumentAnnotationSnapshotUnsafe(normalized.documentId, artifact, normalized.view)
      }

      const now = new Date().toISOString()
      const setId = currentSet?.id ?? randomUUID()
      if (currentSet) {
        const update = this.database.connection.prepare(`
          UPDATE annotation_sets
          SET revision=revision+1,updated_at=?
          WHERE id=? AND document_id=? AND artifact_id=? AND view=? AND revision=?
        `).run(now, currentSet.id, normalized.documentId, normalized.artifactId, normalized.view, normalized.expectedRevision)
        if (update.changes !== 1) throw new CompatDomainError('ANNOTATION_CONFLICT', '标注版本已变化，请重新加载')
      } else {
        this.database.connection.prepare(`
          INSERT INTO annotation_sets(id,document_id,artifact_id,view,revision,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?)
        `).run(setId, normalized.documentId, normalized.artifactId, normalized.view, 1, now, now)
      }

      if (normalized.deleteIds.length > 0) {
        const placeholders = normalized.deleteIds.map(() => '?').join(',')
        this.database.connection.prepare(
          `DELETE FROM reader_annotations WHERE annotation_set_id=? AND id IN (${placeholders})`
        ).run(setId, ...normalized.deleteIds)
      }

      const upsert = this.database.connection.prepare(`
        INSERT INTO reader_annotations(
          id,document_id,artifact_id,annotation_set_id,view,kind,color,block_key,
          start_offset,end_offset,quote,prefix,suffix,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          kind=excluded.kind,
          color=excluded.color,
          block_key=excluded.block_key,
          start_offset=excluded.start_offset,
          end_offset=excluded.end_offset,
          quote=excluded.quote,
          prefix=excluded.prefix,
          suffix=excluded.suffix,
          updated_at=excluded.updated_at
        WHERE reader_annotations.annotation_set_id=excluded.annotation_set_id
      `)
      for (const annotation of normalized.upserts) {
        upsert.run(
          annotation.id,
          annotation.documentId,
          annotation.artifactId,
          setId,
          annotation.view,
          annotation.kind,
          annotation.color,
          annotation.blockKey,
          annotation.startOffset,
          annotation.endOffset,
          annotation.quote,
          annotation.prefix,
          annotation.suffix,
          annotation.createdAt,
          annotation.updatedAt
        )
      }
      return this.readDocumentAnnotationSnapshotUnsafe(normalized.documentId, artifact, normalized.view)
    })
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

  updateDocumentMetadata(id: string, patch: DocumentMetadataPatch): void {
    const current = this.readDocument(id)
    if (!current) throw new Error('文档不存在')
    const title = patch.displayTitle === undefined ? current.display_title : patch.displayTitle
    if (title !== null && typeof title !== 'string') throw new Error('文档元数据无效')
    this.database.connection.prepare('UPDATE documents SET display_title=?, updated_at=? WHERE id=?')
      .run(title, new Date().toISOString(), id)
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
    if (block.jobId) {
      this.commitTranslationBatch({
        taskId: block.taskId,
        jobId: block.jobId,
        blocks: [toBatchBlock(block)],
        cacheEntries: []
      })
      return
    }
    this.database.transaction(() => {
      const job = block.jobId
        ? this.database.connection.prepare('SELECT * FROM jobs WHERE id=? AND document_id=? AND kind=\'translate\'').get(block.jobId, block.taskId) as CompatJobRow | undefined
        : this.latestJob(block.taskId, 'translate')
      if (!job) throw new Error('翻译作业尚未创建')
      this.upsertTranslationBlockUnsafe(job.id, block)
    })
  }

  commitTranslationBatch(input: TranslationBatchCommit): void {
    assertTranslationBatchWithinLimits(input)
    if (!input.taskId || !input.jobId) {
      throw new Error('翻译批次参数无效')
    }
    this.database.transaction(() => {
      const job = this.translationJobById.get(input.jobId, input.taskId) as CompatJobRow | undefined
      if (!job) throw new Error('翻译作业尚未创建')
      for (const block of input.blocks) this.upsertTranslationBlockUnsafe(job.id, block)
      const committedAt = new Date().toISOString()
      for (const entry of input.cacheEntries) {
        this.translationCacheUpsert.run(entry.cacheKey, entry.translated, entry.provider, entry.model, committedAt)
      }
      if (input.checkpoint) {
        const current = parseObject(job.checkpoint_json)
        const checkpoint = {
          ...current,
          totalBlocks: input.checkpoint.totalBlocks,
          completedBlocks: input.checkpoint.completedBlocks,
          failedBlocks: input.checkpoint.failedBlocks,
          failedBlockIds: input.checkpoint.failedBlockIds.slice(0, 64)
        }
        this.translationCheckpointUpdate.run(JSON.stringify(checkpoint), committedAt, job.id)
      }
    })
  }

  listTranslationBlocks(taskId: string, jobId?: string): TranslationBlockRecord[] {
    const job = jobId
      ? this.database.connection.prepare('SELECT * FROM jobs WHERE id=? AND document_id=? AND kind=\'translate\'').get(jobId, taskId) as CompatJobRow | undefined
      : this.latestJob(taskId, 'translate')
    if (!job) return []
    return this.translationBlocksByJob.all(taskId, job.id) as unknown as TranslationBlockRecord[]
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

  private readDocumentAnnotationSnapshotUnsafe(
    documentId: string,
    artifact: ArtifactReference,
    view: 'original' | 'translated'
  ): ReaderAnnotationSnapshot {
    const set = this.database.connection.prepare(`
      SELECT id,revision FROM annotation_sets
      WHERE document_id=? AND artifact_id=? AND view=?
    `).get(documentId, artifact.id, view) as { id: string; revision: number } | undefined
    const rows = set
      ? this.database.connection.prepare(`
          SELECT id,document_id,artifact_id,view,kind,color,block_key,
            start_offset,end_offset,quote,prefix,suffix,created_at,updated_at
          FROM reader_annotations
          WHERE annotation_set_id=? AND document_id=? AND artifact_id=? AND view=?
          ORDER BY block_key,start_offset,end_offset,id
        `).all(set.id, documentId, artifact.id, view) as Array<Record<string, unknown>>
      : []
    const annotations = rows.map((row) => documentAnnotationSchema.parse({
      id: row.id,
      documentId: row.document_id,
      artifactId: row.artifact_id,
      view: row.view,
      kind: row.kind,
      color: row.color,
      blockKey: row.block_key,
      startOffset: row.start_offset,
      endOffset: row.end_offset,
      quote: row.quote,
      prefix: row.prefix,
      suffix: row.suffix,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }))
    return readerAnnotationSnapshotSchema.parse({
      documentId,
      artifactId: artifact.id,
      view,
      revision: set?.revision ?? 0,
      annotations
    })
  }

  private assertAnnotationRowsAvailable(request: MutateReaderAnnotationsRequest): void {
    const set = this.database.connection.prepare(`
      SELECT id FROM annotation_sets
      WHERE document_id=? AND artifact_id=? AND view=?
    `).get(request.documentId, request.artifactId, request.view) as { id: string } | undefined
    for (const annotation of request.upserts) {
      const existing = this.database.connection.prepare(
        'SELECT annotation_set_id FROM reader_annotations WHERE id=?'
      ).get(annotation.id) as { annotation_set_id: string } | undefined
      if (existing && existing.annotation_set_id !== set?.id) {
        throw new CompatDomainError('ANNOTATION_CONFLICT', '标注 ID 已属于其他标注集')
      }
    }
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

  recordArtifactRevision(taskId: string, kind: ArtifactKind, path: string, checksum: string, metadata: Record<string, unknown> = {}, jobId?: string): void {
    this.recordArtifactRevisions([{ taskId, kind, path, checksum, metadata, jobId }])
  }

  recordArtifactRevisions(revisions: readonly ArtifactRevisionInput[]): void {
    this.database.transaction(() => {
      for (const revision of revisions) this.recordArtifactRevisionUnsafe(revision)
    })
  }

  private recordArtifactRevisionUnsafe(input: ArtifactRevisionInput): void {
    const document = this.readDocument(input.taskId)
    if (!document) throw new Error('任务不存在')
    const jobKind: V2JobKind = input.kind === 'translated_markdown' || input.kind === 'manifest' ? 'translate' : 'parse'
    const job = input.jobId
      ? this.database.connection.prepare('SELECT * FROM jobs WHERE id=?').get(input.jobId) as CompatJobRow | undefined
      : this.latestJob(input.taskId, jobKind)
    if (!job || job.document_id !== input.taskId || job.kind !== jobKind) throw new Error('产物对应的作业不存在')
    const relativePath = this.toRelativeArtifactPath(document.storage_path, input.path)
    const existing = this.database.connection.prepare(`
      SELECT id,relative_path,content_hash FROM artifacts
      WHERE document_id=? AND kind=? AND created_by_job_id=? LIMIT 1
    `).get(input.taskId, input.kind, job.id) as { id: string; relative_path: string; content_hash: string } | undefined
    if (existing) {
      if (existing.relative_path === relativePath && existing.content_hash === input.checksum) return
      throw new Error('ARTIFACT_COMMIT_CONFLICT')
    }
    const latest = this.database.connection.prepare(
      'SELECT COALESCE(MAX(revision),0) as revision FROM artifacts WHERE document_id=? AND kind=?'
    ).get(input.taskId, input.kind) as { revision: number }
    this.database.connection.prepare(`
      INSERT INTO artifacts(
        id,document_id,created_by_job_id,kind,revision,relative_path,content_hash,metadata_json,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?)
    `).run(randomUUID(), input.taskId, job.id, input.kind, latest.revision + 1, relativePath, input.checksum, JSON.stringify(input.metadata ?? {}), new Date().toISOString())
  }

  private upsertTranslationBlockUnsafe(jobId: string, block: TranslationBatchBlock | TranslationBlockRecord): void {
    this.translationBlockUpsert.run(jobId, block.blockId, block.sourceHash, block.sourceMarkdown, block.translatedMarkdown,
      block.provider, block.model, block.status, block.error)
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

function assertTranslationBatchWithinLimits(input: TranslationBatchCommit): void {
  if (!input || !Array.isArray(input.blocks) || !Array.isArray(input.cacheEntries) ||
    input.blocks.length > MAX_TRANSLATION_BATCH_ITEMS || input.cacheEntries.length > MAX_TRANSLATION_BATCH_ITEMS) {
    throw new Error('翻译批次参数无效：最多 32 条 block/cache')
  }
  for (const block of input.blocks) {
    assertTranslationField(block.sourceMarkdown, `翻译块 ${block.blockId} 的原文`)
    if (block.translatedMarkdown !== null) assertTranslationField(block.translatedMarkdown, `翻译块 ${block.blockId} 的译文`)
  }
  for (const entry of input.cacheEntries) assertTranslationField(entry.translated, `翻译缓存 ${entry.cacheKey}`)
  let serialized: string
  try {
    serialized = JSON.stringify(input)
  } catch {
    throw new Error('翻译批次参数不可序列化')
  }
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > MAX_TRANSLATION_BATCH_BYTES) {
    throw new Error('翻译批次 UTF-8 大小超过 768KiB')
  }
}

function assertTranslationField(value: unknown, label: string): void {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_TRANSLATION_FIELD_BYTES) {
    throw new Error(`${label}超过 262KiB 持久化字段限制，请保留正文文件并避免通过 RPC`)
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

function toBatchBlock(block: TranslationBlockRecord): TranslationBatchBlock {
  return {
    blockId: block.blockId,
    sourceHash: block.sourceHash,
    sourceMarkdown: block.sourceMarkdown,
    translatedMarkdown: block.translatedMarkdown,
    provider: block.provider,
    model: block.model,
    status: block.status,
    error: block.error
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

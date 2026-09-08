import { DatabaseSync } from 'node:sqlite'
import type {
  AppSettings,
  MinerUTask,
  ReaderAnnotation,
  ReaderAnnotationView,
  ReplaceReaderAnnotationsRequest,
  TaskStatus,
  TranslationBlockRecord,
  TranslationProviderId
} from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/constants'

interface TaskRow {
  id: string
  original_name: string
  title: string | null
  name: string
  source_path: string
  source_hash: string
  output_dir: string
  status: TaskStatus
  progress: number
  translation_provider: TranslationProviderId
  remote_batch_id: string | null
  remote_data_id: string | null
  remote_result_url: string | null
  error: string | null
  created_at: string
  updated_at: string
}

export class TaskRepository {
  private readonly db: DatabaseSync

  constructor(databasePath: string) {
    this.db = new DatabaseSync(databasePath)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    try {
      this.migrate()
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  close(): void {
    this.db.close()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        original_name TEXT NOT NULL DEFAULT '',
        title TEXT,
        name TEXT NOT NULL,
        source_path TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        output_dir TEXT NOT NULL,
        status TEXT NOT NULL,
        progress INTEGER NOT NULL DEFAULT 0,
        translation_provider TEXT NOT NULL,
        remote_batch_id TEXT,
        remote_data_id TEXT,
        remote_result_url TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_source_hash ON tasks(source_hash);
      CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at DESC);
      CREATE TABLE IF NOT EXISTS translation_runs (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        total_blocks INTEGER NOT NULL DEFAULT 0,
        completed_blocks INTEGER NOT NULL DEFAULT 0,
        failed_blocks INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS translation_blocks (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        block_id TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        source_markdown TEXT NOT NULL,
        translated_markdown TEXT,
        provider TEXT,
        model TEXT,
        status TEXT NOT NULL,
        error TEXT,
        PRIMARY KEY(task_id, block_id)
      );
      CREATE TABLE IF NOT EXISTS translation_cache (
        cache_key TEXT PRIMARY KEY,
        translated_markdown TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reader_annotations (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        view TEXT NOT NULL,
        kind TEXT NOT NULL,
        color TEXT,
        block_key TEXT NOT NULL,
        start_offset INTEGER NOT NULL,
        end_offset INTEGER NOT NULL,
        quote TEXT NOT NULL,
        prefix TEXT NOT NULL,
        suffix TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_reader_annotations_task_view
        ON reader_annotations(task_id, view, block_key, start_offset);
    `)
    const taskColumns = new Set(
      (this.db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map((column) => column.name)
    )
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (!taskColumns.has('original_name')) this.db.exec("ALTER TABLE tasks ADD COLUMN original_name TEXT NOT NULL DEFAULT ''")
      if (!taskColumns.has('title')) this.db.exec('ALTER TABLE tasks ADD COLUMN title TEXT')
      if (!taskColumns.has('remote_batch_id')) this.db.exec('ALTER TABLE tasks ADD COLUMN remote_batch_id TEXT')
      if (!taskColumns.has('remote_data_id')) this.db.exec('ALTER TABLE tasks ADD COLUMN remote_data_id TEXT')
      this.db.exec("UPDATE tasks SET original_name = name WHERE original_name IS NULL OR original_name = ''")
      if (taskColumns.has('parser_model')) this.db.exec('ALTER TABLE tasks DROP COLUMN parser_model')
      this.db.exec("DELETE FROM settings WHERE key IN ('parserModel', 'forceOcr', 'ocrLanguage')")
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    this.db
      .prepare("UPDATE tasks SET status = 'failed', error = ?, updated_at = ? WHERE status IN ('uploading','parsing','translating')")
      .run('应用在任务完成前退出，请手动重试。', new Date().toISOString())
  }

  getSettings(outputRoot: string): AppSettings {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as Array<{
      key: string
      value: string
    }>
    const stored = Object.fromEntries(rows.map((row) => [row.key, JSON.parse(row.value)])) as Partial<AppSettings>
    return {
      ...DEFAULT_SETTINGS,
      outputRoot: stored.outputRoot ?? outputRoot,
      formulaEnabled: stored.formulaEnabled ?? DEFAULT_SETTINGS.formulaEnabled,
      tableEnabled: stored.tableEnabled ?? DEFAULT_SETTINGS.tableEnabled,
      translationProvider: stored.translationProvider ?? DEFAULT_SETTINGS.translationProvider,
      qwenBaseUrl: stored.qwenBaseUrl ?? DEFAULT_SETTINGS.qwenBaseUrl,
      qwenModel: stored.qwenModel ?? DEFAULT_SETTINGS.qwenModel,
      deepseekBaseUrl: stored.deepseekBaseUrl ?? DEFAULT_SETTINGS.deepseekBaseUrl,
      deepseekModel: stored.deepseekModel ?? DEFAULT_SETTINGS.deepseekModel,
      credentials: DEFAULT_SETTINGS.credentials
    }
  }

  saveSettings(settings: AppSettings): void {
    const hiddenKeys = new Set(['credentials'])
    const upsert = this.db.prepare(
      'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
    )
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const [key, value] of Object.entries(settings)) {
        if (!hiddenKeys.has(key)) upsert.run(key, JSON.stringify(value))
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  listTasks(): MinerUTask[] {
    const rows = this.db.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all() as unknown as TaskRow[]
    return rows.map(toTask)
  }

  getTask(id: string): MinerUTask | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined
    return row ? toTask(row) : null
  }

  findByHash(hash: string): MinerUTask | null {
    const row = this.db
      .prepare('SELECT * FROM tasks WHERE source_hash = ? ORDER BY created_at DESC LIMIT 1')
      .get(hash) as TaskRow | undefined
    return row ? toTask(row) : null
  }

  insertTask(task: MinerUTask): void {
    this.db
      .prepare(`
        INSERT INTO tasks(
          id,original_name,title,name,source_path,source_hash,output_dir,status,progress,
          translation_provider,remote_batch_id,remote_data_id,remote_result_url,
          error,created_at,updated_at
        ) VALUES(
          @id,@originalName,@title,@name,@sourcePath,@sourceHash,@outputDir,@status,@progress,
          @translationProvider,@remoteBatchId,@remoteDataId,@remoteResultUrl,
          @error,@createdAt,@updatedAt
        )
      `)
      .run({
        ...task,
        originalName: task.originalName || task.name,
        title: task.title ?? null
      })
  }

  insertTasks(tasks: MinerUTask[]): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const task of tasks) this.insertTask(task)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  updateTask(id: string, patch: Partial<MinerUTask>): MinerUTask {
    const current = this.getTask(id)
    if (!current) throw new Error(`Task not found: ${id}`)
    const next: MinerUTask = { ...current, ...patch, id, updatedAt: new Date().toISOString() }
    this.db
      .prepare(`
        UPDATE tasks SET
          original_name=@originalName, title=@title, name=@name,
          source_path=@sourcePath, source_hash=@sourceHash,
          output_dir=@outputDir, status=@status, progress=@progress,
          translation_provider=@translationProvider,
          remote_batch_id=@remoteBatchId, remote_data_id=@remoteDataId,
          remote_result_url=@remoteResultUrl, error=@error, updated_at=@updatedAt
        WHERE id=@id
      `)
      .run({
        id: next.id,
        originalName: next.originalName,
        title: next.title,
        name: next.name,
        sourcePath: next.sourcePath,
        sourceHash: next.sourceHash,
        outputDir: next.outputDir,
        status: next.status,
        progress: next.progress,
        translationProvider: next.translationProvider,
        remoteBatchId: next.remoteBatchId,
        remoteDataId: next.remoteDataId,
        remoteResultUrl: next.remoteResultUrl,
        error: next.error,
        updatedAt: next.updatedAt
      })
    return next
  }

  updateDocumentMetadata(id: string, patch: { displayTitle?: string | null }): void {
    const current = this.getTask(id)
    if (!current) throw new Error('任务不存在')
    const title = patch.displayTitle === undefined ? current.title : patch.displayTitle
    const name = title ? `${title}.pdf` : current.originalName || current.name
    this.db.prepare('UPDATE tasks SET title=?,name=?,updated_at=? WHERE id=?')
      .run(title, name, new Date().toISOString(), id)
  }

  deleteTask(id: string): void {
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id)
  }

  upsertTranslationBlock(block: TranslationBlockRecord): void {
    this.db
      .prepare(`
        INSERT INTO translation_blocks(
          task_id,block_id,source_hash,source_markdown,translated_markdown,provider,model,status,error
        ) VALUES(
          @taskId,@blockId,@sourceHash,@sourceMarkdown,@translatedMarkdown,@provider,@model,@status,@error
        ) ON CONFLICT(task_id,block_id) DO UPDATE SET
          source_hash=excluded.source_hash,
          source_markdown=excluded.source_markdown,
          translated_markdown=excluded.translated_markdown,
          provider=excluded.provider,
          model=excluded.model,
          status=excluded.status,
          error=excluded.error
      `)
      .run({ ...block })
  }

  listTranslationBlocks(taskId: string): TranslationBlockRecord[] {
    return this.db
      .prepare(`
        SELECT task_id as taskId, block_id as blockId, source_hash as sourceHash,
          source_markdown as sourceMarkdown, translated_markdown as translatedMarkdown,
          provider, model, status, error
        FROM translation_blocks WHERE task_id = ? ORDER BY rowid
      `)
      .all(taskId) as unknown as TranslationBlockRecord[]
  }

  updateTranslationRun(taskId: string, total: number, completed: number, failed: number): void {
    this.db
      .prepare(`
        INSERT INTO translation_runs(task_id,total_blocks,completed_blocks,failed_blocks,updated_at)
        VALUES(?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET
          total_blocks=excluded.total_blocks,
          completed_blocks=excluded.completed_blocks,
          failed_blocks=excluded.failed_blocks,
          updated_at=excluded.updated_at
      `)
      .run(taskId, total, completed, failed, new Date().toISOString())
  }

  getCache(cacheKey: string): string | null {
    const row = this.db
      .prepare('SELECT translated_markdown FROM translation_cache WHERE cache_key = ?')
      .get(cacheKey) as { translated_markdown: string } | undefined
    return row?.translated_markdown ?? null
  }

  putCache(cacheKey: string, translated: string, provider: string, model: string): void {
    this.db
      .prepare(`
        INSERT OR REPLACE INTO translation_cache(cache_key,translated_markdown,provider,model,created_at)
        VALUES(?,?,?,?,?)
      `)
      .run(cacheKey, translated, provider, model, new Date().toISOString())
  }

  listReaderAnnotations(taskId: string): ReaderAnnotation[] {
    return this.db
      .prepare(`
        SELECT id, task_id as taskId, view, kind, color, block_key as blockKey,
          start_offset as startOffset, end_offset as endOffset, quote, prefix, suffix,
          created_at as createdAt, updated_at as updatedAt
        FROM reader_annotations
        WHERE task_id = ?
        ORDER BY view, block_key, start_offset, end_offset, id
      `)
      .all(taskId) as unknown as ReaderAnnotation[]
  }

  replaceReaderAnnotations(request: ReplaceReaderAnnotationsRequest): ReaderAnnotation[] {
    if (!request || typeof request.taskId !== 'string' || !request.taskId || !ANNOTATION_VIEWS.has(request.view)) {
      throw new Error('无效的阅读标注请求')
    }
    validateReaderAnnotationsRequest(request, this.getTask(request.taskId) !== null)
    const insert = this.db.prepare(`
      INSERT INTO reader_annotations(
        id, task_id, view, kind, color, block_key, start_offset, end_offset,
        quote, prefix, suffix, created_at, updated_at
      ) VALUES(
        @id, @taskId, @view, @kind, @color, @blockKey, @startOffset, @endOffset,
        @quote, @prefix, @suffix, @createdAt, @updatedAt
      )
    `)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM reader_annotations WHERE task_id = ? AND view = ?')
        .run(request.taskId, request.view)
      for (const annotation of request.annotations) insert.run({ ...annotation })
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return this.listReaderAnnotations(request.taskId)
  }
}

const ANNOTATION_VIEWS = new Set<ReaderAnnotationView>(['original', 'translated'])
const ANNOTATION_KINDS = new Set(['highlight', 'underline'])
const HIGHLIGHT_COLORS = new Set(['yellow', 'green', 'blue', 'pink', 'purple'])

function validateReaderAnnotationsRequest(request: ReplaceReaderAnnotationsRequest, taskExists: boolean): void {
  if (!taskExists) throw new Error('任务不存在')
  if (!Array.isArray(request.annotations) || request.annotations.length > 50_000) {
    throw new Error('阅读标注数量无效')
  }
  const ids = new Set<string>()
  for (const annotation of request.annotations) {
    const validKind = ANNOTATION_KINDS.has(annotation.kind)
    const validColor = annotation.kind === 'highlight'
      ? HIGHLIGHT_COLORS.has(annotation.color ?? '')
      : annotation.color === null
    const validOffsets = Number.isInteger(annotation.startOffset) && Number.isInteger(annotation.endOffset) &&
      annotation.startOffset >= 0 && annotation.endOffset > annotation.startOffset
    if (
      annotation.taskId !== request.taskId || annotation.view !== request.view ||
      typeof annotation.id !== 'string' || !annotation.id || ids.has(annotation.id) ||
      !validKind || !validColor || typeof annotation.blockKey !== 'string' || !annotation.blockKey ||
      !validOffsets || typeof annotation.quote !== 'string' || !annotation.quote ||
      annotation.quote.length !== annotation.endOffset - annotation.startOffset ||
      typeof annotation.prefix !== 'string' || annotation.prefix.length > 32 ||
      typeof annotation.suffix !== 'string' || annotation.suffix.length > 32 ||
      typeof annotation.createdAt !== 'string' || typeof annotation.updatedAt !== 'string'
    ) {
      throw new Error('阅读标注数据无效')
    }
    ids.add(annotation.id)
  }
}

function toTask(row: TaskRow): MinerUTask {
  return {
    id: row.id,
    originalName: row.original_name || row.name,
    title: row.title ?? null,
    name: row.name,
    sourcePath: row.source_path,
    sourceHash: row.source_hash,
    outputDir: row.output_dir,
    status: row.status,
    progress: row.progress,
    translationProvider: row.translation_provider,
    remoteBatchId: row.remote_batch_id,
    remoteDataId: row.remote_data_id,
    remoteResultUrl: row.remote_result_url,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

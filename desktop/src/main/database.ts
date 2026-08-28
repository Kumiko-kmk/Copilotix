import { DatabaseSync } from 'node:sqlite'
import type {
  AppSettings,
  MinerUTask,
  TaskStatus,
  TranslationBlockRecord,
  TranslationProviderId
} from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/constants'

interface TaskRow {
  id: string
  name: string
  source_path: string
  source_hash: string
  output_dir: string
  status: TaskStatus
  progress: number
  parser_model: MinerUTask['parserModel']
  translation_provider: TranslationProviderId
  remote_task_id: string | null
  remote_status_url: string | null
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
    this.migrate()
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
        name TEXT NOT NULL,
        source_path TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        output_dir TEXT NOT NULL,
        status TEXT NOT NULL,
        progress INTEGER NOT NULL DEFAULT 0,
        parser_model TEXT NOT NULL,
        translation_provider TEXT NOT NULL,
        remote_task_id TEXT,
        remote_status_url TEXT,
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
    `)
    this.db
      .prepare("UPDATE tasks SET status = 'failed', error = ?, updated_at = ? WHERE status IN ('uploading','parsing','translating')")
      .run('应用在任务完成前退出，请手动重试。', new Date().toISOString())
  }

  getSettings(outputRoot: string): AppSettings {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as Array<{
      key: string
      value: string
    }>
    const stored = Object.fromEntries(rows.map((row) => [row.key, JSON.parse(row.value)]))
    return {
      ...DEFAULT_SETTINGS,
      outputRoot,
      ...stored,
      hasParserToken: false,
      qwenHasApiKey: false,
      deepseekHasApiKey: false
    }
  }

  saveSettings(settings: AppSettings): void {
    const hiddenKeys = new Set(['hasParserToken', 'qwenHasApiKey', 'deepseekHasApiKey'])
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
          id,name,source_path,source_hash,output_dir,status,progress,parser_model,
          translation_provider,remote_task_id,remote_status_url,remote_result_url,
          error,created_at,updated_at
        ) VALUES(
          @id,@name,@sourcePath,@sourceHash,@outputDir,@status,@progress,@parserModel,
          @translationProvider,@remoteTaskId,@remoteStatusUrl,@remoteResultUrl,
          @error,@createdAt,@updatedAt
        )
      `)
      .run({ ...task })
  }

  updateTask(id: string, patch: Partial<MinerUTask>): MinerUTask {
    const current = this.getTask(id)
    if (!current) throw new Error(`Task not found: ${id}`)
    const next: MinerUTask = { ...current, ...patch, id, updatedAt: new Date().toISOString() }
    this.db
      .prepare(`
        UPDATE tasks SET
          name=@name, source_path=@sourcePath, source_hash=@sourceHash,
          output_dir=@outputDir, status=@status, progress=@progress,
          parser_model=@parserModel, translation_provider=@translationProvider,
          remote_task_id=@remoteTaskId, remote_status_url=@remoteStatusUrl,
          remote_result_url=@remoteResultUrl, error=@error, updated_at=@updatedAt
        WHERE id=@id
      `)
      .run({ ...next })
    return next
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
}

function toTask(row: TaskRow): MinerUTask {
  return {
    id: row.id,
    name: row.name,
    sourcePath: row.source_path,
    sourceHash: row.source_hash,
    outputDir: row.output_dir,
    status: row.status,
    progress: row.progress,
    parserModel: row.parser_model,
    translationProvider: row.translation_provider,
    remoteTaskId: row.remote_task_id,
    remoteStatusUrl: row.remote_status_url,
    remoteResultUrl: row.remote_result_url,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

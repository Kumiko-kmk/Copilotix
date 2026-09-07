import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TaskRepository } from '../src/utility/core/persistence/database'
import type { MinerUTask } from '@shared/types'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('task schema migration', () => {
  it('creates the new fields in an empty database', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mineru-database-empty-'))
    directories.push(directory)
    const repository = new TaskRepository(join(directory, 'database.sqlite3'))
    repository.insertTask(task({ originalName: 'picked.pdf', title: null, name: 'picked.pdf' }))
    expect(repository.getTask('task-1')).toMatchObject({ originalName: 'picked.pdf', title: null, name: 'picked.pdf' })
    repository.close()
  })

  it('backfills originalName and leaves legacy task names unchanged', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mineru-database-legacy-'))
    directories.push(directory)
    const path = join(directory, 'database.sqlite3')
    const database = new DatabaseSync(path)
    database.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        source_path TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        output_dir TEXT NOT NULL,
        status TEXT NOT NULL,
        progress INTEGER NOT NULL DEFAULT 0,
        parser_model TEXT NOT NULL,
        translation_provider TEXT NOT NULL,
        remote_batch_id TEXT,
        remote_data_id TEXT,
        remote_result_url TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
    database.prepare(`
      INSERT INTO tasks(
        id,name,source_path,source_hash,output_dir,status,progress,parser_model,
        translation_provider,remote_batch_id,remote_data_id,remote_result_url,error,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      'legacy-task', 'legacy.pdf', 'legacy/original.pdf', 'hash', 'legacy', 'completed', 100, 'vlm',
      'qwen', null, null, null, null, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
    )
    database.close()

    const repository = new TaskRepository(path)
    expect(repository.getTask('legacy-task')).toMatchObject({
      originalName: 'legacy.pdf',
      title: null,
      name: 'legacy.pdf',
      outputDir: 'legacy',
      sourcePath: 'legacy/original.pdf'
    })
    repository.close()

    const reopened = new TaskRepository(path)
    expect(reopened.getTask('legacy-task')?.originalName).toBe('legacy.pdf')
    reopened.close()
  })

  it('rolls back a failed migration and can be retried after the cause is removed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mineru-database-rollback-'))
    directories.push(directory)
    const path = join(directory, 'database.sqlite3')
    const database = new DatabaseSync(path)
    database.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        source_path TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        output_dir TEXT NOT NULL,
        status TEXT NOT NULL,
        progress INTEGER NOT NULL DEFAULT 0,
        parser_model TEXT NOT NULL,
        translation_provider TEXT NOT NULL,
        remote_batch_id TEXT,
        remote_data_id TEXT,
        remote_result_url TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TRIGGER fail_task_migration BEFORE UPDATE ON tasks
      BEGIN
        SELECT RAISE(ABORT, 'fixture migration failure');
      END;
    `)
    database.prepare(`
      INSERT INTO tasks(
        id,name,source_path,source_hash,output_dir,status,progress,parser_model,
        translation_provider,remote_batch_id,remote_data_id,remote_result_url,error,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      'legacy-task', 'legacy.pdf', 'legacy/original.pdf', 'hash', 'legacy', 'completed', 100, 'vlm',
      'qwen', null, null, null, null, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
    )
    database.close()

    expect(() => new TaskRepository(path)).toThrow('fixture migration failure')
    const afterFailure = new DatabaseSync(path)
    const columns = (afterFailure.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map((row) => row.name)
    expect(columns).not.toContain('original_name')
    expect(columns).not.toContain('title')
    afterFailure.close()

    const retry = new DatabaseSync(path)
    retry.exec('DROP TRIGGER fail_task_migration')
    retry.close()
    const repository = new TaskRepository(path)
    expect(repository.listTasks()).toHaveLength(1)
    repository.close()
  })
})

function task(overrides: Partial<MinerUTask> = {}): MinerUTask {
  return {
    id: 'task-1',
    originalName: 'paper.pdf',
    title: null,
    name: 'paper.pdf',
    sourcePath: 'paper/original.pdf',
    sourceHash: 'hash',
    outputDir: 'paper',
    status: 'completed',
    progress: 100,
    translationProvider: 'qwen',
    remoteBatchId: null,
    remoteDataId: null,
    remoteResultUrl: null,
    error: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides
  }
}

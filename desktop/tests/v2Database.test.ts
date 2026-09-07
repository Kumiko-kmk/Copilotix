import { mkdtemp, rm } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { V2Database, V2_MIGRATIONS, checksumFor, type V2Migration } from '../src/utility/core/persistence/v2Database'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function databasePath(name = 'mineru-v2.sqlite3'): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'mineru-v2-'))
  directories.push(directory)
  return join(directory, name)
}

function insertDocument(database: V2Database, id = 'document-1', storagePath = 'C:/output/documents-v2/document-1'): void {
  database.connection.prepare(`
    INSERT INTO documents(
      id,original_filename,display_title,storage_path,source_checksum,
      translation_provider,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?)
  `).run(id, 'paper.pdf', null, storagePath, `hash-${id}`, 'qwen', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
}

function insertJob(database: V2Database, id: string, documentId = 'document-1', kind = 'parse', status = 'queued'): void {
  database.connection.prepare(`
    INSERT INTO jobs(id,document_id,kind,status,progress,priority,attempt,
      payload_json,checkpoint_json,available_at,created_at,updated_at)
    VALUES(?,?,?,?,0,0,0,'{}','{}','now','now','now')
  `).run(id, documentId, kind, status)
}

describe('v2 migration ledger and strict persistence schema', () => {
  it('creates every v2 table without a tasks fact table and enables WAL', async () => {
    const path = await databasePath()
    const database = new V2Database(path)
    const tables = (database.connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name)
    expect(tables).toEqual([
      'annotation_sets', 'artifacts', 'documents', 'job_events', 'jobs', 'reader_annotations',
      'schema_migrations', 'settings', 'translation_blocks', 'translation_cache'
    ])
    expect(tables).not.toContain('tasks')
    expect(database.connection.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'wal' })
    const strictTables = database.connection.prepare('PRAGMA table_list').all() as Array<{ name: string; strict: number }>
    for (const table of tables) expect(strictTables.find((entry) => entry.name === table)?.strict).toBe(1)
    expect(database.migrationRows()).toEqual(V2_MIGRATIONS.map((migration) => ({
      version: migration.version, name: migration.name, checksum: checksumFor(migration)
    })))
    const documentColumns = (database.connection.prepare('PRAGMA table_info(documents)').all() as Array<{ name: string }>).map((column) => column.name)
    expect(documentColumns).toEqual([
      'id', 'original_filename', 'display_title', 'storage_path', 'source_checksum',
      'translation_provider', 'created_at', 'updated_at'
    ])
    database.close()
  })

  it('contains the durable job, event, artifact, block, and annotation fields', async () => {
    const path = await databasePath()
    const database = new V2Database(path)
    const columns = (table: string) => (database.connection.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name)
    expect(columns('jobs')).toEqual([
      'id', 'document_id', 'depends_on_job_id', 'kind', 'status', 'progress', 'priority', 'attempt', 'max_attempts',
      'payload_json', 'checkpoint_json', 'available_at', 'lease_owner', 'lease_expires_at', 'error_code',
      'error_message', 'started_at', 'finished_at', 'created_at', 'updated_at'
    ])
    expect(columns('job_events')).toEqual(['id', 'job_id', 'sequence', 'from_state', 'to_state', 'detail_json', 'created_at'])
    expect(columns('artifacts')).toContain('relative_path')
    expect(columns('artifacts')).toContain('content_hash')
    expect(columns('artifacts')).toContain('created_by_job_id')
    expect(columns('translation_blocks')).toContain('job_id')
    expect(columns('translation_blocks')).not.toContain('document_id')
    expect(columns('reader_annotations')).toContain('artifact_id')
    database.close()
  })

  it('enforces enum, JSON, same-document FK, active partial uniqueness, and artifact revision constraints', async () => {
    const path = await databasePath()
    const database = new V2Database(path)
    insertDocument(database)
    insertDocument(database, 'document-2', 'C:/output/documents-v2/document-2')
    expect(() => database.connection.prepare("INSERT INTO settings(key,value) VALUES('bad','{')").run()).toThrow()
    expect(() => database.connection.prepare(`
      INSERT INTO documents(id,original_filename,display_title,storage_path,source_checksum,translation_provider,created_at,updated_at)
      VALUES('bad','paper.pdf',NULL,'C:/bad','hash','invalid','now','now')
    `).run()).toThrow()
    insertJob(database, 'parse-1')
    expect(database.connection.prepare('SELECT max_attempts FROM jobs WHERE id = ?').get('parse-1')).toEqual({ max_attempts: 5 })
    expect(() => insertJob(database, 'parse-2')).toThrow()
    insertJob(database, 'parse-2', 'document-1', 'parse', 'succeeded')
    expect(() => insertJob(database, 'translate-1', 'document-1', 'translate', 'retry-wait')).not.toThrow()
    expect(() => insertJob(database, 'translate-2', 'document-1', 'translation', 'queued')).toThrow()
    database.connection.prepare("UPDATE jobs SET status = 'succeeded' WHERE id = 'parse-1'").run()
    expect(() => database.connection.prepare(`
      INSERT INTO jobs(id,document_id,depends_on_job_id,kind,status,progress,payload_json,checkpoint_json,available_at,created_at,updated_at)
      VALUES('same-doc-dependent','document-1','parse-1','parse','queued',0,'{}','{}','now','now','now')
    `).run()).not.toThrow()
    expect(() => database.connection.prepare(`
      INSERT INTO jobs(id,document_id,depends_on_job_id,kind,status,progress,payload_json,checkpoint_json,available_at,created_at,updated_at)
      VALUES('cross-doc-dependent','document-2','parse-1','parse','queued',0,'{}','{}','now','now','now')
    `).run()).toThrow()
    expect(() => database.connection.prepare(`
      INSERT INTO jobs(id,document_id,kind,status,progress,payload_json,checkpoint_json,available_at,created_at,updated_at)
      VALUES('bad-json','document-1','parse','queued',0,'{','{}','now','now','now')
    `).run()).toThrow()
    expect(() => database.connection.prepare(`
      INSERT INTO job_events(id,job_id,sequence,from_state,to_state,detail_json,created_at)
      VALUES('event-1','parse-1',1,NULL,'running','{}','now')
    `).run()).not.toThrow()
    expect(() => database.connection.prepare(`
      INSERT INTO job_events(id,job_id,sequence,from_state,to_state,detail_json,created_at)
      VALUES('event-2','parse-1',1,'queued','running','{}','now')
    `).run()).toThrow()
    expect(() => database.connection.prepare(`
      INSERT INTO job_events(id,job_id,sequence,from_state,to_state,detail_json,created_at)
      VALUES('event-3','parse-1',2,'invalid','running','{}','now')
    `).run()).toThrow()
    expect(() => database.connection.prepare(`
      INSERT INTO artifacts(id,document_id,created_by_job_id,kind,revision,relative_path,content_hash,metadata_json,created_at)
      VALUES('artifact-1','document-1','parse-1','source_pdf',1,'original.pdf','hash','{}','now')
    `).run()).not.toThrow()
    expect(() => database.connection.prepare(`
      INSERT INTO artifacts(id,document_id,created_by_job_id,kind,revision,relative_path,content_hash,metadata_json,created_at)
      VALUES('artifact-cross','document-2','parse-1','source_pdf',1,'original.pdf','hash','{}','now')
    `).run()).toThrow()
    expect(() => database.connection.prepare(`
      INSERT INTO artifacts(id,document_id,kind,revision,relative_path,content_hash,metadata_json,created_at)
      VALUES('artifact-dup','document-1','source_pdf',1,'original.pdf','hash','{}','now')
    `).run()).toThrow()
    expect(() => database.connection.prepare(`
      INSERT INTO artifacts(id,document_id,kind,revision,relative_path,content_hash,metadata_json,created_at)
      VALUES('artifact-2','document-1','content_list',2,'content_list.json','hash-2','{}','now')
    `).run()).not.toThrow()
    expect(() => database.connection.prepare(`
      INSERT INTO translation_blocks(job_id,block_id,source_hash,source_markdown,translated_markdown,provider,model,status,error)
      VALUES('translate-1','block-1','hash','source',NULL,'qwen','qwen','pending',NULL)
    `).run()).not.toThrow()
    expect(() => database.connection.prepare(`
      INSERT INTO translation_blocks(job_id,block_id,source_hash,source_markdown,translated_markdown,provider,model,status,error)
      VALUES('missing-job','block-1','hash','source',NULL,'qwen','qwen','pending',NULL)
    `).run()).toThrow()
    expect(() => database.connection.prepare(`
      INSERT INTO annotation_sets(id,document_id,artifact_id,view,revision,created_at,updated_at)
      VALUES('set-1','document-1','artifact-1','original',1,'now','now')
    `).run()).not.toThrow()
    expect(() => database.connection.prepare(`
      INSERT INTO annotation_sets(id,document_id,artifact_id,view,revision,created_at,updated_at)
      VALUES('set-duplicate','document-1','artifact-1','original',2,'now','now')
    `).run()).toThrow()
    expect(() => database.connection.prepare(`
      INSERT INTO annotation_sets(id,document_id,artifact_id,view,revision,created_at,updated_at)
      VALUES('set-2','document-1','artifact-2','original',1,'now','now')
    `).run()).not.toThrow()
    expect(() => database.connection.prepare(`
      INSERT INTO reader_annotations(id,document_id,artifact_id,annotation_set_id,view,kind,color,block_key,start_offset,end_offset,quote,prefix,suffix,created_at,updated_at)
      VALUES('annotation-1','document-1','artifact-1','set-1','original','highlight','yellow','block',0,1,'x','','','now','now')
    `).run()).not.toThrow()
    expect(() => database.connection.prepare(`
      INSERT INTO reader_annotations(id,document_id,artifact_id,annotation_set_id,view,kind,color,block_key,start_offset,end_offset,quote,prefix,suffix,created_at,updated_at)
      VALUES('annotation-cross','document-1','artifact-1','set-1','translated','highlight','yellow','block',0,1,'x','','','now','now')
    `).run()).toThrow()
    expect(() => database.connection.prepare(`
      INSERT INTO translation_cache(cache_key,translated_markdown,provider,model,created_at)
      VALUES('cache','translated','invalid','model','now')
    `).run()).toThrow()
    database.close()
  })

  it('removes legacy parser settings and model metadata without losing documents or artifacts', async () => {
    const path = await databasePath()
    const legacy = new V2Database(path, [V2_MIGRATIONS[0]!])
    legacy.connection.prepare(`
      INSERT INTO documents(id,original_filename,display_title,storage_path,source_checksum,parser_model,translation_provider,created_at,updated_at)
      VALUES('legacy-document','paper.pdf','Paper','C:/legacy','legacy-hash','pipeline','qwen','now','now')
    `).run()
    legacy.connection.prepare(`
      INSERT INTO artifacts(id,document_id,kind,revision,relative_path,content_hash,metadata_json,created_at)
      VALUES('legacy-artifact','legacy-document','parsed_markdown',1,'paper.md','artifact-hash','{}','now')
    `).run()
    for (const key of ['parserModel', 'forceOcr', 'ocrLanguage', 'outputRoot']) {
      legacy.connection.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run(key, JSON.stringify(key))
    }
    legacy.close()

    const migrated = new V2Database(path)
    const columns = (migrated.connection.prepare('PRAGMA table_info(documents)').all() as Array<{ name: string }>).map((row) => row.name)
    expect(columns).not.toContain('parser_model')
    expect(migrated.connection.prepare('SELECT id,display_title FROM documents').all()).toEqual([
      { id: 'legacy-document', display_title: 'Paper' }
    ])
    expect(migrated.connection.prepare('SELECT id,document_id,relative_path FROM artifacts').all()).toEqual([
      { id: 'legacy-artifact', document_id: 'legacy-document', relative_path: 'paper.md' }
    ])
    expect(migrated.connection.prepare('SELECT key FROM settings ORDER BY key').all()).toEqual([{ key: 'outputRoot' }])
    migrated.close()
  })

  it('is idempotent on duplicate startup and detects checksum drift', async () => {
    const path = await databasePath()
    const first = new V2Database(path)
    first.close()
    const second = new V2Database(path)
    expect(second.migrationRows()).toHaveLength(2)
    second.close()
    const drifted: V2Migration = { version: 1, name: 'create-v2-document-persistence', sql: 'SELECT 1;' }
    expect(() => new V2Database(path, [drifted])).toThrow(/checksum mismatch/)
  })

  it('rolls back a failed migration while preserving previously committed versions', async () => {
    const path = await databasePath()
    const migrations: readonly V2Migration[] = [
      { version: 1, name: 'first', sql: 'CREATE TABLE first(value TEXT) STRICT;' },
      { version: 2, name: 'fails', sql: 'CREATE TABLE second(value TEXT) STRICT; INSERT INTO missing_table VALUES (1);' }
    ]
    expect(() => new V2Database(path, migrations)).toThrow()
    const database = new DatabaseSync(path)
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='first'").get()).toBeTruthy()
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='second'").get()).toBeUndefined()
    expect(database.prepare('SELECT version FROM schema_migrations').all()).toEqual([{ version: 1 }])
    database.close()
  })

  it('does not inspect or mutate a separate v1 database', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mineru-v1-v2-'))
    directories.push(directory)
    const v1Path = join(directory, 'mineru-desktop.sqlite3')
    const v1 = new DatabaseSync(v1Path)
    v1.exec("CREATE TABLE tasks(id TEXT PRIMARY KEY, marker TEXT); INSERT INTO tasks VALUES ('legacy', 'untouched');")
    v1.close()
    const v2 = new V2Database(join(directory, 'mineru-desktop-v2.sqlite3'))
    v2.close()
    const reopened = new DatabaseSync(v1Path)
    expect(reopened.prepare('SELECT marker FROM tasks WHERE id = ?').get('legacy')).toEqual({ marker: 'untouched' })
    reopened.close()
  })
})

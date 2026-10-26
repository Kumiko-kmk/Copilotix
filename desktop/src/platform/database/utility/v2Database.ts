import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, openSync, unlinkSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { resolve } from 'node:path'
import { V2_SCHEMA_SQL, RAG_PERSISTENCE_MIGRATION_SQL } from './v2SchemaSql'

export interface V2Migration {
  version: number
  name: string
  sql: string
}

export class V2MigrationError extends Error {
  constructor(readonly recoverySnapshotPath: string, cause: unknown) {
    super(`V2 database migration failed. A pre-migration snapshot was retained at ${recoverySnapshotPath}`, { cause })
    this.name = 'V2MigrationError'
  }
}

export const V2_MIGRATIONS: readonly V2Migration[] = Object.freeze([
  { version: 1, name: 'create-v2-document-persistence', sql: V2_SCHEMA_SQL },
  {
    version: 2,
    name: 'remove-legacy-parser-settings',
    sql: `
DELETE FROM settings WHERE key IN ('parserModel', 'forceOcr', 'ocrLanguage');
ALTER TABLE documents DROP COLUMN parser_model;
`
  },
  {
    version: 3,
    name: 'add-application-migration-markers',
    sql: `
CREATE TABLE app_migrations (
  id TEXT PRIMARY KEY CHECK (length(id) > 0 AND instr(id, char(0)) = 0),
  applied_at TEXT NOT NULL
) STRICT;
`
  },
  {
    version: 4,
    name: 'add-rag-persistence-and-job-kinds',
    sql: RAG_PERSISTENCE_MIGRATION_SQL
  },
  { version: 5, name: 'add-codex-provider', sql: `
CREATE TABLE documents_codex_rebuild (
  id TEXT PRIMARY KEY CHECK (length(id) > 0 AND instr(id, char(0)) = 0),
  original_filename TEXT NOT NULL CHECK (length(original_filename) > 0 AND instr(original_filename, char(0)) = 0),
  display_title TEXT CHECK (display_title IS NULL OR instr(display_title, char(0)) = 0),
  storage_path TEXT NOT NULL CHECK (length(storage_path) > 0 AND instr(storage_path, char(0)) = 0),
  source_checksum TEXT NOT NULL CHECK (length(source_checksum) > 0),
  translation_provider TEXT NOT NULL CHECK (translation_provider IN ('qwen', 'deepseek', 'bing', 'transmart', 'codex')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(storage_path)
) STRICT;
INSERT INTO documents_codex_rebuild SELECT * FROM documents;
DROP TABLE documents;
ALTER TABLE documents_codex_rebuild RENAME TO documents;
CREATE INDEX idx_documents_source_checksum ON documents(source_checksum);
CREATE INDEX idx_documents_created_at ON documents(created_at DESC);
CREATE TABLE translation_blocks_codex_rebuild (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  block_id TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  source_markdown TEXT NOT NULL,
  translated_markdown TEXT,
  provider TEXT CHECK (provider IS NULL OR provider IN ('qwen', 'deepseek', 'bing', 'transmart', 'codex')),
  model TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  error TEXT,
  PRIMARY KEY(job_id, block_id)
) STRICT;
INSERT INTO translation_blocks_codex_rebuild SELECT * FROM translation_blocks;
DROP TABLE translation_blocks;
ALTER TABLE translation_blocks_codex_rebuild RENAME TO translation_blocks;
CREATE TABLE translation_cache_codex_rebuild (
  cache_key TEXT PRIMARY KEY,
  translated_markdown TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('qwen', 'deepseek', 'bing', 'transmart', 'codex')),
  model TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
INSERT INTO translation_cache_codex_rebuild SELECT * FROM translation_cache;
DROP TABLE translation_cache;
ALTER TABLE translation_cache_codex_rebuild RENAME TO translation_cache;
` }
])

export class V2Database {
  readonly connection: DatabaseSync

  constructor(databasePath: string, migrations: readonly V2Migration[] = V2_MIGRATIONS) {
    this.connection = new DatabaseSync(databasePath)
    this.connection.exec('PRAGMA foreign_keys = ON;')
    try {
      this.applyMigrations(databasePath, migrations)
    } catch (error) {
      this.connection.close()
      throw error
    }
  }

  close(): void {
    this.connection.close()
  }

  transaction<T>(callback: () => T): T {
    this.connection.exec('BEGIN IMMEDIATE')
    try {
      const result = callback()
      this.connection.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.connection.exec('ROLLBACK')
      } catch {
        // Preserve the original transaction error.
      }
      throw error
    }
  }

  migrationRows(): Array<{ version: number; name: string; checksum: string }> {
    return this.connection
      .prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version')
      .all() as Array<{ version: number; name: string; checksum: string }>
  }

  private applyMigrations(databasePath: string, migrations: readonly V2Migration[]): void {
    const ordered = [...migrations].sort((left, right) => left.version - right.version)
    if (ordered.some((migration, index) => migration.version !== index + 1)) {
      throw new Error('v2 migration versions must be contiguous starting at 1')
    }

    const hasLedger = Boolean(this.connection
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
      .get())
    const appliedRows = hasLedger
      ? this.connection
        .prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version')
        .all() as Array<{ version: number; name: string; checksum: string }>
      : []
    const highestSupportedVersion = ordered.at(-1)?.version ?? 0
    const unsupportedVersion = appliedRows.find((row) => row.version > highestSupportedVersion)
    if (unsupportedVersion) {
      throw new Error(`v2 database schema version ${unsupportedVersion.version} is newer than supported version ${highestSupportedVersion}`)
    }
    if (appliedRows.some((row, index) => row.version !== index + 1)) {
      throw new Error('v2 migration ledger is not contiguous starting at version 1')
    }

    const appliedByVersion = new Map(appliedRows.map((row) => [row.version, row] as const))
    for (const migration of ordered) {
      const applied = appliedByVersion.get(migration.version)
      if (!applied) continue
      if (applied.name !== migration.name || applied.checksum !== checksumFor(migration)) {
        throw new Error(`v2 migration checksum mismatch at version ${migration.version}`)
      }
    }

    const pending = ordered.filter((migration) => !appliedByVersion.has(migration.version))
    const snapshotPath = pending.length > 0
      ? createMigrationSnapshot(this.connection, databasePath, pending[0]!.version)
      : null

    try {
      this.connection.exec('PRAGMA journal_mode = WAL;')
      if (pending.length === 0) {
        if (!hasLedger) this.createMigrationLedger()
        return
      }

      // Table rebuilds preserve IDs and referencing rows; foreign keys are checked before commit.
      const rebuildProviders = pending.some(migration => migration.name === 'add-codex-provider')
      if (rebuildProviders) this.connection.exec('PRAGMA foreign_keys = OFF;')
      try {
        this.transaction(() => {
          if (!hasLedger) this.createMigrationLedger()
          for (const migration of pending) {
            const checksum = checksumFor(migration)
            this.connection.exec(migration.sql)
            this.connection
              .prepare('INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES(?,?,?,?)')
              .run(migration.version, migration.name, checksum, new Date().toISOString())
          }
          if (this.connection.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Migration violated foreign keys')
        })
      } finally { this.connection.exec('PRAGMA foreign_keys = ON;') }
    } catch (error) {
      if (snapshotPath) throw new V2MigrationError(snapshotPath, error)
      throw error
    }
  }

  private createMigrationLedger(): void {
    this.connection.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL CHECK (length(checksum) = 64),
        applied_at TEXT NOT NULL
      ) STRICT;
    `)
  }
}

function createMigrationSnapshot(connection: DatabaseSync, databasePath: string, pendingVersion: number): string | null {
  if (databasePath === ':memory:' || !hasPersistentDatabaseState(connection)) return null

  const timestamp = new Date().toISOString().replace(/[:.]/gu, '-')
  const snapshotPath = `${resolve(databasePath)}.pre-migration-v${pendingVersion}-${timestamp}-${randomUUID()}.sqlite3`
  if (existsSync(snapshotPath)) throw new Error('Refusing to overwrite an existing pre-migration snapshot')

  try {
    const previousSynchronous = connection.prepare('PRAGMA synchronous').get() as { synchronous: number }
    connection.exec('PRAGMA synchronous = FULL;')
    try {
      // FULL asks SQLite to flush the completed VACUUM INTO snapshot to disk.
      connection.exec(`VACUUM INTO '${snapshotPath.replace(/'/gu, "''")}'`)
    } finally {
      try {
        connection.exec(`PRAGMA synchronous = ${previousSynchronous.synchronous};`)
      } catch {
        // Keep FULL if restoring a weaker caller-selected setting fails.
      }
    }

    const snapshotFd = openSync(snapshotPath, 'r+')
    try {
      fsyncSync(snapshotFd)
    } finally {
      closeSync(snapshotFd)
    }

    const snapshot = new DatabaseSync(snapshotPath, { readOnly: true })
    try {
      const integrity = snapshot.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>
      if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
        throw new Error('Pre-migration snapshot failed SQLite integrity_check')
      }
    } finally {
      snapshot.close()
    }
    return snapshotPath
  } catch (error) {
    try {
      if (existsSync(snapshotPath)) unlinkSync(snapshotPath)
    } catch {
      // Keep the original snapshot error; migrations still do not start.
    }
    throw new Error('Failed to create a valid pre-migration database snapshot', { cause: error })
  }
}

function hasPersistentDatabaseState(connection: DatabaseSync): boolean {
  const hasUserObjects = Boolean(connection
    .prepare("SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1")
    .get())
  const userVersion = connection.prepare('PRAGMA user_version').get() as { user_version: number }
  const applicationId = connection.prepare('PRAGMA application_id').get() as { application_id: number }
  return hasUserObjects || userVersion.user_version !== 0 || applicationId.application_id !== 0
}

export function checksumFor(migration: V2Migration): string {
  return createHash('sha256')
    .update(`${migration.version}\n${migration.name}\n${migration.sql.replace(/\r\n/gu, '\n')}`)
    .digest('hex')
}

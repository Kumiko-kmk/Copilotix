import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

export interface V2Migration {
  version: number
  name: string
  sql: string
}

const V2_SCHEMA_SQL = `
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL CHECK (json_valid(value))
) STRICT;

CREATE TABLE documents (
  id TEXT PRIMARY KEY CHECK (length(id) > 0 AND instr(id, char(0)) = 0),
  original_filename TEXT NOT NULL CHECK (length(original_filename) > 0 AND instr(original_filename, char(0)) = 0),
  display_title TEXT CHECK (display_title IS NULL OR instr(display_title, char(0)) = 0),
  storage_path TEXT NOT NULL CHECK (length(storage_path) > 0 AND instr(storage_path, char(0)) = 0),
  source_checksum TEXT NOT NULL CHECK (length(source_checksum) > 0),
  parser_model TEXT NOT NULL CHECK (parser_model IN ('vlm', 'pipeline')),
  translation_provider TEXT NOT NULL CHECK (translation_provider IN ('qwen', 'deepseek', 'bing', 'transmart')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(storage_path)
) STRICT;

CREATE INDEX idx_documents_source_checksum ON documents(source_checksum);
CREATE INDEX idx_documents_created_at ON documents(created_at DESC);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY CHECK (length(id) > 0 AND instr(id, char(0)) = 0),
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  depends_on_job_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('parse', 'translate')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'retry-wait', 'succeeded', 'partial', 'failed', 'cancelled')),
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
  priority INTEGER NOT NULL DEFAULT 0,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  checkpoint_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(checkpoint_json)),
  available_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  error_code TEXT,
  error_message TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(id, document_id),
  FOREIGN KEY(depends_on_job_id, document_id)
    REFERENCES jobs(id, document_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX idx_jobs_claim ON jobs(status, available_at, priority DESC, created_at);
CREATE INDEX idx_jobs_document_updated ON jobs(document_id, updated_at DESC);
CREATE UNIQUE INDEX idx_jobs_document_kind_active
  ON jobs(document_id, kind)
  WHERE status NOT IN ('succeeded', 'partial', 'failed', 'cancelled');

CREATE TABLE job_events (
  id TEXT PRIMARY KEY CHECK (length(id) > 0 AND instr(id, char(0)) = 0),
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  from_state TEXT CHECK (from_state IS NULL OR from_state IN ('queued', 'running', 'retry-wait', 'succeeded', 'partial', 'failed', 'cancelled')),
  to_state TEXT NOT NULL CHECK (to_state IN ('queued', 'running', 'retry-wait', 'succeeded', 'partial', 'failed', 'cancelled')),
  detail_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail_json)),
  created_at TEXT NOT NULL,
  UNIQUE(job_id, sequence)
) STRICT;

CREATE INDEX idx_job_events_job_created ON job_events(job_id, created_at);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY CHECK (length(id) > 0 AND instr(id, char(0)) = 0),
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  created_by_job_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('source_pdf', 'parsed_markdown', 'layout', 'block_mappings', 'content_list', 'translated_markdown', 'manifest')),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  relative_path TEXT NOT NULL CHECK (length(relative_path) > 0 AND instr(relative_path, char(0)) = 0),
  content_hash TEXT NOT NULL CHECK (length(content_hash) > 0),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL,
  UNIQUE(document_id, kind, revision),
  UNIQUE(id, document_id),
  FOREIGN KEY(created_by_job_id, document_id)
    REFERENCES jobs(id, document_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX idx_artifacts_document_kind ON artifacts(document_id, kind, revision DESC);

CREATE TABLE translation_blocks (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  block_id TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  source_markdown TEXT NOT NULL,
  translated_markdown TEXT,
  provider TEXT CHECK (provider IS NULL OR provider IN ('qwen', 'deepseek', 'bing', 'transmart')),
  model TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  error TEXT,
  PRIMARY KEY(job_id, block_id)
) STRICT;

CREATE TABLE translation_cache (
  cache_key TEXT PRIMARY KEY,
  translated_markdown TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('qwen', 'deepseek', 'bing', 'transmart')),
  model TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE annotation_sets (
  id TEXT PRIMARY KEY CHECK (length(id) > 0 AND instr(id, char(0)) = 0),
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  view TEXT NOT NULL CHECK (view IN ('original', 'translated')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(document_id, artifact_id, view),
  UNIQUE(id, document_id, artifact_id),
  UNIQUE(id, document_id, artifact_id, view),
  FOREIGN KEY(artifact_id, document_id)
    REFERENCES artifacts(id, document_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE reader_annotations (
  id TEXT PRIMARY KEY CHECK (length(id) > 0 AND instr(id, char(0)) = 0),
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  annotation_set_id TEXT NOT NULL,
  view TEXT NOT NULL CHECK (view IN ('original', 'translated')),
  kind TEXT NOT NULL CHECK (kind IN ('highlight', 'underline')),
  color TEXT CHECK (color IS NULL OR color IN ('yellow', 'green', 'blue', 'pink', 'purple')),
  block_key TEXT NOT NULL,
  start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
  end_offset INTEGER NOT NULL CHECK (end_offset > start_offset),
  quote TEXT NOT NULL,
  prefix TEXT NOT NULL,
  suffix TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(annotation_set_id, id),
  FOREIGN KEY(annotation_set_id, document_id, artifact_id, view)
    REFERENCES annotation_sets(id, document_id, artifact_id, view) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_reader_annotations_document_view
  ON reader_annotations(document_id, artifact_id, view, block_key, start_offset, end_offset, id);
`

export const V2_MIGRATIONS: readonly V2Migration[] = Object.freeze([
  { version: 1, name: 'create-v2-document-persistence', sql: V2_SCHEMA_SQL }
])

export class V2Database {
  readonly connection: DatabaseSync

  constructor(databasePath: string, migrations: readonly V2Migration[] = V2_MIGRATIONS) {
    this.connection = new DatabaseSync(databasePath)
    this.connection.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    try {
      this.applyMigrations(migrations)
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

  private applyMigrations(migrations: readonly V2Migration[]): void {
    const ordered = [...migrations].sort((left, right) => left.version - right.version)
    if (ordered.some((migration, index) => migration.version !== index + 1)) {
      throw new Error('v2 migration versions must be contiguous starting at 1')
    }

    this.connection.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL CHECK (length(checksum) = 64),
        applied_at TEXT NOT NULL
      ) STRICT;
    `)

    for (const migration of ordered) {
      const checksum = checksumFor(migration)
      const applied = this.connection
        .prepare('SELECT name, checksum FROM schema_migrations WHERE version = ?')
        .get(migration.version) as { name: string; checksum: string } | undefined
      if (applied) {
        if (applied.name !== migration.name || applied.checksum !== checksum) {
          throw new Error(`v2 migration checksum mismatch at version ${migration.version}`)
        }
        continue
      }

      this.transaction(() => {
        this.connection.exec(migration.sql)
        this.connection
          .prepare('INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES(?,?,?,?)')
          .run(migration.version, migration.name, checksum, new Date().toISOString())
      })
    }
  }
}

export function checksumFor(migration: V2Migration): string {
  return createHash('sha256')
    .update(`${migration.version}\n${migration.name}\n${migration.sql.replace(/\r\n/gu, '\n')}`)
    .digest('hex')
}

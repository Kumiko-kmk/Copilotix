import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, openSync, unlinkSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { resolve } from 'node:path'

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

/**
 * The fourth migration deliberately rebuilds the durable-job dependency
 * graph instead of using DROP TABLE jobs.  SQLite enforces the foreign keys
 * while a migration is running and jobs is referenced by job_events,
 * artifacts, and translation_blocks (artifacts is itself referenced by the
 * annotation tables).  Copying the graph in dependency order keeps every
 * pre-existing row, including rows created by v1 databases, and lets the
 * whole replacement roll back as one migration transaction.
 */
const RAG_PERSISTENCE_MIGRATION_SQL = `
CREATE TABLE jobs_v4_rebuild (
  id TEXT PRIMARY KEY CHECK (length(id) > 0 AND instr(id, char(0)) = 0),
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  depends_on_job_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('parse', 'translate', 'rag-content-index', 'rag-embed', 'rag-delete')),
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
    REFERENCES jobs_v4_rebuild(id, document_id) ON DELETE RESTRICT
) STRICT;

INSERT INTO jobs_v4_rebuild(
  id, document_id, depends_on_job_id, kind, status, progress, priority, attempt,
  max_attempts, payload_json, checkpoint_json, available_at, lease_owner,
  lease_expires_at, error_code, error_message, started_at, finished_at,
  created_at, updated_at
)
SELECT id, document_id, depends_on_job_id, kind, status, progress, priority, attempt,
  max_attempts, payload_json, checkpoint_json, available_at, lease_owner,
  lease_expires_at, error_code, error_message, started_at, finished_at,
  created_at, updated_at
FROM jobs;

CREATE TABLE job_events_v4_rebuild (
  id TEXT PRIMARY KEY CHECK (length(id) > 0 AND instr(id, char(0)) = 0),
  job_id TEXT NOT NULL REFERENCES jobs_v4_rebuild(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  from_state TEXT CHECK (from_state IS NULL OR from_state IN ('queued', 'running', 'retry-wait', 'succeeded', 'partial', 'failed', 'cancelled')),
  to_state TEXT NOT NULL CHECK (to_state IN ('queued', 'running', 'retry-wait', 'succeeded', 'partial', 'failed', 'cancelled')),
  detail_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail_json)),
  created_at TEXT NOT NULL,
  UNIQUE(job_id, sequence)
) STRICT;

INSERT INTO job_events_v4_rebuild(id, job_id, sequence, from_state, to_state, detail_json, created_at)
SELECT id, job_id, sequence, from_state, to_state, detail_json, created_at
FROM job_events;

CREATE TABLE artifacts_v4_rebuild (
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
    REFERENCES jobs_v4_rebuild(id, document_id) ON DELETE RESTRICT
) STRICT;

INSERT INTO artifacts_v4_rebuild(
  id, document_id, created_by_job_id, kind, revision, relative_path,
  content_hash, metadata_json, created_at
)
SELECT id, document_id, created_by_job_id, kind, revision, relative_path,
  content_hash, metadata_json, created_at
FROM artifacts;

CREATE TABLE translation_blocks_v4_rebuild (
  job_id TEXT NOT NULL REFERENCES jobs_v4_rebuild(id) ON DELETE CASCADE,
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

INSERT INTO translation_blocks_v4_rebuild(
  job_id, block_id, source_hash, source_markdown, translated_markdown,
  provider, model, status, error
)
SELECT job_id, block_id, source_hash, source_markdown, translated_markdown,
  provider, model, status, error
FROM translation_blocks;

CREATE TABLE annotation_sets_v4_rebuild (
  id TEXT PRIMARY KEY CHECK (length(id) > 0 AND instr(id, char(0)) = 0),
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL REFERENCES artifacts_v4_rebuild(id) ON DELETE CASCADE,
  view TEXT NOT NULL CHECK (view IN ('original', 'translated')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(document_id, artifact_id, view),
  UNIQUE(id, document_id, artifact_id),
  UNIQUE(id, document_id, artifact_id, view),
  FOREIGN KEY(artifact_id, document_id)
    REFERENCES artifacts_v4_rebuild(id, document_id) ON DELETE CASCADE
) STRICT;

INSERT INTO annotation_sets_v4_rebuild(
  id, document_id, artifact_id, view, revision, created_at, updated_at
)
SELECT id, document_id, artifact_id, view, revision, created_at, updated_at
FROM annotation_sets;

CREATE TABLE reader_annotations_v4_rebuild (
  id TEXT PRIMARY KEY CHECK (length(id) > 0 AND instr(id, char(0)) = 0),
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL REFERENCES artifacts_v4_rebuild(id) ON DELETE CASCADE,
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
    REFERENCES annotation_sets_v4_rebuild(id, document_id, artifact_id, view) ON DELETE CASCADE
) STRICT;

INSERT INTO reader_annotations_v4_rebuild(
  id, document_id, artifact_id, annotation_set_id, view, kind, color,
  block_key, start_offset, end_offset, quote, prefix, suffix, created_at, updated_at
)
SELECT id, document_id, artifact_id, annotation_set_id, view, kind, color,
  block_key, start_offset, end_offset, quote, prefix, suffix, created_at, updated_at
FROM reader_annotations;

DROP TABLE reader_annotations;
DROP TABLE annotation_sets;
DROP TABLE translation_blocks;
DROP TABLE job_events;
DROP TABLE artifacts;
-- SQLite enforces the legacy table's self-referential RESTRICT constraint
-- during DROP TABLE. The dependency graph is already preserved in the rebuilt
-- table, so detach only the soon-to-be-dropped legacy rows first.
UPDATE jobs SET depends_on_job_id = NULL WHERE depends_on_job_id IS NOT NULL;
DROP TABLE jobs;

ALTER TABLE jobs_v4_rebuild RENAME TO jobs;
ALTER TABLE job_events_v4_rebuild RENAME TO job_events;
ALTER TABLE artifacts_v4_rebuild RENAME TO artifacts;
ALTER TABLE translation_blocks_v4_rebuild RENAME TO translation_blocks;
ALTER TABLE annotation_sets_v4_rebuild RENAME TO annotation_sets;
ALTER TABLE reader_annotations_v4_rebuild RENAME TO reader_annotations;

CREATE INDEX idx_jobs_claim ON jobs(status, available_at, priority DESC, created_at);
CREATE INDEX idx_jobs_document_updated ON jobs(document_id, updated_at DESC);
CREATE UNIQUE INDEX idx_jobs_document_kind_active
  ON jobs(document_id, kind)
  WHERE status NOT IN ('succeeded', 'partial', 'failed', 'cancelled');
CREATE INDEX idx_job_events_job_created ON job_events(job_id, created_at);
CREATE INDEX idx_artifacts_document_kind ON artifacts(document_id, kind, revision DESC);
CREATE INDEX idx_reader_annotations_document_view
  ON reader_annotations(document_id, artifact_id, view, block_key, start_offset, end_offset, id);

CREATE TABLE rag_profiles (
  profile_id TEXT PRIMARY KEY CHECK (length(profile_id) > 0 AND length(profile_id) <= 256 AND instr(profile_id, char(0)) = 0),
  capability TEXT NOT NULL CHECK (capability IN ('embedding', 'rerank', 'chat')),
  provider TEXT NOT NULL CHECK (length(provider) > 0 AND length(provider) <= 128 AND instr(provider, char(0)) = 0),
  model TEXT NOT NULL CHECK (length(model) > 0 AND length(model) <= 256 AND instr(model, char(0)) = 0),
  profile_fingerprint TEXT NOT NULL CHECK (length(profile_fingerprint) > 0 AND length(profile_fingerprint) <= 256 AND instr(profile_fingerprint, char(0)) = 0),
  dimensions INTEGER CHECK (dimensions IS NULL OR dimensions > 0),
  metric TEXT NOT NULL DEFAULT 'cosine' CHECK (metric IN ('cosine', 'dot', 'l2')),
  normalized INTEGER NOT NULL DEFAULT 1 CHECK (normalized IN (0, 1)),
  credential_ref TEXT CHECK (credential_ref IS NULL OR (length(credential_ref) > 0 AND length(credential_ref) <= 256 AND instr(credential_ref, char(0)) = 0)),
  status TEXT NOT NULL DEFAULT 'valid' CHECK (status IN ('valid', 'invalid', 'disabled')),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(capability, profile_fingerprint)
) STRICT;

CREATE TABLE rag_documents (
  document_id TEXT PRIMARY KEY CHECK (length(document_id) > 0 AND length(document_id) <= 512 AND instr(document_id, char(0)) = 0),
  local_state TEXT NOT NULL DEFAULT 'unindexed' CHECK (local_state IN ('unindexed', 'queued', 'indexing', 'ready', 'stale', 'failed')),
  local_progress INTEGER NOT NULL DEFAULT 0 CHECK (local_progress >= 0 AND local_progress <= 100),
  local_error_code TEXT,
  local_error_message TEXT,
  local_error_retryable INTEGER CHECK (local_error_retryable IS NULL OR local_error_retryable IN (0, 1)),
  local_error_retry_after_ms INTEGER CHECK (local_error_retry_after_ms IS NULL OR (local_error_retry_after_ms >= 0 AND local_error_retry_after_ms <= 86400000)),
  active_content_revision_id TEXT,
  semantic_state TEXT NOT NULL DEFAULT 'disabled' CHECK (semantic_state IN ('disabled', 'requires-consent', 'requires-credential', 'queued', 'indexing', 'ready', 'stale', 'failed')),
  semantic_progress INTEGER NOT NULL DEFAULT 0 CHECK (semantic_progress >= 0 AND semantic_progress <= 100),
  semantic_error_code TEXT,
  semantic_error_message TEXT,
  semantic_error_retryable INTEGER CHECK (semantic_error_retryable IS NULL OR semantic_error_retryable IN (0, 1)),
  semantic_error_retry_after_ms INTEGER CHECK (semantic_error_retry_after_ms IS NULL OR (semantic_error_retry_after_ms >= 0 AND semantic_error_retry_after_ms <= 86400000)),
  semantic_content_revision_id TEXT,
  active_vector_index_id TEXT,
  semantic_profile_id TEXT,
  semantic_consent INTEGER NOT NULL DEFAULT 0 CHECK (semantic_consent IN (0, 1)),
  updated_at TEXT NOT NULL,
  CHECK ((local_state = 'failed') = (local_error_code IS NOT NULL AND local_error_message IS NOT NULL)),
  CHECK ((local_state <> 'failed') = (local_error_code IS NULL AND local_error_message IS NULL)),
  CHECK (local_state <> 'ready' OR (active_content_revision_id IS NOT NULL AND local_progress = 100)),
  CHECK (local_state IN ('unindexed', 'stale') OR active_content_revision_id IS NOT NULL OR local_state IN ('queued', 'indexing', 'failed')),
  CHECK ((semantic_state = 'failed') = (semantic_error_code IS NOT NULL AND semantic_error_message IS NOT NULL)),
  CHECK ((semantic_state <> 'failed') = (semantic_error_code IS NULL AND semantic_error_message IS NULL)),
  CHECK (semantic_state <> 'ready' OR (semantic_content_revision_id IS NOT NULL AND active_vector_index_id IS NOT NULL AND semantic_profile_id IS NOT NULL AND semantic_progress = 100)),
  CHECK (semantic_state NOT IN ('disabled', 'requires-consent', 'requires-credential') OR (semantic_content_revision_id IS NULL AND active_vector_index_id IS NULL AND semantic_profile_id IS NULL)),
  FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE,
  FOREIGN KEY(active_content_revision_id, document_id)
    REFERENCES rag_content_revisions(content_revision_id, document_id) ON DELETE RESTRICT,
  FOREIGN KEY(semantic_content_revision_id, document_id)
    REFERENCES rag_content_revisions(content_revision_id, document_id) ON DELETE RESTRICT,
  FOREIGN KEY(active_vector_index_id, document_id)
    REFERENCES rag_vector_indexes(vector_index_id, document_id) ON DELETE RESTRICT,
  FOREIGN KEY(semantic_profile_id) REFERENCES rag_profiles(profile_id) ON DELETE SET NULL
) STRICT;

CREATE TABLE rag_content_revisions (
  content_revision_id TEXT PRIMARY KEY CHECK (length(content_revision_id) > 0 AND length(content_revision_id) <= 256 AND instr(content_revision_id, char(0)) = 0),
  document_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL CHECK (length(artifact_id) > 0 AND instr(artifact_id, char(0)) = 0),
  content_hash TEXT NOT NULL CHECK (length(content_hash) > 0 AND instr(content_hash, char(0)) = 0),
  mapping_fingerprint TEXT NOT NULL CHECK (length(mapping_fingerprint) > 0 AND instr(mapping_fingerprint, char(0)) = 0),
  chunker_fingerprint TEXT NOT NULL CHECK (length(chunker_fingerprint) > 0 AND instr(chunker_fingerprint, char(0)) = 0),
  lexical_generation INTEGER NOT NULL DEFAULT 0 CHECK (lexical_generation >= 0),
  state TEXT NOT NULL DEFAULT 'building' CHECK (state IN ('building', 'ready', 'stale', 'failed')),
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(content_revision_id, document_id),
  -- Artifact identity is provenance, not revision identity.  A parse retry
  -- can publish the same bytes under a new artifact row.
  UNIQUE(document_id, content_hash, mapping_fingerprint, chunker_fingerprint),
  CHECK ((state = 'failed') = (error_code IS NOT NULL AND error_message IS NOT NULL)),
  CHECK ((state <> 'failed') = (error_code IS NULL AND error_message IS NULL)),
  FOREIGN KEY(document_id) REFERENCES rag_documents(document_id) ON DELETE CASCADE,
  FOREIGN KEY(artifact_id, document_id) REFERENCES artifacts(id, document_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE rag_chunks (
  chunk_id TEXT PRIMARY KEY CHECK (length(chunk_id) > 0 AND length(chunk_id) <= 256 AND instr(chunk_id, char(0)) = 0),
  content_revision_id TEXT NOT NULL REFERENCES rag_content_revisions(content_revision_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  content_hash TEXT NOT NULL CHECK (length(content_hash) > 0 AND instr(content_hash, char(0)) = 0),
  source_text TEXT NOT NULL CHECK (length(source_text) > 0 AND instr(source_text, char(0)) = 0),
  section_path_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(section_path_json) AND json_type(section_path_json) = 'array'),
  mapping_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(mapping_ids_json) AND json_type(mapping_ids_json) = 'array'),
  page_start INTEGER CHECK (page_start IS NULL OR page_start >= 0),
  page_end INTEGER CHECK (page_end IS NULL OR (page_end >= 0 AND (page_start IS NULL OR page_end >= page_start))),
  source_start_offset INTEGER CHECK (source_start_offset IS NULL OR source_start_offset >= 0),
  source_end_offset INTEGER CHECK (source_end_offset IS NULL OR (source_end_offset >= 0 AND (source_start_offset IS NULL OR source_end_offset >= source_start_offset))),
  offset_unit TEXT NOT NULL DEFAULT 'utf16' CHECK (offset_unit = 'utf16'),
  token_count INTEGER NOT NULL DEFAULT 0 CHECK (token_count >= 0),
  content_type TEXT NOT NULL DEFAULT 'other' CHECK (content_type IN ('paragraph', 'heading', 'table', 'formula', 'caption', 'code', 'list', 'other')),
  mapping_confidence TEXT NOT NULL DEFAULT 'none' CHECK (mapping_confidence IN ('exact', 'range', 'media', 'fallback', 'none')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(content_revision_id, ordinal),
  UNIQUE(chunk_id, content_revision_id)
) STRICT;

CREATE TABLE rag_chunk_variants (
  chunk_id TEXT NOT NULL REFERENCES rag_chunks(chunk_id) ON DELETE CASCADE,
  translation_artifact_id TEXT NOT NULL CHECK (length(translation_artifact_id) > 0 AND instr(translation_artifact_id, char(0)) = 0),
  translation_generation INTEGER NOT NULL CHECK (translation_generation >= 0),
  translated_text TEXT,
  translated_hash TEXT CHECK (translated_hash IS NULL OR (length(translated_hash) > 0 AND instr(translated_hash, char(0)) = 0)),
  provider TEXT,
  model TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed')),
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(chunk_id, translation_artifact_id, translation_generation),
  FOREIGN KEY(translation_artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE,
  CHECK ((status = 'failed') = (error_code IS NOT NULL AND error_message IS NOT NULL)),
  CHECK ((status <> 'failed') = (error_code IS NULL AND error_message IS NULL)),
  CHECK (status <> 'ready' OR translated_text IS NOT NULL)
) STRICT;

CREATE INDEX idx_rag_chunk_variants_chunk ON rag_chunk_variants(chunk_id, translation_generation DESC);

CREATE TABLE rag_vector_indexes (
  vector_index_id TEXT PRIMARY KEY CHECK (length(vector_index_id) > 0 AND length(vector_index_id) <= 256 AND instr(vector_index_id, char(0)) = 0),
  document_id TEXT NOT NULL,
  content_revision_id TEXT NOT NULL,
  profile_id TEXT NOT NULL REFERENCES rag_profiles(profile_id) ON DELETE RESTRICT,
  backend TEXT NOT NULL DEFAULT 'sqlite-exact' CHECK (length(backend) > 0 AND length(backend) <= 128 AND instr(backend, char(0)) = 0),
  dimensions INTEGER NOT NULL CHECK (dimensions > 0),
  metric TEXT NOT NULL CHECK (metric IN ('cosine', 'dot', 'l2')),
  normalized INTEGER NOT NULL DEFAULT 1 CHECK (normalized IN (0, 1)),
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'building', 'ready', 'stale', 'failed')),
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(vector_index_id, document_id),
  UNIQUE(vector_index_id, content_revision_id),
  UNIQUE(document_id, content_revision_id, profile_id),
  CHECK ((state = 'failed') = (error_code IS NOT NULL AND error_message IS NOT NULL)),
  CHECK ((state <> 'failed') = (error_code IS NULL AND error_message IS NULL)),
  FOREIGN KEY(document_id) REFERENCES rag_documents(document_id) ON DELETE CASCADE,
  FOREIGN KEY(content_revision_id, document_id) REFERENCES rag_content_revisions(content_revision_id, document_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_rag_vector_indexes_document_state ON rag_vector_indexes(document_id, state, updated_at DESC);

CREATE TABLE rag_embeddings (
  vector_index_id TEXT NOT NULL,
  content_revision_id TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  dimensions INTEGER NOT NULL CHECK (dimensions > 0),
  embedding BLOB NOT NULL CHECK (length(embedding) > 0),
  vector_hash TEXT CHECK (vector_hash IS NULL OR (length(vector_hash) > 0 AND instr(vector_hash, char(0)) = 0)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(vector_index_id, chunk_id),
  FOREIGN KEY(vector_index_id, content_revision_id)
    REFERENCES rag_vector_indexes(vector_index_id, content_revision_id) ON DELETE CASCADE,
  FOREIGN KEY(chunk_id, content_revision_id)
    REFERENCES rag_chunks(chunk_id, content_revision_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_rag_embeddings_revision ON rag_embeddings(content_revision_id, vector_index_id);

CREATE TABLE rag_embedding_cache (
  cache_key TEXT PRIMARY KEY CHECK (length(cache_key) > 0 AND length(cache_key) <= 512 AND instr(cache_key, char(0)) = 0),
  profile_id TEXT NOT NULL REFERENCES rag_profiles(profile_id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL CHECK (length(content_hash) > 0 AND instr(content_hash, char(0)) = 0),
  dimensions INTEGER NOT NULL CHECK (dimensions > 0),
  embedding BLOB NOT NULL CHECK (length(embedding) > 0),
  byte_size INTEGER NOT NULL CHECK (byte_size = length(embedding) AND byte_size > 0),
  last_accessed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT,
  UNIQUE(profile_id, content_hash)
) STRICT;

CREATE INDEX idx_rag_embedding_cache_lru ON rag_embedding_cache(last_accessed_at ASC, cache_key ASC);

-- A document delete cascades document-scoped RAG rows.  This table is
-- intentionally not FK-bound to documents so an app-index cleanup can finish
-- after the document row and its durable rag-delete job have disappeared.
CREATE TABLE rag_deletion_tombstones (
  document_id TEXT PRIMARY KEY CHECK (length(document_id) > 0 AND length(document_id) <= 512 AND instr(document_id, char(0)) = 0),
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'succeeded', 'failed')),
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((state = 'failed') = (error_code IS NOT NULL AND error_message IS NOT NULL)),
  CHECK ((state <> 'failed') = (error_code IS NULL AND error_message IS NULL))
) STRICT;

CREATE INDEX idx_rag_deletion_tombstones_state ON rag_deletion_tombstones(state, updated_at ASC);
CREATE INDEX idx_rag_content_revisions_document_state ON rag_content_revisions(document_id, state, updated_at DESC);
CREATE INDEX idx_rag_chunks_revision_ordinal ON rag_chunks(content_revision_id, ordinal ASC);
`

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
  }
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

      this.transaction(() => {
        if (!hasLedger) this.createMigrationLedger()
        for (const migration of pending) {
          const checksum = checksumFor(migration)
          this.connection.exec(migration.sql)
          this.connection
            .prepare('INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES(?,?,?,?)')
            .run(migration.version, migration.name, checksum, new Date().toISOString())
        }
      })
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

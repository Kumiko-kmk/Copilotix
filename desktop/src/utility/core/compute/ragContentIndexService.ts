import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { PathPolicy, type PathPolicyPort } from '../persistence/pathPolicy'
import { V2Database } from '../persistence/v2Database'
import { SqliteRagRepository, type RagContentRevisionRecord } from '../persistence/sqliteRagRepository'
import { blockMappingSchema } from '@shared/ipcSchemas'
import type { BlockMapping } from '@shared/types'
import { structureAwareChunk, type StructureAwareChunkInput } from './structureAwareChunker'

export interface RagContentIndexRequest {
  documentId: string
  contentRevisionId: string
}

export interface RagContentIndexResult {
  documentId: string
  contentRevisionId: string
  chunkCount: number
  revisionState: 'ready'
}

type ArtifactRow = {
  id: string
  document_id: string
  kind: string
  relative_path: string
  content_hash: string
}

export class RagContentIndexError extends Error {
  constructor(readonly code: string, message: string, readonly retryable: boolean) {
    super(message)
    this.name = 'RagContentIndexError'
  }
}

/** Utility-owned, zero-network canonical content indexer. */
export class RagContentIndexService {
  constructor(
    private readonly database: V2Database,
    private readonly ragRepository: SqliteRagRepository,
    private readonly pathPolicy: PathPolicyPort = new PathPolicy()
  ) {}

  async index(request: RagContentIndexRequest, signal?: AbortSignal): Promise<RagContentIndexResult> {
    const revision = this.ragRepository.getContentRevision(request.contentRevisionId)
    if (!revision || revision.documentId !== request.documentId) throw contentError('RAG_CONTENT_REVISION_NOT_FOUND', 'Content revision does not belong to document', false)
    if (signal?.aborted) throw abortError()
    const oldKnowledge = this.ragRepository.getDocumentKnowledge(request.documentId)
    const preserveOldReady = oldKnowledge?.localState === 'ready' && oldKnowledge.activeContentRevisionId !== revision.contentRevisionId
    try {
      if (revision.state === 'failed' || revision.state === 'stale') {
        this.ragRepository.transitionContentRevision({ contentRevisionId: revision.contentRevisionId, state: 'building' })
      } else if (revision.state === 'ready') {
        // A deterministic retry of an already published revision is idempotent.
        return { documentId: request.documentId, contentRevisionId: revision.contentRevisionId, chunkCount: this.ragRepository.listChunks(revision.contentRevisionId).length, revisionState: 'ready' }
      }
      if (!preserveOldReady) this.ragRepository.upsertDocumentKnowledge({ documentId: request.documentId, localState: 'indexing', localProgress: 1 })
      const document = this.database.connection.prepare('SELECT id,storage_path FROM documents WHERE id=?').get(request.documentId) as { id: string; storage_path: string } | undefined
      if (!document) throw contentError('RAG_DOCUMENT_NOT_FOUND', 'Document does not exist', false)
      const artifact = this.database.connection.prepare(`
        SELECT id,document_id,kind,relative_path,content_hash FROM artifacts
        WHERE id=? AND document_id=? AND kind='parsed_markdown'
      `).get(revision.artifactId, request.documentId) as ArtifactRow | undefined
      if (!artifact) throw contentError('RAG_PARSED_ARTIFACT_NOT_REGISTERED', 'Parsed artifact is not registered', false)
      if (artifact.content_hash !== revision.contentHash) throw contentError('RAG_CONTENT_HASH_MISMATCH', 'Registered artifact hash differs from revision', false)
      const markdown = await readRegisteredText(document.storage_path, artifact, this.pathPolicy)
      if (signal?.aborted) throw abortError()
      const mappings = await this.readMappings(document.storage_path, request.documentId, revision.mappingFingerprint, this.pathPolicy)
      const input: StructureAwareChunkInput = {
        documentId: request.documentId,
        contentRevisionId: revision.contentRevisionId,
        contentHash: revision.contentHash,
        sourceText: markdown,
        mappings
      }
      let chunks: ReturnType<typeof structureAwareChunk>
      try {
        chunks = structureAwareChunk(input)
      } catch (error) {
        if (error instanceof RagContentIndexError) throw error
        const message = error instanceof Error ? error.message : 'RAG_CHUNKER_FAILED'
        throw contentError('RAG_CHUNKER_FAILED', message, false)
      }
      if (signal?.aborted) throw abortError()
      validateChunks(chunks, markdown, revision)
      this.ragRepository.replaceChunksAndActivate(revision.contentRevisionId, chunks)
      return { documentId: request.documentId, contentRevisionId: revision.contentRevisionId, chunkCount: chunks.length, revisionState: 'ready' }
    } catch (error) {
      if (isAbort(error) || signal?.aborted) {
        this.restoreAfterCancellation(revision, oldKnowledge)
        throw abortError()
      }
      this.markFailure(revision, oldKnowledge, error)
      throw error
    }
  }

  private async readMappings(root: string, documentId: string, mappingFingerprint: string, policy: PathPolicyPort): Promise<readonly BlockMapping[]> {
    const artifacts = this.database.connection.prepare(`
      SELECT id,document_id,kind,relative_path,content_hash,metadata_json FROM artifacts
      WHERE document_id=? AND kind='block_mappings' ORDER BY revision DESC,id ASC
    `).all(documentId) as Array<ArtifactRow & { metadata_json: string }>
    const artifact = artifacts.find((candidate) => candidate.content_hash === mappingFingerprint || metadataFingerprint(candidate.metadata_json) === mappingFingerprint)
    if (!artifact) return []
    const raw = await readRegisteredText(root, artifact, policy)
    let value: unknown
    try { value = JSON.parse(raw) } catch { throw contentError('RAG_BLOCK_MAPPING_INVALID_JSON', 'Block mapping JSON is invalid', false) }
    const list = Array.isArray(value) ? value : value && typeof value === 'object' && Array.isArray((value as { mappings?: unknown }).mappings) ? (value as { mappings: unknown[] }).mappings : null
    if (!list) throw contentError('RAG_BLOCK_MAPPING_INVALID', 'Block mapping root must be an array', false)
    let parsed: BlockMapping[]
    try { parsed = list.map((item) => blockMappingSchema.parse(item)) } catch { throw contentError('RAG_BLOCK_MAPPING_SCHEMA_INVALID', 'Block mapping schema is invalid', false) }
    return parsed
  }

  private markFailure(revision: RagContentRevisionRecord, oldKnowledge: ReturnType<SqliteRagRepository['getDocumentKnowledge']>, error: unknown): void {
    const message = error instanceof Error ? error.message : 'RAG_CONTENT_INDEX_FAILED'
    const typed = error instanceof RagContentIndexError ? error : undefined
    const failure = { code: typed?.code ?? (message.startsWith('RAG_') ? message : 'RAG_CONTENT_INDEX_FAILED'), message: message.slice(0, 4096), retryable: typed?.retryable ?? false }
    try {
      const current = this.ragRepository.getContentRevision(revision.contentRevisionId)
      if (current && current.state !== 'failed') this.ragRepository.transitionContentRevision({ contentRevisionId: revision.contentRevisionId, state: 'failed', error: failure })
      if (oldKnowledge?.activeContentRevisionId && oldKnowledge.activeContentRevisionId !== revision.contentRevisionId && oldKnowledge.localState === 'ready') {
        this.ragRepository.upsertDocumentKnowledge({
          documentId: revision.documentId,
          localState: 'ready', localProgress: 100,
          activeContentRevisionId: oldKnowledge.activeContentRevisionId,
          localError: null
        })
      } else {
        this.ragRepository.upsertDocumentKnowledge({ documentId: revision.documentId, localState: 'failed', localProgress: 0, localError: failure })
      }
    } catch {
      // Preserve the original indexing error.  A later retry/recovery job can
      // inspect the immutable revision and repair the lifecycle state.
    }
  }

  private restoreAfterCancellation(revision: RagContentRevisionRecord, oldKnowledge: ReturnType<SqliteRagRepository['getDocumentKnowledge']>): void {
    try {
      if (oldKnowledge?.localState === 'ready' && oldKnowledge.activeContentRevisionId && oldKnowledge.activeContentRevisionId !== revision.contentRevisionId) {
        this.ragRepository.upsertDocumentKnowledge({ documentId: revision.documentId, localState: 'ready', localProgress: 100, activeContentRevisionId: oldKnowledge.activeContentRevisionId, localError: null })
      } else {
        this.ragRepository.upsertDocumentKnowledge({ documentId: revision.documentId, localState: 'queued', localProgress: 0, activeContentRevisionId: oldKnowledge?.activeContentRevisionId ?? null, localError: null })
      }
    } catch { /* Preserve cancellation; manual retry will repair the projection. */ }
  }
}

async function readRegisteredText(root: string, artifact: ArtifactRow, policy: PathPolicyPort): Promise<string> {
  let resolved: string
  try { resolved = policy.resolveChild(root, artifact.relative_path) } catch { throw contentError('RAG_ARTIFACT_PATH_INVALID', 'Registered artifact path is outside the document root', false) }
  let stat
  try { stat = await lstat(resolved) } catch { throw contentError('RAG_ARTIFACT_IO', 'Registered artifact is temporarily unavailable', true) }
  if (!stat.isFile()) throw contentError('RAG_ARTIFACT_NOT_REGULAR_FILE', 'Registered artifact is not a regular file', false)
  let bytes
  try { bytes = await readFile(resolved) } catch { throw contentError('RAG_ARTIFACT_IO', 'Registered artifact could not be read', true) }
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== artifact.content_hash) throw contentError('RAG_ARTIFACT_HASH_MISMATCH', 'Registered artifact content hash mismatch', false)
  return bytes.toString('utf8')
}

function validateChunks(chunks: readonly ReturnType<typeof structureAwareChunk>[number][], markdown: string, revision: RagContentRevisionRecord): void {
  const ids = new Set<string>()
  for (const [index, chunk] of chunks.entries()) {
    if (chunk.ordinal !== index || chunk.contentRevisionId !== revision.contentRevisionId || ids.has(chunk.chunkId)) throw contentError('RAG_CHUNK_PROVENANCE_INVALID', 'Chunk provenance is inconsistent', false)
    ids.add(chunk.chunkId)
    if (sha256(chunk.sourceText) !== chunk.contentHash) throw contentError('RAG_CHUNK_HASH_INVALID', 'Chunk content hash is invalid', false)
    if (chunk.sourceStartOffset !== null && chunk.sourceEndOffset !== null) {
      if (chunk.sourceStartOffset < 0 || chunk.sourceEndOffset > markdown.length || chunk.sourceEndOffset < chunk.sourceStartOffset) throw contentError('RAG_CHUNK_OFFSET_INVALID', 'Chunk UTF-16 offset is invalid', false)
    }
  }
}

function metadataFingerprint(value: string): string | null {
  try {
    const parsed = JSON.parse(value) as { mappingFingerprint?: unknown }
    return typeof parsed.mappingFingerprint === 'string' ? parsed.mappingFingerprint : null
  } catch {
    return null
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function abortError(): Error { return new Error('RAG_CONTENT_INDEX_CANCELLED') }
function isAbort(error: unknown): boolean { return error instanceof Error && error.message === 'RAG_CONTENT_INDEX_CANCELLED' }
function contentError(code: string, message: string, retryable: boolean): RagContentIndexError { return new RagContentIndexError(code, message, retryable) }

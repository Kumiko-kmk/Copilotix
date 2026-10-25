import { existsSync, realpathSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { ArtifactKind, TranslationBatchBlock, TranslationBatchCommit } from '@core/types'
import type { CopilotixTask, ReplaceReaderAnnotationsRequest, TaskStatus, TranslationBlockRecord, TranslationProviderId } from '@shared/types'
import { resolveLexicalWithinRoot } from '@platform/files/runtime/pathPolicy'
import { V2Database } from '@platform/database/utility/v2Database'

/** Row shapes, limits and projections of the v2 document repository (see ./v2TaskRepositoryCompat). */

export interface CompatDocumentRow {
  id: string
  original_filename: string
  display_title: string | null
  storage_path: string
  source_checksum: string
  translation_provider: 'qwen' | 'deepseek' | 'bing' | 'transmart' | 'codex'
  created_at: string
  updated_at: string
}

export type V2JobKind = 'parse' | 'translate'
export type V2JobStatus = 'queued' | 'running' | 'retry-wait' | 'succeeded' | 'partial' | 'failed' | 'cancelled'

/** Must match the Utility chunker identity used by the 03 index runner. */
export const RAG_DEFAULT_CHUNKER_FINGERPRINT = 'structure-aware-v1:tokens-v1:utf16'

export interface ListCursor {
  createdAt: string
  id: string
}

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

export type ArtifactBundleRow = {
  id: string
  created_by_job_id: string | null
  content_hash: string
  metadata_json: string
}

export const TERMINAL: ReadonlySet<V2JobStatus> = new Set(['succeeded', 'partial', 'failed', 'cancelled'])
export const MAX_TRANSLATION_BATCH_ITEMS = 32
export const MAX_TRANSLATION_BATCH_BYTES = 768 * 1024
export const MAX_TRANSLATION_FIELD_BYTES = 262_144
export const WORKFLOW_JOB_QUERY_CHUNK = 500

export function assertTranslationBatchWithinLimits(input: TranslationBatchCommit): void {
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

export function assertTranslationField(value: unknown, label: string): void {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_TRANSLATION_FIELD_BYTES) {
    throw new Error(`${label}超过 262KiB 持久化字段限制，请保留正文文件并避免通过 RPC`)
  }
}

export function projectCompatTask(document: CompatDocumentRow, jobs: readonly CompatJobRow[]): CopilotixTask {
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
    translationProvider: document.translation_provider,
    remoteBatchId: stringOrNull(checkpoint.remoteBatchId),
    remoteDataId: stringOrNull(checkpoint.remoteDataId),
    remoteResultUrl: stringOrNull(checkpoint.remoteResultUrl),
    error: latest?.error_message ?? null,
    createdAt: document.created_at,
    updatedAt: document.updated_at
  }
}

export function latestJobOfKind(jobs: readonly CompatJobRow[], kind: V2JobKind): CompatJobRow | undefined {
  return jobs
    .filter((job) => job.kind === kind)
    .reduce<CompatJobRow | undefined>((latest, job) => {
      if (!latest || job.updated_at > latest.updated_at || (job.updated_at === latest.updated_at && job.id > latest.id)) {
        return job
      }
      return latest
    }, undefined)
}

export function selectProjectionJob(parse: CompatJobRow | undefined, translate: CompatJobRow | undefined): CompatJobRow | undefined {
  if (!parse) return translate
  if (!translate) return parse
  // Parse can finish after it enqueues translation. Its later timestamp must
  // not hide a queued/running translation or advertise an absent translation.
  if (parse.status === 'succeeded') return translate
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
  // The parse runner reports its step in `stage` (uploading → polling → downloading); `phase`
  // is only the state the document was inserted with and stays "uploading" for the whole job.
  const checkpoint = parseObject(job.checkpoint_json)
  const stage = typeof checkpoint.stage === 'string' ? checkpoint.stage : checkpoint.phase
  return stage === 'uploading' ? 'uploading' : 'parsing'
}

export function checkpointForTask(task: CopilotixTask): Record<string, unknown> {
  return {
    phase: task.status,
    remoteBatchId: task.remoteBatchId,
    remoteDataId: task.remoteDataId,
    remoteResultUrl: task.remoteResultUrl,
    // Lets the parse job replace a title taken from PDF metadata with the parsed one.
    ...(task.titleSource === 'pdf-metadata' && task.title ? { titleSource: task.titleSource, provisionalTitle: task.title } : {})
  }
}

export function toBatchBlock(block: TranslationBlockRecord): TranslationBatchBlock {
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

export function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

export function isTerminalJobStatus(status: V2JobStatus): boolean {
  return status === 'succeeded' || status === 'partial' || status === 'failed' || status === 'cancelled'
}

export function metadataFingerprint(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key]
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !value.includes('\0') ? value : null
}

export function nextLexicalGeneration(connection: V2Database['connection'], documentId: string): number {
  const row = connection.prepare('SELECT COALESCE(MAX(lexical_generation), -1) AS generation FROM rag_content_revisions WHERE document_id=?').get(documentId) as { generation: number }
  return row.generation + 1
}

export function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

export function toRelativePath(storagePath: string, path: string): string {
  const flavor = process.platform === 'win32' ? 'win32' : 'posix'
  // PathPolicy returns a real path; compare it against the same canonical root.
  // Windows short-name aliases (e.g. RUNNER~1) need not match that spelling.
  const canonicalRoot = existsSync(storagePath) ? realpathSync.native(storagePath) : storagePath
  const resolvedPath = resolveLexicalWithinRoot(canonicalRoot, path, flavor)
  const normalized = relative(canonicalRoot, resolvedPath).replaceAll('\\', '/')
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.includes('\0')) {
    throw new Error('产物路径必须是文档根目录下的相对路径')
  }
  return normalized
}

export function validateAnnotations(request: ReplaceReaderAnnotationsRequest): void {
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

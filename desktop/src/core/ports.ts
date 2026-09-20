import type {
  ArtifactKind,
  ArtifactRevision,
  Document,
  DocumentId,
  Job,
  JsonObject,
  RagChunk,
  RagChunkInput,
  RagCitationResolutionInput,
  RagVectorEntry,
  RagVectorSearchInput,
  RagVectorSearchResult,
  TranslationBlock
} from './types'
import type { CopilotixTask } from '@shared/types'
import type {
  Citation,
  LexicalSearchRequest,
  LexicalSearchResult,
  RagSearchRequest,
  RagSearchResultPage
} from '@shared/ragTypes'
import type {
  TranslationPlanFinalizeResult,
  TranslationPlanListResult,
  TranslationPlanMutationResult,
  TranslationPlanOpenResult
} from '@shared/translationPlanProtocol'

export interface DocumentRepositoryPort {
  create(document: Document): void
  get(id: DocumentId): Document | null
  list(): Document[]
  update(id: DocumentId, patch: Partial<Document>): Document
  delete(id: DocumentId): void
}

export type { JobRepositoryPort } from './jobs'

export interface ArtifactRepositoryPort {
  create(revision: ArtifactRevision): void
  get(id: string): ArtifactRevision | null
  list(documentId: DocumentId, kind?: ArtifactKind): ArtifactRevision[]
  latest(documentId: DocumentId, kind: ArtifactKind): ArtifactRevision | null
}

export interface ParserPort {
  submit(input: { document: Document; job: Job; sourcePath: string }): Promise<{ remoteBatchId: string; remoteDataId: string }>
  poll(input: { document: Document; job: Job }): Promise<{
    status: 'running' | 'succeeded' | 'failed'
    progress: number
    resultUrl?: string
    errorCode?: string
    errorMessage?: string
  }>
}

export interface TranslationProviderPort {
  readonly id: Document['translationProvider']
  isAvailable(): Promise<boolean>
  translate(markdown: string, context?: { documentId: DocumentId; blockId?: string }): Promise<string>
}

export interface CredentialVaultPort {
  get(account: string): Promise<string | null>
  has(account: string): Promise<boolean>
  set(account: string, value: string): Promise<void>
  delete(account: string): Promise<void>
}

export interface ArtifactStorePort {
  commitFile(input: {
    documentId: DocumentId
    kind: ArtifactKind
    stagedPath: string
    relativePath: string
    metadata?: JsonObject
  }): Promise<ArtifactRevision>
  writeText(input: { documentId: DocumentId; kind: ArtifactKind; relativePath: string; text: string; metadata?: JsonObject }): Promise<ArtifactRevision>
  readText(revision: ArtifactRevision): Promise<string>
}

export interface ComputePort {
  run<TInput, TOutput>(name: string, input: TInput): Promise<TOutput>
}

/** Narrow compute calls used by the legacy task service during migration. */
export interface NormalizeParserOutputResult {
  normalized: true
  displayTitle: string | null
  pageCount: number
}

export interface TaskComputePort {
  hashFile(path: string): Promise<string>
  importPdf(sourcePath: string, documentId: string): Promise<{ sha256: string; size: number }>
  normalizeParserOutput(task: CopilotixTask, extractedDir: string, jobId?: string): Promise<NormalizeParserOutputResult>
  rebuildMappings(taskId: string, outputDir: string): Promise<void>
  openTranslationPlan(taskId: string, jobId: string, signal?: AbortSignal): Promise<TranslationPlanOpenResult>
  listTranslationWork(taskId: string, jobId: string, cursor?: number, limit?: number, signal?: AbortSignal): Promise<TranslationPlanListResult>
  tryTranslationCache(
    taskId: string,
    jobId: string,
    unitId: string,
    provider: CopilotixTask['translationProvider'],
    model: string,
    signal?: AbortSignal
  ): Promise<TranslationPlanMutationResult>
  applyTranslation(
    taskId: string,
    jobId: string,
    unitId: string,
    responsePath?: string,
    provider?: CopilotixTask['translationProvider'] | null,
    model?: string | null,
    signal?: AbortSignal
  ): Promise<TranslationPlanMutationResult>
  failTranslation(taskId: string, jobId: string, unitId: string, error?: string, signal?: AbortSignal): Promise<TranslationPlanMutationResult>
  finalizeTranslation(taskId: string, jobId: string, signal?: AbortSignal): Promise<TranslationPlanFinalizeResult>
}

export interface ClockPort {
  now(): string
}

export interface IdGeneratorPort {
  next(): string
}

export interface PathPolicyPort {
  resolveChild(root: string, candidate: string): string
}

export interface TranslationBlockRepositoryPort {
  upsert(block: TranslationBlock): void
  list(jobId: string): TranslationBlock[]
}

/** Builds deterministic, provenance-bearing chunks from a published artifact. */
export interface ChunkerPort {
  chunk(input: RagChunkInput, signal?: AbortSignal): Promise<readonly RagChunk[]>
}

/** Local lexical index contract. Implementations own persistence and deletes. */
export interface LexicalIndexPort {
  rebuild(input: {
    documentId: DocumentId
    contentRevisionId: string
    chunks: readonly RagChunk[]
  }, signal?: AbortSignal): Promise<void>
  search(request: LexicalSearchRequest, signal?: AbortSignal): Promise<LexicalSearchResult>
  delete(input: { documentId: DocumentId; contentRevisionId?: string }, signal?: AbortSignal): Promise<void>
}

/** Vector index contract; vectors remain Utility-internal Float32Array values. */
export interface VectorStorePort {
  upsert(input: readonly RagVectorEntry[], signal?: AbortSignal): Promise<void>
  search(input: RagVectorSearchInput, signal?: AbortSignal): Promise<RagVectorSearchResult>
  delete(input: { vectorIndexId: string; contentRevisionId?: string }, signal?: AbortSignal): Promise<void>
}

/** Combines bounded lexical/dense candidates while preserving result provenance. */
export interface RetrieverPort {
  retrieve(request: RagSearchRequest, signal?: AbortSignal): Promise<RagSearchResultPage>
}

/** Validates candidate provenance before exposing bounded Reader citations. */
export interface CitationResolverPort {
  resolve(input: RagCitationResolutionInput, signal?: AbortSignal): Promise<readonly Citation[]>
}

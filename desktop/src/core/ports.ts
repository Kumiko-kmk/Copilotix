import type {
  ArtifactKind,
  ArtifactRevision,
  Document,
  DocumentId,
  Job,
  JobEvent,
  JobKind,
  JsonObject,
  TranslationBlock
} from './types'

export interface DocumentRepositoryPort {
  create(document: Document): void
  get(id: DocumentId): Document | null
  list(): Document[]
  update(id: DocumentId, patch: Partial<Document>): Document
  delete(id: DocumentId): void
}

export interface JobRepositoryPort {
  create(job: Job): void
  get(id: string): Job | null
  listForDocument(documentId: DocumentId): Job[]
  update(id: string, patch: Partial<Job>): Job
  claimNext(input: { now: string; leaseOwner: string; leaseExpiresAt: string; kind?: JobKind }): Job | null
  heartbeat(id: string, leaseOwner: string, leaseExpiresAt: string): Job
  saveCheckpoint(id: string, leaseOwner: string, checkpoint: JsonObject): Job
  recoverExpiredLeases(now: string): number
  appendEvent(event: JobEvent): void
}

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

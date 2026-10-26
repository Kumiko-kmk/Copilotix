import type { ArtifactKind } from './artifacts'
import type { AppSettings } from '@features/settings/contract/settingsTypes'
import type { CopilotixTask } from './documentTypes'
import type { DocumentSummary } from './documentSchemas'
import type { MutateReaderAnnotationsRequest, ReaderAnnotationSnapshot } from '@features/reader/contract/readerSchemas'

/**
 * Main-process persistence port. Production uses the asynchronous Core RPC
 * proxy; the Utility-owned SQLite repository satisfies it directly in tests.
 */
export interface TaskRepositoryCompat {
  close(): void | Promise<void>
  getSettings(outputRoot: string): AppSettings | Promise<AppSettings>
  saveSettings(settings: AppSettings): void | Promise<void>
  getMigrationMarker(id: string): boolean | Promise<boolean>
  markMigration(id: string): void | Promise<void>
  listTasks(): CopilotixTask[] | Promise<CopilotixTask[]>
  getTask(id: string): CopilotixTask | null | Promise<CopilotixTask | null>
  findByHash(hash: string): CopilotixTask | null | Promise<CopilotixTask | null>
  listDocumentSummaries(): DocumentSummary[] | Promise<DocumentSummary[]>
  getDocumentSummary(id: string): DocumentSummary | null | Promise<DocumentSummary | null>
  listDocumentAnnotations(request: { documentId: string; view: 'original' | 'translated' }): ReaderAnnotationSnapshot | Promise<ReaderAnnotationSnapshot>
  mutateDocumentAnnotations(request: MutateReaderAnnotationsRequest): ReaderAnnotationSnapshot | Promise<ReaderAnnotationSnapshot>
  insertTasks(tasks: CopilotixTask[]): void | Promise<void>
  /** Narrow metadata-only update; it must not derive or mutate job state. */
  updateDocumentMetadata(id: string, patch: DocumentMetadataPatch): void | Promise<void>
  deleteTask(id: string): void | Promise<void>
  recordArtifactRevision(taskId: string, kind: ArtifactKind, path: string, checksum: string, metadata?: Record<string, unknown>, jobId?: string): void | Promise<void>
}

export interface DocumentMetadataPatch {
  displayTitle?: string | null
}

import type { CoreUtilityOperationHandler } from '@platform/rpc/utility/coreUtilityRuntime'
import { hashFile } from '@platform/files/utility/fileHash'
import type { CopilotixTask } from '../contract/documentTypes'
import { libraryCategoriesRequestSchema } from '../contract/libraryCategories'
import { coreDocumentMetadataPayloadSchema, coreImportPdfPayloadSchema, coreListPagePayloadSchema, type LibraryOperations } from '../contract/rpc'
import { importPdf } from './importPdf'
import { LibraryCategoryService, type CategoryStore } from './libraryCategoryService'
import { byteBoundedPage } from './paging'
import type { V2TaskRepositoryCompat } from './v2TaskRepositoryCompat'

/** Library maintenance (`library:check`, `library:manage`) stays with the Utility composition, which owns the database lifecycle. */
type StatelessLibraryOperation = Exclude<keyof LibraryOperations, 'library:check' | 'library:manage'>

export interface LibraryOperationDeps {
  /** Throws while the database is not ready. */
  repository(): V2TaskRepositoryCompat
  /** Current library root; validated by the import. */
  outputRoot(): string | undefined
  /** Paper briefs that feed the categories (the insight store). */
  insightStore(): CategoryStore
}

export function createLibraryOperations(deps: LibraryOperationDeps) {
  const categories = new LibraryCategoryService(deps.insightStore, deps.repository)
  const handlers: Record<StatelessLibraryOperation, CoreUtilityOperationHandler> = {
    // Reads every paper's text on first use: compute lane, so quick data requests are not held up.
    'compute:library-categories': (request, signal) => categories.page(libraryCategoriesRequestSchema.parse(request.payload).after ?? 0, signal),
    'tasks:list': (request) => {
      const { after } = coreListPagePayloadSchema.parse(request.payload)
      return byteBoundedPage((cursor, limit) => deps.repository().listTasksPage(cursor, limit), after ?? null)
    },
    'tasks:get': (request) => deps.repository().getTask((request.payload as { id: string }).id),
    'tasks:find-by-hash': (request) => deps.repository().findByHash((request.payload as { hash: string }).hash),
    'tasks:insert-many': (request) => {
      deps.repository().insertTasks((request.payload as { tasks: CopilotixTask[] }).tasks)
      return { changed: true }
    },
    'tasks:delete': (request) => {
      deps.repository().deleteTask((request.payload as { id: string }).id)
      return { changed: true }
    },
    'documents:list': (request) => {
      const { after } = coreListPagePayloadSchema.parse(request.payload)
      return byteBoundedPage((cursor, limit) => deps.repository().listDocumentSummariesPage(cursor, limit), after ?? null)
    },
    'documents:get-summary': (request) => deps.repository().getDocumentSummary((request.payload as { id: string }).id),
    'documents:update-metadata': (request) => {
      const payload = coreDocumentMetadataPayloadSchema.parse(request.payload)
      deps.repository().updateDocumentMetadata(payload.id, payload.patch)
      return { changed: true }
    },
    'artifacts:record-revision': (request) => {
      const payload = request.payload as { taskId: string; kind: Parameters<V2TaskRepositoryCompat['recordArtifactRevision']>[1]; path: string; checksum: string; metadata?: Record<string, unknown>; jobId?: string }
      deps.repository().recordArtifactRevision(payload.taskId, payload.kind, payload.path, payload.checksum, payload.metadata ?? {}, payload.jobId)
      return { changed: true }
    },
    'compute:hash-file': async (request) => ({ sha256: await hashFile((request.payload as { path: string }).path) }),
    'compute:import-pdf': async (request, signal) => {
      const payload = coreImportPdfPayloadSchema.parse(request.payload)
      return importPdf(payload.sourcePath, payload.documentId, { outputRoot: deps.outputRoot() }, signal, payload.skipFirstPage === true)
    }
  }
  return { handlers }
}

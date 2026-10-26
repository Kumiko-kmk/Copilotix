import { eventChannel, invokeChannel, type IpcBridge } from '@platform/ipc/contract/channels'
import { noRequestSchema, voidResponseSchema } from '@platform/ipc/contract/schemas'
import { libraryCategoriesPageSchema, libraryCategoriesRequestSchema, type LibraryCategoriesPage, type LibraryCategoriesRequest } from './libraryCategories'
import { libraryRequestSchema, libraryResultSchema, type LibraryRequest, type LibraryResult } from './librarySchemas'
import type { ImportFileOptions } from './pdfImport'
import {
  deleteDocumentRequestSchema,
  documentChangeEventSchema,
  documentDetailsSchema,
  documentIdRequestSchema,
  documentSummarySchema,
  importDocumentsIpcRequestSchema,
  importDocumentsResultSchema,
  saveDocumentAsRequestSchema,
  saveDocumentAsResultSchema,
  tutorialImportRequestSchema,
  type DeleteDocumentRequest,
  type DocumentChangeEvent,
  type DocumentDetails,
  type DocumentSummary,
  type ImportDocumentsRequest,
  type ImportDocumentsResult,
  type SaveDocumentAsRequest,
  type SaveDocumentAsResult
} from './documentSchemas'

export const libraryChannels = {
  categories: invokeChannel('library:categories', libraryCategoriesRequestSchema, libraryCategoriesPageSchema),
  manage: invokeChannel('library:manage', libraryRequestSchema, libraryResultSchema),
  importDocuments: invokeChannel('documents:import', importDocumentsIpcRequestSchema, importDocumentsResultSchema),
  importTutorialPaper: invokeChannel('tutorial:import-paper', tutorialImportRequestSchema, documentSummarySchema.nullable()),
  list: invokeChannel('documents:list', noRequestSchema, documentSummarySchema.array()),
  retry: invokeChannel('documents:retry', documentIdRequestSchema, voidResponseSchema),
  delete: invokeChannel('documents:delete', deleteDocumentRequestSchema, voidResponseSchema),
  get: invokeChannel('documents:get', documentIdRequestSchema, documentDetailsSchema),
  openOutput: invokeChannel('documents:open-output', documentIdRequestSchema, voidResponseSchema),
  saveAs: invokeChannel('documents:save-as', saveDocumentAsRequestSchema, saveDocumentAsResultSchema),
  changed: eventChannel('documents:changed', documentChangeEventSchema),
  /** A notification click asks the renderer to open this document. */
  open: eventChannel('documents:open', documentIdRequestSchema)
}

export interface LibraryDesktopApi {
  /** One page of the library's content categories (see shared/libraryCategories.ts). */
  libraryCategories(request: LibraryCategoriesRequest): Promise<LibraryCategoriesPage>
  manageLibrary(request: LibraryRequest): Promise<LibraryResult>
  importDocuments(request: ImportDocumentsRequest, droppedFiles?: File[], fileOptions?: ImportFileOptions[]): Promise<ImportDocumentsResult>
  importTutorialPaper(createDuplicate?: boolean): Promise<DocumentSummary | null>
  listDocuments(): Promise<DocumentSummary[]>
  retryDocument(documentId: string): Promise<void>
  deleteDocument(request: DeleteDocumentRequest): Promise<void>
  getDocument(documentId: string): Promise<DocumentDetails>
  openDocumentOutput(documentId: string): Promise<void>
  saveDocumentAs(request: SaveDocumentAsRequest): Promise<SaveDocumentAsResult>
  onDocumentsChanged(listener: (event: DocumentChangeEvent) => void): () => void
  onOpenDocument(listener: (documentId: string) => void): () => void
}

/** `pathForFile` resolves a dropped File to its local path (Electron `webUtils` in preload). */
export function createLibraryApi(ipc: IpcBridge, pathForFile: (file: File) => string): LibraryDesktopApi {
  return {
    libraryCategories: request => ipc.invoke(libraryChannels.categories, request),
    manageLibrary: request => ipc.invoke(libraryChannels.manage, request),
    importDocuments: (request, droppedFiles, fileOptions) => {
      const dropped = droppedFiles
        ?.map((file, index) => ({ path: pathForFile(file), options: fileOptions?.[index] ?? {} }))
        .filter(({ path }) => path.length > 0)
      // Main ignores non-PDF paths anyway; dropping them here keeps a mixed
      // folder drop inside the request limit. Without dropped files Main opens
      // the native picker instead. Per-file options stay paired with their path.
      const pdfs = dropped?.filter(({ path }) => /\.pdf$/iu.test(path))
      const internalRequest = dropped && dropped.length > 0
        ? {
            options: request,
            paths: pdfs!.map(({ path }) => path),
            ...(fileOptions ? { files: pdfs!.map(({ options }) => options) } : {})
          }
        : { options: request }
      return ipc.invoke(libraryChannels.importDocuments, internalRequest)
    },
    importTutorialPaper: (createDuplicate = false) => ipc.invoke(libraryChannels.importTutorialPaper, { createDuplicate }),
    listDocuments: () => ipc.invoke(libraryChannels.list, undefined),
    retryDocument: documentId => ipc.invoke(libraryChannels.retry, documentId),
    deleteDocument: request => ipc.invoke(libraryChannels.delete, request),
    getDocument: documentId => ipc.invoke(libraryChannels.get, documentId),
    openDocumentOutput: documentId => ipc.invoke(libraryChannels.openOutput, documentId),
    saveDocumentAs: request => ipc.invoke(libraryChannels.saveAs, request),
    onDocumentsChanged: listener => ipc.subscribe(libraryChannels.changed, listener),
    onOpenDocument: listener => ipc.subscribe(libraryChannels.open, listener)
  }
}

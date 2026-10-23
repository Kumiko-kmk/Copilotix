import { markdownEditRequestSchema, markdownEditResultSchema } from '@shared/markdownEdits'
import { codexProbeSchema, codexStatusSchema } from '@shared/codex'
import { paperInsightRequestSchema, paperInsightStateSchema, paperInsightCancelSchema, paperInsightChangedSchema } from '@shared/paperInsight'
import { figureInsightRequestSchema, figureInsightStateSchema, figureInsightCancelSchema, figureInsightChangedSchema } from '@shared/figureInsight'
import { libraryCategoriesRequestSchema, libraryCategoriesPageSchema } from '@shared/libraryCategories'
import { paperChatAskRequestSchema, paperChatAskResultSchema, paperChatCancelRequestSchema, paperChatCancelResultSchema, paperChatStatusRequestSchema, paperChatStatusSchema } from '@shared/paperChatSchemas'
import { paperChatDeleteTurnSchema, paperChatDeletedSchema, paperChatDocumentRequestSchema, paperChatLoadRequestSchema, paperChatPageSchema, paperChatSaveSessionSchema, paperChatSessionSchema, paperChatSavedSchema, paperChatClearedSchema } from '@shared/paperChatStorageSchemas'
import { zoteroExportRequestSchema, zoteroExportResultSchema, zoteroCatalogRequestSchema, zoteroCatalogSchema, zoteroImportRequestSchema, zoteroImportResultSchema, zoteroItemsPageSchema, zoteroItemsRequestSchema } from '@shared/zotero'
import { readerNoteDeleteSchema, readerNoteUpsertSchema, readerNotesRequestSchema, readerNotesSchema } from '@shared/readerNotes'
import { ragStreamEventSchema } from '@shared/ragSchemas'
import { libraryRequestSchema, libraryResultSchema } from '@shared/librarySchemas'
import type { ImportFileOptions } from '@shared/pdfImport'
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { z } from 'zod'
import {
  cacheDocumentFigureRequestSchema,
  cacheDocumentFigureResultSchema,
  repairTextLayerResultSchema,
  appSettingsSchema,
  credentialValidationRequestSchema,
  credentialValidationResultSchema,
  outputDirectorySchema,
  deleteDocumentRequestSchema,
  documentChangeEventSchema,
  documentDetailsSchema,
  documentIdRequestSchema,
  documentSummarySchema,
  tutorialImportRequestSchema,
  type DeleteDocumentRequest,
  type DocumentChangeEvent,
  type ImportDocumentsRequest,
  type ListReaderAnnotationsRequest,
  type MutateReaderAnnotationsRequest,
  type SaveDocumentAsRequest,
  importDocumentsIpcRequestSchema,
  importDocumentsResultSchema,
  listReaderAnnotationsRequestSchema,
  mutateReaderAnnotationsRequestSchema,
  noRequestSchema,
  readerAnnotationSnapshotSchema,
  saveDocumentAsRequestSchema,
  saveDocumentAsResultSchema,
  settingsSaveResultSchema,
  settingsUpdateSchema,
  storageInfoSchema,
  usageAnalyticsSchema,
  voidResponseSchema,
  windowActionSchema,
  windowStateSchema
} from '@shared/ipcSchemas'
import { decodeIpcEvent, decodeIpcResponse } from './ipcClient'
import type {
  CopilotixDesktopApi,
  CredentialName,
  SettingsUpdate,
  WindowAction
} from '@shared/types'

async function invokeValidated<Request, Response>(
  channel: string,
  requestSchema: z.ZodType<Request>,
  responseSchema: z.ZodType<Response>,
  request: Request
): Promise<Response> {
  const validatedRequest = requestSchema.parse(request)
  const response = await ipcRenderer.invoke(channel, validatedRequest)
  return decodeIpcResponse(response, responseSchema)
}

const api: CopilotixDesktopApi = {
  codex: {
    cached: settings => invokeValidated('codex:cached', codexProbeSchema.shape.settings, codexStatusSchema.nullable(), settings),
    inspect: request => invokeValidated('codex:inspect', codexProbeSchema, codexStatusSchema, request),
    selectExecutable: () => invokeValidated('codex:select-executable', noRequestSchema, outputDirectorySchema, undefined)
  },
  figureInsight: {
    get: request => invokeValidated('figureInsight:get', figureInsightRequestSchema, figureInsightStateSchema, request),
    generate: request => invokeValidated('figureInsight:generate', figureInsightRequestSchema, voidResponseSchema, request),
    cancel: request => invokeValidated('figureInsight:cancel', figureInsightRequestSchema, figureInsightCancelSchema, request),
    onChanged: listener => {
      const handler = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
        const parsed = decodeIpcEvent(payload, figureInsightChangedSchema)
        if (parsed) listener(parsed)
      }
      ipcRenderer.on('figureInsight:changed', handler)
      return () => ipcRenderer.removeListener('figureInsight:changed', handler)
    }
  },
  libraryCategories: (request) => invokeValidated('library:categories', libraryCategoriesRequestSchema, libraryCategoriesPageSchema, request),
  paperInsight: {
    get: (request) => invokeValidated('paperInsight:get', paperInsightRequestSchema, paperInsightStateSchema, request),
    generate: (request) => invokeValidated('paperInsight:generate', paperInsightRequestSchema, voidResponseSchema, request),
    cancel: (request) => invokeValidated('paperInsight:cancel', paperInsightRequestSchema, paperInsightCancelSchema, request),
    onChanged: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
        const parsed = decodeIpcEvent(payload, paperInsightChangedSchema)
        if (parsed) listener(parsed)
      }
      ipcRenderer.on('paperInsight:changed', handler)
      return () => ipcRenderer.removeListener('paperInsight:changed', handler)
    }
  },
  readerNotes: {
    list: (request) => invokeValidated('reader-notes:list', readerNotesRequestSchema, readerNotesSchema, request),
    upsert: (request) => invokeValidated('reader-notes:upsert', readerNoteUpsertSchema, readerNotesSchema, request),
    delete: (request) => invokeValidated('reader-notes:delete', readerNoteDeleteSchema, readerNotesSchema, request)
  },
  zotero: {
    catalog: (request) => invokeValidated('zotero:catalog', zoteroCatalogRequestSchema, zoteroCatalogSchema, request),
    items: (request) => invokeValidated('zotero:items', zoteroItemsRequestSchema, zoteroItemsPageSchema, request),
    importItems: (request) => invokeValidated('zotero:import', zoteroImportRequestSchema, zoteroImportResultSchema, request),
    exportDocuments: (request) => invokeValidated('zotero:export', zoteroExportRequestSchema, zoteroExportResultSchema, request)
  },
  paperChat: {
    load: (request) => invokeValidated('paper-chat:load', paperChatLoadRequestSchema, paperChatPageSchema, request),
    session: (request) => invokeValidated('paper-chat:session', paperChatDocumentRequestSchema, paperChatSessionSchema, request),
    saveSession: (request) => invokeValidated('paper-chat:save-session', paperChatSaveSessionSchema, paperChatSavedSchema, request),
    deleteTurn: request => invokeValidated('paper-chat:delete-turn', paperChatDeleteTurnSchema, paperChatDeletedSchema, request),
    clear: (request) => invokeValidated('paper-chat:clear', paperChatDocumentRequestSchema, paperChatClearedSchema, request),
    ask: (request) => invokeValidated('paper-chat:ask', paperChatAskRequestSchema, paperChatAskResultSchema, request),
    cancel: (request) => invokeValidated('paper-chat:cancel', paperChatCancelRequestSchema, paperChatCancelResultSchema, request),
    ensureIndex: (request) => invokeValidated('paper-chat:ensure-index', paperChatStatusRequestSchema, paperChatStatusSchema, request),
    onEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
        const event = decodeIpcEvent(payload, ragStreamEventSchema)
        if (event) listener(event)
      }
      ipcRenderer.on('paper-chat:event', handler)
      return () => ipcRenderer.removeListener('paper-chat:event', handler)
    }
  },
  manageLibrary: (request) => invokeValidated('library:manage', libraryRequestSchema, libraryResultSchema, request),
  getSettings: () => invokeValidated('settings:get', noRequestSchema, appSettingsSchema, undefined),
  saveSettings: (update: SettingsUpdate) => invokeValidated('settings:save', settingsUpdateSchema, settingsSaveResultSchema, update),
  validateCredential: (name: CredentialName, value?: string) =>
    invokeValidated('settings:validate-credential', credentialValidationRequestSchema, credentialValidationResultSchema, { name, value }),
  chooseOutputDirectory: () =>
    invokeValidated('dialog:output-directory', noRequestSchema, outputDirectorySchema, undefined),
  getStorageInfo: () => invokeValidated('storage:info', noRequestSchema, storageInfoSchema, undefined),
  getUsageAnalytics: () => invokeValidated('analytics:usage', noRequestSchema, usageAnalyticsSchema, undefined),
  openStorageLocation: () => invokeValidated('storage:open-location', noRequestSchema, voidResponseSchema, undefined),
  importDocuments: (request: ImportDocumentsRequest, droppedFiles?: File[], fileOptions?: ImportFileOptions[]) => {
    const dropped = droppedFiles
      ?.map((file, index) => ({ path: webUtils.getPathForFile(file), options: fileOptions?.[index] ?? {} }))
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
    return invokeValidated(
      'documents:import',
      importDocumentsIpcRequestSchema,
      importDocumentsResultSchema,
      internalRequest
    )
  },
  importTutorialPaper: (createDuplicate = false) => invokeValidated('tutorial:import-paper', tutorialImportRequestSchema, documentSummarySchema.nullable(), { createDuplicate }),
  listDocuments: () => invokeValidated('documents:list', noRequestSchema, documentSummarySchema.array(), undefined),
  retryDocument: (documentId: string) => invokeValidated('documents:retry', documentIdRequestSchema, voidResponseSchema, documentId),
  deleteDocument: (request: DeleteDocumentRequest) =>
    invokeValidated('documents:delete', deleteDocumentRequestSchema, voidResponseSchema, request),
  getDocument: (documentId: string) => invokeValidated('documents:get', documentIdRequestSchema, documentDetailsSchema, documentId),
  editDocumentMarkdown: (request) => invokeValidated('documents:edit-markdown', markdownEditRequestSchema, markdownEditResultSchema, request),
  retranslateEditedDocument: (documentId: string) => invokeValidated('documents:retranslate-edited', documentIdRequestSchema, voidResponseSchema, documentId),
  repairDocumentTextLayer: (documentId: string) => invokeValidated('documents:repair-text-layer', documentIdRequestSchema, repairTextLayerResultSchema, documentId),
  cacheDocumentFigure: (request) => invokeValidated('documents:cache-figure', cacheDocumentFigureRequestSchema, cacheDocumentFigureResultSchema, request),
  openDocumentOutput: (documentId: string) =>
    invokeValidated('documents:open-output', documentIdRequestSchema, voidResponseSchema, documentId),
  saveDocumentAs: (request: SaveDocumentAsRequest) =>
    invokeValidated('documents:save-as', saveDocumentAsRequestSchema, saveDocumentAsResultSchema, request),
  listReaderAnnotations: (request: ListReaderAnnotationsRequest) =>
    invokeValidated('reader-annotations:list', listReaderAnnotationsRequestSchema, readerAnnotationSnapshotSchema, request),
  mutateReaderAnnotations: (request: MutateReaderAnnotationsRequest) =>
    invokeValidated('reader-annotations:mutate', mutateReaderAnnotationsRequestSchema, readerAnnotationSnapshotSchema, request),
  performWindowAction: (action: WindowAction) => invokeValidated('window:action', windowActionSchema, windowStateSchema, action),
  getWindowState: () => invokeValidated('window:state', noRequestSchema, windowStateSchema, undefined),
  onDocumentsChanged: (listener: (event: DocumentChangeEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
      const change = decodeIpcEvent(payload, documentChangeEventSchema)
      if (change) listener(change)
    }
    ipcRenderer.on('documents:changed', handler)
    return () => ipcRenderer.removeListener('documents:changed', handler)
  },
  onOpenDocument: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
      const documentId = decodeIpcEvent(payload, documentIdRequestSchema)
      if (documentId) listener(documentId)
    }
    ipcRenderer.on('documents:open', handler)
    return () => ipcRenderer.removeListener('documents:open', handler)
  },
  onWindowStateChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
      const state = decodeIpcEvent(payload, windowStateSchema)
      if (state) listener(state)
    }
    ipcRenderer.on('window:state-changed', handler)
    return () => ipcRenderer.removeListener('window:state-changed', handler)
  }
}

contextBridge.exposeInMainWorld('copilotix', api)

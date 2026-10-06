import { paperChatAskRequestSchema, paperChatAskResultSchema, paperChatCancelRequestSchema, paperChatCancelResultSchema, paperChatStatusRequestSchema, paperChatStatusSchema } from '@shared/paperChatSchemas'
import { ragStreamEventSchema } from '@shared/ragSchemas'
import { libraryRequestSchema, libraryResultSchema } from '@shared/librarySchemas'
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { z } from 'zod'
import {
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
  paperChat: {
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
  importDocuments: (request: ImportDocumentsRequest, droppedFiles?: File[]) => {
    const dropped = droppedFiles
      ?.map((file) => webUtils.getPathForFile(file))
      .filter((path) => path.length > 0)
    // Main ignores non-PDF paths anyway; dropping them here keeps a mixed
    // folder drop inside the request limit. Without dropped files Main opens
    // the native picker instead.
    const internalRequest = dropped && dropped.length > 0
      ? { options: request, paths: dropped.filter((path) => /\.pdf$/iu.test(path)) }
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

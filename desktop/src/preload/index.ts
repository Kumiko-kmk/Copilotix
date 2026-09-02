import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { z } from 'zod'
import {
  appSettingsSchema,
  outputDirectorySchema,
  deleteDocumentRequestSchema,
  documentChangeEventSchema,
  documentDetailsSchema,
  documentIdRequestSchema,
  documentSummarySchema,
  type DeleteDocumentRequest,
  type DocumentChangeEvent,
  type ImportDocumentsRequest,
  type ListReaderAnnotationsRequest,
  type MutateReaderAnnotationsRequest,
  type SaveDocumentAsRequest,
  healthResultSchema,
  importDocumentsIpcRequestSchema,
  listReaderAnnotationsRequestSchema,
  mutateReaderAnnotationsRequestSchema,
  noRequestSchema,
  parserTokenSchema,
  providerIdRequestSchema,
  readerAnnotationSnapshotSchema,
  saveDocumentAsRequestSchema,
  saveDocumentAsResultSchema,
  settingsUpdateSchema,
  voidResponseSchema,
  windowActionSchema,
  windowStateSchema
} from '@shared/ipcSchemas'
import { decodeIpcEvent, decodeIpcResponse } from './ipcClient'
import type {
  MinerUDesktopApi,
  SettingsUpdate,
  TranslationProviderId,
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

const api: MinerUDesktopApi = {
  getSettings: () => invokeValidated('settings:get', noRequestSchema, appSettingsSchema, undefined),
  saveSettings: (update: SettingsUpdate) => invokeValidated('settings:save', settingsUpdateSchema, appSettingsSchema, update),
  testParserConnection: (parserToken) =>
    invokeValidated('settings:test-parser', parserTokenSchema, healthResultSchema, parserToken),
  testTranslationProvider: (provider: TranslationProviderId) =>
    invokeValidated('settings:test-translation', providerIdRequestSchema, healthResultSchema, provider),
  chooseOutputDirectory: () =>
    invokeValidated('dialog:output-directory', noRequestSchema, outputDirectorySchema, undefined),
  importDocuments: (request: ImportDocumentsRequest, droppedFiles?: File[]) => {
    const paths = droppedFiles
      ?.map((file) => webUtils.getPathForFile(file))
      .filter((path) => path.length > 0)
    const internalRequest = paths && paths.length > 0
      ? { options: request, paths }
      : { options: request }
    return invokeValidated(
      'documents:import',
      importDocumentsIpcRequestSchema,
      documentSummarySchema.array(),
      internalRequest
    )
  },
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

contextBridge.exposeInMainWorld('mineru', api)

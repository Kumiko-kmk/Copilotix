import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { z } from 'zod'
import {
  appSettingsSchema,
  createTasksRequestSchema,
  deleteTaskRequestSchema,
  documentPayloadSchema,
  healthResultSchema,
  inspectPdfsRequestSchema,
  minerUTaskSchema,
  noRequestSchema,
  outputDirectorySchema,
  parserTokenSchema,
  providerIdRequestSchema,
  readerAnnotationSchema,
  replaceReaderAnnotationsRequestSchema,
  saveAsRequestSchema,
  selectedPdfSchema,
  settingsUpdateSchema,
  taskIdRequestSchema,
  voidResponseSchema,
  windowActionSchema,
  windowStateSchema
} from '@shared/ipcSchemas'
import { decodeIpcEvent, decodeIpcResponse } from './ipcClient'
import type {
  CreateTasksRequest,
  DeleteTaskRequest,
  MinerUDesktopApi,
  ReplaceReaderAnnotationsRequest,
  SaveAsRequest,
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
  choosePdfs: () => invokeValidated('dialog:pdfs', noRequestSchema, selectedPdfSchema.array(), undefined),
  inspectDroppedPdfs: (files: File[]) => {
    const paths = files.map((file) => webUtils.getPathForFile(file))
    return invokeValidated('dialog:inspect-pdfs', inspectPdfsRequestSchema, selectedPdfSchema.array(), paths)
  },
  createTasks: (request: CreateTasksRequest) =>
    invokeValidated('tasks:create', createTasksRequestSchema, minerUTaskSchema.array(), request),
  listTasks: () => invokeValidated('tasks:list', noRequestSchema, minerUTaskSchema.array(), undefined),
  deleteTask: (request: DeleteTaskRequest) =>
    invokeValidated('tasks:delete', deleteTaskRequestSchema, voidResponseSchema, request),
  retryTask: (taskId: string) => invokeValidated('tasks:retry', taskIdRequestSchema, voidResponseSchema, taskId),
  getDocument: (taskId: string) => invokeValidated('document:get', taskIdRequestSchema, documentPayloadSchema, taskId),
  getReaderAnnotations: (taskId: string) =>
    invokeValidated('reader-annotations:get', taskIdRequestSchema, readerAnnotationSchema.array(), taskId),
  replaceReaderAnnotations: (request: ReplaceReaderAnnotationsRequest) =>
    invokeValidated('reader-annotations:replace', replaceReaderAnnotationsRequestSchema, readerAnnotationSchema.array(), request),
  openOutputDirectory: (taskId: string) =>
    invokeValidated('document:open-output', taskIdRequestSchema, voidResponseSchema, taskId),
  saveAs: (request: SaveAsRequest) =>
    invokeValidated('document:save-as', saveAsRequestSchema, outputDirectorySchema, request),
  performWindowAction: (action: WindowAction) =>
    invokeValidated('window:action', windowActionSchema, windowStateSchema, action),
  getWindowState: () => invokeValidated('window:state', noRequestSchema, windowStateSchema, undefined),
  onTasksChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
      const tasks = decodeIpcEvent(payload, minerUTaskSchema.array())
      if (tasks) listener(tasks)
    }
    ipcRenderer.on('tasks:changed', handler)
    return () => ipcRenderer.removeListener('tasks:changed', handler)
  },
  onOpenTask: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
      const taskId = decodeIpcEvent(payload, taskIdRequestSchema)
      if (taskId) listener(taskId)
    }
    ipcRenderer.on('tasks:open', handler)
    return () => ipcRenderer.removeListener('tasks:open', handler)
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

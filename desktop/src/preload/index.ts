import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AppSettings,
  CreateTasksRequest,
  DeleteTaskRequest,
  DocumentPayload,
  HealthResult,
  MinerUDesktopApi,
  MinerUTask,
  SaveAsRequest,
  SelectedPdf,
  SettingsUpdate,
  TranslationProviderId
} from '@shared/types'

const api: MinerUDesktopApi = {
  getSettings: () => ipcRenderer.invoke('settings:get') as Promise<AppSettings>,
  saveSettings: (update: SettingsUpdate) => ipcRenderer.invoke('settings:save', update) as Promise<AppSettings>,
  testParserConnection: (parserToken) => ipcRenderer.invoke('settings:test-parser', parserToken) as Promise<HealthResult>,
  testTranslationProvider: (provider: TranslationProviderId) =>
    ipcRenderer.invoke('settings:test-translation', provider) as Promise<HealthResult>,
  chooseOutputDirectory: () => ipcRenderer.invoke('dialog:output-directory') as Promise<string | null>,
  choosePdfs: () => ipcRenderer.invoke('dialog:pdfs') as Promise<SelectedPdf[]>,
  inspectDroppedPdfs: (files: File[]) =>
    ipcRenderer.invoke('dialog:inspect-pdfs', files.map((file) => webUtils.getPathForFile(file))) as Promise<SelectedPdf[]>,
  createTasks: (request: CreateTasksRequest) => ipcRenderer.invoke('tasks:create', request) as Promise<MinerUTask[]>,
  listTasks: () => ipcRenderer.invoke('tasks:list') as Promise<MinerUTask[]>,
  deleteTask: (request: DeleteTaskRequest) => ipcRenderer.invoke('tasks:delete', request) as Promise<void>,
  retryTask: (taskId: string) => ipcRenderer.invoke('tasks:retry', taskId) as Promise<void>,
  getDocument: (taskId: string) => ipcRenderer.invoke('document:get', taskId) as Promise<DocumentPayload>,
  openOutputDirectory: (taskId: string) => ipcRenderer.invoke('document:open-output', taskId) as Promise<void>,
  saveAs: (request: SaveAsRequest) => ipcRenderer.invoke('document:save-as', request) as Promise<string | null>,
  onTasksChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, tasks: MinerUTask[]): void => listener(tasks)
    ipcRenderer.on('tasks:changed', handler)
    return () => ipcRenderer.removeListener('tasks:changed', handler)
  },
  onOpenTask: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, taskId: string): void => listener(taskId)
    ipcRenderer.on('tasks:open', handler)
    return () => ipcRenderer.removeListener('tasks:open', handler)
  }
}

contextBridge.exposeInMainWorld('mineru', api)

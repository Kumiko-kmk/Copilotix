import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { createIpcBridge } from '@platform/ipc/preload/bridge'
import { createDesktopApi } from '../contract/desktopApi'

// Every channel, schema and API shape comes from the module contracts; preload only binds Electron.
contextBridge.exposeInMainWorld('copilotix', createDesktopApi(createIpcBridge(ipcRenderer), (file) => webUtils.getPathForFile(file)))

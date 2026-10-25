import { invokeChannel, type IpcBridge } from '@platform/ipc/contract/channels'
import {
  zoteroCatalogRequestSchema,
  zoteroCatalogSchema,
  zoteroExportRequestSchema,
  zoteroExportResultSchema,
  zoteroImportRequestSchema,
  zoteroImportResultSchema,
  zoteroItemsPageSchema,
  zoteroItemsRequestSchema,
  type ZoteroDesktopApi
} from '@shared/zotero'

export const zoteroChannels = {
  catalog: invokeChannel('zotero:catalog', zoteroCatalogRequestSchema, zoteroCatalogSchema),
  items: invokeChannel('zotero:items', zoteroItemsRequestSchema, zoteroItemsPageSchema),
  importItems: invokeChannel('zotero:import', zoteroImportRequestSchema, zoteroImportResultSchema),
  exportDocuments: invokeChannel('zotero:export', zoteroExportRequestSchema, zoteroExportResultSchema)
}

export function createZoteroApi(ipc: IpcBridge): ZoteroDesktopApi {
  return {
    catalog: request => ipc.invoke(zoteroChannels.catalog, request),
    items: request => ipc.invoke(zoteroChannels.items, request),
    importItems: request => ipc.invoke(zoteroChannels.importItems, request),
    exportDocuments: request => ipc.invoke(zoteroChannels.exportDocuments, request)
  }
}

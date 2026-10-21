import {
  zoteroCatalogRequestSchema,
  zoteroCatalogSchema,
  zoteroImportRequestSchema,
  zoteroImportResultSchema,
  zoteroItemsPageSchema,
  zoteroItemsRequestSchema
} from '@shared/zotero'
import { registerValidatedHandler, type IpcValidationOptions } from '../ipc'
import type { TaskRepositoryCompat } from '../taskRepositoryCompat'
import type { TaskService } from '../taskService'
import { readLocalApiFileUrl, readLocalApiSnapshot, readSqliteSnapshot } from './zoteroCatalog'
import { ZoteroImportService } from './zoteroImportService'
import { locateZoteroProfile } from './zoteroProfile'

export function registerZoteroHandlers(service: ZoteroImportService, options: IpcValidationOptions): void {
  registerValidatedHandler('zotero:catalog', zoteroCatalogRequestSchema, zoteroCatalogSchema, (_event, request) => service.catalog(request.refresh), options)
  registerValidatedHandler('zotero:items', zoteroItemsRequestSchema, zoteroItemsPageSchema, (_event, request) => service.items(request), options)
  registerValidatedHandler('zotero:import', zoteroImportRequestSchema, zoteroImportResultSchema, (_event, request) => service.importItems(request), options)
}

/** Wires the import service to the app's task service and repository. */
export function createZoteroImportService(deps: {
  tasks: Pick<TaskService, 'importPaths' | 'list'>
  repository: Pick<TaskRepositoryCompat, 'findByHash'>
  tempRoot: string
}): ZoteroImportService {
  return new ZoteroImportService({
    locateProfile: () => locateZoteroProfile(),
    readLocalApi: (profile) => readLocalApiSnapshot(profile),
    readSqlite: (profile, reason) => readSqliteSnapshot(profile, deps.tempRoot, reason),
    fileUrl: (profile, attachmentKey) => readLocalApiFileUrl(profile, attachmentKey),
    listDocuments: () => deps.tasks.list(),
    findByHash: async (sha256) => await deps.repository.findByHash(sha256),
    // Zotero imports always deduplicate by PDF hash; titles come from parsing like other imports.
    importPaths: (paths) => deps.tasks.importPaths(paths, { createDuplicates: false, useOriginalFilename: false })
  })
}

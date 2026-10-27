import type { IpcRegistrar } from '@platform/ipc/main/ipc'
import { zoteroChannels } from '../contract/ipc'
import type { TaskRepositoryCompat } from '@features/library/contract/taskRepository'
import type { TaskService } from '@features/library/main'
import { readLocalApiFileUrl, readLocalApiSnapshot, readSqliteSnapshot } from './zoteroCatalog'
import { ZoteroImportService } from './zoteroImportService'
import { createZoteroConnector } from './zoteroConnector'
import { ZoteroExportService } from './zoteroExportService'
import { extractPaperProfile } from '@features/library/core'
import type { PaperInsightState } from '@features/insight/contract/paperInsight'
import type { ReaderNotes } from '@features/reader/contract/readerNotes'
import { locateZoteroProfile } from './zoteroProfile'

export function registerZoteroHandlers(service: ZoteroImportService, ipc: IpcRegistrar): void {
  ipc.handle(zoteroChannels.catalog, (_event, request) => service.catalog(request.refresh))
  ipc.handle(zoteroChannels.items, (_event, request) => service.items(request))
  ipc.handle(zoteroChannels.importItems, (_event, request) => service.importItems(request))
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

/** Gathers each paper's titles, AI summary, highlights and notes from the existing stores. */
export function createZoteroExportService(deps: {
  repository: Pick<TaskRepositoryCompat, 'getTask' | 'listDocumentAnnotations'>
  tasks: Pick<TaskService, 'getDocument'>
  insight(documentId: string): Promise<PaperInsightState>
  notes(documentId: string): Promise<ReaderNotes>
}): ZoteroExportService {
  return new ZoteroExportService({
    connector: async () => createZoteroConnector((await locateZoteroProfile()).port),
    getDocument: async (documentId) => {
      const task = await deps.repository.getTask(documentId)
      return task ? { id: task.id, outputDir: task.outputDir, sourcePath: task.sourcePath, displayName: task.title ?? task.name } : null
    },
    gatherContent: async (documentId) => {
      const [document, insight, original, translated, notes] = await Promise.all([
        deps.tasks.getDocument(documentId),
        deps.insight(documentId).catch(() => null),
        deps.repository.listDocumentAnnotations({ documentId, view: 'original' }),
        deps.repository.listDocumentAnnotations({ documentId, view: 'translated' }),
        deps.notes(documentId).catch(() => ({ notes: [] }))
      ])
      const profile = extractPaperProfile(document.markdown ?? '', document.translatedMarkdown ?? '')
      const summary = insight?.status === 'ready' ? ('brief' in insight ? insight.brief.tldr : insight.insight.summary) : null
      return {
        title: profile.title ?? '',
        translatedTitle: profile.translatedTitle,
        abstract: profile.abstract,
        summary,
        highlights: [...original.annotations, ...translated.annotations].map((annotation) => ({ view: annotation.view, quote: annotation.quote })),
        notes: notes.notes.map((note) => ({ quote: note.anchors.map((anchor) => anchor.quote).join(' … '), body: note.body }))
      }
    }
  })
}

export function registerZoteroExportHandler(service: ZoteroExportService, ipc: IpcRegistrar): void {
  ipc.handle(zoteroChannels.exportDocuments, (_event, request) => service.exportDocuments(request))
}

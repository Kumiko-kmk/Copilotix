import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ZOTERO_ITEMS_PAGE_SIZE,
  type ZoteroCatalog,
  type ZoteroImportRequest,
  type ZoteroImportResult,
  type ZoteroItemsPage,
  type ZoteroItemsRequest
} from '../contract/zotero'
import type { ImportPathsResult } from '@features/library/main'
import type { ZoteroEntry, ZoteroSnapshot } from './zoteroCatalog'
import { ZoteroUnavailableError } from './zoteroCatalog'
import { addZoteroLink, readZoteroLinks } from './zoteroLinks'
import type { ZoteroProfile } from './zoteroProfile'

interface LibraryDocument {
  id: string
  outputDir: string
}

export interface ZoteroImportDependencies {
  locateProfile(): Promise<ZoteroProfile>
  readLocalApi(profile: ZoteroProfile): Promise<ZoteroSnapshot>
  readSqlite(profile: ZoteroProfile, fallbackReason: string): Promise<ZoteroSnapshot>
  /** Asks the running Zotero for a file URL when the snapshot could not resolve a path. */
  fileUrl?(profile: ZoteroProfile, attachmentKey: string): Promise<string | null>
  listDocuments(): Promise<LibraryDocument[]>
  findByHash(sha256: string): Promise<LibraryDocument | null>
  importPaths(paths: readonly string[]): Promise<Pick<ImportPathsResult, 'failed'> & { created: Array<LibraryDocument & { sourceHash: string }> }>
  hashFile?(path: string): Promise<string>
  now?(): Date
}

interface ActiveSnapshot {
  id: string
  profile: ZoteroProfile
  snapshot: ZoteroSnapshot
  /** Zotero item key → Copilotix document already linked to it. */
  imported: Map<string, string>
}

/**
 * Zotero → Copilotix import. The catalog is read once per dialog (local API first, zotero.sqlite
 * copy otherwise); the renderer pages through it and sends back item keys only. PDFs go through
 * the normal import path, so the PDF hash decides duplicates; each Zotero item is then linked to
 * the paper it became (new or existing) for the later write-back to Zotero.
 */
export class ZoteroImportService {
  private active: ActiveSnapshot | null = null

  constructor(private readonly deps: ZoteroImportDependencies) {}

  async catalog(refresh = false): Promise<ZoteroCatalog> {
    if (!this.active || refresh) this.active = await this.load()
    const { id, snapshot } = this.active
    const counts = new Map<string, number>()
    let unfiled = 0
    for (const entry of snapshot.entries) {
      if (entry.collectionKeys.length === 0) unfiled += 1
      for (const key of entry.collectionKeys) counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    const known = new Set(snapshot.collections.map((collection) => collection.key))
    return {
      snapshotId: id,
      source: snapshot.source,
      fallbackReason: snapshot.fallbackReason,
      libraryID: snapshot.libraryID,
      collections: snapshot.collections.map((collection) => ({
        key: collection.key,
        name: collection.name,
        // A parent in the trash leaves its child at the top level.
        parentKey: collection.parentKey && known.has(collection.parentKey) ? collection.parentKey : null,
        itemCount: counts.get(collection.key) ?? 0
      })),
      totalItems: snapshot.entries.length,
      unfiledItems: unfiled
    }
  }

  items(request: ZoteroItemsRequest): ZoteroItemsPage {
    const active = this.require(request.snapshotId)
    const query = request.query?.trim().toLocaleLowerCase()
    const matches = active.snapshot.entries.filter((entry) => {
      if (request.collectionKey === 'unfiled' ? entry.collectionKeys.length > 0 : request.collectionKey && !entry.collectionKeys.includes(request.collectionKey)) return false
      return !query || `${entry.title} ${entry.creators} ${entry.year ?? ''}`.toLocaleLowerCase().includes(query)
    })
    const start = request.after ?? 0
    const page = matches.slice(start, start + ZOTERO_ITEMS_PAGE_SIZE)
    return {
      items: page.map((entry) => ({
        itemKey: entry.itemKey,
        title: entry.title.slice(0, 2_000),
        creators: entry.creators.slice(0, 500),
        year: entry.year,
        itemType: entry.itemType.slice(0, 64),
        attachmentKey: entry.pdfs[0]?.attachmentKey ?? null,
        pdfCount: entry.pdfs.length,
        importedDocumentId: active.imported.get(entry.itemKey) ?? null
      })),
      next: start + page.length < matches.length ? start + page.length : null,
      total: matches.length
    }
  }

  async importItems(request: ZoteroImportRequest): Promise<ZoteroImportResult> {
    const active = this.require(request.snapshotId)
    const byKey = new Map(active.snapshot.entries.map((entry) => [entry.itemKey, entry] as const))
    const failed: ZoteroImportResult['failed'] = []
    const planned: Array<{ entry: ZoteroEntry; attachmentKey: string; path: string; sha256: string }> = []
    for (const itemKey of new Set(request.itemKeys)) {
      const entry = byKey.get(itemKey)
      if (!entry) {
        failed.push({ name: itemKey, message: 'Zotero 条目已不在当前列表中，请刷新' })
        continue
      }
      try {
        const { attachmentKey, path } = await this.resolvePdf(active, entry)
        planned.push({ entry, attachmentKey, path, sha256: await (this.deps.hashFile ?? hashFile)(path) })
      } catch (error) {
        failed.push({ name: entry.title, message: error instanceof Error ? error.message : String(error) })
      }
    }

    const imported = planned.length > 0 ? await this.deps.importPaths([...new Set(planned.map((plan) => plan.path))]) : { created: [], failed: [] }
    const createdByHash = new Map(imported.created.map((document) => [document.sourceHash, document] as const))
    const failedNames = new Map(imported.failed.map((failure) => [failure.name, failure.message] as const))
    let linked = 0
    const linkedAt = (this.deps.now?.() ?? new Date()).toISOString()
    for (const plan of planned) {
      const created = createdByHash.get(plan.sha256)
      const document = created ?? await this.deps.findByHash(plan.sha256)
      if (!document) {
        failed.push({ name: plan.entry.title, message: failedNames.get(basename(plan.path)) ?? 'PDF 未能导入' })
        continue
      }
      if (!created) linked += 1
      await addZoteroLink(document.outputDir, {
        libraryID: active.snapshot.libraryID,
        groupID: null,
        itemKey: plan.entry.itemKey,
        attachmentKey: plan.attachmentKey,
        linkedAt
      })
      active.imported.set(plan.entry.itemKey, document.id)
    }
    return { created: imported.created.length, linked, failed }
  }

  private async load(): Promise<ActiveSnapshot> {
    const profile = await this.deps.locateProfile()
    let snapshot: ZoteroSnapshot
    try {
      snapshot = await this.deps.readLocalApi(profile)
    } catch (error) {
      if (!(error instanceof ZoteroUnavailableError)) throw error
      snapshot = await this.deps.readSqlite(profile, error.message)
    }
    const imported = new Map<string, string>()
    for (const document of await this.deps.listDocuments()) {
      for (const link of await readZoteroLinks(document.outputDir)) {
        if (link.groupID === null) imported.set(link.itemKey, document.id)
      }
    }
    return { id: randomUUID(), profile, snapshot, imported }
  }

  private require(snapshotId: string): ActiveSnapshot {
    if (!this.active || this.active.id !== snapshotId) throw new Error('Zotero 列表已过期，请重新打开')
    return this.active
  }

  private async resolvePdf(active: ActiveSnapshot, entry: ZoteroEntry): Promise<{ attachmentKey: string; path: string }> {
    let lastError = '没有可用的 PDF 附件'
    for (const pdf of entry.pdfs) {
      let path = pdf.path
      if (!path && this.deps.fileUrl) {
        const url = await this.deps.fileUrl(active.profile, pdf.attachmentKey).catch(() => null)
        path = url?.startsWith('file:') ? fileURLToPath(url) : null
      }
      if (!path) {
        lastError = '无法定位 PDF 附件文件'
        continue
      }
      if (extname(path).toLowerCase() !== '.pdf') {
        lastError = `附件不是 .pdf 文件：${basename(path)}`
        continue
      }
      try {
        if ((await stat(path)).isFile()) return { attachmentKey: pdf.attachmentKey, path }
      } catch {
        // Try the next PDF attachment.
      }
      lastError = `PDF 附件文件不存在：${basename(path)}`
    }
    throw new Error(lastError)
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

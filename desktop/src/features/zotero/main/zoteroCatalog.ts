import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, rm, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ZoteroSource } from '../contract/zotero'
import type { ZoteroProfile } from './zoteroProfile'

export interface ZoteroPdf {
  attachmentKey: string
  /** Local file; null when only Zotero itself can resolve it (local API `file/view/url`). */
  path: string | null
}

export interface ZoteroEntry {
  itemKey: string
  title: string
  creators: string
  year: string | null
  itemType: string
  collectionKeys: string[]
  pdfs: ZoteroPdf[]
}

/** A read-only picture of "My Library", limited to entries that carry at least one PDF. */
export interface ZoteroSnapshot {
  source: ZoteroSource
  fallbackReason: string | null
  libraryID: number
  collections: Array<{ key: string; name: string; parentKey: string | null }>
  entries: ZoteroEntry[]
}

/** Zotero's own user library ID; the local API only serves this library as users/0. */
const USER_LIBRARY_ID = 1
const LOCAL_API_TIMEOUT_MS = 4_000

export class ZoteroUnavailableError extends Error {
  readonly code = 'ZOTERO_UNAVAILABLE'
}

// ---------------------------------------------------------------------------
// Local API (Zotero 7+: Settings → Advanced → "Allow other applications on this computer to communicate with Zotero")

interface ApiCollection { key: string; data: { name?: string; parentCollection?: string | false } }
interface ApiCreator { firstName?: string; lastName?: string; name?: string }
interface ApiItem {
  key: string
  data: {
    itemType?: string
    title?: string
    parentItem?: string
    collections?: string[]
    creators?: ApiCreator[]
    date?: string
    contentType?: string
    linkMode?: string
    filename?: string
    path?: string
  }
  meta?: { parsedDate?: string }
}

export async function readLocalApiSnapshot(profile: ZoteroProfile, fetchImpl: typeof fetch = fetch): Promise<ZoteroSnapshot> {
  const base = `http://127.0.0.1:${profile.port}/api/users/0`
  const get = async <T>(path: string): Promise<T> => {
    let response: Response
    try {
      response = await fetchImpl(`${base}${path}`, {
        headers: { 'Zotero-API-Version': '3' },
        signal: AbortSignal.timeout(LOCAL_API_TIMEOUT_MS)
      })
    } catch {
      throw new ZoteroUnavailableError('Zotero 未运行')
    }
    if (response.status === 403) throw new ZoteroUnavailableError('Zotero 未开启“允许其他应用程序与 Zotero 通信”')
    if (!response.ok) throw new ZoteroUnavailableError(`Zotero 本机接口返回 ${response.status}`)
    return await response.json() as T
  }
  const [collections, items] = await Promise.all([
    get<ApiCollection[]>('/collections'),
    get<ApiItem[]>('/items')
  ])
  const pdfsByParent = new Map<string, ZoteroPdf[]>()
  const entries: ZoteroEntry[] = []
  for (const item of items) {
    const data = item.data
    if (data.itemType !== 'attachment' || data.contentType !== 'application/pdf') continue
    const path = apiAttachmentPath(item, profile)
    if (path === undefined) continue
    const pdf = { attachmentKey: item.key, path }
    if (data.parentItem) pdfsByParent.set(data.parentItem, [...pdfsByParent.get(data.parentItem) ?? [], pdf])
    else entries.push(entryFromApi(item, [pdf]))
  }
  for (const item of items) {
    const pdfs = pdfsByParent.get(item.key)
    if (pdfs && item.data.itemType !== 'attachment' && item.data.itemType !== 'note' && item.data.itemType !== 'annotation') {
      entries.push(entryFromApi(item, pdfs))
    }
  }
  return {
    source: 'local-api',
    fallbackReason: null,
    libraryID: USER_LIBRARY_ID,
    collections: collections.map((collection) => ({
      key: collection.key,
      name: collection.data.name ?? '',
      parentKey: typeof collection.data.parentCollection === 'string' ? collection.data.parentCollection : null
    })),
    entries
  }
}

/** Zotero's own answer for where an attachment file is (`file:///…`). */
export async function readLocalApiFileUrl(profile: ZoteroProfile, attachmentKey: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const response = await fetchImpl(`http://127.0.0.1:${profile.port}/api/users/0/items/${encodeURIComponent(attachmentKey)}/file/view/url`, {
    headers: { 'Zotero-API-Version': '3' },
    signal: AbortSignal.timeout(LOCAL_API_TIMEOUT_MS)
  })
  return response.ok ? (await response.text()).trim() || null : null
}

/** undefined = not a stored file (linked URL); null = file Zotero must resolve. */
function apiAttachmentPath(item: ApiItem, profile: ZoteroProfile): string | null | undefined {
  const { linkMode, filename, path } = item.data
  if (linkMode === 'imported_file' || linkMode === 'imported_url') {
    return filename ? join(profile.dataDir, 'storage', item.key, filename) : null
  }
  if (linkMode === 'linked_file') return path ? resolveLinkedPath(path, profile) : null
  return undefined
}

function entryFromApi(item: ApiItem, pdfs: ZoteroPdf[]): ZoteroEntry {
  return {
    itemKey: item.key,
    title: item.data.title?.trim() || item.data.filename || item.key,
    creators: summarizeCreators((item.data.creators ?? []).map((creator) => creator.lastName || creator.name || creator.firstName || '')),
    year: yearOf(item.meta?.parsedDate ?? item.data.date ?? ''),
    itemType: item.data.itemType ?? '',
    collectionKeys: item.data.collections ?? [],
    pdfs
  }
}

// ---------------------------------------------------------------------------
// zotero.sqlite fallback: a private copy is read so Zotero's own file is never opened or locked.

export async function readSqliteSnapshot(profile: ZoteroProfile, tempRoot: string, fallbackReason: string | null): Promise<ZoteroSnapshot> {
  const source = join(profile.dataDir, 'zotero.sqlite')
  try {
    await stat(source)
  } catch {
    throw new ZoteroUnavailableError(`未找到 Zotero 数据库：${source}`)
  }
  const workDir = join(tempRoot, `zotero-snapshot-${randomUUID()}`)
  await mkdir(workDir, { recursive: true })
  try {
    const copy = join(workDir, 'zotero.sqlite')
    await copyFile(source, copy)
    // Pending writes of a WAL-mode database live beside it; copy them too when present.
    await copyFile(`${source}-wal`, `${copy}-wal`).catch(() => undefined)
    const database = new DatabaseSync(copy, { readOnly: true })
    try {
      return { ...querySnapshot(database, profile), fallbackReason }
    } finally {
      database.close()
    }
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

type Row = Record<string, unknown>

function querySnapshot(database: DatabaseSync, profile: ZoteroProfile): Omit<ZoteroSnapshot, 'fallbackReason'> {
  const all = (sql: string, ...params: Array<string | number>): Row[] => database.prepare(sql).all(...params) as Row[]
  const library = all("SELECT libraryID FROM libraries WHERE type = 'user' ORDER BY libraryID LIMIT 1")[0]
  if (!library) throw new ZoteroUnavailableError('Zotero 数据库中没有“我的文库”')
  const libraryID = Number(library.libraryID)

  const collections = all(`
    SELECT c.key AS key, c.collectionName AS name, p.key AS parentKey
    FROM collections c LEFT JOIN collections p ON p.collectionID = c.parentCollectionID
    WHERE c.libraryID = ? AND c.collectionID NOT IN (SELECT collectionID FROM deletedCollections)
    ORDER BY c.collectionName`, libraryID).map((row) => ({
    key: String(row.key),
    name: String(row.name ?? ''),
    parentKey: row.parentKey == null ? null : String(row.parentKey)
  }))

  const titleField = `(SELECT fieldID FROM fieldsCombined WHERE fieldName = 'title')`
  const titles = new Map(all(`
    SELECT d.itemID AS itemID, v.value AS value FROM itemData d JOIN itemDataValues v ON v.valueID = d.valueID
    WHERE d.fieldID = ${titleField}
       OR d.fieldID IN (SELECT fieldID FROM baseFieldMappingsCombined WHERE baseFieldID = ${titleField})`)
    .map((row) => [Number(row.itemID), String(row.value ?? '')] as const))
  const dates = new Map(all(`
    SELECT d.itemID AS itemID, v.value AS value FROM itemData d JOIN itemDataValues v ON v.valueID = d.valueID
    WHERE d.fieldID = (SELECT fieldID FROM fieldsCombined WHERE fieldName = 'date')`)
    .map((row) => [Number(row.itemID), String(row.value ?? '')] as const))
  const creators = new Map<number, string[]>()
  for (const row of all(`
    SELECT ic.itemID AS itemID, c.lastName AS lastName, c.firstName AS firstName
    FROM itemCreators ic JOIN creators c ON c.creatorID = ic.creatorID ORDER BY ic.itemID, ic.orderIndex`)) {
    const id = Number(row.itemID)
    creators.set(id, [...creators.get(id) ?? [], String(row.lastName || row.firstName || '')])
  }
  const memberships = new Map<number, string[]>()
  for (const row of all(`
    SELECT ci.itemID AS itemID, c.key AS key FROM collectionItems ci JOIN collections c ON c.collectionID = ci.collectionID
    WHERE c.collectionID NOT IN (SELECT collectionID FROM deletedCollections)`)) {
    const id = Number(row.itemID)
    memberships.set(id, [...memberships.get(id) ?? [], String(row.key)])
  }

  const pdfsByParent = new Map<number, ZoteroPdf[]>()
  const standalone: Array<{ itemID: number; pdf: ZoteroPdf }> = []
  for (const row of all(`
    SELECT a.itemID AS itemID, a.parentItemID AS parentItemID, ai.key AS key, a.linkMode AS linkMode, a.path AS path
    FROM itemAttachments a JOIN items ai ON ai.itemID = a.itemID
    WHERE ai.libraryID = ? AND a.contentType = 'application/pdf' AND a.linkMode IN (0, 1, 2)
      AND a.itemID NOT IN (SELECT itemID FROM deletedItems)
    ORDER BY a.parentItemID, ai.dateAdded, ai.itemID`, libraryID)) {
    const pdf = { attachmentKey: String(row.key), path: sqliteAttachmentPath(String(row.key), Number(row.linkMode), row.path == null ? null : String(row.path), profile) }
    if (row.parentItemID == null) standalone.push({ itemID: Number(row.itemID), pdf })
    else {
      const parent = Number(row.parentItemID)
      pdfsByParent.set(parent, [...pdfsByParent.get(parent) ?? [], pdf])
    }
  }

  const entries: ZoteroEntry[] = []
  const entryOf = (itemID: number, itemKey: string, itemType: string, pdfs: ZoteroPdf[]): ZoteroEntry => ({
    itemKey,
    title: titles.get(itemID)?.trim() || itemKey,
    creators: summarizeCreators(creators.get(itemID) ?? []),
    year: yearOf(dates.get(itemID) ?? ''),
    itemType,
    collectionKeys: memberships.get(itemID) ?? [],
    pdfs
  })
  for (const row of all(`
    SELECT i.itemID AS itemID, i.key AS key, t.typeName AS typeName
    FROM items i JOIN itemTypesCombined t ON t.itemTypeID = i.itemTypeID
    WHERE i.libraryID = ? AND t.typeName NOT IN ('attachment', 'note', 'annotation')
      AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
    ORDER BY i.dateAdded DESC, i.itemID DESC`, libraryID)) {
    const pdfs = pdfsByParent.get(Number(row.itemID))
    if (pdfs) entries.push(entryOf(Number(row.itemID), String(row.key), String(row.typeName), pdfs))
  }
  const keys = new Map(all('SELECT itemID, key FROM items WHERE libraryID = ?', libraryID).map((row) => [Number(row.itemID), String(row.key)] as const))
  for (const { itemID, pdf } of standalone) entries.push(entryOf(itemID, keys.get(itemID) ?? pdf.attachmentKey, 'attachment', [pdf]))
  return { source: 'sqlite', libraryID, collections, entries }
}

/** linkMode 0 imported_file, 1 imported_url (both "storage:<name>"), 2 linked_file. */
function sqliteAttachmentPath(key: string, linkMode: number, path: string | null, profile: ZoteroProfile): string | null {
  if (!path) return null
  if (linkMode === 0 || linkMode === 1) {
    return path.startsWith('storage:') ? join(profile.dataDir, 'storage', key, path.slice('storage:'.length)) : null
  }
  return resolveLinkedPath(path, profile)
}

function resolveLinkedPath(path: string, profile: ZoteroProfile): string | null {
  if (path.startsWith('attachments:')) {
    return profile.baseAttachmentPath ? join(profile.baseAttachmentPath, path.slice('attachments:'.length)) : null
  }
  return isAbsolute(path) ? path : null
}

export function summarizeCreators(names: readonly string[]): string {
  const clean = names.map((name) => name.trim()).filter(Boolean)
  if (clean.length === 0) return ''
  return clean.length > 3 ? `${clean.slice(0, 3).join(', ')} 等` : clean.join(', ')
}

/** Zotero dates are stored as "YYYY-MM-DD original text"; 0000 means no year. */
export function yearOf(date: string): string | null {
  const match = /^(\d{4})/u.exec(date.trim())
  return match && match[1] !== '0000' ? match[1]! : null
}

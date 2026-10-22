import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { readLocalApiSnapshot, readSqliteSnapshot, ZoteroUnavailableError, type ZoteroSnapshot } from '../src/main/zotero/zoteroCatalog'
import { ZoteroImportService } from '../src/main/zotero/zoteroImportService'
import { addZoteroLink, readZoteroExports, readZoteroLinks, zoteroLinkPath } from '../src/main/zotero/zoteroLinks'
import { createZoteroConnector, type ZoteroConnector, type ZoteroConnectorItem } from '../src/main/zotero/zoteroConnector'
import { ZoteroExportService, type ZoteroExportContent } from '../src/main/zotero/zoteroExportService'
import { locateZoteroProfile, type ZoteroProfile } from '../src/main/zotero/zoteroProfile'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'copilotix-zotero-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

/** The slice of Zotero's schema the bridge reads, with one trashed item and one trashed collection. */
function writeZoteroDatabase(path: string): void {
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE libraries (libraryID INTEGER PRIMARY KEY, type TEXT);
    CREATE TABLE collections (collectionID INTEGER PRIMARY KEY, collectionName TEXT, parentCollectionID INT, libraryID INT, key TEXT);
    CREATE TABLE deletedCollections (collectionID INTEGER PRIMARY KEY);
    CREATE TABLE collectionItems (collectionID INT, itemID INT);
    CREATE TABLE itemTypesCombined (itemTypeID INT, typeName TEXT);
    CREATE TABLE fieldsCombined (fieldID INT, fieldName TEXT);
    CREATE TABLE baseFieldMappingsCombined (itemTypeID INT, baseFieldID INT, fieldID INT);
    CREATE TABLE items (itemID INTEGER PRIMARY KEY, itemTypeID INT, dateAdded TEXT, libraryID INT, key TEXT);
    CREATE TABLE deletedItems (itemID INTEGER PRIMARY KEY);
    CREATE TABLE itemData (itemID INT, fieldID INT, valueID INT);
    CREATE TABLE itemDataValues (valueID INTEGER PRIMARY KEY, value);
    CREATE TABLE creators (creatorID INTEGER PRIMARY KEY, firstName TEXT, lastName TEXT);
    CREATE TABLE itemCreators (itemID INT, creatorID INT, orderIndex INT);
    CREATE TABLE itemAttachments (itemID INTEGER PRIMARY KEY, parentItemID INT, linkMode INT, contentType TEXT, path TEXT);
    INSERT INTO libraries VALUES (1, 'user'), (2, 'group');
    INSERT INTO collections VALUES (1, '力学论文', NULL, 1, 'AJ59LQ7F'), (2, '子分类', 1, 1, 'BBBBBBBB'), (3, '回收站分类', NULL, 1, 'CCCCCCCC');
    INSERT INTO deletedCollections VALUES (3);
    INSERT INTO itemTypesCombined VALUES (1, 'journalArticle'), (2, 'attachment'), (3, 'note'), (4, 'case');
    INSERT INTO fieldsCombined VALUES (1, 'title'), (2, 'date'), (3, 'caseName');
    INSERT INTO baseFieldMappingsCombined VALUES (4, 1, 3);
    INSERT INTO items VALUES
      (10, 1, '2026-01-01', 1, 'ITEMAAAA'), (11, 2, '2026-01-01', 1, 'PDFAAAAA'),
      (12, 1, '2026-01-02', 1, 'ITEMBBBB'), (13, 2, '2026-01-02', 1, 'PDFBBBBB'),
      (14, 1, '2026-01-03', 1, 'ITEMCCCC'), (15, 2, '2026-01-03', 1, 'PDFCCCCC'),
      (16, 2, '2026-01-04', 1, 'LQNEPDFX'),
      (17, 4, '2026-01-05', 1, 'CASEDDDD'), (18, 2, '2026-01-05', 1, 'PDFDDDDD'),
      (19, 1, '2026-01-06', 1, 'NOPDFEEE');
    INSERT INTO deletedItems VALUES (14);
    INSERT INTO itemDataValues VALUES (1, 'Concrete spall'), (2, '2014-06-00 06/2014'), (3, 'Linked paper'), (4, 'Trashed'), (5, 'Loose.pdf'), (6, 'Roe v. Wade');
    INSERT INTO itemData VALUES (10, 1, 1), (10, 2, 2), (12, 1, 3), (14, 1, 4), (16, 1, 5), (17, 3, 6);
    INSERT INTO creators VALUES (1, 'X', 'Li'), (2, 'Y', 'Hao');
    INSERT INTO itemCreators VALUES (10, 2, 1), (10, 1, 0);
    INSERT INTO collectionItems VALUES (1, 10), (2, 12), (3, 12);
    INSERT INTO itemAttachments VALUES
      (11, 10, 0, 'application/pdf', 'storage:spall.pdf'),
      (13, 12, 2, 'application/pdf', 'attachments:papers/linked.pdf'),
      (15, 14, 1, 'application/pdf', 'storage:trashed.pdf'),
      (16, NULL, 0, 'application/pdf', 'storage:Loose.pdf'),
      (18, 17, 3, 'text/html', NULL);
  `)
  db.close()
}

describe('Zotero catalog', () => {
  it('reads a private copy of zotero.sqlite without trashed items or collections', async () => {
    const dataDir = join(root, 'Zotero')
    await mkdir(dataDir)
    writeZoteroDatabase(join(dataDir, 'zotero.sqlite'))
    const profile: ZoteroProfile = { dataDir, baseAttachmentPath: join(root, 'Base'), port: 23119 }
    const snapshot = await readSqliteSnapshot(profile, join(root, 'tmp'), 'Zotero 未运行')

    expect(snapshot).toMatchObject({ source: 'sqlite', fallbackReason: 'Zotero 未运行', libraryID: 1 })
    expect(snapshot.collections).toEqual([
      { key: 'AJ59LQ7F', name: '力学论文', parentKey: null },
      { key: 'BBBBBBBB', name: '子分类', parentKey: 'AJ59LQ7F' }
    ])
    expect(snapshot.entries.map((entry) => entry.itemKey)).toEqual(['ITEMBBBB', 'ITEMAAAA', 'LQNEPDFX'])
    const [linked, spall, loose] = snapshot.entries
    expect(spall).toMatchObject({ title: 'Concrete spall', creators: 'Li, Hao', year: '2014', collectionKeys: ['AJ59LQ7F'] })
    expect(spall!.pdfs).toEqual([{ attachmentKey: 'PDFAAAAA', path: join(dataDir, 'storage', 'PDFAAAAA', 'spall.pdf') }])
    expect(linked!.collectionKeys).toEqual(['BBBBBBBB'])
    expect(linked!.pdfs[0]!.path).toBe(join(root, 'Base', 'papers', 'linked.pdf'))
    expect(loose).toMatchObject({ title: 'Loose.pdf', itemType: 'attachment' })
    // The snapshot copy is removed again; Zotero's own file is untouched.
    expect(await readFile(join(dataDir, 'zotero.sqlite'))).toBeTruthy()
  })

  it('uses the local API when Zotero answers and reports why it cannot', async () => {
    const profile: ZoteroProfile = { dataDir: join(root, 'Zotero'), baseAttachmentPath: null, port: 23119 }
    const responses: Record<string, unknown> = {
      '/collections': [{ key: 'AJ59LQ7F', data: { name: '力学论文', parentCollection: false } }],
      '/items': [
        { key: 'ITEMAAAA', data: { itemType: 'journalArticle', title: 'A', collections: ['AJ59LQ7F'], creators: [{ lastName: 'Li' }], date: 'June 2014' }, meta: { parsedDate: '2014-06' } },
        { key: 'PDFAAAAA', data: { itemType: 'attachment', parentItem: 'ITEMAAAA', contentType: 'application/pdf', linkMode: 'imported_file', filename: 'a.pdf' } },
        { key: 'URLBBBBB', data: { itemType: 'attachment', parentItem: 'ITEMAAAA', contentType: 'application/pdf', linkMode: 'linked_url' } },
        { key: 'ITEMBBBB', data: { itemType: 'book', title: 'No PDF' } }
      ]
    }
    const fetchOk = (async (url: string) => new Response(JSON.stringify(responses[new URL(url).pathname.replace('/api/users/0', '')]), { status: 200 })) as typeof fetch
    const snapshot = await readLocalApiSnapshot(profile, fetchOk)
    expect(snapshot.source).toBe('local-api')
    expect(snapshot.entries).toEqual([{
      itemKey: 'ITEMAAAA', title: 'A', creators: 'Li', year: '2014', itemType: 'journalArticle', collectionKeys: ['AJ59LQ7F'],
      pdfs: [{ attachmentKey: 'PDFAAAAA', path: join(root, 'Zotero', 'storage', 'PDFAAAAA', 'a.pdf') }]
    }])

    const forbidden = (async () => new Response('Local API is not enabled', { status: 403 })) as typeof fetch
    await expect(readLocalApiSnapshot(profile, forbidden)).rejects.toThrow(ZoteroUnavailableError)
    const refused = (async () => { throw new TypeError('fetch failed') }) as typeof fetch
    await expect(readLocalApiSnapshot(profile, refused)).rejects.toThrow('Zotero 未运行')
  })

  it('finds the data folder from the default profile prefs', async () => {
    const profiles = join(root, 'AppData', 'Zotero', 'Zotero')
    await mkdir(join(profiles, 'Profiles', 'abc.default'), { recursive: true })
    await writeFile(join(profiles, 'profiles.ini'), '[Profile0]\nName=default\nIsRelative=1\nPath=Profiles/abc.default\nDefault=1\n')
    await writeFile(join(profiles, 'Profiles', 'abc.default', 'prefs.js'), [
      'user_pref("extensions.zotero.dataDir", "D:\\\\Library\\\\Zotero");',
      'user_pref("extensions.zotero.useDataDir", true);',
      'user_pref("extensions.zotero.httpServer.port", 23120);'
    ].join('\n'))
    expect(await locateZoteroProfile({ appData: join(root, 'AppData'), home: root })).toEqual({ dataDir: 'D:\\Library\\Zotero', baseAttachmentPath: null, port: 23120 })
    expect((await locateZoteroProfile({ appData: join(root, 'missing'), home: root })).dataDir).toBe(join(root, 'Zotero'))
  })
})

describe('Zotero import', () => {
  async function setup() {
    const pdfA = join(root, 'a.pdf')
    const pdfB = join(root, 'b.pdf')
    await writeFile(pdfA, 'A')
    await writeFile(pdfB, 'B')
    const existing = { id: '11111111-1111-4111-8111-111111111111', outputDir: join(root, 'docs', 'existing') }
    const fresh = { id: '22222222-2222-4222-8222-222222222222', outputDir: join(root, 'docs', 'fresh') }
    const documents = [existing]
    const snapshot: ZoteroSnapshot = {
      source: 'sqlite', fallbackReason: 'Zotero 未运行', libraryID: 1,
      collections: [{ key: 'AJ59LQ7F', name: '力学论文', parentKey: null }],
      entries: [
        { itemKey: 'ITEMAAAA', title: 'Already here', creators: '', year: null, itemType: 'journalArticle', collectionKeys: ['AJ59LQ7F'], pdfs: [{ attachmentKey: 'PDFAAAAA', path: pdfA }] },
        { itemKey: 'ITEMBBBB', title: 'New paper', creators: '', year: null, itemType: 'journalArticle', collectionKeys: [], pdfs: [{ attachmentKey: 'PDFBBBBB', path: pdfB }] },
        { itemKey: 'ITEMCCCC', title: 'Missing file', creators: '', year: null, itemType: 'journalArticle', collectionKeys: [], pdfs: [{ attachmentKey: 'PDFCCCCC', path: join(root, 'gone.pdf') }] }
      ]
    }
    const importedPaths: string[][] = []
    const service = new ZoteroImportService({
      locateProfile: async () => ({ dataDir: root, baseAttachmentPath: null, port: 23119 }),
      readLocalApi: async () => { throw new ZoteroUnavailableError('Zotero 未运行') },
      readSqlite: async () => snapshot,
      listDocuments: async () => documents,
      hashFile: async (path) => (path === pdfA ? 'hash-a' : 'hash-b'),
      findByHash: async (hash) => (hash === 'hash-a' ? existing : null),
      importPaths: async (paths) => {
        importedPaths.push([...paths])
        // The normal import path skips the PDF that is already in the library.
        return { created: paths.includes(pdfB) ? [{ ...fresh, sourceHash: 'hash-b' }] : [], failed: [] }
      },
      now: () => new Date('2026-10-21T00:00:00.000Z')
    })
    return { service, existing, fresh, importedPaths, pdfA, pdfB }
  }

  it('imports through the normal path, links new and existing papers, and reports missing files', async () => {
    const { service, existing, fresh, importedPaths, pdfA, pdfB } = await setup()
    const catalog = await service.catalog()
    expect(catalog).toMatchObject({ source: 'sqlite', totalItems: 3, unfiledItems: 2, collections: [{ key: 'AJ59LQ7F', itemCount: 1 }] })

    const result = await service.importItems({ snapshotId: catalog.snapshotId, itemKeys: ['ITEMAAAA', 'ITEMBBBB', 'ITEMCCCC'] })
    expect(result).toEqual({ created: 1, linked: 1, failed: [{ name: 'Missing file', message: 'PDF 附件文件不存在：gone.pdf' }] })
    expect(importedPaths).toEqual([[pdfA, pdfB]])
    expect(await readZoteroLinks(existing.outputDir)).toEqual([{ libraryID: 1, groupID: null, itemKey: 'ITEMAAAA', attachmentKey: 'PDFAAAAA', linkedAt: '2026-10-21T00:00:00.000Z' }])
    expect((await readZoteroLinks(fresh.outputDir))[0]?.itemKey).toBe('ITEMBBBB')

    const page = service.items({ snapshotId: catalog.snapshotId, collectionKey: null })
    expect(page.items.map((item) => [item.itemKey, item.importedDocumentId])).toEqual([
      ['ITEMAAAA', existing.id], ['ITEMBBBB', fresh.id], ['ITEMCCCC', null]
    ])
    expect(service.items({ snapshotId: catalog.snapshotId, collectionKey: 'unfiled', query: 'new' }).items.map((item) => item.itemKey)).toEqual(['ITEMBBBB'])
  })

  it('marks previously linked papers when the catalog is reopened and rejects stale snapshots', async () => {
    const { service, existing } = await setup()
    await mkdir(join(existing.outputDir, 'zotero'), { recursive: true })
    await writeFile(zoteroLinkPath(existing.outputDir), JSON.stringify({ version: 1, links: [{ libraryID: 1, groupID: null, itemKey: 'ITEMAAAA', attachmentKey: 'PDFAAAAA', linkedAt: '2026-10-01T00:00:00.000Z' }] }))
    const first = await service.catalog()
    expect(service.items({ snapshotId: first.snapshotId, collectionKey: 'AJ59LQ7F' }).items[0]?.importedDocumentId).toBe(existing.id)
    const second = await service.catalog(true)
    expect(() => service.items({ snapshotId: first.snapshotId, collectionKey: null })).toThrow('已过期')
    expect(second.snapshotId).not.toBe(first.snapshotId)
  })
})

describe('Zotero export', () => {
  const content: ZoteroExportContent = {
    title: 'Attention <Is> All',
    translatedTitle: '注意力就是全部',
    abstract: 'Abstract text',
    summary: 'AI & summary',
    highlights: [{ view: 'original', quote: 'key sentence' }, { view: 'translated', quote: '关键句' }],
    notes: [{ quote: 'quoted', body: 'line 1\nline 2' }]
  }
  function fakeConnector(options: { attachmentFails?: boolean } = {}) {
    const calls: Array<{ items?: ZoteroConnectorItem[]; attachment?: { parentItemID: string; bytes: number } }> = []
    const connector: ZoteroConnector = {
      ping: async () => undefined,
      saveItems: async (items) => { calls.push({ items }); return 'session-1' },
      saveAttachment: async (_session, parentItemID, _title, pdf) => {
        if (options.attachmentFails) throw new Error('Zotero 当前文库不接受附件文件')
        calls.push({ attachment: { parentItemID, bytes: pdf.length } })
      }
    }
    return { connector, calls }
  }
  async function serviceFor(connector: ZoteroConnector, outputDir: string) {
    await mkdir(outputDir, { recursive: true })
    return new ZoteroExportService({
      connector: async () => connector,
      getDocument: async (id) => ({ id, outputDir, sourcePath: join(outputDir, 'original.pdf'), displayName: 'paper.pdf' }),
      gatherContent: async () => content,
      readPdf: async () => Buffer.from('%PDF-1.4'),
      now: () => new Date('2026-10-22T00:00:00.000Z')
    })
  }
  const id = '33333333-3333-4333-8333-333333333333'

  it('sends a linked paper as a standalone note pointing at its Zotero item, and asks before repeating', async () => {
    const outputDir = join(root, 'linked')
    const { connector, calls } = fakeConnector()
    const service = await serviceFor(connector, outputDir)
    await addZoteroLink(outputDir, { libraryID: 1, groupID: null, itemKey: 'ITEMAAAA', attachmentKey: 'PDFAAAAA', linkedAt: '2026-10-21T00:00:00.000Z' })

    expect(await service.exportDocuments({ documentIds: [id] })).toEqual({ notes: 1, items: 0, skipped: [], failed: [] })
    const note = calls[0]!.items![0]!
    expect(note.itemType).toBe('note')
    expect(note.note).toContain('zotero://select/library/items/ITEMAAAA')
    expect(note.note).toContain('Copilotix：Attention &lt;Is&gt; All')
    expect(note.note).toContain('AI &amp; summary')
    expect(note.note).toContain('［译文］关键句')
    expect(note.note).toContain('line 1<br>line 2')
    expect(await readZoteroExports(outputDir)).toEqual([{ kind: 'note', exportedAt: '2026-10-22T00:00:00.000Z' }])

    expect(await service.exportDocuments({ documentIds: [id] })).toEqual({ notes: 0, items: 0, skipped: [id], failed: [] })
    expect(calls).toHaveLength(1)
    expect((await service.exportDocuments({ documentIds: [id], repeat: true })).notes).toBe(1)
  })

  it('sends other papers as a new item with the PDF and records a half-finished export', async () => {
    const outputDir = join(root, 'plain')
    const { connector, calls } = fakeConnector()
    const service = await serviceFor(connector, outputDir)
    expect(await service.exportDocuments({ documentIds: [id] })).toEqual({ notes: 0, items: 1, skipped: [], failed: [] })
    expect(calls[0]!.items![0]).toMatchObject({ itemType: 'document', title: 'Attention <Is> All', abstractNote: 'Abstract text' })
    expect(calls[0]!.items![0]!.notes![0]!.note).not.toContain('zotero://select')
    expect(calls[1]!.attachment).toEqual({ parentItemID: 'copilotix-item', bytes: 8 })

    const failingDir = join(root, 'no-files')
    const failing = await serviceFor(fakeConnector({ attachmentFails: true }).connector, failingDir)
    const result = await failing.exportDocuments({ documentIds: [id] })
    expect(result.failed[0]?.message).toContain('条目已在 Zotero 建立，但 PDF 未能附上')
    // The item exists in Zotero, so the next export asks before creating another one.
    expect(await readZoteroExports(failingDir)).toHaveLength(1)
  })

  it('talks to the connector with the header Zotero requires and explains when Zotero is closed', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = []
    const fetchOk = (async (url: string, init: RequestInit) => {
      seen.push({ url, headers: init.headers as Record<string, string> })
      return new Response(null, { status: url.endsWith('/ping') ? 200 : 201 })
    }) as typeof fetch
    const connector = createZoteroConnector(23119, fetchOk)
    await connector.ping()
    const session = await connector.saveItems([{ id: 'a', itemType: 'note', note: '<p>x</p>' }])
    await connector.saveAttachment(session, 'a', 'PDF', Buffer.from('%PDF'))
    expect(seen.map((call) => new URL(call.url).pathname)).toEqual(['/connector/ping', '/connector/saveItems', '/connector/saveAttachment'])
    expect(seen.every((call) => call.headers['Zotero-Allowed-Request'] === '1')).toBe(true)
    expect(JSON.parse(seen[2]!.headers['X-Metadata']!)).toMatchObject({ sessionID: session, parentItemID: 'a' })

    const closed = createZoteroConnector(23119, (async () => { throw new TypeError('fetch failed') }) as typeof fetch)
    await expect(closed.ping()).rejects.toThrow('请先打开 Zotero')
  })
})

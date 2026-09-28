import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { V2Database } from '../src/utility/core/persistence/v2Database'
import { manageLibrary, verifyBackup } from '../src/utility/core/libraryMaintenance'

const connections: V2Database[] = []
afterEach(() => { for (const db of connections.splice(0)) db.close() })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'copilotix-library-test-'))
  const data = join(root, 'data'), output = join(root, 'output'), backups = join(root, 'backups')
  await Promise.all([mkdir(data), mkdir(output), mkdir(backups)])
  const databasePath = join(data, 'library.sqlite3')
  const db = new V2Database(databasePath)
  connections.push(db)
  const doc = '00000000-0000-4000-8000-000000000001'
  const documentPath = join(output, 'documents-v2', doc)
  await mkdir(documentPath, { recursive: true })
  await writeFile(join(documentPath, 'original.pdf'), '%PDF-1.4 test document')
  await writeFile(join(documentPath, 'full.md'), '# Research\n\nOriginal text.')
  const now = new Date().toISOString()
  db.connection.prepare('INSERT INTO documents(id,original_filename,display_title,storage_path,source_checksum,translation_provider,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(doc, 'paper.pdf', 'Research', documentPath, 'source-checksum', 'qwen', now, now)
  db.connection.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('outputRoot', JSON.stringify(output))
  db.connection.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('qwenApiKey', JSON.stringify('legacy-secret'))
  return { root, db, databasePath, output, backups, documentPath, doc, now }
}

describe('document library maintenance', () => {
  it('backs up and restores documents, annotations and settings without copying API keys', async () => {
    const f = await fixture()
    f.db.connection.prepare("INSERT INTO artifacts(id,document_id,kind,revision,relative_path,content_hash,metadata_json,created_at) VALUES('artifact',?,'parsed_markdown',1,'full.md','hash','{}',?)").run(f.doc, f.now)
    f.db.connection.prepare("INSERT INTO annotation_sets(id,document_id,artifact_id,view,revision,created_at,updated_at) VALUES('set',?,'artifact','original',1,?,?)").run(f.doc, f.now, f.now)
    f.db.connection.prepare("INSERT INTO reader_annotations(id,document_id,artifact_id,annotation_set_id,view,kind,block_key,start_offset,end_offset,quote,prefix,suffix,created_at,updated_at) VALUES('annotation',?,'artifact','set','original','highlight','block',0,4,'text','','',?,?)").run(f.doc, f.now, f.now)
    const backup = await manageLibrary(f.db, f.databasePath, { action: 'backup', path: f.backups })
    expect(backup.restartRequired).toBe(false)
    expect((await readFile(join(backup.path!, 'library.sqlite3'))).includes(Buffer.from('legacy-secret'))).toBe(false)
    expect((await verifyBackup(backup.path!)).documents).toEqual([f.doc])
    f.db.connection.prepare("UPDATE documents SET display_title='Changed'").run()
    f.db.connection.prepare('DELETE FROM reader_annotations').run()
    const restored = await manageLibrary(f.db, f.databasePath, { action: 'restore', path: backup.path! })
    expect(restored.restartRequired).toBe(true)
    const row = f.db.connection.prepare('SELECT display_title,storage_path FROM documents').get() as { display_title: string; storage_path: string }
    expect(row.display_title).toBe('Research')
    expect(await readFile(join(row.storage_path, 'full.md'), 'utf8')).toContain('Original text.')
    expect(f.db.connection.prepare('SELECT quote FROM reader_annotations').get()).toMatchObject({ quote: 'text' })
    expect(f.db.connection.prepare("SELECT value FROM settings WHERE key='qwenApiKey'").get()).toBeUndefined()
    expect(await readFile(join(f.documentPath, 'original.pdf'), 'utf8')).toContain('%PDF')
    expect((await readdir(join(f.root, 'data', 'library-recovery'))).some((name) => name.startsWith('Copilotix-backup-'))).toBe(true)
  })

  it('rejects a damaged backup before changing the existing library', async () => {
    const f = await fixture()
    const backup = await manageLibrary(f.db, f.databasePath, { action: 'backup', path: f.backups })
    await writeFile(join(backup.path!, 'documents', f.doc, 'full.md'), 'corrupted')
    await expect(manageLibrary(f.db, f.databasePath, { action: 'restore', path: backup.path! })).rejects.toThrow('校验失败')
    expect(f.db.connection.prepare('SELECT storage_path FROM documents').get()).toMatchObject({ storage_path: f.documentPath })
  })

  it('rejects path traversal and files not declared in a backup', async () => {
    const f = await fixture()
    const backup = await manageLibrary(f.db, f.databasePath, { action: 'backup', path: f.backups })
    const manifestFile = join(backup.path!, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
    manifest.files[0].path = '../outside'
    await writeFile(manifestFile, JSON.stringify(manifest))
    await expect(verifyBackup(backup.path!)).rejects.toThrow('不安全')
  })

  it('migrates by verified copy and switches paths only after successful copying', async () => {
    const f = await fixture()
    const destination = join(f.root, 'new-location')
    await mkdir(destination)
    const result = await manageLibrary(f.db, f.databasePath, { action: 'migrate', path: destination })
    expect(result.restartRequired).toBe(true)
    const row = f.db.connection.prepare('SELECT storage_path FROM documents').get() as { storage_path: string }
    expect(row.storage_path).toBe(join(destination, 'documents-v2', f.doc))
    expect(await readFile(join(row.storage_path, 'original.pdf'), 'utf8')).toContain('%PDF')
    expect(await readFile(join(f.documentPath, 'original.pdf'), 'utf8')).toContain('%PDF')
    expect(f.db.connection.prepare("SELECT value FROM settings WHERE key='outputRoot'").get()).toMatchObject({ value: JSON.stringify(destination) })
  })

  it('refuses nonempty migration targets and active jobs without changing source paths', async () => {
    const f = await fixture()
    await expect(manageLibrary(f.db, f.databasePath, { action: 'migrate', path: f.output })).rejects.toThrow('空目录')
    f.db.connection.prepare("INSERT INTO jobs(id,document_id,kind,status,available_at,created_at,updated_at) VALUES('job',?,'parse','queued',?,?,?)").run(f.doc, f.now, f.now, f.now)
    await expect(manageLibrary(f.db, f.databasePath, { action: 'backup', path: f.backups })).rejects.toThrow('任务')
    expect(f.db.connection.prepare('SELECT storage_path FROM documents').get()).toMatchObject({ storage_path: f.documentPath })
    expect(await readdir(f.backups)).toEqual([])
  })

  it('rejects a backup nested inside a document and respects cancellation', async () => {
    const f = await fixture()
    await expect(manageLibrary(f.db, f.databasePath, { action: 'backup', path: f.documentPath })).rejects.toThrow('内部')
    const controller = new AbortController()
    controller.abort()
    await expect(manageLibrary(f.db, f.databasePath, { action: 'backup', path: f.backups }, controller.signal)).rejects.toThrow()
    expect(await readdir(f.backups)).toEqual([])
  })
})

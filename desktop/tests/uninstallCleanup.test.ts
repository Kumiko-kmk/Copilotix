import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { executeUninstallCleanup, prepareUninstallCleanup } from '../src/utility/uninstallCleanup'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'copilotix-uninstall-cleanup-'))
  roots.push(root)
  const appData = join(root, 'appData')
  const userData = join(appData, 'Copilotix-Translation-v2')
  const installDirectory = join(root, 'install')
  const output = join(root, 'shared-output')
  const library = join(output, 'documents-v2', 'document_1')
  await mkdir(userData, { recursive: true })
  await mkdir(library, { recursive: true })
  await writeFile(join(library, 'original.pdf'), 'imported copy')
  await writeFile(join(output, 'unrelated.pdf'), 'unrelated shared file')
  await writeFile(join(root, 'original.pdf'), 'original source')
  await writeFile(join(userData, 'settings.json'), 'settings')
  const databasePath = join(userData, 'copilotix-desktop-v2.sqlite3')
  const db = new DatabaseSync(databasePath)
  db.exec('CREATE TABLE documents(id TEXT,storage_path TEXT); CREATE TABLE settings(key TEXT,value TEXT)')
  db.prepare('INSERT INTO documents VALUES(?,?)').run('document_1', library)
  db.prepare('INSERT INTO settings VALUES(?,?)').run('outputRoot', JSON.stringify(output))
  db.close()
  return { root, userData, databasePath, output, library, options: { appData, installDirectory } }
}

describe('uninstall data cleanup', () => {
  it('previews without changing data and removes only registered document copies plus application data', async () => {
    const f = await fixture()
    const originalDatabase = await readFile(f.databasePath)
    const plan = await prepareUninstallCleanup(f.options)
    expect(plan).toMatchObject({ userData: f.userData, libraryPaths: [f.library], documentCount: 1, outputRoot: f.output })
    expect(await readFile(f.databasePath)).toEqual(originalDatabase)
    await executeUninstallCleanup(plan)
    await expect(readFile(f.databasePath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(f.library, 'original.pdf'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(f.root, 'original.pdf'), 'utf8')).toBe('original source')
    expect(await readFile(join(f.output, 'unrelated.pdf'), 'utf8')).toBe('unrelated shared file')
  })

  it.each(['unsafe-id', 'unsafe-path', 'protected-path'])('rejects %s before deleting anything', async (kind) => {
    const f = await fixture()
    const db = new DatabaseSync(f.databasePath)
    if (kind === 'unsafe-id') db.exec("UPDATE documents SET id='../document_1'")
    if (kind === 'unsafe-path') db.prepare('UPDATE documents SET storage_path=?').run(f.output)
    db.close()
    const options = kind === 'protected-path' ? { ...f.options, protectedDirectories: [f.library] } : f.options
    await expect(prepareUninstallCleanup(options)).rejects.toThrow('safely')
    expect(await readFile(join(f.library, 'original.pdf'), 'utf8')).toBe('imported copy')
    expect(await readFile(join(f.userData, 'settings.json'), 'utf8')).toBe('settings')
  })

  it('rejects a corrupt database while retaining all folders', async () => {
    const f = await fixture()
    await writeFile(f.databasePath, 'not SQLite')
    await expect(prepareUninstallCleanup(f.options)).rejects.toThrow('safely')
    expect(await readFile(join(f.library, 'original.pdf'), 'utf8')).toBe('imported copy')
  })

  it('rejects linked descendants and ancestors before any deletion', async () => {
    const f = await fixture()
    const external = join(f.root, 'external')
    await mkdir(external)
    await writeFile(join(external, 'keep.txt'), 'preserve')
    await symlink(external, join(f.library, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(prepareUninstallCleanup(f.options)).rejects.toThrow('safely')
    expect(await readFile(join(external, 'keep.txt'), 'utf8')).toBe('preserve')
    await rm(join(f.library, 'linked'))
    const alias = join(f.root, 'alias')
    await symlink(f.output, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const db = new DatabaseSync(f.databasePath)
    db.prepare('UPDATE documents SET storage_path=?').run(join(alias, 'documents-v2', 'document_1'))
    db.close()
    await expect(prepareUninstallCleanup(f.options)).rejects.toThrow('safely')
  })

  it.each(['tree', 'database'])('aborts when %s changes after confirmation preview', async (kind) => {
    const f = await fixture()
    const plan = await prepareUninstallCleanup(f.options)
    if (kind === 'tree') await writeFile(join(f.library, 'new.md'), 'new result')
    else {
      const db = new DatabaseSync(f.databasePath)
      db.prepare('UPDATE settings SET value=?').run(JSON.stringify(join(f.root, 'changed')))
      db.close()
    }
    await expect(executeUninstallCleanup(plan)).rejects.toThrow('safely')
    expect(await readFile(join(f.library, 'original.pdf'), 'utf8')).toBe('imported copy')
    expect(await readFile(join(f.userData, 'settings.json'), 'utf8')).toBe('settings')
  })

  it('allows retry after the application data directory is already absent', async () => {
    const f = await fixture()
    await rm(f.userData, { recursive: true })
    const plan = await prepareUninstallCleanup(f.options)
    expect(plan.documentCount).toBe(0)
    await executeUninstallCleanup(plan)
    expect(await readFile(join(f.library, 'original.pdf'), 'utf8')).toBe('imported copy')
  })

  it('permits normal user data and library children of protected home and documents folders', async () => {
    const f = await fixture()
    const plan = await prepareUninstallCleanup({ ...f.options, protectedDirectories: [f.root, f.output] })
    await executeUninstallCleanup(plan)
    expect(await readFile(join(f.output, 'unrelated.pdf'), 'utf8')).toBe('unrelated shared file')
  })

  it('rejects libraries anywhere inside forbidden system folders', async () => {
    const f = await fixture()
    await expect(prepareUninstallCleanup({ ...f.options, forbiddenDirectories: [f.output] })).rejects.toThrow('safely')
    expect(await readFile(join(f.library, 'original.pdf'), 'utf8')).toBe('imported copy')
  })
})

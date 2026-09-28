import { expect, test } from '@playwright/test'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createE2EWorkspace, launchElectron, seedReaderTask } from './helpers'
import { V2Database } from '../src/utility/core/persistence/v2Database'
import { verifyBackup } from '../src/utility/core/libraryMaintenance'

test('backs up a complete library through the storage settings RPC in an isolated workspace', async ({}, testInfo) => {
  const workspace = await createE2EWorkspace()
  let app: Awaited<ReturnType<typeof launchElectron>> | null = null
  try {
    const documentId = await seedReaderTask(workspace)
    seedBackupMetadata(workspace.userData, documentId, workspace.root)

    const backupParent = join(workspace.root, 'selected-backup-directory')
    await mkdir(backupParent)
    app = await launchElectron({ args: [join(__dirname, '../out/main/index.js')], env: workspace.env })
    const window = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1100, 700))
    await expect.poll(() => window.evaluate(() => innerWidth)).toBeGreaterThanOrEqual(1100)
    await expect.poll(() => window.evaluate(() => innerHeight)).toBeGreaterThanOrEqual(700)

    // Stub only Electron's native directory picker. The click below still goes
    // through renderer -> preload validation -> Main IPC -> Utility RPC.
    await app.evaluate(({ dialog }, selectedDirectory) => {
      Reflect.set(globalThis, '__libraryDirectoryDialogCalls', 0)
      Object.defineProperty(dialog, 'showOpenDialog', {
        configurable: true,
        value: async () => {
          Reflect.set(globalThis, '__libraryDirectoryDialogCalls', Number(Reflect.get(globalThis, '__libraryDirectoryDialogCalls')) + 1)
          return { canceled: false, filePaths: [selectedDirectory] }
        }
      })
    }, backupParent)

    await window.locator('[data-edge-dock="top"]').hover()
    await window.getByRole('button', { name: '设置' }).click()
    await window.getByRole('button', { name: /文件存储/u }).click()
    const storage = window.getByRole('region', { name: '文件存储' })
    const library = window.getByRole('region', { name: '文档库管理' })
    await expect(storage).toBeVisible()
    await expect(library).toBeVisible()
    await expect(window.locator('.settings-content-body > .settings-section.storage-management')).toHaveCount(1)
    await expect(library.getByRole('button', { name: '备份文档库', exact: true })).toBeEnabled()

    const dimensions = await window.evaluate(() => {
      const root = document.documentElement
      const body = document.body
      const layout = document.querySelector('.settings-layout')!
      const section = document.querySelector('.settings-section.storage-management')!
      return {
        viewportWidth: innerWidth,
        rootScrollWidth: root.scrollWidth,
        bodyClientWidth: body.clientWidth,
        bodyScrollWidth: body.scrollWidth,
        layoutClientWidth: layout.clientWidth,
        layoutScrollWidth: layout.scrollWidth,
        sectionClientWidth: section.clientWidth,
        sectionScrollWidth: section.scrollWidth
      }
    })
    expect(dimensions.viewportWidth).toBeLessThanOrEqual(1102)
    expect(dimensions.rootScrollWidth).toBeLessThanOrEqual(dimensions.viewportWidth + 1)
    expect(dimensions.bodyScrollWidth).toBeLessThanOrEqual(dimensions.bodyClientWidth + 1)
    expect(dimensions.layoutScrollWidth).toBeLessThanOrEqual(dimensions.layoutClientWidth + 1)
    expect(dimensions.sectionScrollWidth).toBeLessThanOrEqual(dimensions.sectionClientWidth + 1)

    const screenshotPath = testInfo.outputPath('library-storage-1100x700.png')
    await mkdir(dirname(screenshotPath), { recursive: true })
    await window.screenshot({ path: screenshotPath })

    // This is the only library-management button the spec clicks.
    await library.getByRole('button', { name: '备份文档库', exact: true }).click()
    const notice = window.locator('.ant-message-notice-content').last()
    await expect(notice).toBeVisible({ timeout: 15000 })
    await expect(notice).toContainText('备份完成：')
    expect(await app.evaluate(() => Reflect.get(globalThis, '__libraryDirectoryDialogCalls'))).toBe(1)

    const names = await readdir(backupParent)
    const backupName = names.find((name) => name.startsWith('Copilotix-backup-'))
    expect(backupName).toBeDefined()
    const backupDirectory = join(backupParent, backupName!)
    const manifest = await verifyBackup(backupDirectory)
    expect(manifest.documents).toEqual([documentId])
    expect(manifest.files.map((file) => file.path)).toEqual(expect.arrayContaining([
      `documents/${documentId}/original.pdf`,
      `documents/${documentId}/full.md`,
      'library.sqlite3'
    ]))
    expect(await readFile(join(backupDirectory, 'documents', documentId, 'full.md'), 'utf8')).toContain('Fixture document')

    const snapshot = await readFile(join(backupDirectory, 'library.sqlite3'))
    expect(snapshot.includes(Buffer.from('backup-library-setting-marker'))).toBe(true)
    expect(snapshot.includes(Buffer.from('backup-annotation-marker'))).toBe(true)
    expect(snapshot.includes(Buffer.from('e2e-only-api-key-secret'))).toBe(false)
  } finally {
    await app?.close()
    await workspace.cleanup()
  }
})

function seedBackupMetadata(userData: string, documentId: string, outputRoot: string): void {
  const database = new V2Database(join(userData, 'copilotix-desktop-v2.sqlite3'))
  try {
    const artifact = database.connection.prepare(
      "SELECT id FROM artifacts WHERE document_id=? AND kind='parsed_markdown' ORDER BY revision DESC LIMIT 1"
    ).get(documentId) as { id: string } | undefined
    if (!artifact) throw new Error('The seeded document has no parsed Markdown artifact')

    const now = new Date().toISOString()
    database.transaction(() => {
      database.connection.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run('outputRoot', JSON.stringify(outputRoot))
      database.connection.prepare('INSERT INTO settings(key,value) VALUES(?,?)')
        .run('libraryE2ePreference', JSON.stringify('backup-library-setting-marker'))
      database.connection.prepare('INSERT INTO settings(key,value) VALUES(?,?)')
        .run('qwenApiKey', JSON.stringify('e2e-only-api-key-secret'))
      database.connection.prepare(`
        INSERT INTO annotation_sets(id,document_id,artifact_id,view,revision,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?)
      `).run('library-e2e-annotation-set', documentId, artifact.id, 'original', 1, now, now)
      database.connection.prepare(`
        INSERT INTO reader_annotations(
          id,document_id,artifact_id,annotation_set_id,view,kind,block_key,start_offset,end_offset,
          quote,prefix,suffix,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run('library-e2e-annotation', documentId, artifact.id, 'library-e2e-annotation-set', 'original',
        'highlight', 'fixture-block', 0, 25, 'backup-annotation-marker', '', '', now, now)
    })
  } finally {
    database.close()
  }
}

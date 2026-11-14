import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { createE2EWorkspace, launchElectron, seedReaderTask } from './helpers'

const LITE_OUT = resolve(__dirname, '../out-lite')
const LITE_ENTRY = join(LITE_OUT, 'main/index.js')

test.describe('lite edition', () => {
  test.skip(!existsSync(LITE_ENTRY), 'run pnpm desktop:build:lite first')

  test('bundle leaves out the archive, the home effects and automatic brief generation', async () => {
    const assets = join(LITE_OUT, 'renderer/assets')
    const scripts = (await readdir(assets)).filter((file) => file.endsWith('.js'))
    const renderer = (await Promise.all(scripts.map((file) => readFile(join(assets, file), 'utf8')))).join('\n')
    // Fixed strings from three.js, the archive page, the tutorial and the cipher backdrop.
    for (const marker of ['WebGLRenderer', '正在載入文庫', '展開主導覽', 'startCipherField']) expect(renderer).not.toContain(marker)
    const main = await readFile(LITE_ENTRY, 'utf8')
    expect(main).not.toMatch(/paperInsight\.onJobChanged\(/u)
    expect(main).not.toMatch(/paperInsight\.recover\(/u)
  })

  test('bundles use the Lite data folder, and never the full edition one', async () => {
    const main = await readFile(LITE_ENTRY, 'utf8')
    const uninstallWorker = await readFile(join(LITE_OUT, 'utility/uninstall-cleanup.js'), 'utf8')
    for (const bundle of [main, uninstallWorker]) {
      expect(bundle).toContain('Copilotix-Lite')
      expect(bundle).not.toContain('Copilotix-Translation-v2')
    }
  })

  test('home, sidebar, reader and settings work as one window', async () => {
    const workspace = await createE2EWorkspace()
    const taskId = await seedReaderTask(workspace, { englishTitle: 'Fixture paper for reading' })
    const app = await launchElectron({ args: [LITE_ENTRY], env: workspace.env })
    try {
      const page = await app.firstWindow()
      await page.setViewportSize({ width: 1100, height: 700 })
      const nav = page.getByRole('navigation', { name: '論文導覽' })
      await expect(page.getByRole('heading', { name: '今天想讀些什麼？' })).toBeVisible()
      await expect(page.locator('.new-parse-page canvas, .copilotix-wordmark')).toHaveCount(0)
      await expect(page.getByRole('navigation', { name: '主導覽' })).toHaveCount(0)
      await expect(page.locator('.window-controls')).toBeVisible()
      expect(await app.evaluate(({ app: electronApp }) => electronApp.getName())).toBe('Copilotix Lite')
      expect(await app.evaluate(({ app: electronApp }) => electronApp.getLocale())).toBe('zh-TW')
      // A first run keeps its documents apart from the full edition's folder.
      expect((await page.evaluate(() => window.copilotix.getSettings())).outputRoot).toMatch(/[\\/]Copilotix Lite$/u)

      await nav.locator(`[data-document-id="${taskId}"]`).click()
      await expect(page.locator('.reader-title')).toContainText('Fixture paper for reading')
      await expect(page.locator('.reader-header').getByRole('button', { name: '返回' })).toHaveCount(0)
      await expect(page.locator('.reader-workbench')).toBeVisible()

      // Going through settings must leave the reader mounted, so it comes back exactly as it was.
      await page.evaluate(() => { document.querySelector('.reader-page')?.setAttribute('data-kept', 'yes') })
      await page.getByRole('button', { name: '設定' }).click()
      const sections = page.getByRole('navigation', { name: '設定分類' })
      for (const name of ['服務', '儲存', '外觀']) {
        await sections.getByRole('button', { name }).click()
        const overflow = await page.locator('.settings-content-body').evaluate((body) => body.scrollHeight - body.clientHeight)
        expect(overflow, `${name} fits on one screen`).toBeLessThanOrEqual(1)
      }
      // A window over the app, not a page in its place: the paper stays on screen behind it.
      await expect(page.locator('.settings-dialog .ant-modal-content')).toBeVisible()
      await expect(page.locator('.reader-page[data-kept="yes"]')).toBeVisible()
      await page.getByRole('button', { name: '關閉設定' }).click()
      await expect(sections).toHaveCount(0)
      await expect(page.locator('.reader-page[data-kept="yes"]')).toBeVisible()

      // Collapsing keeps the title clear of the window controls and the sidebar toggle.
      await page.getByRole('button', { name: '收起側邊欄' }).click()
      await expect(nav).toHaveCount(0)
      const toggle = await page.getByRole('button', { name: '展開側邊欄' }).boundingBox()
      const title = await page.locator('.reader-title').boundingBox()
      expect(title!.x).toBeGreaterThanOrEqual(toggle!.x + toggle!.width)
      await page.getByRole('button', { name: '展開側邊欄' }).click()

      await nav.getByRole('button', { name: '新建' }).click()
      await expect(page.getByRole('heading', { name: '今天想讀些什麼？' })).toBeVisible()
    } finally {
      await app.close()
      await workspace.cleanup()
    }
  })

  test('a paper opens beside another, in a window of its own, and takes a new name', async () => {
    const workspace = await createE2EWorkspace()
    const first = await seedReaderTask(workspace, { englishTitle: 'First paper on fracture', createdAt: '2026-11-01T00:00:00.000Z' })
    const second = await seedReaderTask(workspace, { taskId: '00000000-0000-4000-8000-0000000000b2', englishTitle: 'Second paper on fatigue', createdAt: '2026-11-02T00:00:00.000Z' })
    const app = await launchElectron({ args: [LITE_ENTRY], env: workspace.env })
    try {
      const page = await app.firstWindow()
      await page.setViewportSize({ width: 1400, height: 800 })
      const nav = page.getByRole('navigation', { name: '論文導覽' })
      const menu = async (documentId: string, item: string): Promise<void> => {
        await nav.locator(`[data-document-id="${documentId}"]`).click({ button: 'right' })
        await page.getByRole('menuitem', { name: item }).click()
      }
      await nav.locator(`[data-document-id="${first}"]`).click()
      await expect(page.locator('.lite-pane .reader-workbench')).toBeVisible()

      await menu(second, '分屏開啟')
      const panes = page.locator('.lite-pane')
      await expect(panes).toHaveCount(2)
      await expect(panes.nth(1).locator('.reader-title')).toContainText('Second paper on fatigue')
      await expect(panes.nth(1).locator('.reader-workbench')).toBeVisible()
      const before = (await panes.nth(0).boundingBox())!
      const handle = (await page.getByRole('separator', { name: '調整分屏寬度' }).boundingBox())!
      await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
      await page.mouse.down()
      await page.mouse.move(handle.x - 120, handle.y + handle.height / 2, { steps: 4 })
      await page.mouse.up()
      expect((await panes.nth(0).boundingBox())!.width).toBeLessThan(before.width - 60)
      await panes.nth(1).getByRole('button', { name: '關閉分屏' }).click()
      await expect(panes).toHaveCount(1)

      await menu(second, '重新命名')
      const field = nav.getByRole('textbox', { name: '論文標題' })
      await field.fill('Renamed fatigue study')
      await field.press('Enter')
      await expect(nav.locator(`[data-document-id="${second}"]`)).toContainText('Renamed fatigue study')

      // The reader window reads the paper through the same trusted IPC as the main window.
      const opened = app.waitForEvent('window')
      await menu(second, '在新視窗中開啟')
      const reader = await opened
      await expect(reader.locator('.lite-reader-slot[data-active] .reader-title')).toContainText('Renamed fatigue study', { timeout: 30_000 })
      await expect(reader.locator('.lite-reader-slot[data-active] .reader-workbench')).toBeVisible()
      expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(2)
      await reader.getByRole('button', { name: '關閉視窗' }).click()
      await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
      await expect(page.locator('.reader-title')).toContainText('First paper on fracture')
    } finally {
      await app.close()
      await workspace.cleanup()
    }
  })
})

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
    for (const marker of ['WebGLRenderer', '正在加载文库', '展开主导航', 'startCipherField']) expect(renderer).not.toContain(marker)
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
      const nav = page.getByRole('navigation', { name: '论文导航' })
      await expect(page.getByRole('heading', { name: '今天想读些什么？' })).toBeVisible()
      await expect(page.locator('.new-parse-page canvas, .copilotix-wordmark')).toHaveCount(0)
      await expect(page.getByRole('navigation', { name: '主导航' })).toHaveCount(0)
      await expect(page.locator('.window-controls')).toBeVisible()
      expect(await app.evaluate(({ app: electronApp }) => electronApp.getName())).toBe('Copilotix Lite')
      // A first run keeps its documents apart from the full edition's folder.
      expect((await page.evaluate(() => window.copilotix.getSettings())).outputRoot).toMatch(/[\\/]Copilotix Lite$/u)

      await nav.locator(`[data-document-id="${taskId}"]`).click()
      await expect(page.locator('.reader-title')).toContainText('Fixture paper for reading')
      await expect(page.locator('.reader-header').getByRole('button', { name: '返回' })).toHaveCount(0)
      await expect(page.locator('.reader-workbench')).toBeVisible()

      // Going through settings must leave the reader mounted, so it comes back exactly as it was.
      await page.evaluate(() => { document.querySelector('.reader-page')?.setAttribute('data-kept', 'yes') })
      await page.getByRole('button', { name: '设置' }).click()
      const sections = page.getByRole('navigation', { name: '设置分类' })
      for (const name of ['服务连接', 'API 密钥', '模型设置', '文件存储', '显示设置']) {
        await sections.getByRole('button', { name }).click()
        const overflow = await page.locator('.settings-content-body').evaluate((body) => body.scrollHeight - body.clientHeight)
        expect(overflow, `${name} fits on one screen`).toBeLessThanOrEqual(1)
      }
      // A window over the app, not a page in its place: the paper stays on screen behind it.
      await expect(page.locator('.settings-dialog .ant-modal-content')).toBeVisible()
      await expect(page.locator('.reader-page[data-kept="yes"]')).toBeVisible()
      await page.getByRole('button', { name: '关闭设置' }).click()
      await expect(sections).toHaveCount(0)
      await expect(page.locator('.reader-page[data-kept="yes"]')).toBeVisible()

      // Collapsing keeps the title clear of the window controls and the sidebar toggle.
      await page.getByRole('button', { name: '收起侧边栏' }).click()
      await expect(nav).toHaveCount(0)
      const toggle = await page.getByRole('button', { name: '展开侧边栏' }).boundingBox()
      const title = await page.locator('.reader-title').boundingBox()
      expect(title!.x).toBeGreaterThanOrEqual(toggle!.x + toggle!.width)
      await page.getByRole('button', { name: '展开侧边栏' }).click()

      await nav.getByRole('button', { name: '新建' }).click()
      await expect(page.getByRole('heading', { name: '今天想读些什么？' })).toBeVisible()
    } finally {
      await app.close()
      await workspace.cleanup()
    }
  })
})

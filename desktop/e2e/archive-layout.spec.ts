import { expect, test, type Page } from '@playwright/test'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { createE2EWorkspace, launchElectron, seedReaderTask } from './helpers'
import { briefContent } from '../tests/fixtures/paperBrief'

const originalTitle = 'Learning nonlinear operators via DeepONet based on the universal approximation theorem of operators for scientific machine learning'
const translatedTitle = '基于算子通用逼近定理通过深度算子网络学习非线性算子'
const translatedAbstract = '本文研究非线性算子的学习方法，使用深度算子网络比较不同方程与训练条件。'

test('archive keeps titles separate, category controls fixed, and translated abstract first', async ({}, testInfo) => {
  // Thirteen papers, three viewport captures and a full row wrap on software GL.
  test.setTimeout(180_000)
  const baseline = process.env.COPILOTIX_LAYOUT_BASELINE === '1'
  const workspace = await createE2EWorkspace()
  let app: Awaited<ReturnType<typeof launchElectron>> | undefined
  try {
    const ids: string[] = []
    for (let index = 0; index < 13; index++) {
      ids.push(await seedReaderTask(workspace, {
        taskId: `00000000-0000-4000-8000-${String(index + 100).padStart(12, '0')}`,
        createdAt: '2026-10-07T12:00:00Z', englishTitle: `${originalTitle} ${index}`,
        sourceMarkdown: `# ${originalTitle}\n\n## Abstract\n\nOriginal abstract.\n\n## Method\n\nOperators.`,
        translatedMarkdown: `# ${translatedTitle}\n\n## 摘要\n\n${translatedAbstract}\n\n## 方法\n\n算子学习。`
      }))
    }
    app = await launchElectron({ args: [join(__dirname, '../out/main/index.js')], env: workspace.env })
    const page = await app.firstWindow()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await expect.poll(() => page.evaluate(() => typeof window.copilotix?.libraryCategories)).toBe('function')
    // Deterministic categories/card cross the real validated IPC and renderer. No provider call.
    await app.evaluate(({ ipcMain }, documentIds) => {
      ipcMain.removeHandler('library:categories')
      ipcMain.handle('library:categories', () => ({ ok: true, value: {
        revision: '0123456789abcdef', next: null,
        categories: [{ id: 'operators', name: '非线性算子学习与科学计算模型方法', named: 'terms', size: 12 }, { id: 'short', name: '图网络', named: 'terms', size: 1 }],
        items: documentIds.map((documentId, rank) => ({ documentId, category: rank < 12 ? 0 : 1, rank: rank < 12 ? rank : 0 }))
      } }))
    }, ids)
    await app.evaluate(({ ipcMain }, content) => {
      ipcMain.removeHandler('paperInsight:get')
      ipcMain.handle('paperInsight:get', () => ({ ok: true, value: {
        status: 'ready', stale: false, promptOutdated: false, anchors: [],
        brief: { ...content, schemaVersion: 2, checks: content.findings.map(() => ({ grounded: false, numbersVerified: false })),
          provenance: { promptVersion: 'brief-v2.2026-10-10', model: { provider: 'deepseek', name: 'deepseek-flash' }, generatedAt: '2026-10-10T00:00:00Z', sourceRevision: 'fixture', language: 'original', sentBytes: 100, sourceBytes: 200 } }
      } }))
    }, briefContent)
    await page.locator('[data-edge-dock="top"]').hover()
    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: /文库$/u }).click()
    const archive = page.getByRole('region', { name: '文库', exact: true })
    await expect(archive.locator('canvas[data-archive-state="ready"]')).toBeVisible({ timeout: 20_000 })
    await expect(archive.locator('.paper-archive-translated-title')).toHaveText(translatedTitle)
    const geometry: unknown[] = []
    for (const size of [{ width: 1280, height: 720 }, { width: 1100, height: 700 }, { width: 1600, height: 900 }]) {
      const browserWindow = await app.browserWindow(page)
      await browserWindow.evaluate((win, value) => win.setContentSize(value.width, value.height), size)
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(size.width)
      await expect(archive.locator('.paper-archive-translated-title')).toHaveText(translatedTitle)
      const metrics = await measureTitles(page)
      geometry.push({ size, metrics })
      expect(metrics.titleBottom).toBeLessThanOrEqual(metrics.subtitleTop + 1)
      expect(metrics.subtitleBottom).toBeLessThanOrEqual(metrics.metadataTop + 1)
      expect(metrics.titleTop).toBeGreaterThanOrEqual(metrics.brandBottom)
      expect(metrics.metadataRight).toBeLessThanOrEqual(metrics.panelRight + 1)
      expect(metrics.lineHeight).toBeGreaterThan(20)
      await page.screenshot({ path: testInfo.outputPath(`${baseline ? 'baseline' : 'updated'}-${size.width}.png`) })
    }
    if (baseline) return
    await expect(archive.getByText('COLUMN 01 / 02', { exact: true })).toBeVisible()
    await expect(archive.locator('.paper-archive-keywords')).toContainText(briefContent.keywords.join(' '))
    await expect(archive.locator('.paper-archive-meta')).not.toContainText('已完成')
    await expect(archive.locator('.paper-archive-meta').locator('dt')).toHaveText(['关键词', '总结'])
    await expect(archive.locator('.paper-archive-summary')).toContainText(briefContent.tldr)
    const positions = () => archive.locator('.paper-archive-shelves').evaluate((element) => {
      const buttons = [...element.querySelectorAll('button')].map((button) => button.getBoundingClientRect().left)
      const label = element.querySelector('div')!.getBoundingClientRect()
      return { buttons, left: label.left, right: label.right, width: label.width }
    })
    const before = await positions()
    await archive.getByRole('button', { name: '下一列' }).click()
    await expect(archive.getByText('COLUMN 02 / 02', { exact: true })).toBeVisible()
    expect(await positions()).toEqual(before)
    await archive.getByRole('button', { name: '上一列' }).click()
    await expect(archive.getByText('COLUMN 01 / 02', { exact: true })).toBeVisible()
    for (let index = 0; index < 18; index++) {
      await archive.focus()
      await page.keyboard.press('ArrowDown')
      await page.waitForTimeout(80)
      await expect(archive.locator('.paper-archive-title')).toHaveCount(1)
      await expect(archive.locator('.paper-archive-translated-title')).toHaveCount(1)
    }
    await expect(archive.locator('.paper-archive-keywords')).toContainText('论文阅读')
    await archive.getByRole('button', { name: '查看档案' }).click()
    await expect(archive).toHaveAttribute('data-detail-phase', 'open', { timeout: 20_000 })
    await expect(archive.getByRole('tab')).toHaveText([/01摘要/u, /02背景/u, /03结论/u, /04讨论/u])
    await expect(archive.getByRole('tab', { name: /摘要/u })).toHaveAttribute('aria-selected', 'true')
    await expect(archive.getByRole('tabpanel')).toContainText(translatedAbstract)
    await expect(archive.locator('.paper-archive-fields')).not.toContainText('关键词')
    await expect(archive.getByRole('tab', { name: /阅读路线|术语/u })).toHaveCount(0)
    await archive.getByRole('tab', { name: /背景/u }).click()
    await expect(archive.getByRole('tabpanel')).toContainText(briefContent.context.question)
    await page.screenshot({ path: testInfo.outputPath('updated-detail.png') })
    expect(errors).toEqual([])
    await writeFile(testInfo.outputPath('layout-metrics.json'), JSON.stringify({ geometry, positions: before, errors }, null, 2))
  } finally {
    await app?.close()
    await workspace.cleanup()
  }
})

async function measureTitles(page: Page) {
  return page.locator('.paper-archive-panel').evaluate((panel) => {
    const title = panel.querySelector('.paper-archive-title')!.getBoundingClientRect()
    const subtitle = panel.querySelector('.paper-archive-translated-title')!.getBoundingClientRect()
    const metadata = panel.querySelector('.paper-archive-meta')!.getBoundingClientRect()
    return { titleTop: title.top, titleBottom: title.bottom, subtitleTop: subtitle.top, subtitleBottom: subtitle.bottom,
      metadataTop: metadata.top, metadataRight: metadata.right, panelRight: panel.getBoundingClientRect().right,
      brandBottom: document.querySelector('.paper-archive-brand')!.getBoundingClientRect().bottom,
      lineHeight: parseFloat(getComputedStyle(panel.querySelector('.paper-archive-title')!).lineHeight) }
  })
}

import { chromium, expect, test } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createE2EWorkspace, seedReaderTask } from './helpers'
import { paperBriefRecordSchema } from '../src/shared/paperBrief/contracts'
import { briefContent } from '../tests/fixtures/paperBrief'

test('packaged archive renders long titles and saved keywords without overlapping', async ({}, testInfo) => {
  test.setTimeout(90_000)
  const executable = process.env.COPILOTIX_LAYOUT_EXE
  test.skip(!executable, 'Set COPILOTIX_LAYOUT_EXE to the release program under verification')
  const workspace = await createE2EWorkspace()
  let launched: ChildProcess | undefined
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined
  const title = 'Learning nonlinear operators via DeepONet based on the universal approximation theorem of operators for scientific machine learning'
  const translated = '基于算子通用逼近定理通过深度算子网络学习非线性算子'
  try {
    for (let index = 0; index < 13; index++) {
      const documentId = await seedReaderTask(workspace, {
        taskId: `00000000-0000-4000-8000-${String(index + 200).padStart(12, '0')}`,
        createdAt: '2026-10-07T12:00:00Z', englishTitle: `${title} ${index}`,
        sourceMarkdown: `# ${title}\n\n## Abstract\n\nOriginal abstract.\n\n## Method\n\nOperators.`,
        translatedMarkdown: `# ${translated}\n\n## 摘要\n\n这份译文摘要用于检查实际程序包的显示。\n\n## 方法\n\n算子学习。`
      })
      const insightDirectory = join(workspace.root, 'documents-v2', documentId, 'insight')
      await mkdir(insightDirectory)
      const record = paperBriefRecordSchema.parse({ version: 2, documentId, anchors: [], brief: {
        ...briefContent, schemaVersion: 2, checks: briefContent.findings.map(() => ({ grounded: false, numbersVerified: false })),
        provenance: { promptVersion: 'brief-v2.2026-10-10', model: { provider: 'deepseek', name: 'deepseek-flash' },
          generatedAt: '2026-10-10T00:00:00Z', sourceRevision: 'fixture', language: 'original', sentBytes: 100, sourceBytes: 200 }
      } })
      await writeFile(join(insightDirectory, 'brief.v2.json'), JSON.stringify(record))
    }
    // Release fuses disable Node inspection; launch normally and inspect only the renderer via CDP.
    launched = spawn(executable!, ['--remote-debugging-port=0', '--no-sandbox'], { env: workspace.env, windowsHide: true, stdio: 'ignore' })
    let port = ''
    await expect.poll(async () => {
      try { port = (await readFile(join(workspace.userData, 'DevToolsActivePort'), 'utf8')).split('\n')[0]!; return Boolean(port) }
      catch { return false }
    }, { timeout: 20_000 }).toBe(true)
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    const context = browser.contexts()[0]!
    const page = context.pages()[0] ?? await context.waitForEvent('page', { timeout: 20_000 })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.locator('[data-edge-dock="top"]').hover()
    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: /文库$/u }).click()
    const archive = page.getByRole('region', { name: '文库', exact: true })
    await expect(archive.locator('canvas[data-archive-state="ready"]')).toBeVisible({ timeout: 20_000 })
    await expect(archive.getByText('COLUMN 01 / 01', { exact: true })).toBeVisible()
    await expect(archive.locator('.paper-archive-keywords')).toContainText('论文阅读')
    const metrics = []
    for (const width of [1100, 1280, 1600]) {
      await page.setViewportSize({ width, height: width === 1600 ? 900 : 720 })
      await expect(archive.locator('.paper-archive-translated-title')).toHaveText(translated)
      const result = await archive.locator('.paper-archive-panel').evaluate((panel) => {
        const title = panel.querySelector('.paper-archive-title')!.getBoundingClientRect()
        const translated = panel.querySelector('.paper-archive-translated-title')!.getBoundingClientRect()
        const meta = panel.querySelector('.paper-archive-meta')!.getBoundingClientRect()
        return { titleBottom: title.bottom, translatedTop: translated.top, translatedBottom: translated.bottom, metaTop: meta.top }
      })
      expect(result.titleBottom).toBeLessThanOrEqual(result.translatedTop + 1)
      expect(result.translatedBottom).toBeLessThanOrEqual(result.metaTop + 1)
      metrics.push({ width, ...result })
      await page.screenshot({ path: testInfo.outputPath(`packaged-${width}.png`) })
    }
    for (let index = 0; index < 18; index++) {
      await archive.focus(); await page.keyboard.press('ArrowDown'); await page.waitForTimeout(80)
      await expect(archive.locator('.paper-archive-title')).toHaveCount(1)
      await expect(archive.locator('.paper-archive-translated-title')).toHaveCount(1)
    }
    await archive.getByRole('button', { name: '查看档案' }).click()
    await expect(archive).toHaveAttribute('data-detail-phase', 'open', { timeout: 20_000 })
    await expect(archive.getByRole('tab')).toHaveText([/01摘要/u, /02概览/u, /03发现/u, /04局限与前提/u])
    await expect(archive.getByRole('tabpanel')).toContainText('这份译文摘要用于检查实际程序包的显示。')
    await page.screenshot({ path: testInfo.outputPath('packaged-detail.png') })
    expect(errors).toEqual([])
    await writeFile(testInfo.outputPath('packaged-metrics.json'), JSON.stringify({ metrics, errors }, null, 2))
  } finally {
    await browser?.close()
    if (launched && launched.exitCode === null) {
      const stopped = new Promise<void>((resolve) => launched!.once('exit', () => resolve()))
      launched.kill(); await stopped
    }
    await workspace.cleanup()
  }
})

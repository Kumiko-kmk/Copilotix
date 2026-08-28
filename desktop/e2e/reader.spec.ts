import { _electron as electron, expect, test } from '@playwright/test'
import { join } from 'node:path'
import { createE2EWorkspace, seedReaderTask } from './helpers'

test('renders a local PDF with range requests before parsing succeeds', async () => {
  const workspace = await createE2EWorkspace()
  const taskId = await seedReaderTask(workspace)
  const app = await electron.launch({ args: [join(__dirname, '../out/main/index.js')], env: workspace.env })
  try {
    const window = await app.firstWindow()
    await window.locator('.recent-task', { hasText: 'fixture.pdf' }).click()
    await expect(window.getByText('1 / 2')).toBeVisible()
    await expect.poll(() => window.locator('.pdf-page canvas').first().evaluate((canvas) => (canvas as HTMLCanvasElement).width)).toBeGreaterThan(0)
    await expect(window.locator('.pdf-block')).toHaveCount(4)
    await expect(window.locator('.pdf-block-label')).toHaveCount(4)
    await expect(window.locator('.pdf-merge-layer line')).toHaveCount(1)
    const sourceBlockId = await window.locator('[data-block-position="0-1"]').getAttribute('data-block-id')
    const continuationBlockId = await window.locator('[data-block-position="0-2"]').getAttribute('data-block-id')
    expect(continuationBlockId).toBe(sourceBlockId)
    const borderColor = await window.locator('[data-block-position="0-3"]').evaluate((element) => getComputedStyle(element).borderTopColor)
    expect(borderColor).not.toBe('rgba(0, 0, 0, 0)')

    await window.locator('.markdown-block', { hasText: 'Second paragraph.' }).click()
    await expect(window.locator('[data-block-position="0-3"]')).toHaveClass(/active/)
    await window.locator('[data-block-position="0-2"]').click()
    await expect(window.getByText('1 / 2')).toBeVisible()
    await expect(window.locator('[data-block-position="0-1"]')).toHaveClass(/active/)
    await expect(window.locator('[data-block-position="0-2"]')).toHaveClass(/active/)

    const rangeResult = await window.evaluate(async (url) => {
      const response = await fetch(url, { headers: { Range: 'bytes=0-3' } })
      return {
        status: response.status,
        contentRange: response.headers.get('content-range'),
        bytes: [...new Uint8Array(await response.arrayBuffer())]
      }
    }, `mineru-asset://${taskId}/original.pdf`)
    expect(rangeResult).toEqual({ status: 206, contentRange: expect.stringMatching(/^bytes 0-3\//), bytes: [0x25, 0x50, 0x44, 0x46] })

    const originalWidth = await window.locator('.pdf-page canvas').first().evaluate((canvas) => (canvas as HTMLCanvasElement).width)
    await window.getByLabel('放大').click()
    await expect.poll(() => window.locator('.pdf-page canvas').first().evaluate((canvas) => (canvas as HTMLCanvasElement).width)).toBeGreaterThan(originalWidth)
    await window.getByLabel('下一页').click()
    await expect(window.getByText('2 / 2')).toBeVisible()
  } finally {
    await app.close()
    await workspace.cleanup()
  }
})

test('shows a recoverable error when the local PDF is missing', async () => {
  const workspace = await createE2EWorkspace()
  await seedReaderTask(workspace, { missingPdf: true })
  const app = await electron.launch({ args: [join(__dirname, '../out/main/index.js')], env: workspace.env })
  try {
    const window = await app.firstWindow()
    await window.locator('.recent-task', { hasText: 'missing.pdf' }).click()
    await expect(window.getByText('PDF 无法打开')).toBeVisible()
    await expect(window.getByRole('button', { name: '重新加载' })).toBeVisible()
  } finally {
    await app.close()
    await workspace.cleanup()
  }
})

test('renders an optional real MinerU PDF fixture', async () => {
  const sourcePdf = process.env.MINERU_E2E_REAL_PDF
  test.skip(!sourcePdf, 'Set MINERU_E2E_REAL_PDF for the local non-CI acceptance check')
  const workspace = await createE2EWorkspace()
  await seedReaderTask(workspace, { sourcePdf: sourcePdf! })
  const app = await electron.launch({ args: [join(__dirname, '../out/main/index.js')], env: workspace.env })
  try {
    const window = await app.firstWindow()
    await window.locator('.recent-task', { hasText: 'original.pdf' }).click()
    await expect(window.locator('.pdf-page canvas').first()).toBeVisible()
    await expect.poll(() => window.locator('.pdf-page canvas').first().evaluate((canvas) => (canvas as HTMLCanvasElement).width)).toBeGreaterThan(0)
  } finally {
    await app.close()
    await workspace.cleanup()
  }
})

test('renders and links every block from an optional real MinerU task', async () => {
  const sourceTaskDir = process.env.MINERU_E2E_REAL_TASK_DIR
  test.skip(!sourceTaskDir, 'Set MINERU_E2E_REAL_TASK_DIR for the local layout acceptance check')
  const workspace = await createE2EWorkspace()
  await seedReaderTask(workspace, { sourceTaskDir: sourceTaskDir! })
  const app = await electron.launch({ args: [join(__dirname, '../out/main/index.js')], env: workspace.env })
  try {
    const window = await app.firstWindow()
    await window.locator('.recent-task').first().click()
    await expect.poll(() => window.locator('.pdf-page canvas').first().evaluate((canvas) => (canvas as HTMLCanvasElement).width)).toBeGreaterThan(0)
    await expect(window.locator('.pdf-block').first()).toBeVisible()
    expect(await window.locator('.pdf-block').count()).toBeGreaterThan(100)
    await expect(window.locator('.markdown-block[data-block-ids=""]')).toHaveCount(0)
    const screenshotPath = process.env.MINERU_E2E_SCREENSHOT
    if (screenshotPath) {
      const mergedBlock = window.locator('.pdf-block.merged').first()
      if (await mergedBlock.count()) await mergedBlock.scrollIntoViewIfNeeded()
      await window.screenshot({ path: screenshotPath })
    }
  } finally {
    await app.close()
    await workspace.cleanup()
  }
})

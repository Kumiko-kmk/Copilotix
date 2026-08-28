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

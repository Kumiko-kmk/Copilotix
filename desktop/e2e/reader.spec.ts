import { _electron as electron, expect, test, type Locator } from '@playwright/test'
import { join } from 'node:path'
import { createE2EWorkspace, seedReaderTask } from './helpers'

async function isCentered(locator: Locator, containerSelector: string): Promise<boolean> {
  if (await locator.count() === 0) return false
  return locator.first().evaluate((element, selector) => {
    const container = element.closest(selector)
    if (!container) return false
    const elementRect = element.getBoundingClientRect()
    const containerRect = container.getBoundingClientRect()
    const elementCenter = (elementRect.top + elementRect.bottom) / 2
    const containerCenter = (containerRect.top + containerRect.bottom) / 2
    return elementRect.top >= containerRect.top - 2 && elementRect.bottom <= containerRect.bottom + 2 &&
      Math.abs(elementCenter - containerCenter) <= containerRect.height * 0.45
  }, containerSelector)
}

test('renders a local PDF with range requests before parsing succeeds', async () => {
  const workspace = await createE2EWorkspace()
  const taskId = await seedReaderTask(workspace, {
    translatedMarkdown: [
      '# 测试文档',
      '<sub>艾达·洛夫莱斯</sub>和艾伦·图灵',
      '摘要 | 独立映射的摘要。',
      '第一页在第二栏继续。<sup>12</sup> 水是 H<sub>2</sub>O。',
      '第二段落包含 $E=mc^2$。',
      '<table><tbody><tr><td>学术单元格</td></tr></tbody></table>',
      '![测试图片](images/fixture.png)'
    ].join('\n\n')
  })
  const app = await electron.launch({ args: [join(__dirname, '../out/main/index.js')], env: workspace.env })
  try {
    const window = await app.firstWindow()
    await window.locator('.recent-task', { hasText: 'fixture.pdf' }).click()
    await expect(window.getByText('1 / 2')).toBeVisible()
    await expect.poll(() => window.locator('.pdf-page canvas').first().evaluate((canvas) => (canvas as HTMLCanvasElement).width)).toBeGreaterThan(0)
    await expect(window.locator('.pdf-block')).toHaveCount(8)
    await expect(window.locator('.pdf-block-label')).toHaveCount(8)
    await expect(window.locator('.pdf-merge-layer line')).toHaveCount(1)
    await expect(window.locator('.markdown-scroll')).toHaveAttribute('data-render-state', 'ready')
    await expect(window.locator('.markdown-body sup')).toHaveText('12')
    await expect(window.locator('.markdown-body sub', { hasText: /^2$/ })).toHaveText('2')
    await expect(window.locator('.markdown-body td')).toHaveText('Academic cell')
    await expect(window.locator('.markdown-body .katex')).toBeVisible()
    const markdownImage = window.locator('.markdown-body img')
    await expect.poll(() => markdownImage.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    const stableImageRect = await markdownImage.boundingBox()
    await window.waitForTimeout(200)
    const settledImageRect = await markdownImage.boundingBox()
    if (!stableImageRect || !settledImageRect) throw new Error('Markdown image is not visible after render readiness')
    expect(settledImageRect.y).toBeCloseTo(stableImageRect.y, 1)
    expect(settledImageRect.height).toBeCloseTo(stableImageRect.height, 1)
    const originalBlockCount = await window.locator('.markdown-block').count()
    const sourceBlockId = await window.locator('[data-block-position="0-3"]').getAttribute('data-block-id')
    const continuationBlockId = await window.locator('[data-block-position="0-4"]').getAttribute('data-block-id')
    expect(continuationBlockId).toBe(sourceBlockId)
    const borderColor = await window.locator('[data-block-position="0-4"]').evaluate((element) => getComputedStyle(element).borderTopColor)
    expect(borderColor).not.toBe('rgba(0, 0, 0, 0)')

    await window.locator('.markdown-block', { hasText: 'Second paragraph with' }).click()
    await expect(window.getByText('2 / 2')).toBeVisible()
    await expect(window.locator('[data-block-position="1-0"]')).toHaveClass(/active/)
    await expect.poll(() => isCentered(window.locator('[data-block-position="1-0"]'), '.pdf-scroll')).toBe(true)

    await window.locator('[data-block-position="0-4"]').click()
    await expect.poll(() => isCentered(window.locator('.markdown-block', { hasText: 'First page continues in second column.' }), '.markdown-scroll')).toBe(true)
    await expect(window.locator('[data-block-position="0-3"]')).toHaveClass(/active/)
    await expect(window.locator('[data-block-position="0-4"]')).toHaveClass(/active/)

    const markdownImageBlock = window.locator('.markdown-block', { has: window.locator('img') })
    const markdownImageMapping = await markdownImageBlock.getAttribute('data-block-ids')
    const pdfImageMapping = await window.locator('[data-block-position="1-2"]').getAttribute('data-block-id')
    expect(markdownImageMapping).toContain(pdfImageMapping)
    await markdownImage.click()
    await expect(window.locator('[data-block-position="1-2"]')).toHaveClass(/active/)
    await expect.poll(() => isCentered(window.locator('[data-block-position="1-2"]'), '.pdf-scroll')).toBe(true)
    await window.locator('[data-block-position="1-2"]').click()
    await expect.poll(() => isCentered(markdownImageBlock, '.markdown-scroll')).toBe(true)

    await window.getByText('Markdown（中文）').click()
    await expect(window.locator('.markdown-scroll')).toHaveAttribute('data-render-state', 'ready')
    await expect(window.locator('.markdown-block')).toHaveCount(originalBlockCount)
    await expect(window.locator('.markdown-body sup')).toHaveText('12')
    await expect(window.locator('.markdown-body sub', { hasText: /^2$/ })).toHaveText('2')
    await expect(window.locator('.markdown-body td')).toHaveText('学术单元格')
    await expect(window.locator('.markdown-body .katex')).toBeVisible()
    const translatedAuthors = window.locator('.markdown-block', { hasText: '艾达·洛夫莱斯' })
    const translatedAbstract = window.locator('.markdown-block', { hasText: '独立映射的摘要' })
    await expect(translatedAuthors).not.toContainText('独立映射的摘要')
    await translatedAuthors.click()
    await expect(window.locator('[data-block-position="0-1"]')).toHaveClass(/active/)
    await expect(window.locator('[data-block-position="0-2"]')).not.toHaveClass(/active/)
    await translatedAbstract.click()
    await expect(window.locator('[data-block-position="0-2"]')).toHaveClass(/active/)
    await expect(window.locator('[data-block-position="0-1"]')).not.toHaveClass(/active/)
    await expect(window.locator('.markdown-block', { hasText: '第二段落包含' })).toBeVisible()
    await window.locator('.markdown-block', { hasText: '第二段落包含' }).click()
    await expect(window.locator('[data-block-position="1-0"]')).toHaveClass(/active/)
    await expect.poll(() => isCentered(window.locator('[data-block-position="1-0"]'), '.pdf-scroll')).toBe(true)
    await window.locator('[data-block-position="1-0"]').click()
    await expect.poll(() => isCentered(window.locator('.markdown-block', { hasText: '第二段落包含' }), '.markdown-scroll')).toBe(true)

    const beforePassiveScroll = await window.locator('.pdf-scroll').evaluate((element) => element.scrollTop)
    await window.locator('.markdown-scroll').evaluate((element) => {
      element.scrollTop = element.scrollHeight
      element.dispatchEvent(new Event('scroll', { bubbles: true }))
    })
    await window.waitForTimeout(100)
    const afterPassiveScroll = await window.locator('.pdf-scroll').evaluate((element) => element.scrollTop)
    expect(afterPassiveScroll).toBe(beforePassiveScroll)

    await window.getByText('JSON', { exact: true }).click()
    await expect(window.locator('.json-view')).toBeVisible()
    await expect(window.locator('.markdown-block')).toHaveCount(0)
    await window.locator('[data-block-position="1-0"]').click()
    await expect(window.locator('.json-view')).toBeVisible()

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
    await expect(window.locator('.markdown-scroll')).toHaveAttribute('data-render-state', 'ready', { timeout: 30_000 })
    const markdownImages = window.locator('.markdown-body img')
    if (await markdownImages.count()) {
      await expect.poll(() => markdownImages.evaluateAll((images) =>
        images.every((image) => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0)
      )).toBe(true)
    }
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

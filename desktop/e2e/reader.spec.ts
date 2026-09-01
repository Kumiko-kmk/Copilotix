import { _electron as electron, expect, test, type Locator, type Page } from '@playwright/test'
import { join } from 'node:path'
import { createE2EWorkspace, seedReaderTask } from './helpers'

const FIXTURE_TRANSLATED_MARKDOWN = [
  '# 测试文档',
  '<sub>艾达·洛夫莱斯</sub>和艾伦·图灵',
  '摘要 | 独立映射的摘要。',
  '第一页在第二栏继续。<sup>12</sup> 水是 H<sub>2</sub>O。',
  '第二段落包含 $E=mc^2$。',
  '<table><tbody><tr><td>学术单元格</td></tr></tbody></table>',
  '![测试图片](images/fixture.png)'
].join('\n\n')

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
    translatedMarkdown: FIXTURE_TRANSLATED_MARKDOWN,
    legacyTranslationManifest: true
  })
  const app = await electron.launch({ args: [join(__dirname, '../out/main/index.js')], env: workspace.env })
  try {
    const window = await app.firstWindow()
    await openPaper(window, taskId)
    const activeTextPanel = window.locator('.reader-tab-panel.active')
    await expect(window.getByText('1 / 2')).toBeVisible()
    await expect.poll(() => window.locator('.pdf-page canvas').first().evaluate((canvas) => (canvas as HTMLCanvasElement).width)).toBeGreaterThan(0)
    await expect(window.locator('.pdf-block')).toHaveCount(8)
    await expect(window.locator('.pdf-block-label')).toHaveCount(8)
    await expect(window.locator('.pdf-merge-layer line')).toHaveCount(1)
    await expect(activeTextPanel.locator('.markdown-scroll')).toHaveAttribute('data-render-state', 'ready')
    await expect(activeTextPanel.locator('.markdown-body sup')).toHaveText('12')
    await expect(activeTextPanel.locator('.markdown-body sub', { hasText: /^2$/ })).toHaveText('2')
    await expect(activeTextPanel.locator('.markdown-body td')).toHaveText('Academic cell')
    await expect(activeTextPanel.locator('.markdown-body .katex')).toBeVisible()
    const markdownImage = activeTextPanel.locator('.markdown-body img')
    await expect.poll(() => markdownImage.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    const stableImageRect = await markdownImage.boundingBox()
    await window.waitForTimeout(200)
    const settledImageRect = await markdownImage.boundingBox()
    if (!stableImageRect || !settledImageRect) throw new Error('Markdown image is not visible after render readiness')
    expect(settledImageRect.y).toBeCloseTo(stableImageRect.y, 1)
    expect(settledImageRect.height).toBeCloseTo(stableImageRect.height, 1)
    const originalBlockCount = await activeTextPanel.locator('.markdown-block').count()
    const sourceBlockId = await window.locator('[data-block-position="0-3"]').getAttribute('data-block-id')
    const continuationBlockId = await window.locator('[data-block-position="0-4"]').getAttribute('data-block-id')
    expect(continuationBlockId).toBe(sourceBlockId)
    const borderColor = await window.locator('[data-block-position="0-4"]').evaluate((element) => getComputedStyle(element).borderTopColor)
    expect(borderColor).not.toBe('rgba(0, 0, 0, 0)')

    await activeTextPanel.locator('.markdown-block', { hasText: 'Second paragraph with' }).click()
    await expect(window.getByText('2 / 2')).toBeVisible()
    await expect(window.locator('[data-block-position="1-0"]')).toHaveClass(/active/)
    await expect.poll(() => isCentered(window.locator('[data-block-position="1-0"]'), '.pdf-scroll')).toBe(true)

    await window.locator('[data-block-position="0-4"]').click()
    await expect.poll(() => isCentered(activeTextPanel.locator('.markdown-block', { hasText: 'First page continues in second column.' }), '.markdown-scroll')).toBe(true)
    await expect(window.locator('[data-block-position="0-3"]')).toHaveClass(/active/)
    await expect(window.locator('[data-block-position="0-4"]')).toHaveClass(/active/)

    const markdownImageBlock = activeTextPanel.locator('.markdown-block:has(img)')
    const markdownImageMapping = await markdownImageBlock.getAttribute('data-block-ids')
    const pdfImageMapping = await window.locator('[data-block-position="1-2"]').getAttribute('data-block-id')
    expect(markdownImageMapping).toContain(pdfImageMapping)
    await markdownImage.click()
    await expect(window.locator('[data-block-position="1-2"]')).toHaveClass(/active/)
    await expect.poll(() => isCentered(window.locator('[data-block-position="1-2"]'), '.pdf-scroll')).toBe(true)
    await window.locator('[data-block-position="1-2"]').click()
    await expect.poll(() => isCentered(markdownImageBlock, '.markdown-scroll')).toBe(true)

    await window.evaluate(() => {
      Object.defineProperty(window, '__mineruOriginalMarkdownScroller', {
        value: document.querySelector('[data-reader-tab-panel="original"] .markdown-scroll'),
        configurable: true
      })
    })
    await window.getByText('Markdown（中文）').click()
    await expect(activeTextPanel.locator('.markdown-scroll')).toHaveAttribute('data-render-state', 'ready')
    await expect(activeTextPanel.locator('.markdown-block')).toHaveCount(originalBlockCount)
    expect(await window.evaluate(() =>
      document.querySelector('[data-reader-tab-panel="original"] .markdown-scroll') ===
      Reflect.get(window, '__mineruOriginalMarkdownScroller')
    )).toBe(true)
    await expect(activeTextPanel.locator('.markdown-body sup')).toHaveText('12')
    await expect(activeTextPanel.locator('.markdown-body sub', { hasText: /^2$/ })).toHaveText('2')
    await expect(activeTextPanel.locator('.markdown-body td')).toHaveText('学术单元格')
    await expect(activeTextPanel.locator('.markdown-body .katex')).toBeVisible()
    const translatedAuthors = activeTextPanel.locator('.markdown-block', { hasText: '艾达·洛夫莱斯' })
    const translatedAbstract = activeTextPanel.locator('.markdown-block', { hasText: '独立映射的摘要' })
    await expect(translatedAuthors).not.toContainText('独立映射的摘要')
    await translatedAuthors.click()
    await expect(window.locator('[data-block-position="0-1"]')).toHaveClass(/active/)
    await expect(window.locator('[data-block-position="0-2"]')).not.toHaveClass(/active/)
    await translatedAbstract.click()
    await expect(window.locator('[data-block-position="0-2"]')).toHaveClass(/active/)
    await expect(window.locator('[data-block-position="0-1"]')).not.toHaveClass(/active/)
    await expect(activeTextPanel.locator('.markdown-block', { hasText: '第二段落包含' })).toBeVisible()
    await activeTextPanel.locator('.markdown-block', { hasText: '第二段落包含' }).click()
    await expect(window.locator('[data-block-position="1-0"]')).toHaveClass(/active/)
    await expect.poll(() => isCentered(window.locator('[data-block-position="1-0"]'), '.pdf-scroll')).toBe(true)
    await window.locator('[data-block-position="1-0"]').click()
    await expect.poll(() => isCentered(activeTextPanel.locator('.markdown-block', { hasText: '第二段落包含' }), '.markdown-scroll')).toBe(true)

    const beforePassiveScroll = await window.locator('.pdf-scroll').evaluate((element) => element.scrollTop)
    await activeTextPanel.locator('.markdown-scroll').evaluate((element) => {
      element.scrollTop = element.scrollHeight
      element.dispatchEvent(new Event('scroll', { bubbles: true }))
    })
    await window.waitForTimeout(100)
    const afterPassiveScroll = await window.locator('.pdf-scroll').evaluate((element) => element.scrollTop)
    expect(afterPassiveScroll).toBe(beforePassiveScroll)

    await window.getByText('JSON', { exact: true }).click()
    await expect(activeTextPanel.locator('.json-view')).toBeVisible()
    await expect(activeTextPanel.locator('.markdown-block')).toHaveCount(0)
    await window.locator('[data-block-position="1-0"]').click()
    await expect(activeTextPanel.locator('.json-view')).toBeVisible()
    await window.getByText('Markdown（中文）').click()
    await expect(activeTextPanel.locator('.markdown-block', { hasText: '第二段落包含' })).toBeVisible()

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

test('restores discarded headers, footnotes, footers and page numbers as gray display-only content', async () => {
  const workspace = await createE2EWorkspace()
  const taskId = await seedReaderTask(workspace, {
    supplementalBlocks: true,
    translatedMarkdown: FIXTURE_TRANSLATED_MARKDOWN,
    legacyTranslationManifest: true
  })
  const app = await electron.launch({ args: [join(__dirname, '../out/main/index.js')], env: workspace.env })
  try {
    const window = await app.firstWindow()
    await openPaper(window, taskId)
    const activeTextPanel = window.locator('.reader-tab-panel.active')
    await expect(activeTextPanel.locator('.markdown-scroll')).toHaveAttribute('data-render-state', 'ready')

    await expect(activeTextPanel.locator('[data-reader-role="page-header"]')).toHaveText([
      'Fixture journal header',
      'Fixture running header'
    ])
    const footnote = activeTextPanel.locator('[data-reader-role="footnote"]')
    await expect(footnote).toHaveText('*. Fixture conference footnote')
    await expect(footnote.locator('sub')).toHaveText('*')
    await expect(activeTextPanel.locator('[data-reader-role="page-footer"]')).toHaveText([
      'Fixture author footer',
      'Fixture ending footer'
    ])
    await expect(activeTextPanel.locator('[data-reader-role="page-number"]')).toHaveCount(0)
    await expect(activeTextPanel.locator('[data-reader-role="page-divider"]')).toHaveText(['第 1 页', '第 2 页'])

    const headerColor = await activeTextPanel.locator('[data-reader-role="page-header"]').first()
      .evaluate((element) => getComputedStyle(element).color)
    expect(headerColor).toBe('rgb(150, 156, 168)')

    await expect(activeTextPanel.locator('.markdown-supplemental[data-block-ids]')).toHaveCount(0)
    await expect(window.locator('.pdf-block.discarded.active')).toHaveCount(0)
    await footnote.click()
    await activeTextPanel.locator('[data-reader-role="page-divider"]', { hasText: '第 1 页' }).click()
    await expect(window.getByText('1 / 2')).toBeVisible()
    await expect(window.locator('.pdf-block.discarded.active')).toHaveCount(0)
    await expect(activeTextPanel.locator('.markdown-block.active')).toHaveCount(0)

    await window.getByText('Markdown（中文）').click()
    await expect(activeTextPanel.locator('.markdown-scroll')).toHaveAttribute('data-render-state', 'ready')
    await expect(activeTextPanel.locator('[data-reader-role="page-header"]')).toHaveText([
      'Fixture journal header',
      'Fixture running header'
    ])
    await expect(activeTextPanel.locator('[data-reader-role="footnote"] sub')).toHaveText('*')
    await expect(activeTextPanel.locator('[data-reader-role="page-footer"]')).toHaveText([
      'Fixture author footer',
      'Fixture ending footer'
    ])
    await expect(activeTextPanel.locator('[data-reader-role="page-number"]')).toHaveText(['315', '316'])
    await expect(activeTextPanel.locator('[data-reader-role="page-divider"]')).toHaveText(['第 1 页', '第 2 页'])
    await activeTextPanel.locator('.markdown-block', { hasText: '第二段落包含' }).click()
    await expect(window.locator('[data-block-position="1-1"]')).toHaveClass(/active/)
  } finally {
    await app.close()
    await workspace.cleanup()
  }
})

test('keeps repeated short phrases in source order and maps each one to one PDF block', async () => {
  const workspace = await createE2EWorkspace()
  const taskId = await seedReaderTask(workspace, { alignmentRegression: true })
  const app = await electron.launch({ args: [join(__dirname, '../out/main/index.js')], env: workspace.env })
  try {
    const window = await app.firstWindow()
    await openPaper(window, taskId)
    const activeTextPanel = window.locator('.reader-tab-panel.active')
    await expect(activeTextPanel.locator('.markdown-scroll')).toHaveAttribute('data-render-state', 'ready')

    const markdownBlocks = activeTextPanel.locator('.markdown-block')
    await expect(markdownBlocks).toHaveCount(7)
    expect(await markdownBlocks.allTextContents()).toEqual([
      'Alignment regression',
      'The abstract explains what happens then and furthermore motivates the method.',
      'Keywords: operators',
      'Then',
      'First equation explanation.',
      'Furthermore,',
      'Furthermore,'
    ])

    const mappingIds = await markdownBlocks.evaluateAll((elements) => elements.flatMap((element) =>
      (element.getAttribute('data-block-ids') ?? '').split(/\s+/).filter(Boolean)
    ))
    expect(new Set(mappingIds).size).toBe(mappingIds.length)

    await expect(window.locator('[data-block-position="1-0"]')).toBeAttached()
    await markdownBlocks.filter({ hasText: /^Then$/ }).click()
    await expect(window.getByText('2 / 2')).toBeVisible({ timeout: 10_000 })
    await expect(window.locator('.pdf-block.active')).toHaveCount(1)
    await expect(window.locator('[data-block-position="1-0"]')).toHaveClass(/active/)

    const furthermoreBlocks = markdownBlocks.filter({ hasText: /^Furthermore,$/ })
    await furthermoreBlocks.nth(0).click()
    await expect(window.locator('.pdf-block.active')).toHaveCount(1)
    await expect(window.locator('[data-block-position="1-2"]')).toHaveClass(/active/)
    await furthermoreBlocks.nth(1).click()
    await expect(window.locator('.pdf-block.active')).toHaveCount(1)
    await expect(window.locator('[data-block-position="1-3"]')).toHaveClass(/active/)
  } finally {
    await app.close()
    await workspace.cleanup()
  }
})

test('shows a recoverable error when the local PDF is missing', async () => {
  const workspace = await createE2EWorkspace()
  const taskId = await seedReaderTask(workspace, { missingPdf: true })
  const app = await electron.launch({ args: [join(__dirname, '../out/main/index.js')], env: workspace.env })
  try {
    const window = await app.firstWindow()
    await openPaper(window, taskId)
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
  const taskId = await seedReaderTask(workspace, { sourcePdf: sourcePdf! })
  const app = await electron.launch({ args: [join(__dirname, '../out/main/index.js')], env: workspace.env })
  try {
    const window = await app.firstWindow()
    await openPaper(window, taskId)
    await expect(window.locator('.pdf-page canvas').first()).toBeVisible()
    await expect.poll(() => window.locator('.pdf-page canvas').first().evaluate((canvas) => (canvas as HTMLCanvasElement).width)).toBeGreaterThan(0)
  } finally {
    await app.close()
    await workspace.cleanup()
  }
})

test('renders and safely links an optional real MinerU task', async () => {
  const sourceTaskDir = process.env.MINERU_E2E_REAL_TASK_DIR
  test.skip(!sourceTaskDir, 'Set MINERU_E2E_REAL_TASK_DIR for the local layout acceptance check')
  const workspace = await createE2EWorkspace()
  const taskId = await seedReaderTask(workspace, { sourceTaskDir: sourceTaskDir! })
  const app = await electron.launch({ args: [join(__dirname, '../out/main/index.js')], env: workspace.env })
  try {
    const window = await app.firstWindow()
    await openPaper(window, taskId)
    const activeTextPanel = window.locator('.reader-tab-panel.active')
    await expect.poll(
      () => window.locator('.pdf-page canvas').first().evaluate((canvas) => (canvas as HTMLCanvasElement).width),
      { timeout: 30_000 }
    ).toBeGreaterThan(0)
    await expect(window.locator('.pdf-block').first()).toBeVisible()
    expect(await window.locator('.pdf-block').count()).toBeGreaterThan(100)
    const markdownBlocks = activeTextPanel.locator('.markdown-block')
    await expect(markdownBlocks).toHaveCount(1110)
    await expect(activeTextPanel.locator('.markdown-block[data-block-ids=""]')).toHaveCount(1)
    await expect(activeTextPanel.locator('[data-reader-role="page-number"]')).toHaveCount(0)
    const assignedIds = await markdownBlocks.evaluateAll((elements) => elements.flatMap((element) =>
      (element.getAttribute('data-block-ids') ?? '').split(/\s+/).filter(Boolean)
    ))
    expect(new Set(assignedIds).size).toBe(assignedIds.length)
    await expect(activeTextPanel.locator('.markdown-scroll')).toHaveAttribute('data-render-state', 'ready', { timeout: 30_000 })
    const markdownImages = activeTextPanel.locator('.markdown-body img')
    if (await markdownImages.count()) {
      await expect.poll(() => markdownImages.evaluateAll((images) =>
        images.every((image) => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0)
      )).toBe(true)
    }
    await window.getByText('Markdown（中文）').click()
    await expect(activeTextPanel.locator('.markdown-scroll')).toHaveAttribute('data-render-state', 'ready', { timeout: 30_000 })
    await expect(activeTextPanel.locator('.markdown-block')).toHaveCount(1110)
    await expect(activeTextPanel.locator('.markdown-block[data-block-ids=""]')).toHaveCount(1)
    await expect.poll(() => activeTextPanel.locator('[data-reader-role="page-number"]').count()).toBeGreaterThan(0)
    await expect(activeTextPanel.locator('[data-reader-role="page-divider"]')).toHaveCount(97)
    const translatedMappedBlock = activeTextPanel.locator('.markdown-block:not([data-block-ids=""])').first()
    const translatedMappingId = (await translatedMappedBlock.getAttribute('data-block-ids'))?.split(/\s+/)[0]
    expect(translatedMappingId).toBeTruthy()
    await translatedMappedBlock.click()
    await expect(window.locator(`[data-block-id="${translatedMappingId}"]`).first()).toHaveClass(/active/)
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

async function openPaper(window: Page, taskId: string): Promise<void> {
  await window.locator('[data-edge-dock="bottom"]').hover()
  const item = window.locator(`[data-paper-task-id="${taskId}"]`)
  await expect(item).toBeVisible()
  await item.click()
}

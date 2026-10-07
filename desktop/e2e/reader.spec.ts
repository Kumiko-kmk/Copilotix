import { chromium, expect, test, type Locator, type Page } from '@playwright/test'
import { execFileSync, spawn } from 'node:child_process'
import { join } from 'node:path'
import { createE2EWorkspace, launchElectron, seedReaderTask } from './helpers'
import type { ReaderAnnotationSnapshot } from '../src/shared/ipcSchemas'
import type { CopilotixDesktopApi } from '../src/shared/types'

const FIXTURE_TRANSLATED_MARKDOWN = [
  '# 测试文档',
  '<sub>艾达·洛夫莱斯</sub>和艾伦·图灵',
  '摘要 | 独立映射的摘要。',
  '第一页在第二栏继续。<sup>12</sup> 水是 H<sub>2</sub>O。',
  '第二段落包含 $E=mc^2$。',
  '<table><tbody><tr><td>学术单元格</td></tr></tbody></table>',
  '![测试图片](images/fixture.png)'
].join('\n\n')

const COMPACT_TABLE_SOURCE = '<table><tbody><tr><td>Academic cell</td><td>123,456,789</td><td>223,456,789</td><td>323,456,789</td><td>423,456,789</td><td>523,456,789</td><td>623,456,789</td><td>723,456,789</td><td>823,456,789</td><td>923,456,789</td><td>1,023,456,789</td><td>1,123,456,789</td></tr><tr><td>$x$</td><td>$$y$$</td><td>\\(z\\)</td><td>\\[w\\]</td><td colspan="8">Symbols ± ≤ ≥</td></tr></tbody></table>'
const COMPACT_TABLE_TRANSLATED = COMPACT_TABLE_SOURCE.replace('Academic cell', '学术单元格')
const COMPACT_MARKDOWN_SOURCE = [
  '# Compact table fixture',
  'Ada Lovelace and Alan Turing',
  'A separately mapped summary.',
  'First page continues in second column.',
  'Paragraph formula $E=mc^2$.',
  COMPACT_TABLE_SOURCE,
  '![Fixture image](images/fixture.png)'
].join('\n\n')
const COMPACT_MARKDOWN_TRANSLATED = [
  '# 紧凑表格测试',
  '艾达·洛夫莱斯和艾伦·图灵',
  '独立映射的摘要。',
  '第一页在第二栏继续。',
  '段落公式 $E=mc^2$。',
  COMPACT_TABLE_TRANSLATED,
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

async function selectText(locator: Locator, startOffset: number, endOffset: number): Promise<void> {
  await locator.scrollIntoViewIfNeeded()
  // Tab activation commits before its passive selection listener. Recreate the
  // user selection until that listener has accepted it, rather than racing the
  // inactive pane's pending selection cleanup on a slower CI desktop.
  await expect(async () => {
    await locator.evaluate((element, offsets) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      const nodes: Text[] = []
      let node = walker.nextNode()
      while (node) {
        nodes.push(node as Text)
        node = walker.nextNode()
      }
      const locate = (target: number): { node: Text; offset: number } => {
        let consumed = 0
        for (const textNode of nodes) {
          if (target <= consumed + textNode.data.length) return { node: textNode, offset: target - consumed }
          consumed += textNode.data.length
        }
        throw new Error('Selection offset exceeds rendered text')
      }
      const start = locate(offsets.startOffset)
      const end = locate(offsets.endOffset)
      const range = document.createRange()
      range.setStart(start.node, start.offset)
      range.setEnd(end.node, end.offset)
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
    }, { startOffset, endOffset })
    await expect(locator.page().getByRole('toolbar', { name: '文本标注' })).toBeVisible({ timeout: 500 })
  }).toPass({ timeout: 5_000 })
}

test('renders compact scrollable tables and independent real formula minimaps', async () => {
  const workspace = await createE2EWorkspace()
  const taskId = await seedReaderTask(workspace, {
    sourceMarkdown: COMPACT_MARKDOWN_SOURCE,
    translatedMarkdown: COMPACT_MARKDOWN_TRANSLATED
  })
  const app = await launchElectron({ args: [join(__dirname, '../out/main/index.js')], env: workspace.env })
  try {
    const window = await app.firstWindow()
    await openPaper(window, taskId)
    const activeTextPanel = window.locator('.reader-tab-panel.active')
    await assertCompactMarkdownLayout(activeTextPanel)

    await window.evaluate(() => {
      Object.defineProperty(window, '__copilotixCompactOriginalArticle', {
        value: document.querySelector('.reader-tab-panel.active article'),
        configurable: true
      })
    })
    await window.getByText('Markdown（中文）').click()
    await assertCompactMarkdownLayout(activeTextPanel)
    await expect(activeTextPanel.locator('article')).not.toHaveText(/Academic cell/u)
    expect(await window.evaluate(() =>
      document.querySelector('.reader-tab-panel.active article') !==
      Reflect.get(window, '__copilotixCompactOriginalArticle')
    )).toBe(true)
  } finally {
    await app.close()
    await workspace.cleanup()
  }
})

async function assertCompactMarkdownLayout(activeTextPanel: Locator): Promise<void> {
  await expect(activeTextPanel.locator('.markdown-scroll')).toHaveAttribute('data-render-state', 'ready')
  await expect(activeTextPanel.locator('.markdown-body')).toHaveCSS('padding-top', '15px')
  await expect(activeTextPanel.locator('.markdown-body h1')).toHaveCSS('margin-top', '4px')
  await expect(activeTextPanel.locator('.markdown-body h1')).toHaveCSS('margin-bottom', '11px')
  await expect(activeTextPanel.locator('.markdown-body .markdown-block > p').first()).toHaveCSS('margin-top', '3px')
  await expect(activeTextPanel.locator('.markdown-body .markdown-block > p').first()).toHaveCSS('margin-bottom', '3px')
  await expect(activeTextPanel.locator('.markdown-body td .katex')).toHaveCount(4)
  await expect(activeTextPanel.locator('.markdown-minimap-formula .katex')).toHaveCount(5)
  await expect(activeTextPanel.locator('.markdown-body table')).not.toContainText('$x$')
  const minimapWidth = await activeTextPanel.locator('.markdown-minimap').evaluate((element) => element.getBoundingClientRect().width)
  expect(minimapWidth).toBeCloseTo(60, 0)
  const tableMetrics = await activeTextPanel.locator('.markdown-table-scroll').evaluate((element) => {
    const cell = element.querySelector('td')!
    const bounds = cell.getBoundingClientRect()
    const style = getComputedStyle(cell)
    return {
      cellHeight: bounds.height,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      fontSize: style.fontSize,
      lineHeight: style.lineHeight,
      paddingBlock: `${style.paddingTop} ${style.paddingBottom}`
    }
  })
  expect(tableMetrics.cellHeight).toBeGreaterThanOrEqual(23)
  expect(tableMetrics.cellHeight).toBeLessThanOrEqual(29)
  expect(tableMetrics.scrollWidth).toBeGreaterThan(tableMetrics.clientWidth)
  expect(tableMetrics).toMatchObject({ fontSize: '13px', paddingBlock: '3px 3px' })
}

test('fits PDF pages without an outer frame and preserves the current page while resizing', async () => {
  const workspace = await createE2EWorkspace()
  const taskId = await seedReaderTask(workspace, { sourcePdf: join(__dirname, '../resources/tutorial/Attention Is All You Need.pdf') })
  const app = await launchElectron({ args: [join(__dirname, '../out/main/index.js')], env: workspace.env })
  try {
    const window = await app.firstWindow()
    await openPaper(window, taskId)
    const scroller = window.locator('.pdf-scroll')
    await expect(window.getByText('1 / 15')).toBeVisible()
    await expect.poll(() => window.locator('[data-pdf-page="1"] canvas').evaluate((canvas) => (canvas as HTMLCanvasElement).width)).toBeGreaterThan(0)
    await expect(scroller).toHaveCSS('padding', '0px')
    await expect(scroller).toHaveCSS('border-left-width', '0px')
    await expect(window.locator('.pdf-page').first()).toHaveCSS('box-shadow', 'none')
    await expect.poll(() => scroller.evaluate((element) =>
      Math.abs(element.querySelector('.pdf-page')!.getBoundingClientRect().width - element.clientWidth)
    )).toBeLessThan(1)
    await scroller.evaluate((element) => {
      const page = element.querySelector('[data-pdf-page="1"]')!.getBoundingClientRect()
      const viewport = element.getBoundingClientRect()
      element.scrollTo({ top: element.scrollTop + page.top - viewport.top + page.height * 0.35 - element.clientHeight * 0.45, behavior: 'instant' })
    })
    await expect(window.getByText('2 / 15')).toBeVisible()
    const expectReadingPosition = async (): Promise<void> => {
      await expect(window.getByText('2 / 15')).toBeVisible()
      await expect.poll(() => scroller.evaluate((element) => {
        const page = element.querySelector('[data-pdf-page="1"]')!.getBoundingClientRect()
        const viewport = element.getBoundingClientRect()
        return Math.abs((viewport.top + element.clientHeight * 0.45 - page.top) / page.height - 0.35)
      })).toBeLessThan(0.01)
    }
    const split = window.getByRole('separator', { name: '调整 PDF 与 Markdown 阅读器宽度' })
    for (const key of ['Home', 'End', 'Home', 'End']) {
      const previousWidth = await scroller.evaluate((element) => element.clientWidth)
      await split.press(key)
      await expect.poll(() => scroller.evaluate((element) => element.clientWidth)).not.toBe(previousWidth)
      await expectReadingPosition()
    }
    const handle = (await split.boundingBox())!
    const area = (await window.locator('.reader-split').boundingBox())!
    await window.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
    await window.mouse.down()
    for (const percent of [0.42, 0.58, 0.45]) {
      await window.mouse.move(area.x + area.width * percent, handle.y + handle.height / 2, { steps: 12 })
      await expectReadingPosition()
    }
    await window.mouse.up()
    await window.getByLabel('放大').click()
    await expect(window.getByText('110%')).toBeVisible()
    await expectReadingPosition()
  } finally {
    await app.close()
    await workspace.cleanup()
  }
})

test('uses the entire PDF viewport without scrollbar gutters or page gaps on a real paper', async ({}, testInfo) => {
  const workspace = await createE2EWorkspace()
  const taskId = await seedReaderTask(workspace, { sourcePdf: join(__dirname, '../resources/tutorial/Attention Is All You Need.pdf') })
  const app = await launchElectron({ args: [join(__dirname, '../out/main/index.js')], env: workspace.env })
  try {
    const window = await app.firstWindow()
    await openPaper(window, taskId)
    const scroller = window.locator('.pdf-scroll')
    await expect(window.getByText('1 / 15')).toBeVisible()
    await expect.poll(() => window.locator('[data-pdf-page="1"] canvas').evaluate((canvas) => (canvas as HTMLCanvasElement).width)).toBeGreaterThan(0)
    const expectNoGutters = async (): Promise<void> => {
      const dimensions = await scroller.evaluate((element) => {
        const parent = element.parentElement!.getBoundingClientRect()
        const bounds = element.getBoundingClientRect()
        return { rightGutter: element.offsetWidth - element.clientWidth, bottomGutter: element.offsetHeight - element.clientHeight,
          rightInset: parent.right - bounds.right, bottomInset: parent.bottom - bounds.bottom }
      })
      expect(dimensions).toEqual({ rightGutter: 0, bottomGutter: 0, rightInset: 0, bottomInset: 0 })
    }
    await expectNoGutters()
    expect(await window.locator('.reader-split').evaluate((element) => {
      const panes = element.querySelectorAll('.reader-split-pane')
      return Math.abs(panes[1]!.getBoundingClientRect().left - panes[0]!.getBoundingClientRect().right)
    })).toBeLessThan(0.1)
    await expect(window.locator('.reader-split-handle')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await expect.poll(() => scroller.evaluate((element) => {
      const page = element.querySelector('.pdf-page')!.getBoundingClientRect()
      return Math.abs(page.right - element.getBoundingClientRect().right)
    })).toBeLessThan(1)
    await expect.poll(() => window.locator('[data-pdf-page="0"]').evaluate((page) => {
      const next = page.parentElement!.querySelector('[data-pdf-page="1"]')!
      return Math.abs(next.getBoundingClientRect().top - page.getBoundingClientRect().bottom)
    })).toBeLessThan(0.1)
    await scroller.evaluate((element) => {
      const next = element.querySelector('[data-pdf-page="1"]')!.getBoundingClientRect()
      element.scrollTo({ top: element.scrollTop + next.top - element.getBoundingClientRect().top - element.clientHeight * 0.7, behavior: 'instant' })
    })
    await window.mouse.move(20, 20)
    await window.locator('.pdf-viewport').screenshot({ path: testInfo.outputPath('pdf-no-frame-100.png') })
    await window.getByLabel('放大', { exact: true }).click()
    await window.getByLabel('放大', { exact: true }).click()
    await expect(window.getByText('120%')).toBeVisible()
    await expect.poll(() => scroller.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true)
    await expectNoGutters()
    const viewport = (await scroller.boundingBox())!
    await window.mouse.move(viewport.x + viewport.width - 1, viewport.y + viewport.height - 1)
    const vertical = window.getByRole('scrollbar', { name: 'PDF 垂直滚动' })
    const horizontal = window.getByRole('scrollbar', { name: 'PDF 水平滚动' })
    await expect(vertical).toHaveClass(/visible/)
    await expect(horizontal).toHaveClass(/visible/)
    await expectNoGutters()
    const oldLeft = await scroller.evaluate((element) => element.scrollLeft)
    const horizontalThumb = (await horizontal.locator('.pdf-scrollbar-thumb').boundingBox())!
    await window.mouse.move(horizontalThumb.x + horizontalThumb.width / 2, horizontalThumb.y + horizontalThumb.height / 2)
    await window.mouse.down()
    await window.mouse.move(horizontalThumb.x + horizontalThumb.width / 2 + 25, horizontalThumb.y + horizontalThumb.height / 2, { steps: 5 })
    await window.mouse.up()
    await expect.poll(() => scroller.evaluate((element) => element.scrollLeft)).toBeGreaterThan(oldLeft)
    await window.mouse.move(viewport.x + viewport.width - 1, viewport.y + viewport.height / 2)
    const oldTop = await scroller.evaluate((element) => element.scrollTop)
    const verticalThumb = (await vertical.locator('.pdf-scrollbar-thumb').boundingBox())!
    await window.mouse.move(verticalThumb.x + verticalThumb.width / 2, verticalThumb.y + verticalThumb.height / 2)
    await window.mouse.down()
    await window.mouse.move(verticalThumb.x + verticalThumb.width / 2, verticalThumb.y + verticalThumb.height / 2 + 25, { steps: 5 })
    await window.mouse.up()
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(oldTop)
    await window.mouse.move(20, 20)
    await expect(vertical).not.toHaveClass(/visible/)
    await expect(horizontal).not.toHaveClass(/visible/)
    await expect(vertical).toHaveCSS('opacity', '0')
    await expect(horizontal).toHaveCSS('opacity', '0')
    await expectNoGutters()
    await window.locator('.pdf-viewport').screenshot({ path: testInfo.outputPath('pdf-no-frame-120.png') })
    await vertical.press('End')
    await expect(window.getByText('15 / 15')).toBeVisible()
    await expect.poll(() => scroller.evaluate((element) => {
      const last = element.querySelector('[data-pdf-page="14"]')!.getBoundingClientRect()
      return Math.abs(last.bottom - element.getBoundingClientRect().bottom)
    })).toBeLessThan(1)
    await expectNoGutters()
  } finally {
    await app.close()
    await workspace.cleanup()
  }
})

test('renders a local PDF with range requests before parsing succeeds', async () => {
  const workspace = await createE2EWorkspace()
  const taskId = await seedReaderTask(workspace, {
    translatedMarkdown: FIXTURE_TRANSLATED_MARKDOWN
  })
  const app = await launchElectron({ args: [join(__dirname, '../out/main/index.js')], env: workspace.env })
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
    await expect(activeTextPanel.locator('.markdown-body .katex').first()).toBeVisible()
    await expect(activeTextPanel.locator('.markdown-body .katex-error')).toHaveCount(0)
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

    await window.getByText('Markdown（中文）').click()
    await expect(activeTextPanel.locator('.markdown-scroll')).toHaveAttribute('data-render-state', 'ready')
    await expect(activeTextPanel.locator('.markdown-block')).toHaveCount(originalBlockCount)
    await expect(window.locator('[data-reader-tab-panel="original"] .markdown-scroll')).toHaveCount(0)
    await expect(activeTextPanel.locator('.markdown-body sup')).toHaveText('12')
    await expect(activeTextPanel.locator('.markdown-body sub', { hasText: /^2$/ })).toHaveText('2')
    await expect(activeTextPanel.locator('.markdown-body td')).toHaveText('学术单元格')
    await expect(activeTextPanel.locator('.markdown-body .katex').first()).toBeVisible()
    await expect(activeTextPanel.locator('.markdown-body .katex-error')).toHaveCount(0)
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

    await expect(window.getByText('JSON', { exact: true })).toHaveCount(0)
    await expect(window.locator('[data-reader-tab-panel="json"]')).toHaveCount(0)
    await expect(activeTextPanel.locator('.markdown-block', { hasText: '第二段落包含' })).toBeVisible()

    const rangeResult = await window.evaluate(async (url) => {
      const response = await fetch(url, { headers: { Range: 'bytes=0-3' } })
      return {
        status: response.status,
        contentRange: response.headers.get('content-range'),
        bytes: [...new Uint8Array(await response.arrayBuffer())]
      }
    }, `copilotix-asset://${taskId}/original.pdf`)
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

test('persists original and translated Markdown annotations with color and underline isolation', async () => {
  const workspace = await createE2EWorkspace()
  const taskId = await seedReaderTask(workspace, {
    translatedMarkdown: FIXTURE_TRANSLATED_MARKDOWN
  })
  const app = await launchElectron({ args: [join(__dirname, '../out/main/index.js')], env: workspace.env })
  try {
    const window = await app.firstWindow()
    await openPaper(window, taskId)
    let activeTextPanel = window.locator('.reader-tab-panel.active')
    await expect(activeTextPanel.locator('.markdown-scroll')).toHaveAttribute('data-render-state', 'ready')
    const originalBlock = activeTextPanel.locator('.markdown-block', { hasText: 'Second paragraph with' })
    await selectText(originalBlock, 0, 6)
    await expect(window.getByRole('toolbar', { name: '文本标注' })).toBeVisible()
    await window.getByRole('button', { name: '荧光笔高亮' }).click({ button: 'right' })
    await expect(window.getByRole('option')).toHaveCount(5)
    await window.getByRole('option', { name: '选择蓝色' }).click()
    await expect(window.getByRole('toolbar', { name: '文本标注' })).toBeVisible()
    await window.getByRole('button', { name: '荧光笔高亮' }).click()
    await expect.poll(() => window.evaluate(async (id) => {
      const values = await (window as unknown as { copilotix: CopilotixDesktopApi }).copilotix.listReaderAnnotations({ documentId: id, view: 'original' })
      return values.annotations.map((value) => [value.view, value.kind, value.color, value.quote])
    }, taskId)).toEqual([['original', 'highlight', 'blue', 'Second']])

    await window.reload()
    await openPaper(window, taskId)
    activeTextPanel = window.locator('.reader-tab-panel.active')
    await expect(activeTextPanel.locator('.markdown-scroll')).toHaveAttribute('data-render-state', 'ready')
    await expect.poll(() => window.evaluate(() =>
      (CSS as typeof CSS & { highlights?: { get(name: string): { size: number } | undefined } }).highlights?.get('copilotix-highlight-blue')?.size ?? 0
    )).toBeGreaterThan(0)

    await window.getByText('Markdown（中文）').click()
    activeTextPanel = window.locator('.reader-tab-panel.active')
    await expect(activeTextPanel.locator('.markdown-scroll')).toHaveAttribute('data-render-state', 'ready')
    const translatedBlock = activeTextPanel.locator('.markdown-block', { hasText: '第二段落包含' })
    await selectText(translatedBlock, 0, 4)
    await window.getByRole('button', { name: '添加下划线' }).click()
    await expect.poll(() => window.evaluate(async (id) => {
      const values = await Promise.all([
        (window as unknown as { copilotix: CopilotixDesktopApi }).copilotix.listReaderAnnotations({ documentId: id, view: 'original' }),
        (window as unknown as { copilotix: CopilotixDesktopApi }).copilotix.listReaderAnnotations({ documentId: id, view: 'translated' })
      ])
      return values.flatMap((snapshot: ReaderAnnotationSnapshot) => snapshot.annotations.map((value) => [value.view, value.kind, value.quote]))
    }, taskId)).toEqual([
      ['original', 'highlight', 'Second'],
      ['translated', 'underline', '第二段落']
    ])

    await window.getByText('Markdown', { exact: true }).click()
    activeTextPanel = window.locator('.reader-tab-panel.active')
    await expect(activeTextPanel.locator('.markdown-scroll')).toHaveAttribute('data-render-state', 'ready')
    await selectText(activeTextPanel.locator('.markdown-block', { hasText: 'Second paragraph with' }), 0, 6)
    await window.getByRole('button', { name: '荧光笔高亮' }).click({ button: 'right' })
    await window.getByRole('option', { name: '选择蓝色' }).click()
    await window.getByRole('button', { name: '荧光笔高亮' }).click()
    await expect.poll(() => window.evaluate(async (id) => {
      const values = await Promise.all([
        (window as unknown as { copilotix: CopilotixDesktopApi }).copilotix.listReaderAnnotations({ documentId: id, view: 'original' }),
        (window as unknown as { copilotix: CopilotixDesktopApi }).copilotix.listReaderAnnotations({ documentId: id, view: 'translated' })
      ])
      return values.flatMap((snapshot: ReaderAnnotationSnapshot) => snapshot.annotations.map((value) => value.view))
    }, taskId)).toEqual(['translated'])
  } finally {
    await app.close()
    await workspace.cleanup()
  }
})

test('restores discarded headers, footnotes and footers while hiding printed page numbers', async () => {
  const workspace = await createE2EWorkspace()
  const taskId = await seedReaderTask(workspace, {
    supplementalBlocks: true,
    translatedMarkdown: FIXTURE_TRANSLATED_MARKDOWN
  })
  const app = await launchElectron({ args: [join(__dirname, '../out/main/index.js')], env: workspace.env })
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
    await expect(activeTextPanel.locator('[data-reader-role="page-number"]')).toHaveCount(0)
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
  const app = await launchElectron({ args: [join(__dirname, '../out/main/index.js')], env: workspace.env })
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
  const app = await launchElectron({ args: [join(__dirname, '../out/main/index.js')], env: workspace.env })
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

test('shows the parsed English title in recent tasks and the Reader header', async () => {
  const workspace = await createE2EWorkspace()
  await seedReaderTask(workspace, { englishTitle: 'Attention Is All You Need' })
  const app = await launchElectron({ args: [join(__dirname, '../out/main/index.js')], env: workspace.env })
  try {
    const window = await app.firstWindow()
    await openTaskList(window)
    const paper = window.locator('.task-link', { hasText: 'Attention Is All You Need.pdf' })
    await expect(paper).toBeVisible()
    await paper.click()
    await expect(window.locator('.reader-title')).toHaveText('Attention Is All You Need.pdf')
  } finally {
    await app.close()
    await workspace.cleanup()
  }
})

test('renders an optional real Copilotix PDF fixture', async () => {
  const sourcePdf = process.env.COPILOTIX_E2E_REAL_PDF
  test.skip(!sourcePdf, 'Set COPILOTIX_E2E_REAL_PDF for the local non-CI acceptance check')
  const workspace = await createE2EWorkspace()
  const taskId = await seedReaderTask(workspace, { sourcePdf: sourcePdf! })
  const app = await launchElectron({ args: [join(__dirname, '../out/main/index.js')], env: workspace.env })
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

test('renders and safely links an optional real Copilotix task', async () => {
  const sourceTaskDir = process.env.COPILOTIX_E2E_REAL_TASK_DIR
  test.skip(!sourceTaskDir, 'Set COPILOTIX_E2E_REAL_TASK_DIR for the local layout acceptance check')
  const workspace = await createE2EWorkspace()
  const taskId = await seedReaderTask(workspace, { sourceTaskDir: sourceTaskDir! })
  const app = await launchElectron({ args: [join(__dirname, '../out/main/index.js')], env: workspace.env })
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
    await expect(activeTextPanel.locator('[data-reader-role="page-number"]')).toHaveCount(0)
    await expect(activeTextPanel.locator('[data-reader-role="page-divider"]')).toHaveCount(97)
    const translatedMappedBlock = activeTextPanel.locator('.markdown-block:not([data-block-ids=""])').first()
    const translatedMappingId = (await translatedMappedBlock.getAttribute('data-block-ids'))?.split(/\s+/)[0]
    expect(translatedMappingId).toBeTruthy()
    await translatedMappedBlock.click()
    await expect(window.locator(`[data-block-id="${translatedMappingId}"]`).first()).toHaveClass(/active/)
    const screenshotPath = process.env.COPILOTIX_E2E_SCREENSHOT
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

async function openTaskList(window: Page): Promise<void> {
  await window.locator('[data-edge-dock="top"]').hover()
  await window.getByRole('button', { name: '任务管理' }).click()
}

async function openPaper(window: Page, taskId: string): Promise<void> {
  await openTaskList(window)
  const item = window.locator(`tr[data-row-key="${taskId}"] .task-link`)
  await expect(item).toBeVisible()
  await item.click()
  await expect(window.locator('.reader-header')).toBeVisible({ timeout: 30_000 })
  // Image/font readiness has a production 30 s deadline. Wait for the actual
  // ready/error state, failing promptly on errors rather than operating during loading.
  const scroller = window.locator('.reader-tab-panel.active .markdown-scroll')
  await expect(scroller).toHaveAttribute('data-render-state', /^(ready|error)$/, { timeout: 31_000 })
  await expect(scroller).toHaveAttribute('data-render-state', 'ready')
}

test('keeps the complete minimap static across long-document jumps', async () => {
  const workspace = await createE2EWorkspace()
  const markdown = Array.from({ length: 180 }, (_, index) =>
    `## Section ${index}\n\n${'A long paragraph with varying wrapped lines and document geometry. '.repeat(8 + index % 12)}`
  ).join('\n\n')
  const sourceTaskDir = process.env.COPILOTIX_E2E_REAL_TASK_DIR
  const taskId = await seedReaderTask(workspace, sourceTaskDir
    ? { sourceTaskDir }
    : { sourceMarkdown: markdown, translatedMarkdown: markdown })
  const app = await launchStaticReaderAcceptance(workspace.env)
  try {
    const window = await app.firstWindow()
    await window.evaluate(() => {
      const state = window as Window & { minimapPaintCount: number }
      state.minimapPaintCount = 0
      const clear = CanvasRenderingContext2D.prototype.clearRect
      CanvasRenderingContext2D.prototype.clearRect = function (...args) {
        if (this.canvas.classList.contains('markdown-minimap-canvas')) state.minimapPaintCount += 1
        return clear.apply(this, args)
      }
    })
    await openPaper(window, taskId)
    const panel = window.locator('.reader-tab-panel.active')
    await expect.poll(() => panel.locator('.markdown-minimap-heading').count()).toBeGreaterThan(0)
    if (!sourceTaskDir) await expect(panel.locator('.markdown-minimap-heading')).toHaveCount(180)
    await panel.locator('.markdown-scroll').hover({ position: { x: 50, y: 50 } })
    await window.waitForTimeout(600)
    const readSnapshot = async () => {
      const displayBounds = await panel.locator('.markdown-minimap-canvas').boundingBox()
      if (!displayBounds) throw new Error('Minimap canvas is not visible')
      // Capture only complete CSS pixels. Fractional element screenshot edges are
      // composited differently after a pane resize/scroll, despite identical canvas
      // bytes. Keep the display geometry in the exact-equality assertion as well.
      const clip = {
        x: Math.ceil(displayBounds.x),
        y: Math.ceil(displayBounds.y),
        width: Math.floor(displayBounds.x + displayBounds.width) - Math.ceil(displayBounds.x),
        height: Math.floor(displayBounds.y + displayBounds.height) - Math.ceil(displayBounds.y)
      }
      return {
        displayBounds,
        pixels: (await window.screenshot({
          clip,
          scale: 'css',
          animations: 'disabled',
          // Keep the outer window's rounded corner out of this canvas invariant.
          style: '.app-shell { border-radius: 0 !important; } .markdown-minimap-frame, .markdown-minimap-frame-hit { visibility: hidden !important; } .markdown-minimap-heading:focus-visible { background: transparent !important; box-shadow: none !important; } .markdown-minimap:focus-visible { box-shadow: none !important; }'
        })).toString('base64'),
        ...await panel.evaluate((element) => ({
          canvasPixels: element.querySelector<HTMLCanvasElement>('.markdown-minimap-canvas')!.toDataURL(),
          formulas: element.querySelector('.markdown-minimap-formulas')!.innerHTML,
          headings: Array.from(element.querySelectorAll<HTMLElement>('.markdown-minimap-heading')).map((heading) => heading.style.cssText),
          paintCount: (window as Window & { minimapPaintCount: number }).minimapPaintCount
        }))
      }
    }
    const expectSnapshot = async (baseline: Awaited<ReturnType<typeof readSnapshot>>) => {
      const current = await readSnapshot()
      const { pixels: expectedPixels, ...expectedContent } = baseline
      const { pixels: currentPixels, ...currentContent } = current
      // Canvas bytes, indexing and repaint count must remain exactly equal.
      expect(currentContent).toEqual(expectedContent)
      if (currentPixels === expectedPixels) return
      // Chromium can round CSS-scaled clip-edge colors by one channel level.
      // The CI trace differed at just 11/35,105 pixels, all in the bottom corner.
      // Decode the PNGs so this narrowly bounded rasterization difference never
      // hides an actual content shift, repaint or missing minimap element.
      const difference = await window.evaluate(async ({ expected, actual }) => {
        const decode = async (pixels: string) => {
          const image = new Image()
          image.src = `data:image/png;base64,${pixels}`
          await image.decode()
          const canvas = document.createElement('canvas')
          canvas.width = image.naturalWidth
          canvas.height = image.naturalHeight
          const context = canvas.getContext('2d')!
          context.drawImage(image, 0, 0)
          return { width: canvas.width, height: canvas.height, values: context.getImageData(0, 0, canvas.width, canvas.height).data }
        }
        const [left, right] = await Promise.all([decode(expected), decode(actual)])
        if (left.width !== right.width || left.height !== right.height) return { sameDimensions: false, maxChannelDelta: 255, changedRatio: 1 }
        let maxChannelDelta = 0
        let changedPixels = 0
        for (let offset = 0; offset < left.values.length; offset += 4) {
          let changed = false
          for (let channel = 0; channel < 4; channel += 1) {
            const delta = Math.abs(left.values[offset + channel]! - right.values[offset + channel]!)
            maxChannelDelta = Math.max(maxChannelDelta, delta)
            if (delta > 0) changed = true
          }
          if (changed) changedPixels += 1
        }
        return { sameDimensions: true, maxChannelDelta, changedRatio: changedPixels / (left.width * left.height) }
      }, { expected: expectedPixels, actual: currentPixels })
      if (!difference.sameDimensions || difference.maxChannelDelta > 1 || difference.changedRatio > 0.001) {
        await test.info().attach('minimap-expected', { body: Buffer.from(expectedPixels, 'base64'), contentType: 'image/png' })
        await test.info().attach('minimap-actual', { body: Buffer.from(currentPixels, 'base64'), contentType: 'image/png' })
      }
      expect(difference.sameDimensions).toBe(true)
      expect(difference.maxChannelDelta).toBeLessThanOrEqual(1)
      expect(difference.changedRatio).toBeLessThanOrEqual(0.001)
    }
    const original = await readSnapshot()
    const rail = panel.locator('.markdown-minimap')
    const bounds = (await rail.boundingBox())!
    const frame = panel.locator('.markdown-minimap-frame')
    const originalFrame = await frame.getAttribute('style')
    const headings = panel.locator('.markdown-minimap-heading')
    await expect(headings.first()).not.toHaveAttribute('title')
    // Dense documents can have overlapping heading hit areas. Hover at the
    // actual rail coordinate and use keyboard navigation for an exact heading.
    const middleHeadingBounds = (await headings.nth(Math.floor(await headings.count() / 2)).boundingBox())!
    await rail.hover({ position: {
      x: middleHeadingBounds.x + middleHeadingBounds.width / 2 - bounds.x,
      y: middleHeadingBounds.y + middleHeadingBounds.height / 2 - bounds.y
    } })
    await window.waitForTimeout(300)
    expect(await frame.getAttribute('style')).toBe(originalFrame)
    await expectSnapshot(original)
    for (const fraction of [0.75, 0.25, 0.95, 0.1]) {
      await rail.click({ position: { x: bounds.width - 2, y: bounds.height * fraction } })
      await expect.poll(() => panel.locator('.markdown-scroll').evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
      await window.waitForTimeout(300)
      await expectSnapshot(original)
    }
    const headingIndex = Math.floor(await headings.count() / 2)
    await headings.nth(headingIndex).focus()
    await headings.nth(headingIndex).press('Enter')
    await window.waitForTimeout(600)
    await expectSnapshot(original)
    const split = window.getByRole('separator', { name: '调整 PDF 与 Markdown 阅读器宽度' })
    const initialWidth = await panel.locator('article').evaluate((element) => element.clientWidth)
    await split.focus()
    await split.press('End')
    await expect.poll(() => panel.locator('article').evaluate((element) => element.clientWidth)).not.toBe(initialWidth)
    // The retained canvas and indexed overview stay fixed, while resizing can
    // resample its CSS display to a different PNG. Capture the settled display
    // at the new size and require subsequent navigation to preserve it too.
    let resized = await readSnapshot()
    await expect.poll(async () => {
      const next = await readSnapshot()
      const unchanged = JSON.stringify(next) === JSON.stringify(resized)
      resized = next
      return unchanged
    }, { intervals: [200, 300, 500], timeout: 5_000 }).toBe(true)
    expect(resized.canvasPixels).toBe(original.canvasPixels)
    expect(resized.formulas).toBe(original.formulas)
    expect(resized.headings).toEqual(original.headings)
    expect(resized.paintCount).toBe(original.paintCount)
    await headings.nth(headingIndex).focus()
    await headings.nth(headingIndex).press('Enter')
    const target = panel.locator('article h1, article h2, article h3, article h4, article h5, article h6').nth(headingIndex)
    await expect.poll(() => target.evaluate((element) => {
      const scroller = element.closest('.markdown-scroll')!
      return element.getBoundingClientRect().top - scroller.getBoundingClientRect().top
    })).toBeCloseTo(16, 0)
    const sourcePosition = await headings.nth(headingIndex).evaluate((element) =>
      Number.parseFloat((element as HTMLElement).style.top) / Number.parseFloat((element.parentElement as HTMLElement).style.height)
    )
    const resizedBounds = (await rail.boundingBox())!
    await rail.click({ position: { x: resizedBounds.width - 2, y: resizedBounds.height * sourcePosition } })
    await expect.poll(() => isCentered(target, '.markdown-scroll')).toBe(true)
    await expectSnapshot(resized)
  } finally {
    await app.close()
    await workspace.cleanup()
  }
})

async function launchStaticReaderAcceptance(env: NodeJS.ProcessEnv) {
  const executablePath = process.env.COPILOTIX_E2E_PACKAGED_EXE
  if (!executablePath) return launchElectron({ args: [join(__dirname, '../out/main/index.js')], env })
  const child = spawn(executablePath, ['--remote-debugging-port=0'], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
  try {
    const endpoint = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Packaged reader debugging endpoint timed out')), 30_000)
      child.stderr.on('data', (data: Buffer) => {
        const match = /DevTools listening on (ws:\/\/[^\s]+)/u.exec(data.toString())
        if (match) { clearTimeout(timer); resolve(match[1]!) }
      })
      child.once('error', (error) => { clearTimeout(timer); reject(error) })
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Packaged reader exited: ${code}`)) })
    })
    const browser = await chromium.connectOverCDP(endpoint)
    return {
      firstWindow: async () => browser.contexts()[0]!.pages()[0] ?? await browser.contexts()[0]!.waitForEvent('page'),
      close: async () => {
        await browser.close()
        if (child.exitCode === null && child.pid) execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        await new Promise((resolve) => setTimeout(resolve, 300))
      }
    }
  } catch (error) {
    if (child.exitCode === null && child.pid) execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    throw error
  }
}

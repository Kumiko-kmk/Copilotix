import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createE2EWorkspace, launchElectron, seedReaderTask } from './helpers'

const MINIMAP_TRANSLATED_MARKDOWN = [
  '# 测试文档',
  '<sub>艾达·洛夫莱斯</sub>和艾伦·图灵',
  '摘要 | 独立映射的摘要。',
  '第一页在第二栏继续。<sup>12</sup> 水是 H<sub>2</sub>O。',
  '第二段落包含 $E=mc^2$。',
  '<table><tbody><tr><td>学术单元格</td></tr></tbody></table>',
  '![测试图片](images/fixture.png)'
].join('\n\n')

test('keeps hover chrome inside the minimum supported window size', async () => {
  const workspace = await createE2EWorkspace()
  await seedReaderTask(workspace)
  const app = await launchElectron({ args: [join(__dirname, '../out/main/index.js')], env: workspace.env })
  try {
    const window = await app.firstWindow()
    await app.evaluate(({ BrowserWindow, nativeTheme }) => {
      nativeTheme.themeSource = 'light'
      BrowserWindow.getAllWindows()[0]?.setSize(1100, 700)
    })
    await window.emulateMedia({ colorScheme: 'light' })
    const viewport = await window.evaluate(() => [innerWidth, innerHeight] as const)
    expect(viewport[0]).toBeGreaterThanOrEqual(1100)
    expect(viewport[0]).toBeLessThanOrEqual(1102)
    expect(viewport[1]).toBeGreaterThanOrEqual(700)
    expect(viewport[1]).toBeLessThanOrEqual(702)

    const mainBounds = await window.locator('.main-surface').boundingBox()
    expect(mainBounds).not.toBeNull()
    expect(mainBounds!.x).toBeCloseTo(1, 0)
    expect(mainBounds!.y).toBeCloseTo(40, 0)
    expect(mainBounds!.x + mainBounds!.width).toBeCloseTo(viewport[0] - 1, 0)
    expect(mainBounds!.y + mainBounds!.height).toBeCloseTo(viewport[1] - 1, 0)
    await expect(window.locator('.app-shell')).toHaveCSS('border-radius', '16px')
    await expect(window.locator('.app-shell')).toHaveCSS('background-color', 'rgb(255, 255, 255)')
    await expect(window.locator('.main-surface')).toHaveCSS('border-radius', '0px')
    await expect(window.locator('.main-surface')).toHaveCSS('background-color', 'rgb(247, 242, 232)')
    const closeControl = window.locator('[data-window-control="close"]')
    await expect(closeControl).toHaveCSS('width', '12px')
    await expect(closeControl).toHaveCSS('height', '12px')
    const closeBounds = await closeControl.boundingBox()
    expect(closeBounds).not.toBeNull()
    expect(closeBounds!.y).toBeGreaterThanOrEqual(14)
    expect(closeBounds!.y + closeBounds!.height).toBeLessThanOrEqual(27)

    await window.locator('[data-edge-dock="top"]').hover()
    await window.waitForTimeout(300)
    const topBounds = await window.locator('[data-edge-dock="top"] .edge-dock-panel').boundingBox()
    expect(topBounds).not.toBeNull()
    expect(topBounds!.x).toBeGreaterThanOrEqual(0)
    expect(topBounds!.x + topBounds!.width).toBeLessThanOrEqual(viewport[0])
    await capture(window, 'chrome-1100x700-light-top.png')

    await window.locator('[data-edge-dock="bottom"]').hover()
    await window.waitForTimeout(500)
    const bottomBounds = await window.locator('[data-edge-dock="bottom"] .edge-dock-panel').boundingBox()
    expect(bottomBounds).not.toBeNull()
    expect(bottomBounds!.y + bottomBounds!.height).toBeLessThanOrEqual(viewport[1])
    await window.emulateMedia({ colorScheme: 'dark' })
    await expect.poll(() => window.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(true)
    await expect(window.locator('.app-shell')).toHaveCSS('background-color', 'rgb(255, 255, 255)')
    await expect(window.locator('.main-surface')).toHaveCSS('background-color', 'rgb(247, 242, 232)')
    await capture(window, 'chrome-1100x700-fixed-light-bottom.png')
  } finally {
    await app.close()
    await workspace.cleanup()
  }
})

test('keeps the new parse page static across supported sizes and themes', async () => {
  const workspace = await createE2EWorkspace()
  const app = await launchElectron({ args: [join(__dirname, '../out/main/index.js')], env: workspace.env })
  try {
    const window = await app.firstWindow()
    const uploadEntry = window.getByTestId('pdf-upload-entry')

    await app.evaluate(({ BrowserWindow, nativeTheme }) => {
      nativeTheme.themeSource = 'light'
      BrowserWindow.getAllWindows()[0]?.setSize(1100, 700)
    })
    await window.waitForTimeout(300)
    const compactViewport = await window.evaluate(() => [innerWidth, innerHeight] as const)
    expect(compactViewport[0]).toBeGreaterThanOrEqual(1100)
    expect(compactViewport[0]).toBeLessThanOrEqual(1102)
    expect(compactViewport[1]).toBeGreaterThanOrEqual(700)
    expect(compactViewport[1]).toBeLessThanOrEqual(702)
    await expect(window.locator('.new-parse-page canvas')).toHaveCount(0)
    await expect(uploadEntry).toHaveCSS('background-color', 'rgb(247, 242, 232)')
    await expect(uploadEntry).toHaveCSS('backdrop-filter', 'none')
    await capture(window, 'new-parse-1100x700-static.png')

    await app.evaluate(({ BrowserWindow, nativeTheme }) => {
      nativeTheme.themeSource = 'dark'
      BrowserWindow.getAllWindows()[0]?.setSize(1440, 900)
    })
    await window.emulateMedia({ colorScheme: 'dark' })
    await expect.poll(() => window.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(true)
    await window.waitForTimeout(300)
    const spaciousViewport = await window.evaluate(() => [innerWidth, innerHeight] as const)
    expect(spaciousViewport[0]).toBeGreaterThanOrEqual(1440)
    expect(spaciousViewport[0]).toBeLessThanOrEqual(1442)
    expect(spaciousViewport[1]).toBeGreaterThanOrEqual(900)
    expect(spaciousViewport[1]).toBeLessThanOrEqual(902)
    await expect(window.locator('.new-parse-page canvas')).toHaveCount(0)
    await expect(window.locator('.app-shell')).toHaveCSS('border-radius', '16px')
    await expect(window.locator('.main-surface')).toHaveCSS('border-radius', '0px')
    await expect(window.locator('.main-surface')).toHaveCSS('background-color', 'rgb(247, 242, 232)')
    await capture(window, 'new-parse-1440x900-static.png')
  } finally {
    await app.close()
    await workspace.cleanup()
  }
})

test('provides an interactive minimap for original and translated Markdown', async () => {
  const workspace = await createE2EWorkspace()
  const taskId = await seedReaderTask(workspace, { translatedMarkdown: MINIMAP_TRANSLATED_MARKDOWN })
  const app = await launchElectron({ args: [join(__dirname, '../out/main/index.js')], env: workspace.env })
  try {
    const window = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1100, 700))
    await window.locator('[data-edge-dock="bottom"]').hover()
    await window.locator(`[data-paper-task-id="${taskId}"]`).click()

    const activePanel = window.locator('.reader-tab-panel.active')
    const scroller = activePanel.locator('.markdown-scroll')
    const minimap = activePanel.getByRole('scrollbar', { name: 'Markdown 文档缩略导航' })
    await expect(scroller).toHaveAttribute('data-render-state', 'ready')
    await expect(minimap).toBeVisible()
    await expect(minimap).toHaveCSS('width', '84px')
    await expect(minimap).toHaveCSS('background-color', 'rgb(247, 242, 232)')
    await expect(scroller).toHaveCSS('scrollbar-width', 'none')
    await expect(minimap.locator('.markdown-minimap-canvas')).toHaveCount(1)
    await expect(minimap.locator('.markdown-minimap-line')).toHaveCount(0)
    await expect.poll(() => minimap.locator('canvas').evaluate((canvas: HTMLCanvasElement) => {
      const context = canvas.getContext('2d')
      return context ? context.getImageData(0, 0, canvas.width, canvas.height).data.some((channel) => channel !== 0) : false
    })).toBe(true)
    const originalHeading = minimap.getByRole('button', { name: '跳转到Fixture document' })
    await expect(originalHeading).toBeVisible()
    await expect(originalHeading).toHaveCSS('left', '4px')

    await scroller.evaluate((element) => {
      const article = element.querySelector<HTMLElement>('.markdown-body')
      if (article) article.style.minHeight = '2400px'
    })
    await expect.poll(() => scroller.evaluate((element) => element.scrollHeight)).toBeGreaterThan(2_000)
    const minimapBounds = await minimap.boundingBox()
    if (!minimapBounds) throw new Error('Markdown minimap is not visible')
    await window.mouse.move(minimapBounds.x + minimapBounds.width / 2, minimapBounds.y + minimapBounds.height * 0.75)
    await expect(minimap.locator('.markdown-minimap-frame')).toHaveAttribute('data-preview', 'true')
    expect(await scroller.evaluate((element) => element.scrollTop)).toBe(0)

    await window.mouse.down()
    await window.mouse.move(minimapBounds.x + minimapBounds.width / 2, minimapBounds.y + minimapBounds.height * 0.4)
    await window.mouse.up()
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(200)
    await originalHeading.click()
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeLessThan(80)
    await capture(window, 'reader-minimap-1100x700-original.png')

    await window.getByText('Markdown（中文）').click()
    const translatedPanel = window.locator('.reader-tab-panel.active')
    const translatedMinimap = translatedPanel.getByRole('scrollbar', { name: 'Markdown 文档缩略导航' })
    await expect(translatedPanel.locator('.markdown-scroll')).toHaveAttribute('data-render-state', 'ready')
    await expect(translatedMinimap.getByRole('button', { name: '跳转到测试文档' })).toHaveCSS('left', '4px')
    await expect(translatedMinimap.locator('.markdown-minimap-canvas')).toHaveCount(1)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 900))
    await expect(translatedMinimap).toHaveCSS('width', '84px')
    await capture(window, 'reader-minimap-1440x900-translated.png')

    await window.getByText('JSON', { exact: true }).click()
    await expect(window.locator('.reader-tab-panel.active .markdown-minimap')).toHaveCount(0)
    await expect(window.locator('.reader-tab-panel.active .json-view')).toBeVisible()
  } finally {
    await app.close()
    await workspace.cleanup()
  }
})

async function capture(window: import('@playwright/test').Page, filename: string): Promise<void> {
  const directory = process.env.COPILOTIX_E2E_UI_SCREENSHOTS
  if (!directory) return
  mkdirSync(directory, { recursive: true })
  await window.screenshot({ path: join(directory, filename) })
}

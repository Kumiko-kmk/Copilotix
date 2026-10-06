import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createE2EWorkspace, launchElectron, seedReaderTask } from './helpers'
import { MAX_PDF_PAGES } from '../src/shared/constants'

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
    expect(mainBounds!.y).toBeCloseTo(32, 0)
    expect(mainBounds!.x + mainBounds!.width).toBeCloseTo(viewport[0] - 1, 0)
    expect(mainBounds!.y + mainBounds!.height).toBeCloseTo(viewport[1] - 1, 0)
    await expect(window.locator('.app-shell')).toHaveCSS('border-radius', '8px')
    await expect(window.locator('.app-shell')).toHaveCSS('background-color', 'rgb(247, 242, 232)')
    await expect(window.locator('.main-surface')).toHaveCSS('border-radius', '0px')
    await expect(window.locator('.main-surface')).toHaveCSS('background-color', 'rgb(247, 242, 232)')
    const closeControl = window.locator('[data-window-control="close"]')
    await expect(closeControl).toHaveCSS('width', '20px')
    await expect(closeControl).toHaveCSS('height', '28px')
    expect(await closeControl.evaluate((element) => getComputedStyle(element, '::before').width)).toBe('12px')
    const closeBounds = await closeControl.boundingBox()
    expect(closeBounds).not.toBeNull()
    expect(closeBounds!.y).toBeGreaterThanOrEqual(1)
    expect(closeBounds!.y + closeBounds!.height).toBeLessThanOrEqual(32)

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
    await expect(window.locator('.app-shell')).toHaveCSS('background-color', 'rgb(247, 242, 232)')
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
    await expect(window.locator('.tutorial-page')).toBeVisible()
    await window.locator('[data-edge-dock="top"]').hover()
    await window.locator('.top-navigation-item').filter({ hasText: '新解析' }).click()

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
    await expect(window.locator('.titlebar-brand')).toHaveCount(0)
    await expect(window.getByRole('img', { name: 'COPILOTIX' })).toBeVisible()
    await expect(window.locator('.copilotix-wordmark span')).toHaveCount(10)
    await expect.poll(() => window.locator('.copilotix-wordmark').evaluate((element) => {
      const text = element.textContent ?? ''
      return Object.fromEntries([...new Set('COPILOTIX')].map((letter) => [letter, [...text].filter((cell) => cell === letter).length]))
    })).toEqual({ C: 36, O: 80, P: 36, I: 80, L: 32, T: 30, X: 36 })
    await expect(window.getByText('今天想读些什么？')).toBeVisible()
    await expect(window.getByText('拖入文档')).toBeVisible()
    await expect(window.getByText(`当前支持 PDF，单篇最多 ${MAX_PDF_PAGES} 页`)).toBeVisible()
    await expect(window.getByRole('button', { name: '选择文档' })).toBeVisible()
    await expect(window.getByText('需要先配置解析 API Token')).toHaveCount(0)
    await expect(uploadEntry).toHaveCSS('min-height', '94px')
    await expect(uploadEntry).toHaveCSS('border-top-style', 'solid')
    await expect(uploadEntry).toHaveCSS('backdrop-filter', 'none')
    const compactWordmarkBounds = await window.locator('.copilotix-wordmark').boundingBox()
    const compactButtonBounds = await window.getByRole('button', { name: '选择文档' }).boundingBox()
    expect(compactWordmarkBounds).not.toBeNull()
    expect(compactButtonBounds).not.toBeNull()
    expect(compactWordmarkBounds!.x).toBeGreaterThanOrEqual(0)
    expect(compactWordmarkBounds!.x + compactWordmarkBounds!.width).toBeLessThanOrEqual(compactViewport[0])
    expect(compactButtonBounds!.y + compactButtonBounds!.height).toBeLessThanOrEqual(compactViewport[1])
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
    await expect(window.locator('.app-shell')).toHaveCSS('border-radius', '8px')
    await expect(window.locator('.main-surface')).toHaveCSS('border-radius', '0px')
    await expect(window.locator('.main-surface')).toHaveCSS('background-color', 'rgb(247, 242, 232)')
    await capture(window, 'new-parse-1440x900-static.png')

    await app.evaluate(({ BrowserWindow, nativeTheme }) => {
      nativeTheme.themeSource = 'light'
      BrowserWindow.getAllWindows()[0]?.setSize(1584, 992)
    })
    await window.emulateMedia({ colorScheme: 'light' })
    await window.waitForTimeout(300)
    await expect(window.locator('.titlebar-brand')).toHaveCount(0)
    const uploadBounds = await uploadEntry.boundingBox()
    expect(uploadBounds?.width).toBeCloseTo(720, 0)
    expect(uploadBounds?.height).toBeCloseTo(94, 0)
    await capture(window, 'new-parse-1584x992-reference.png')
    await window.locator('input[type="file"]').setInputFiles({
      name: 'fixture.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4 fixture')
    })
    await expect(window.getByRole('dialog', { name: '确认解析任务' })).toBeVisible()
  } finally {
    await app.close()
    await workspace.cleanup()
  }
})

test('lays out service credentials as compact connection cards', async () => {
  const workspace = await createE2EWorkspace()
  const app = await launchElectron({ args: [join(__dirname, '../out/main/index.js')], env: workspace.env })
  try {
    const window = await app.firstWindow()
    await app.evaluate(({ BrowserWindow, nativeTheme }) => {
      nativeTheme.themeSource = 'light'
      BrowserWindow.getAllWindows()[0]?.setSize(1440, 900)
    })
    await window.locator('[data-edge-dock="top"]').hover()
    await window.getByRole('button', { name: '设置' }).click()

    await expect(window.getByRole('region', { name: '服务连接' })).toBeVisible()
    await expect(window.getByRole('heading', { name: '服务连接' })).toHaveCount(0)
    await expect(window.getByText('文档解析必需')).toHaveCount(0)
    await expect(window.getByRole('button', { name: /更多/u })).toHaveCount(0)
    await expect(window.getByText('服务地址')).toHaveCount(0)
    await expect(window.getByText('高级设置')).toHaveCount(0)
    const parserCard = window.locator('.service-card').filter({ has: window.locator('#credential-parser') })
    const tokenInput = parserCard.getByLabel('APIKey', { exact: true })
    const testButton = parserCard.getByRole('button', { name: '测试连接' })
    const [inputBounds, buttonBounds] = await Promise.all([tokenInput.boundingBox(), testButton.boundingBox()])
    expect(inputBounds).not.toBeNull()
    expect(buttonBounds).not.toBeNull()
    const inputCenter = inputBounds!.y + inputBounds!.height / 2
    const buttonCenter = buttonBounds!.y + buttonBounds!.height / 2
    expect(Math.abs(inputCenter - buttonCenter)).toBeLessThanOrEqual(1)

    await expect(window.getByLabel('APIKey', { exact: true })).toHaveCount(3)
    const qwenInput = window.locator('#credential-qwen')
    await expect(qwenInput).toBeVisible()
    await qwenInput.focus()
    await expect(window.locator('#credential-qwen')).toHaveAttribute('type', 'password')
    await expect(window.getByRole('region', { name: 'APIKey 用量分析' })).toBeVisible()
    await expect(window.locator('.settings-page')).toHaveCSS('overflow', 'hidden')
    expect(await window.locator('.settings-page').evaluate((element) => element.scrollHeight <= element.clientHeight)).toBe(true)
    await capture(window, 'settings-services-reference.png')
  } finally {
    await app.close()
    await workspace.cleanup()
  }
})

test('reorders and enables translation providers with explicit persistent saves', async () => {
  const workspace = await createE2EWorkspace()
  let app = await launchElectron({ args: [join(__dirname, '../out/main/index.js')], env: workspace.env })
  try {
    let window = await app.firstWindow()
    await window.locator('[data-edge-dock="top"]').hover()
    await window.getByRole('button', { name: '设置' }).click()
    await window.getByRole('button', { name: /模型设置/u }).click()

    await expect(window.getByText('大语言模型优先级')).toBeVisible()
    await expect(window.getByText('通过 DeepSeek API 提供大语言模型翻译')).toBeVisible()
    await expect(window.getByText('通过阿里云百炼 API 提供专业翻译模型')).toBeVisible()
    await expect(window.getByRole('button', { name: '保存全部更改' })).toBeDisabled()
    await expect(window.getByText('拖动调整优先级，越靠上越优先使用')).toHaveCount(0)
    await expect(window.getByText('无需密钥')).toHaveCount(0)
    await expect(window.getByRole('button', { name: '配置', exact: true })).toHaveCount(0)
    const [contentBounds, actionBounds] = await Promise.all([
      window.locator('.settings-content').boundingBox(),
      window.locator('.settings-actions').boundingBox()
    ])
    expect(contentBounds).not.toBeNull()
    expect(actionBounds).not.toBeNull()
    expect(actionBounds!.x).toBeCloseTo(contentBounds!.x, 0)
    expect(actionBounds!.width).toBeCloseTo(contentBounds!.width, 0)
    const modelCardBounds = await window.locator('.model-priority-item').evaluateAll((elements) => elements.map((element) => {
      const bounds = element.getBoundingClientRect()
      return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
    }))
    expect(modelCardBounds).toHaveLength(4)
    for (const [index, bounds] of modelCardBounds.entries()) {
      expect(bounds.x).toBeCloseTo(modelCardBounds[0]!.x, 0)
      expect(bounds.height).toBeGreaterThanOrEqual(82)
      if (index > 0) expect(bounds.y).toBeGreaterThan(modelCardBounds[index - 1]!.y)
    }
    await capture(window, 'settings-models-reference.png')

    await window.getByRole('button', { name: '移动千问 / Qwen' }).dragTo(window.locator('[data-provider="bing"]'))
    await expect(window.getByText('DeepSeek → Bing → 千问 → Transmart')).toBeVisible()
    await window.getByRole('button', { name: '保存全部更改' }).click()
    await expect.poll(async () => (await window.evaluate(() => window.copilotix.getSettings())).translationProviderOrder)
      .toEqual(['deepseek', 'bing', 'qwen', 'transmart'])

    await window.getByRole('checkbox', { name: '启用DeepSeek' }).click()
    await expect(window.getByText('Bing → 千问 → Transmart')).toBeVisible()
    await window.getByRole('button', { name: '保存全部更改' }).click()
    await expect.poll(async () => (await window.evaluate(() => window.copilotix.getSettings())).enabledTranslationProviders)
      .toEqual(['bing', 'qwen', 'transmart'])

    await app.close()
    app = await launchElectron({ args: [join(__dirname, '../out/main/index.js')], env: workspace.env })
    window = await app.firstWindow()
    await window.locator('[data-edge-dock="top"]').hover()
    await window.getByRole('button', { name: '设置' }).click()
    await window.getByRole('button', { name: /模型设置/u }).click()
    await expect(window.getByText('Bing → 千问 → Transmart')).toBeVisible()
    await expect(window.getByRole('checkbox', { name: '启用DeepSeek' })).not.toBeChecked()
  } finally {
    await app.close()
    await workspace.cleanup()
  }
})

test('shows live file storage usage and location controls', async () => {
  const workspace = await createE2EWorkspace()
  const app = await launchElectron({ args: [join(__dirname, '../out/main/index.js')], env: workspace.env })
  try {
    const window = await app.firstWindow()
    await window.locator('[data-edge-dock="top"]').hover()
    await window.getByRole('button', { name: '设置' }).click()
    await window.getByRole('button', { name: /文件存储/u }).click()

    await expect(window.getByRole('region', { name: '文件存储' })).toBeVisible()
    await expect(window.getByRole('heading', { name: '文件管理' })).toHaveCount(0)
    await expect(window.getByLabel('文档保存位置')).not.toHaveValue('')
    await expect(window.getByRole('button', { name: '导出文库' })).toBeVisible()
    await expect(window.getByRole('button', { name: '导入文库' })).toBeVisible()
    await expect(window.getByRole('button', { name: '迁移文库' })).toBeVisible()
    await expect(window.getByRole('button', { name: '打开当前目录' })).toBeVisible()
    await expect(window.getByRole('button', { name: /刷新用量/u })).toBeVisible()
    await expect(window.getByText('占用空间')).toBeVisible()
    await expect(window.getByRole('region', { name: '存储构成' })).toBeVisible()
    await expect(window.getByRole('img', { name: /存储构成，总计/u })).toBeVisible()
    await expect(window.getByRole('region', { name: '近期存储增长' })).toBeVisible()
    await expect(window.getByRole('img', { name: '近 14 日存储增长曲线' })).toBeVisible()
    await expect(window.getByText(/导入或迁移会保留旧库并在完成后重启/u)).toBeVisible()
    const changeLocationBounds = await window.getByRole('button', { name: '迁移文库' }).boundingBox()
    const openLocationBounds = await window.getByRole('button', { name: '打开当前目录' }).boundingBox()
    expect(changeLocationBounds).not.toBeNull()
    expect(openLocationBounds).not.toBeNull()
    expect(changeLocationBounds!.x).toBeLessThan(openLocationBounds!.x)
    await expect.poll(async () => (await window.evaluate(() => window.copilotix.getStorageInfo())).totalBytes).toBeGreaterThanOrEqual(0)
    await capture(window, 'settings-storage-insights.png')
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

    // Opening a paper loads its details through IPC before the Markdown pane exists.
    await expect(window.locator('.reader-header')).toBeVisible({ timeout: 30_000 })
    const activePanel = window.locator('.reader-tab-panel.active')
    const scroller = activePanel.locator('.markdown-scroll')
    const minimap = activePanel.getByRole('scrollbar', { name: 'Markdown 文档缩略导航' })
    const separator = window.getByRole('separator', { name: '调整 PDF 与 Markdown 阅读器宽度' })
    await expect(scroller).toHaveAttribute('data-render-state', 'ready')
    await expect(window.locator('.reader-header')).toHaveCSS('height', '44px')
    await expect(window.locator('.pdf-toolbar')).toHaveCSS('height', '48px')
    await expect(window.locator('.text-toolbar')).toHaveCSS('height', '48px')
    await expect(separator).toHaveAttribute('aria-valuemin', '40')
    await expect(separator).toHaveAttribute('aria-valuemax', '60')
    await expect(minimap).toBeVisible()
    await expect(minimap).toHaveCSS('width', '60px')
    await expect(minimap).toHaveCSS('background-color', 'rgb(247, 242, 232)')
    await expect(scroller).toHaveCSS('scrollbar-width', 'none')
    await expect(activePanel.locator('.markdown-block > p').first()).toHaveCSS('text-indent', '32px')
    await expect(activePanel.locator('.markdown-block > h1').first()).toHaveCSS('text-indent', '0px')
    await expect(minimap.locator('.markdown-minimap-canvas')).toHaveCount(1)
    await expect(minimap.locator('.markdown-minimap-line')).toHaveCount(0)
    const splitBounds = await window.locator('.reader-split').boundingBox()
    const separatorBounds = await separator.boundingBox()
    if (!splitBounds || !separatorBounds) throw new Error('Reader split is not visible')
    await window.mouse.move(separatorBounds.x + separatorBounds.width / 2, separatorBounds.y + 120)
    await window.mouse.down()
    await window.mouse.move(splitBounds.x + splitBounds.width * 0.75, separatorBounds.y + 120)
    await window.mouse.up()
    await expect(separator).toHaveAttribute('aria-valuenow', '60')
    await expect(minimap).toHaveCSS('width', '60px')
    // The fixture includes a custom-protocol image, so Chromium correctly
    // prevents getImageData on this canvas. Compare rendered pixels instead.
    const canvas = minimap.locator('canvas')
    const overlayStyle = '.markdown-minimap-heading, .markdown-minimap-frame, .markdown-minimap-frame-hit { visibility: hidden !important; }'
    const blankCanvas = await canvas.screenshot({ style: `${overlayStyle} .markdown-minimap-canvas { opacity: 0 !important; }` })
    await expect.poll(async () => (await canvas.screenshot({ style: overlayStyle })).equals(blankCanvas)).toBe(false)
    const originalHeading = minimap.getByRole('button', { name: '跳转到Fixture document' })
    await expect(originalHeading).toBeVisible()
    await expect(originalHeading).toHaveCSS('left', '4px')

    const maxScroll = await scroller.evaluate((element) => element.scrollHeight - element.clientHeight)
    expect(maxScroll).toBeGreaterThan(0)
    const minimapBounds = await minimap.boundingBox()
    if (!minimapBounds) throw new Error('Markdown minimap is not visible')
    const frameBeforeHover = await minimap.locator('.markdown-minimap-frame').getAttribute('style')
    await window.mouse.move(minimapBounds.x + minimapBounds.width / 2, minimapBounds.y + minimapBounds.height * 0.75)
    await expect(minimap.locator('.markdown-minimap-frame')).toHaveAttribute('data-preview', 'false')
    await expect(minimap.locator('.markdown-minimap-frame')).toHaveAttribute('style', frameBeforeHover!)
    expect(await scroller.evaluate((element) => element.scrollTop)).toBe(0)

    await window.mouse.down()
    await window.mouse.move(minimapBounds.x + minimapBounds.width / 2, minimapBounds.y + minimapBounds.height * 0.9)
    await window.mouse.up()
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(maxScroll * 0.5)
    await originalHeading.click()
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeLessThan(80)
    await capture(window, 'reader-minimap-1100x700-original.png')

    await window.getByText('Markdown（中文）').click()
    const translatedPanel = window.locator('.reader-tab-panel.active')
    const translatedMinimap = translatedPanel.getByRole('scrollbar', { name: 'Markdown 文档缩略导航' })
    await expect(translatedPanel.locator('.markdown-scroll')).toHaveAttribute('data-render-state', 'ready')
    await expect(translatedPanel.locator('.markdown-block > p').first()).toHaveCSS('text-indent', '32px')
    await expect(translatedMinimap.getByRole('button', { name: '跳转到测试文档' })).toHaveCSS('left', '4px')
    await expect(translatedMinimap.locator('.markdown-minimap-canvas')).toHaveCount(1)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 900))
    await expect(translatedMinimap).toHaveCSS('width', '60px')
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

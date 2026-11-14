import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createE2EWorkspace, launchElectron, openPaperFromLibrary, seedReaderTask } from './helpers'
import { MAX_PDF_PAGES } from '../src/features/library/contract/pdfLimits'

const MINIMAP_TRANSLATED_MARKDOWN = [
  '# 測試文件',
  '<sub>艾達·洛夫萊斯</sub>和艾倫·圖靈',
  '摘要 | 獨立對映的摘要。',
  '第一頁在第二欄繼續。<sup>12</sup> 水是 H<sub>2</sub>O。',
  '第二段落包含 $E=mc^2$。',
  '<table><tbody><tr><td>學術單元格</td></tr></tbody></table>',
  '![測試圖片](images/fixture.png)'
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
    // Compact 28px titlebar.
    expect(mainBounds!.y).toBeCloseTo(28, 0)
    expect(mainBounds!.x + mainBounds!.width).toBeCloseTo(viewport[0] - 1, 0)
    expect(mainBounds!.y + mainBounds!.height).toBeCloseTo(viewport[1] - 1, 0)
    const closeControl = window.locator('[data-window-control="close"]')
    await expect(closeControl).toHaveCSS('width', '20px')
    await expect(closeControl).toHaveCSS('height', '24px')
    expect(await closeControl.evaluate((element) => getComputedStyle(element, '::before').width)).toBe('12px')
    const closeBounds = await closeControl.boundingBox()
    expect(closeBounds).not.toBeNull()
    expect(closeBounds!.y).toBeGreaterThanOrEqual(1)
    expect(closeBounds!.y + closeBounds!.height).toBeLessThanOrEqual(28)

    await window.locator('[data-edge-dock="top"]').hover()
    await window.waitForTimeout(300)
    const topBounds = await window.locator('[data-edge-dock="top"] .edge-dock-panel').boundingBox()
    expect(topBounds).not.toBeNull()
    expect(topBounds!.x).toBeGreaterThanOrEqual(0)
    expect(topBounds!.x + topBounds!.width).toBeLessThanOrEqual(viewport[0])
    await capture(window, 'chrome-1100x700-light-top.png')

    await expect(window.locator('[data-edge-dock="bottom"]')).toHaveCount(0)
    await window.emulateMedia({ colorScheme: 'dark' })
    await expect.poll(() => window.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(true)
    await capture(window, 'chrome-1100x700-fixed-light-bottom.png')
  } finally {
    await app.close()
    await workspace.cleanup()
  }
})

test('keeps the new parse page layout across supported sizes and themes', async () => {
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
    // The only canvas is the cipher backdrop; the hero itself stays DOM.
    await expect(window.locator('.new-parse-page canvas')).toHaveCount(1)
    await expect(window.locator('.new-parse-page canvas.home-cipher')).toHaveCount(1)
    await expect(window.locator('.titlebar-brand')).toHaveCount(0)
    await expect(window.getByRole('img', { name: 'COPILOTIX' })).toBeVisible()
    await expect(window.getByText('今天想讀些什麼？')).toBeVisible()
    await expect(window.getByText('拖入文件')).toBeVisible()
    await expect(window.getByText(`當前支援 PDF，單篇最多 ${MAX_PDF_PAGES} 頁`)).toBeVisible()
    await expect(window.getByRole('button', { name: '選擇文件' })).toBeVisible()
    await expect(window.getByText('需要先配置解析 API Token')).toHaveCount(0)
    await expect(uploadEntry).toHaveCSS('min-height', '94px')
    await expect(uploadEntry).toHaveCSS('border-top-style', 'solid')
    await expect(uploadEntry).toHaveCSS('backdrop-filter', 'none')
    const compactWordmarkBounds = await window.locator('.copilotix-wordmark').boundingBox()
    const compactButtonBounds = await window.getByRole('button', { name: '選擇文件' }).boundingBox()
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
    // The only canvas is the cipher backdrop; the hero itself stays DOM.
    await expect(window.locator('.new-parse-page canvas')).toHaveCount(1)
    await expect(window.locator('.new-parse-page canvas.home-cipher')).toHaveCount(1)
    await capture(window, 'new-parse-1440x900-static.png')

    await app.evaluate(({ BrowserWindow, nativeTheme }) => {
      nativeTheme.themeSource = 'light'
      BrowserWindow.getAllWindows()[0]?.setSize(1584, 992)
    })
    await window.emulateMedia({ colorScheme: 'light' })
    await window.waitForTimeout(300)
    await expect(window.locator('.titlebar-brand')).toHaveCount(0)
    const uploadBounds = await uploadEntry.boundingBox()
    expect(uploadBounds?.width).toBeCloseTo(780, 0)
    expect(uploadBounds?.height).toBeCloseTo(94, 0)
    await capture(window, 'new-parse-1584x992-reference.png')
    await window.locator('input[type="file"]').setInputFiles({
      name: 'fixture.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4 fixture')
    })
    await expect(window.getByRole('dialog', { name: '確認匯入' })).toBeVisible()
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
    await window.getByRole('button', { name: '設定' }).click()

    await expect(window.getByRole('region', { name: '服務連線' })).toBeVisible()
    await expect(window.getByRole('heading', { name: '服務連線' })).toHaveCount(0)
    await expect(window.getByText('文件解析必需')).toHaveCount(0)
    await expect(window.getByRole('button', { name: /更多/u })).toHaveCount(0)
    await expect(window.getByText('服務地址')).toHaveCount(0)
    await expect(window.getByText('高階設定')).toHaveCount(0)
    const parserCard = window.locator('.service-card').filter({ has: window.locator('#credential-parser') })
    const tokenInput = parserCard.getByLabel('APIKey', { exact: true })
    const testButton = parserCard.getByRole('button', { name: '測試連線' })
    const [inputBounds, buttonBounds] = await Promise.all([tokenInput.boundingBox(), testButton.boundingBox()])
    expect(inputBounds).not.toBeNull()
    expect(buttonBounds).not.toBeNull()
    const inputCenter = inputBounds!.y + inputBounds!.height / 2
    const buttonCenter = buttonBounds!.y + buttonBounds!.height / 2
    expect(Math.abs(inputCenter - buttonCenter)).toBeLessThanOrEqual(1)

    // Model keys moved to their own view; the services page keeps one summary row for them.
    await expect(window.getByLabel('APIKey', { exact: true })).toHaveCount(1)
    await expect(window.locator('#credential-qwen')).toHaveCount(0)
    await expect(window.locator('[data-provider="model-keys"]')).toContainText('DeepSeek 0 個 · 千問 0 個')
    await expect(window.getByRole('region', { name: 'APIKey 用量分析' })).toBeVisible()
    await expect(window.locator('.settings-page')).toHaveCSS('overflow', 'hidden')
    expect(await window.locator('.settings-page').evaluate((element) => element.scrollHeight <= element.clientHeight)).toBe(true)
    await expect(window.getByRole('region', { name: 'Codex 連線' })).toBeVisible()
    for (const size of [[1440, 900], [1100, 700]] as const) {
      await app.evaluate(({ BrowserWindow }, [width, height]) => BrowserWindow.getAllWindows()[0]?.setSize(width, height), size)
      await expect.poll(() => window.locator('.settings-content-body').evaluate((element) => element.scrollHeight <= element.clientHeight && element.querySelector('.usage-dashboard')!.getBoundingClientRect().bottom <= element.getBoundingClientRect().bottom + 1)).toBe(true)
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 900))
    await capture(window, 'settings-services-reference.png')
  } finally {
    await app.close()
    await workspace.cleanup()
  }
})

test('manages up to five keys per provider on one screen without saving unverified keys', async () => {
  const workspace = await createE2EWorkspace()
  const app = await launchElectron({ args: [join(__dirname, '../out/main/index.js')], env: workspace.env })
  try {
    const window = await app.firstWindow()
    await app.evaluate(({ BrowserWindow, nativeTheme }) => {
      nativeTheme.themeSource = 'light'
      BrowserWindow.getAllWindows()[0]?.setSize(1440, 900)
    })
    await window.locator('[data-edge-dock="top"]').hover()
    await window.getByRole('button', { name: '設定' }).click()
    await window.locator('[data-provider="model-keys"]').getByRole('button', { name: '管理金鑰' }).click()
    const view = window.getByRole('region', { name: 'API 金鑰' })
    await expect(view).toBeVisible()
    await expect(view.getByText('尚未新增金鑰', { exact: false })).toBeVisible()
    // Drafts only: adding a key never contacts the provider until the page is saved.
    for (const [index, label] of ['主帳號', '實驗室', '備用一', '備用二', '備用三'].entries()) {
      await view.getByLabel('新金鑰名稱').fill(label)
      await view.getByLabel('新 API Key').fill(`sk-e2e-draft-${index}`)
      await view.getByRole('button', { name: /新增/u }).click()
    }
    await expect(view.locator('.api-key-item')).toHaveCount(5)
    await expect(view.getByLabel('新 API Key')).toBeDisabled()
    await expect(view.getByRole('tab', { name: /DeepSeek/u })).toContainText('5/5')
    await expect(view.locator('.model-request-order strong')).toHaveText('主帳號 → 實驗室 → 備用一 → 備用二 → 備用三')
    await view.getByRole('checkbox', { name: '啟用實驗室' }).click()
    await view.getByRole('button', { name: '移動備用三' }).focus()
    await window.keyboard.press('ArrowUp')
    await expect(view.locator('.model-request-order strong')).toHaveText('主帳號 → 備用一 → 備用三 → 備用二')
    await expect(window.getByText('有未儲存的更改')).toBeVisible()
    for (const size of [[1440, 900], [1100, 700]] as const) {
      await app.evaluate(({ BrowserWindow }, [width, height]) => BrowserWindow.getAllWindows()[0]?.setSize(width, height), size)
      await expect.poll(() => window.locator('.settings-content-body').evaluate((element) => {
        const bottom = element.getBoundingClientRect().bottom + 1
        return element.scrollHeight <= element.clientHeight && [...element.querySelectorAll('.api-key-item, .api-key-add')].every((row) => row.getBoundingClientRect().bottom <= bottom)
      })).toBe(true)
      await capture(window, `settings-api-keys-${size[0]}x${size[1]}.png`)
    }
    await window.getByRole('button', { name: '放棄更改' }).click()
    await expect(view.locator('.api-key-item')).toHaveCount(0)
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
    await window.getByRole('button', { name: '設定' }).click()
    await window.getByRole('button', { name: /模型設定/u }).click()

    await expect(window.getByText('大語言模型優先順序')).toBeVisible()
    // Rows carry only the model name; no second line of explanation.
    await expect(window.getByText('透過 DeepSeek API 提供大語言模型翻譯')).toHaveCount(0)
    await expect(window.getByText('透過阿里雲百鍊 API 提供專業翻譯模型')).toHaveCount(0)
    await expect(window.getByRole('button', { name: '儲存全部更改' })).toBeDisabled()
    await expect(window.getByText('拖動調整優先順序，越靠上越優先使用')).toHaveCount(0)
    await expect(window.getByText('無需金鑰')).toHaveCount(0)
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
    expect(modelCardBounds).toHaveLength(3)
    await expect(window.locator('[data-provider="bing"], [data-provider="transmart"]')).toHaveCount(0)
    for (const [index, bounds] of modelCardBounds.entries()) {
      expect(bounds.x).toBeCloseTo(modelCardBounds[0]!.x, 0)
      expect(bounds.height).toBeGreaterThanOrEqual(52)
      if (index > 0) expect(bounds.y).toBeGreaterThan(modelCardBounds[index - 1]!.y)
    }
    // The whole model page, including the AI note, fits without scrolling down to the minimum window.
    for (const size of [[1440, 900], [1100, 700]] as const) {
      await app.evaluate(({ BrowserWindow }, [width, height]) => BrowserWindow.getAllWindows()[0]?.setSize(width, height), size)
      await expect.poll(() => window.locator('.settings-content-body').evaluate((element) => element.scrollHeight <= element.clientHeight && [...element.querySelectorAll('.model-priority-card')].every((card) => card.getBoundingClientRect().bottom <= element.getBoundingClientRect().bottom + 1))).toBe(true)
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 900))
    await capture(window, 'settings-models-reference.png')

    const requestOrder = window.locator('.model-request-order strong')
    await expect(requestOrder).toHaveText('千問 → DeepSeek')
    await window.getByRole('button', { name: '移動千問 / Qwen' }).dragTo(window.locator('[data-provider="codex"]'))
    await expect(requestOrder).toHaveText('DeepSeek → 千問')
    await window.getByRole('button', { name: '儲存全部更改' }).click()
    await expect.poll(async () => (await window.evaluate(() => window.copilotix.getSettings())).translationProviderOrder)
      .toEqual(['deepseek', 'codex', 'qwen'])

    await window.getByRole('checkbox', { name: '啟用DeepSeek' }).click()
    await expect(requestOrder).toHaveText('千問')
    await window.getByRole('button', { name: '儲存全部更改' }).click()
    await expect.poll(async () => (await window.evaluate(() => window.copilotix.getSettings())).enabledTranslationProviders)
      .toEqual(['qwen'])

    await app.close()
    app = await launchElectron({ args: [join(__dirname, '../out/main/index.js')], env: workspace.env })
    window = await app.firstWindow()
    await window.locator('[data-edge-dock="top"]').hover()
    await window.getByRole('button', { name: '設定' }).click()
    await window.getByRole('button', { name: /模型設定/u }).click()
    await expect(window.locator('.model-request-order strong')).toHaveText('千問')
    await expect(window.getByRole('checkbox', { name: '啟用DeepSeek' })).not.toBeChecked()
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
    await window.getByRole('button', { name: '設定' }).click()
    await window.getByRole('button', { name: /檔案儲存/u }).click()

    await expect(window.getByRole('region', { name: '檔案儲存' })).toBeVisible()
    await expect(window.getByRole('heading', { name: '檔案管理' })).toHaveCount(0)
    await expect(window.getByLabel('文件儲存位置')).not.toHaveValue('')
    await expect(window.getByRole('button', { name: '匯出文庫' })).toBeVisible()
    await expect(window.getByRole('button', { name: '匯入文庫' })).toBeVisible()
    await expect(window.getByRole('button', { name: '遷移文庫' })).toBeVisible()
    await expect(window.getByRole('button', { name: '開啟當前目錄' })).toBeVisible()
    await expect(window.getByRole('button', { name: /重新整理用量/u })).toBeVisible()
    await expect(window.getByText('佔用空間')).toBeVisible()
    await expect(window.getByRole('region', { name: '儲存構成' })).toBeVisible()
    await expect(window.getByRole('img', { name: /儲存構成，總計/u })).toBeVisible()
    await expect(window.getByRole('region', { name: '近期儲存增長' })).toBeVisible()
    await expect(window.getByRole('img', { name: '近 14 日儲存增長曲線' })).toBeVisible()
    // The restart notice lives in the import/migrate confirmation, not as a note under the page.
    await expect(window.getByText(/匯入或遷移會保留舊庫並在完成後重啟/u)).toHaveCount(0)
    const changeLocationBounds = await window.getByRole('button', { name: '遷移文庫' }).boundingBox()
    const openLocationBounds = await window.getByRole('button', { name: '開啟當前目錄' }).boundingBox()
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
    // Papers open from the library search; the task list and home shelf were removed.
    await openPaperFromLibrary(window, taskId)

    // Opening a paper loads its details through IPC before the Markdown pane exists.
    await expect(window.locator('.reader-header')).toBeVisible({ timeout: 30_000 })
    const activePanel = window.locator('.reader-tab-panel.active')
    const scroller = activePanel.locator('.markdown-scroll')
    const minimap = activePanel.getByRole('scrollbar', { name: 'Markdown 文件縮略導覽' })
    const separator = window.getByRole('separator', { name: '調整 PDF 與 原文 閱讀器寬度' })
    await expect(scroller).toHaveAttribute('data-render-state', 'ready')
    // Compact reader chrome leaves more height for reading.
    await expect(window.locator('.reader-header')).toHaveCSS('height', '36px')
    // Each workbench group has one 40px tab bar; PDF page/zoom controls live inside it.
    await expect(window.locator('.reader-group-bar').first()).toHaveCSS('height', '40px')
    await expect(window.locator('.reader-group-bar').last()).toHaveCSS('height', '40px')
    await expect(window.locator('.reader-group-bar .pdf-toolbar')).toBeVisible()
    await expect.poll(async () => Number(await separator.getAttribute('aria-valuemin'))).toBeLessThan(40)
    await expect.poll(async () => Number(await separator.getAttribute('aria-valuemax'))).toBeGreaterThan(60)
    await expect(minimap).toBeVisible()
    await expect(minimap).toHaveCSS('width', '60px')
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
    // Groups only stop at their minimum size, so 75% is honoured.
    await expect(separator).toHaveAttribute('aria-valuenow', '75')
    await expect(minimap).toHaveCSS('width', '60px')
    // The fixture includes a custom-protocol image, so Chromium correctly
    // prevents getImageData on this canvas. Compare rendered pixels instead.
    const canvas = minimap.locator('canvas')
    const overlayStyle = '.markdown-minimap-heading, .markdown-minimap-frame, .markdown-minimap-frame-hit { visibility: hidden !important; }'
    const blankCanvas = await canvas.screenshot({ style: `${overlayStyle} .markdown-minimap-canvas { opacity: 0 !important; }` })
    await expect.poll(async () => (await canvas.screenshot({ style: overlayStyle })).equals(blankCanvas)).toBe(false)
    const originalHeading = minimap.getByRole('button', { name: '跳轉到Fixture document' })
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

    await window.getByText('譯文').click()
    const translatedPanel = window.locator('.reader-tab-panel.active')
    const translatedMinimap = translatedPanel.getByRole('scrollbar', { name: 'Markdown 文件縮略導覽' })
    await expect(translatedPanel.locator('.markdown-scroll')).toHaveAttribute('data-render-state', 'ready')
    await expect(translatedPanel.locator('.markdown-block > p').first()).toHaveCSS('text-indent', '32px')
    await expect(translatedMinimap.getByRole('button', { name: '跳轉到測試文件' })).toHaveCSS('left', '4px')
    await expect(translatedMinimap.locator('.markdown-minimap-canvas')).toHaveCount(1)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 900))
    await expect(translatedMinimap).toHaveCSS('width', '60px')
    await capture(window, 'reader-minimap-1440x900-translated.png')

    await expect(window.getByText('JSON', { exact: true })).toHaveCount(0)
    await window.getByText('Chat', { exact: true }).click()
    await expect(window.locator('.reader-tab-panel.active .markdown-minimap')).toHaveCount(0)
    await expect(window.locator('.reader-tab-panel.active .paper-chat')).toBeVisible()
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

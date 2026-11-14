import { expect, test } from '@playwright/test'
import { join } from 'node:path'
import { createE2EWorkspace, launchElectron, openPaperFromLibrary, seedReaderTask } from './helpers'

test('Codex settings and grounded chat use the local app-server without API keys', async () => {
  test.skip(process.env.COPILOTIX_CODEX_LIVE !== '1', 'Explicit opt-in: sends only synthetic fixture text to the local Codex login')
  test.setTimeout(240_000)
  const workspace = await createE2EWorkspace()
  const documentId = await seedReaderTask(workspace, {
    sourceMarkdown: '# Synthetic accuracy experiment\n\n## Results\nMethod A achieved 90% accuracy on 20 synthetic samples. The baseline achieved 70%. No external validation was performed.',
    translatedMarkdown: '# 合成準確率實驗\n\n## 結果\n方法 A 在20個合成樣本上的準確率為90%，基線為70%。沒有外部驗證。'
  })
  const app = await launchElectron({ args: [join(__dirname, '../out/main/index.js')], env: workspace.env })
  try {
    const page = await app.firstWindow()
    await page.locator('[data-edge-dock="top"]').hover()
    await page.getByRole('navigation', { name: '主導覽' }).getByRole('button', { name: /設定$/u }).click()
    const card = page.getByRole('region', { name: 'Codex 連線' })
    await card.getByRole('button', { name: '測試連線' }).click()
    await expect(card.getByRole('status')).toContainText('本機 Codex 已登入', { timeout: 30_000 })
    await expect(page.locator('#codex-executable')).toHaveValue(/codex\.exe$/iu)
    const remoteButton = page.locator('[data-provider="parser"] .credential-validate')
    const localButton = card.getByRole('button', { name: '測試連線' })
    const remoteBox = await remoteButton.boundingBox(), localBox = await localButton.boundingBox()
    expect(Math.abs(remoteBox!.x - localBox!.x)).toBeLessThan(2)
    if (process.env.CODEX_TEST_MODEL) {
      for (const label of ['Codex 翻譯模型', 'Codex 問答模型']) {
        await card.getByRole('combobox', { name: label }).locator('xpath=ancestor::*[contains(@class, "ant-select") and not(contains(@class, "ant-select-selection"))][1]').click()
        const listId = await card.getByRole('combobox', { name: label }).getAttribute('aria-controls')
        await page.locator(`[id^="${listId}_"] .ant-select-item-option-content`).filter({ hasText: new RegExp(`^${process.env.CODEX_TEST_MODEL}( · 識圖)?$`, 'iu') }).click()
      }
      await card.getByRole('button', { name: '測試模型' }).click()
      await expect(card.locator('.credential-status')).toHaveText('驗證成功', { timeout: 120_000 })
    }
    await page.screenshot({ path: join(__dirname, '../../..', 'investigation/codex-live/settings-updated.png') })

    await page.getByRole('button', { name: '儲存全部更改' }).click()
    await page.getByRole('button', { name: /模型設定/u }).click()
    await page.getByRole('checkbox', { name: '啟用Codex', exact: true }).check()
    const handle = page.getByRole('button', { name: '移動Codex', exact: true })
    await handle.focus()
    for (let index = 0; index < 4; index++) await handle.press('ArrowUp')
    await page.getByRole('button', { name: '儲存全部更改' }).click()
    await expect.poll(() => page.evaluate(async () => (await window.copilotix.getSettings()).translationProvider)).toBe('codex')
    if (process.env.CODEX_TEST_MODEL) await page.evaluate(async model => {
      const { credentials: _credentials, ...settings } = await window.copilotix.getSettings()
      await window.copilotix.saveSettings({ ...settings, codex: { ...settings.codex!, chatModel: model } })
    }, process.env.CODEX_TEST_MODEL)
    await page.locator('[data-edge-dock="top"]').hover()
    await page.getByRole('navigation', { name: '主導覽' }).getByRole('button', { name: /新解析$/u }).click()
    await openPaperFromLibrary(page, documentId)
    await page.locator('.reader-tab', { hasText: 'Chat' }).click()
    const input = page.getByRole('textbox', { name: '向當前論文提問' })
    await expect(input).toBeEnabled({ timeout: 30_000 })
    await input.fill('方法 A 的準確率是多少？請引用論文證據。')
    await expect(page.getByRole('button', { name: '傳送', exact: true })).toBeEnabled({ timeout: 30_000 })
    await page.getByRole('button', { name: '傳送', exact: true }).click()
    await expect(page.getByRole('group', { name: '同意傳送論文片段' })).toHaveCount(0)
    await expect(page.getByRole('log', { name: '問答記錄' })).toContainText('90', { timeout: 120_000 })
    await expect.poll(async () => {
      const saved = await page.evaluate(id => window.copilotix.paperChat.load({ documentId: id }), documentId)
      return saved.turns.at(-1)?.status
    }, { timeout: 120_000 }).toBe('completed')
    const saved = await page.evaluate(id => window.copilotix.paperChat.load({ documentId: id }), documentId)
    expect(saved.turns.at(-1)?.provider).toBe('codex')
    expect(Object.keys(saved.turns.at(-1)?.citations ?? {})).not.toHaveLength(0)
    await page.screenshot({ path: join(__dirname, '../../..', 'investigation/codex-live/electron-chat.png') })
  } finally { await app.close(); await workspace.cleanup() }
})

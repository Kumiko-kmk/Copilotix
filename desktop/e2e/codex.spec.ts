import { expect, test } from '@playwright/test'
import { join } from 'node:path'
import { createE2EWorkspace, launchElectron, openPaperFromLibrary, seedReaderTask } from './helpers'

test('Codex settings and grounded chat use the local app-server without API keys', async () => {
  test.skip(process.env.COPILOTIX_CODEX_LIVE !== '1', 'Explicit opt-in: sends only synthetic fixture text to the local Codex login')
  test.setTimeout(240_000)
  const workspace = await createE2EWorkspace()
  const documentId = await seedReaderTask(workspace, {
    sourceMarkdown: '# Synthetic accuracy experiment\n\n## Results\nMethod A achieved 90% accuracy on 20 synthetic samples. The baseline achieved 70%. No external validation was performed.',
    translatedMarkdown: '# 合成准确率实验\n\n## 结果\n方法 A 在20个合成样本上的准确率为90%，基线为70%。没有外部验证。'
  })
  const app = await launchElectron({ args: [join(__dirname, '../out/main/index.js')], env: workspace.env })
  try {
    const page = await app.firstWindow()
    await page.locator('[data-edge-dock="top"]').hover()
    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: /设置$/u }).click()
    const card = page.getByRole('region', { name: 'Codex 连接' })
    await card.getByRole('button', { name: '测试连接' }).click()
    await expect(card.getByRole('status')).toContainText('本机 Codex 已登录', { timeout: 30_000 })
    await expect(page.locator('#codex-executable')).toHaveValue(/codex\.exe$/iu)
    const remoteButton = page.locator('[data-provider="qwen"] .credential-validate')
    const localButton = card.getByRole('button', { name: '测试连接' })
    const remoteBox = await remoteButton.boundingBox(), localBox = await localButton.boundingBox()
    expect(Math.abs(remoteBox!.x - localBox!.x)).toBeLessThan(2)
    if (process.env.CODEX_TEST_MODEL) {
      for (const label of ['Codex 翻译模型', 'Codex 问答模型']) {
        await card.getByRole('combobox', { name: label }).locator('xpath=ancestor::*[contains(@class, "ant-select") and not(contains(@class, "ant-select-selection"))][1]').click()
        const listId = await card.getByRole('combobox', { name: label }).getAttribute('aria-controls')
        await page.locator(`[id^="${listId}_"] .ant-select-item-option-content`).filter({ hasText: new RegExp(`^${process.env.CODEX_TEST_MODEL}( · 识图)?$`, 'iu') }).click()
      }
      await card.getByRole('button', { name: '测试模型' }).click()
      await expect(card.locator('.credential-status')).toHaveText('验证成功', { timeout: 120_000 })
    }
    await page.screenshot({ path: join(__dirname, '../../..', 'investigation/codex-live/settings-updated.png') })

    await page.getByRole('button', { name: '保存全部更改' }).click()
    await page.getByRole('button', { name: /模型设置/u }).click()
    await page.getByRole('checkbox', { name: '启用Codex', exact: true }).check()
    const handle = page.getByRole('button', { name: '移动Codex', exact: true })
    await handle.focus()
    for (let index = 0; index < 4; index++) await handle.press('ArrowUp')
    await page.getByRole('button', { name: '保存全部更改' }).click()
    await expect.poll(() => page.evaluate(async () => (await window.copilotix.getSettings()).translationProvider)).toBe('codex')
    if (process.env.CODEX_TEST_MODEL) await page.evaluate(async model => {
      const { credentials: _credentials, ...settings } = await window.copilotix.getSettings()
      await window.copilotix.saveSettings({ ...settings, codex: { ...settings.codex!, chatModel: model } })
    }, process.env.CODEX_TEST_MODEL)
    await page.locator('[data-edge-dock="top"]').hover()
    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: /新解析$/u }).click()
    await openPaperFromLibrary(page, documentId)
    await page.locator('.reader-tab', { hasText: 'Chat' }).click()
    const input = page.getByRole('textbox', { name: '向当前论文提问' })
    await expect(input).toBeEnabled({ timeout: 30_000 })
    await input.fill('方法 A 的准确率是多少？请引用论文证据。')
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled({ timeout: 30_000 })
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await expect(page.getByRole('group', { name: '同意发送论文片段' })).toHaveCount(0)
    await expect(page.getByRole('log', { name: '问答记录' })).toContainText('90', { timeout: 120_000 })
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

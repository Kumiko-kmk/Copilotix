import { _electron as electron, expect, test } from '@playwright/test'
import { join } from 'node:path'
import { createE2EWorkspace, seedReaderTask } from './helpers'

test('reuses the translation API and switches chat models without a second settings page', async () => {
  test.setTimeout(30_000)
  const workspace = await createE2EWorkspace()
  const documentId = await seedReaderTask(workspace)
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined
  try {
    // Preserve the production renderer sandbox; a host startup failure is reported, never bypassed.
    app = await electron.launch({ args: [join(__dirname, '../out/main/index.js')], env: workspace.env, timeout: 15_000 })
    const window = await app.firstWindow({ timeout: 10_000 })
    await window.getByRole('button', { name: '展开主导航' }).click()
    await window.getByRole('button', { name: '任务管理' }).click()
    await window.locator(`tr[data-row-key="${documentId}"] .task-link`).click()
    // Chat is the reader's fourth tab, sized exactly like the Markdown reader.
    const chatTab = window.locator('.text-toolbar .ant-segmented-item', { hasText: 'AI 问答' })
    const model = window.locator('.reader-chat-model .ant-select-selection-item')
    await chatTab.click()
    await expect(window.getByRole('region', { name: '论文 AI 问答' })).toBeVisible()
    await expect(model).toHaveAttribute('title', 'qwen-plus')
    await expect(window.getByRole('button', { name: '前往设置' })).toHaveCount(0)
    await expect.poll(() => window.evaluate(() => typeof window.copilotix.paperChat.ask)).toBe('function')
    await window.locator('.reader-chat-model').click()
    await window.locator('.ant-select-item-option[title="qwen3.8-flash"]').click()
    await expect(model).toHaveAttribute('title', 'qwen3.8-flash')
    // Leaving and returning to the tab keeps the session's model choice.
    await window.locator('.text-toolbar .ant-segmented-item', { hasText: 'JSON' }).click()
    await expect(window.getByRole('region', { name: '论文 AI 问答' })).toBeHidden()
    await chatTab.click()
    await expect(model).toHaveAttribute('title', 'qwen3.8-flash')
    await expect(window.locator('.ant-drawer')).toHaveCount(0)
    await window.locator('[data-edge-dock="top"]').hover()
    await expect(window.getByRole('navigation', { name: '主导航' })).toBeVisible()
    await window.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '设置' }).click()
    await expect(window.getByRole('region', { name: '服务连接' })).toBeVisible()
    await expect(window.getByRole('button', { name: 'AI 问答', exact: true })).toHaveCount(0)
  } finally {
    await app?.close()
    await workspace.cleanup()
  }
})

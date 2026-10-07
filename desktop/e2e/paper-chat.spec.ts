import { _electron as electron, expect, test } from '@playwright/test'
import { join } from 'node:path'
import { createE2EWorkspace, seedReaderTask } from './helpers'

test('reuses the translation API and switches chat models without a second settings page', async () => {
  test.setTimeout(60_000)
  const workspace = await createE2EWorkspace()
  const documentId = await seedReaderTask(workspace)
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined
  try {
    // Preserve the production renderer sandbox; a host startup failure is reported, never bypassed.
    app = await electron.launch({ args: [join(__dirname, '../out/main/index.js')], env: workspace.env, timeout: 15_000 })
    const window = await app.firstWindow({ timeout: 10_000 })
    await expect.poll(() => window.evaluate(() => typeof window.copilotix?.getSettings)).toBe('function')
    // Exercise the real credential validation/save IPC with an isolated native
    // vault. Only the provider HTTP response is simulated; no paid API is called.
    expect((await window.evaluate(() => window.copilotix.getSettings())).credentials.qwen.state).toBe('missing')
    await app.evaluate(({ net }) => {
      Reflect.set(globalThis, '__chatCredentialProbeCount', 0)
      net.fetch = async (input, init) => {
        const body = JSON.parse(String(init?.body)) as { model?: string; stream?: boolean }
        if (input !== 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
          || init?.method !== 'POST'
          || new Headers(init.headers).get('Authorization') !== 'Bearer copilotix-e2e-not-a-real-api-key'
          || !['qwen-mt-plus', 'qwen3.8-flash'].includes(body.model ?? '')) throw new Error('Unexpected provider request in chat fixture')
        if (body.stream) return new Response('data: {"choices":[{"delta":{"content":"持久保存的测试回答"}}]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
        Reflect.set(globalThis, '__chatCredentialProbeCount', Number(Reflect.get(globalThis, '__chatCredentialProbeCount')) + 1)
        return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), {
          status: 200, headers: { 'Content-Type': 'application/json' }
        })
      }
    })
    const saved = await window.evaluate(async () => {
      const { credentials: _credentials, ...settings } = await window.copilotix.getSettings()
      return window.copilotix.saveSettings({
        ...settings,
        chatConsentVersion: 2,
        credentialMutations: { qwen: { action: 'set', value: 'copilotix-e2e-not-a-real-api-key' } }
      })
    })
    expect(saved.fieldErrors).toEqual({})
    expect(saved.settings.credentials.qwen.state).toBe('valid')
    expect(await app.evaluate(() => Reflect.get(globalThis, '__chatCredentialProbeCount'))).toBe(1)
    await window.reload()
    await window.getByRole('button', { name: '展开主导航' }).click()
    await window.getByRole('button', { name: '任务管理' }).click()
    await window.locator(`tr[data-row-key="${documentId}"] .task-link`).click()
    // Chat is the reader's third tab, sized exactly like the Markdown reader.
    const chatTab = window.locator('.text-toolbar .ant-segmented-item', { hasText: 'AI 问答' })
    const model = window.locator('.reader-chat-model .ant-select-selection-item')
    await chatTab.click()
    await expect(window.getByRole('region', { name: '论文 AI 问答' })).toBeVisible()
    await expect(model).toHaveAttribute('title', 'qwen-plus')
    await expect(window.locator('.reader-chat-provider')).toHaveText('Qwen')
    await expect(window.getByRole('button', { name: '前往设置' })).toHaveCount(0)
    await expect.poll(() => window.evaluate(() => typeof window.copilotix.paperChat.ask)).toBe('function')
    await window.locator('.reader-chat-model').click()
    await window.locator('.ant-select-item-option[title="qwen3.8-flash"]').click()
    await expect(model).toHaveAttribute('title', 'qwen3.8-flash')
    // Leaving and returning to the tab keeps the session's model choice.
    await window.getByText('Markdown', { exact: true }).click()
    await expect(window.getByRole('region', { name: '论文 AI 问答' })).toBeHidden()
    await chatTab.click()
    await expect(model).toHaveAttribute('title', 'qwen3.8-flash')
    await window.getByLabel('向当前论文提问').fill('记住这个问题')
    await expect(window.getByRole('button', { name: '发送', exact: true })).toBeEnabled({ timeout: 30_000 })
    await window.getByRole('button', { name: '发送', exact: true }).click()
    await expect(window.getByRole('log', { name: '问答记录' })).toContainText('持久保存的测试回答')
    await expect(window.getByLabel('正在生成', { exact: true })).toHaveCount(0)
    await window.getByLabel('向当前论文提问').fill('未发送草稿')
    // Wait for the durable session write, then reload through the real preload/Main/Utility path.
    await expect.poll(() => window.evaluate((documentId) => window.copilotix.paperChat.session({ documentId }), documentId)).toMatchObject({ draft: '未发送草稿' })
    await window.reload()
    await window.getByRole('button', { name: '展开主导航' }).click()
    await window.getByRole('button', { name: '任务管理' }).click()
    await window.locator(`tr[data-row-key="${documentId}"] .task-link`).click()
    await chatTab.click()
    await expect(window.getByRole('log', { name: '问答记录' })).toContainText('记住这个问题')
    await expect(window.getByRole('log', { name: '问答记录' })).toContainText('持久保存的测试回答')
    await expect(window.getByLabel('向当前论文提问')).toHaveValue('未发送草稿')
    await expect(model).toHaveAttribute('title', 'qwen3.8-flash')
    expect((await window.evaluate((documentId) => window.copilotix.paperChat.load({ documentId }), documentId)).turns).toEqual([expect.objectContaining({ question: '记住这个问题', answer: '持久保存的测试回答', status: 'completed' })])
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

import { expect, test } from '@playwright/test'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { createE2EWorkspace, launchElectron, seedReaderTask } from './helpers'

test('archive insight uses validated settings, provider HTTP and durable local storage', async ({}, testInfo) => {
  const workspace = await createE2EWorkspace()
  const documentId = await seedReaderTask(workspace, { englishTitle: 'Insight test paper', sourceMarkdown: '# Original title\n\n# Abstract\n\nOriginal paper content.\n\n# Method\n\nStructured analysis.\n\n# Conclusion\n\nImproved reading.', translatedMarkdown: '# 论文标题\n\n# 摘要\n\n研究论文阅读效率。\n\n# 方法\n\n结构化提取。\n\n# 结论\n\n改进阅读。' })
  let app: Awaited<ReturnType<typeof launchElectron>> | undefined
  try {
    app = await launchElectron({ args: [join(__dirname, '../out/main/index.js')], env: workspace.env })
    const window = await app.firstWindow()
    await expect.poll(() => window.evaluate(() => typeof window.copilotix?.paperInsight?.get)).toBe('function')
    const initial = await window.evaluate(() => window.copilotix.getSettings())
    expect(initial.autoGeneratePaperInsight).toBe(false)
    expect(initial.credentials.qwen.state).toBe('missing')
    // Consent alone never enables a network call without a verified key.
    await window.evaluate(async () => {
      const { credentials: _credentials, ...settings } = await window.copilotix.getSettings()
      await window.copilotix.saveSettings({ ...settings, chatConsentVersion: 2 })
    })
    const openDetail = async () => {
      await window.locator('[data-edge-dock="top"]').hover()
      await window.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: /文库$/u }).click()
      const archive = window.getByRole('region', { name: '文库', exact: true })
      await expect(archive.locator('canvas[data-archive-state="ready"]')).toBeVisible({ timeout: 20_000 })
      await archive.getByRole('button', { name: '查看档案' }).click()
      await expect(archive.locator('.paper-archive-detail')).toHaveAttribute('aria-busy', 'false')
      await expect(archive.locator('.paper-archive-detail h2')).toHaveText('Original title')
      await archive.getByRole('tab', { name: /AI 解读/u }).click()
      await expect.poll(() => archive.locator('.paper-archive-tabpanel').evaluate((element) => getComputedStyle(element, '::after').transform)).toBe('matrix(0, 0, 0, 1, 0, 0)')
      return archive
    }
    let archive = await openDetail()
    await expect(archive.getByText('请先在服务连接中保存模型 API Key。')).toBeVisible()
    await expect(archive.getByRole('button', { name: '生成 AI 解读' })).toHaveCount(0)
    await app.evaluate(({ net }) => {
      Reflect.set(globalThis, '__insightRequests', [])
      net.fetch = async (input, init) => {
        const body = JSON.parse(String(init?.body)) as { model: string; stream?: boolean; messages?: unknown[] }
        if (input !== 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions' || new Headers(init?.headers).get('Authorization') !== 'Bearer copilotix-e2e-insight-fake-key') throw new Error('Unexpected provider request')
        if (body.stream) {
          if (body.model !== 'qwen-plus') throw new Error('Wrong insight model')
          const requests = Reflect.get(globalThis, '__insightRequests') as unknown[]; requests.push(body)
          const content = JSON.stringify({ summary: '仅根据摘录生成的测试概述', researchQuestion: '如何提高论文阅读效率？', method: '通过结构化提取组织内容', contributions: ['统一研究问题与方法'], findings: ['方便快速浏览'], limitations: ['只依据摘录'], keywords: ['论文阅读'] })
          return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), { headers: { 'Content-Type': 'application/json' } })
      }
    })
    const saved = await window.evaluate(async () => {
      const { credentials: _credentials, ...settings } = await window.copilotix.getSettings()
      return window.copilotix.saveSettings({ ...settings, credentialMutations: { qwen: { action: 'set', value: 'copilotix-e2e-insight-fake-key' } } })
    })
    expect(saved.fieldErrors).toEqual({}); expect(saved.settings.credentials.qwen.state).toBe('valid')
    await window.reload(); archive = await openDetail()
    await archive.getByRole('button', { name: '生成 AI 解读' }).click()
    await expect(archive.getByText('如何提高论文阅读效率？')).toBeVisible({ timeout: 15_000 })
    await expect(archive.getByText('通过结构化提取组织内容')).toBeVisible()
    await expect(archive.getByText('统一研究问题与方法')).toBeVisible()
    const requests = await app.evaluate(() => Reflect.get(globalThis, '__insightRequests')) as unknown[]
    expect(requests).toHaveLength(1)
    expect(JSON.stringify(requests)).toContain('研究论文阅读效率')
    expect(JSON.stringify(requests)).not.toContain(workspace.root)
    expect(JSON.stringify(requests)).not.toContain('copilotix-e2e-insight-fake-key')
    const durable = await readFile(join(workspace.root, 'documents-v2', documentId, 'insight', 'insight.v1.json'), 'utf8')
    expect(durable).toContain('统一研究问题与方法'); expect(durable).not.toContain('fake-key')
    await window.screenshot({ path: testInfo.outputPath('archive-insight.png') })
    await window.reload(); archive = await openDetail()
    await expect(archive.getByText('统一研究问题与方法')).toBeVisible()
    expect(await app.evaluate(() => (Reflect.get(globalThis, '__insightRequests') as unknown[]).length)).toBe(1)
    await window.locator('[data-edge-dock="top"]').hover()
    await window.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '设置' }).click()
    await window.getByRole('button', { name: '模型设置' }).click()
    const automatic = window.getByRole('checkbox', { name: '翻译完成后自动生成 AI 解读' })
    await expect(automatic).not.toBeChecked()
    await automatic.check()
    await window.getByRole('button', { name: /保存/u }).click()
    await expect.poll(() => window.evaluate(async () => (await window.copilotix.getSettings()).autoGeneratePaperInsight)).toBe(true)
  } finally { await app?.close(); await workspace.cleanup() }
})

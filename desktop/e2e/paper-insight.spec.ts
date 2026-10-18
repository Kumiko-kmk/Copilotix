import { briefGeneration } from '../tests/fixtures/paperBrief'
import { expect, test } from '@playwright/test'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { createE2EWorkspace, launchElectron, openPaperFromLibrary, seedReaderTask } from './helpers'
import { backgroundPoints } from '../src/shared/paperBrief/background'

test('archive insight uses validated settings, provider HTTP and durable local storage', async ({}, testInfo) => {
  const workspace = await createE2EWorkspace()
  const documentId = await seedReaderTask(workspace, { englishTitle: 'Insight test paper', sourceMarkdown: '# Original title\n\n# Abstract\n\nOriginal paper content.\n\n# Method\n\nStructured analysis.\n\n# Conclusion\n\nImproved reading.', translatedMarkdown: '# 论文标题\n\n# 摘要\n\n研究论文阅读效率。\n\n# 方法\n\n结构化提取。\n\n# 结论\n\n改进阅读。' })
  let app: Awaited<ReturnType<typeof launchElectron>> | undefined
  try {
    app = await launchElectron({ args: [join(__dirname, '../out/main/index.js')], env: workspace.env })
    const window = await app.firstWindow()
    await window.emulateMedia({ reducedMotion: 'reduce' })
    await expect.poll(() => window.evaluate(() => typeof window.copilotix?.paperInsight?.get)).toBe('function')
    const initial = await window.evaluate(() => window.copilotix.getSettings())
    expect(initial.autoGeneratePaperInsight).toBe(true)
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
      await expect(archive).toHaveAttribute('data-detail-phase', 'open')
      await expect(archive.getByRole('tab', { name: /摘要/u })).toHaveAttribute('aria-selected', 'true')
      const legacyTab = archive.getByRole('tab', { name: /AI 解读/u })
      if (await legacyTab.count()) await legacyTab.click()
      return archive
    }
    await window.locator('[data-edge-dock="top"]').hover()
    await window.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: /文库$/u }).click()
    let archive = window.getByRole('region', { name: '文库', exact: true })
    await expect(archive.locator('canvas[data-archive-state="ready"]')).toBeVisible({ timeout: 20_000 })
    expect(await window.evaluate((id) => window.copilotix.paperInsight.get({ documentId: id }), documentId)).toEqual({
      status: 'unavailable', reason: '请先在服务连接中保存模型 API Key。'
    })
    await expect(archive.locator('.paper-archive-brief-status')).toHaveCount(0)
    await expect(archive.getByRole('button', { name: '查看档案' })).toBeDisabled()
    await expect(archive.getByRole('button', { name: '生成 AI 档案卡' })).toHaveCount(0)
    await app.evaluate(({ net }, brief) => {
      Reflect.set(globalThis, '__insightRequests', [])
      net.fetch = async (input, init) => {
        const body = JSON.parse(String(init?.body)) as { model: string; stream?: boolean; messages?: unknown[] }
        if (input !== 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions' || new Headers(init?.headers).get('Authorization') !== 'Bearer copilotix-e2e-insight-fake-key') throw new Error('Unexpected provider request')
        if (body.stream) {
          if (body.model !== 'qwen-plus') throw new Error('Wrong insight model')
          const requests = Reflect.get(globalThis, '__insightRequests') as unknown[]; requests.push(body)
          const content = JSON.stringify(brief)
          return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), { headers: { 'Content-Type': 'application/json' } })
      }
    }, briefGeneration)
    const saved = await window.evaluate(async () => {
      const { credentials: _credentials, ...settings } = await window.copilotix.getSettings()
      return window.copilotix.saveSettings({ ...settings, credentialMutations: { qwen: { action: 'set', value: 'copilotix-e2e-insight-fake-key' } } })
    })
    expect(saved.fieldErrors).toEqual({}); expect(saved.settings.credentials.qwen.state).toBe('valid')
    await window.reload()
    await expect(archive.getByRole('button', { name: /生成.*档案卡/u })).toHaveCount(0)
    await openPaperFromLibrary(window, documentId)
    const reader = window.locator('.reader-header')
    await expect(reader.getByRole('button', { name: '档案卡', exact: true })).toHaveCount(0)
    await window.getByRole('tab', { name: 'Chat', exact: true }).click()
    const cardActions = window.locator('.reader-chat-toolbar').getByRole('button', { name: '档案卡', exact: true })
    await cardActions.click()
    await window.getByRole('menuitem', { name: '生成 AI 档案卡' }).click()
    await expect.poll(() => window.evaluate(async (id) => (await window.copilotix.paperInsight.get({ documentId: id })).status, documentId)).toBe('ready')
    await cardActions.click()
    await expect(window.getByRole('menuitem', { name: '重新生成档案卡' })).toBeVisible()
    await window.keyboard.press('Escape')
    await reader.getByRole('button', { name: '返回', exact: true }).click()
    archive = await openDetail()
    await expect(archive.getByRole('tab', { name: /背景/u })).toBeVisible({ timeout: 15_000 })
    await expect(archive.getByRole('tab', { name: /摘要/u })).toHaveAttribute('aria-selected', 'true')
    await expect(archive.getByRole('tabpanel')).toContainText(briefGeneration.analysis.abstract)
    await archive.getByRole('tab', { name: /背景/u }).click()
    for (const point of backgroundPoints(briefGeneration.analysis.background)) {
      await expect(archive.getByRole('tabpanel')).toContainText(point.title)
      await expect(archive.getByRole('tabpanel')).toContainText(point.text)
    }
    const requests = await app.evaluate(() => Reflect.get(globalThis, '__insightRequests')) as unknown[]
    expect(requests).toHaveLength(1)
    expect(JSON.stringify(requests)).toContain('Original paper content')
    expect(requests[0]).toMatchObject({ temperature: 0.2, max_tokens: 6000, response_format: { type: 'json_object' } })
    expect(JSON.stringify(requests)).not.toContain(workspace.root)
    expect(JSON.stringify(requests)).not.toContain('copilotix-e2e-insight-fake-key')
    const durable = await readFile(join(workspace.root, 'documents-v2', documentId, 'insight', 'brief.v2.json'), 'utf8')
    expect(durable).toContain(briefGeneration.analysis.conclusions[0]!.title); expect(durable).not.toContain('fake-key')
    await expect(archive.getByText('证据基础', { exact: true })).toHaveCount(0)
    await expect(archive.getByText('页数', { exact: true })).toHaveCount(0)
    await archive.getByRole('tab', { name: /结论/u }).click()
    await expect(archive.getByText('证据需核对', { exact: true })).toHaveCount(0)
    const firstFinding = archive.locator('.paper-archive-reading-points > li').first()
    await expect(firstFinding.locator('.paper-archive-anchor summary')).toContainText('E1')
    await firstFinding.locator('.paper-archive-anchor summary').click()
    await expect(firstFinding.locator('.paper-archive-anchor p')).toContainText('Original paper content')
    await window.screenshot({ path: testInfo.outputPath('archive-insight.png') })
    await window.reload(); archive = await openDetail()
    await expect(archive.getByRole('tabpanel')).toContainText(briefGeneration.analysis.abstract)
    await archive.getByRole('tab', { name: /背景/u }).click()
    for (const point of backgroundPoints(briefGeneration.analysis.background)) {
      await expect(archive.getByRole('tabpanel')).toContainText(point.title)
      await expect(archive.getByRole('tabpanel')).toContainText(point.text)
    }
    expect(await app.evaluate(() => (Reflect.get(globalThis, '__insightRequests') as unknown[]).length)).toBe(1)
    await window.locator('[data-edge-dock="top"]').hover()
    await window.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '设置' }).click()
    await window.getByRole('button', { name: '模型设置' }).click()
    // Automatic briefs are always on: no switch is offered.
    await expect(window.getByRole('checkbox', { name: '翻译完成后自动生成 AI 解读' })).toHaveCount(0)
    expect((await window.evaluate(() => window.copilotix.getSettings())).autoGeneratePaperInsight).toBe(true)
  } finally { await app?.close(); await workspace.cleanup() }
})

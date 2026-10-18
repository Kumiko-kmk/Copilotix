import { expect, test } from '@playwright/test'
import { join } from 'node:path'
import { createE2EWorkspace, launchElectron, seedReaderTask } from './helpers'
import { briefContent } from '../tests/fixtures/paperBrief'

test('archive renders maths across fields and tabs without clipping or changing reader behaviour', async ({ browserName }, testInfo) => {
  test.setTimeout(120_000)
  testInfo.annotations.push({ type: 'browser', description: browserName })
  const workspace = await createE2EWorkspace()
  let app: Awaited<ReturnType<typeof launchElectron>> | undefined
  const text = '输入 $x_i$，比例 \\(\\frac{a}{b}\\)，维度 d_model=512；代码 `d_model`。'
  // Parsed translation artifacts use the canonical dollar delimiter format.
  const documentText = text.replace('\\(\\frac{a}{b}\\)', '$\\frac{a}{b}$').replace('d_model=512', '$d_{\\mathrm{model}}=512$')
  try {
    await seedReaderTask(workspace, {
      englishTitle: 'Model $x_i$',
      sourceMarkdown: `# Model $x_i$\n\n## Abstract\n\n${documentText}\n\n## Method\n\n${documentText}`,
      translatedMarkdown: `# 模型 $x_i$\n\n## 摘要\n\n${documentText}\n\n## 1 方法 $x_i$\n\n${documentText}`
    })
    app = await launchElectron({ args: [join(__dirname, '../out/main/index.js')], env: workspace.env })
    const page = await app.firstWindow()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await expect.poll(() => page.evaluate(() => typeof window.copilotix?.getDocument)).toBe('function')
    const content = structuredClone(briefContent)
    content.metadata = { title: null, authors: { value: text, evidence: text, anchors: ['E1'] },
      venue: { value: text, evidence: text, anchors: ['E1'] }, year: null, doi: null }
    content.context = { background: text, gap: text, question: text }
    content.approach = { ...content.approach, summary: text, keyIdeas: [text], basis: text, evaluation: text }
    content.approach.summary += `\n\n$$\n${Array.from({ length: 45 }, () => 'a_i').join('+')}\n$$`
    content.contributions = [{ kind: 'method', text }]
    content.findings = [{ claim: text, evidence: text, scope: text, strength: 'limited', anchors: ['E1'] }]
    content.limitations = [{ text, source: 'author' }]
    content.assumptions = [text]
    content.openQuestions = [text]
    await app.evaluate(({ ipcMain }, value) => {
      ipcMain.removeHandler('paperInsight:get')
      ipcMain.handle('paperInsight:get', () => ({ ok: true, value: {
        status: 'ready', stale: false, promptOutdated: false,
        anchors: [{ id: 'E1', section: 'Method $x_i$', text: value.text }],
        brief: { ...value.content, schemaVersion: 2, checks: [{ grounded: true, numbersVerified: true }],
          provenance: { promptVersion: 'fixture', model: { provider: 'deepseek', name: 'deepseek-flash' }, generatedAt: '2026-10-14T00:00:00Z', sourceRevision: 'fixture', language: 'original', sentBytes: 100, sourceBytes: 200 } }
      } }))
    }, { content, text })
    await page.locator('[data-edge-dock="top"]').hover()
    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: /文库$/u }).click()
    const archive = page.getByRole('region', { name: '文库', exact: true })
    await expect(archive.locator('canvas[data-archive-state="ready"]')).toBeVisible({ timeout: 20_000 })
    await archive.getByRole('button', { name: '查看档案' }).click()
    await expect(archive).toHaveAttribute('data-detail-phase', 'open', { timeout: 20_000 })
    await expect(archive.locator('.paper-archive-detail header .katex')).toHaveCount(2)
    await expect(archive.locator('.paper-archive-fields .katex')).toHaveCount(6)
    await expect(archive.locator('.paper-archive-translated-abstract .katex')).toHaveCount(3)
    await expect(archive.locator('.paper-archive-translated-abstract code')).toHaveText('d_model')
    for (const size of [{ width: 1100, height: 720 }, { width: 1600, height: 900 }]) {
      const win = await app.browserWindow(page)
      await win.evaluate((window, next) => window.setContentSize(next.width, next.height), size)
      for (const name of ['摘要', '背景', '结论', '讨论']) {
        const tab = archive.getByRole('tab', { name: new RegExp(name, 'u') })
        await tab.click()
        await expect(tab).toHaveAttribute('aria-selected', 'true')
        await expect(archive.getByRole('tabpanel').locator('.katex').first()).toBeVisible()
        expect(await archive.locator('.katex-error').count()).toBe(0)
        if (name === '结论') {
          await archive.locator('.paper-archive-anchor summary').click()
          await expect(archive.locator('.paper-archive-anchor p .katex')).toHaveCount(3)
        }
        if (name === '结论') {
          await expect(archive.getByRole('tabpanel').locator('.katex-display')).toHaveCount(1)
          const formula = await archive.getByRole('tabpanel').locator('.katex-display').evaluate(node => ({ scroll: node.scrollWidth, width: node.clientWidth }))
          expect(formula.scroll).toBeGreaterThan(formula.width)
        }
        await expect.poll(() => archive.locator('.paper-archive-redaction-ink').count()).toBe(0)
        const geometry = await archive.locator('.paper-archive-detail').evaluate(element => {
          const panel = element.querySelector('.paper-archive-tabpanel') as HTMLElement
          return { scroll: panel.scrollWidth, width: panel.clientWidth, invalidNesting: element.querySelectorAll('p p, p div, h3 p, dd p p').length,
            formulas: [...element.querySelectorAll<HTMLElement>('.katex-html')].map(formula => { const rect = formula.getBoundingClientRect(); return { width: rect.width, height: rect.height } }) }
        })
        expect(geometry.scroll).toBeLessThanOrEqual(geometry.width + 1)
        expect(geometry.invalidNesting).toBe(0)
        expect(geometry.formulas.every(formula => formula.width > 0 && formula.height > 0)).toBe(true)
      }
      await page.evaluate(() => Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => undefined))))
      await page.screenshot({ path: testInfo.outputPath(`archive-math-${size.width}.png`) })
    }
    await archive.getByRole('button', { name: /打开阅读/u }).click()
    await expect(page.locator('.reader-header')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('.markdown-body .katex').first()).toBeVisible({ timeout: 30_000 })
    expect(errors).toEqual([])
  } finally {
    await app?.close()
    await workspace.cleanup()
  }
})

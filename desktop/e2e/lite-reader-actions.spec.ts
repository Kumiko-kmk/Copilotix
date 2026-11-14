import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { createE2EWorkspace, launchElectron, seedReaderTask } from './helpers'

const entry = resolve(__dirname, '../out-lite/main/index.js')
test.skip(!existsSync(entry), 'run pnpm desktop:build:lite first')

test('Lite title search, double-click editing and persistent citation copy card', async () => {
  const workspace = await createE2EWorkspace()
  const reference = 'Smith J. Fracture mechanics. Journal of Materials. 2024.'
  const paragraph = 'This editable paragraph describes a material experiment.'
  const citing = 'The measured response agrees with [1] in this experiment.'
  const id = await seedReaderTask(workspace, {
    englishTitle: '材料力學 Fracture Mechanics',
    sourceMarkdown: ['# Material experiment', paragraph, '## Results', 'The specimen was loaded slowly.',
      'The results describe the deformation of the material.', citing, '## References', `[1] ${reference}`,
      '[2] Liu WK. Material modelling. Science. 2022.', '[3] Peng GC. Multiscale mechanics. Nature. 2021.'].join('\n\n')
  })
  await seedReaderTask(workspace, { taskId: '00000000-0000-4000-8000-000000000099', englishTitle: 'Unrelated optics' })
  const app = await launchElectron({ args: [entry], env: workspace.env })
  try {
    const page = await app.firstWindow()
    await page.setViewportSize({ width: 1100, height: 700 })
    const nav = page.getByRole('navigation', { name: '論文導覽' })
    await expect(nav.locator('[data-document-id]')).toHaveCount(2)
    await nav.getByRole('button', { name: '搜尋論文', exact: true }).click()
    const search = nav.getByRole('searchbox', { name: '搜尋論文標題' })
    for (const query of ['材力', 'FRACT MECH']) {
      await search.fill(query)
      await expect(nav.locator('[data-document-id]')).toHaveCount(1)
      await expect(nav.locator('[data-document-id]')).toHaveAttribute('data-document-id', id)
    }
    await search.fill('不存在的論文')
    await expect(nav.getByRole('status')).toHaveText('沒有匹配的論文')
    await search.press('Escape')
    await expect(nav.locator('[data-document-id]')).toHaveCount(2)
    await nav.locator(`[data-document-id="${id}"]`).click()
    await expect(page.locator('.markdown-scroll[data-render-state="ready"]')).toBeVisible()
    const text = page.getByText(paragraph, { exact: true })
    await text.click()
    await page.waitForTimeout(350)
    await text.click()
    await page.waitForTimeout(350)
    await expect(page.getByRole('textbox', { name: '編輯原文段落' })).toHaveCount(0)
    await text.dblclick()
    const editor = page.getByRole('textbox', { name: '編輯原文段落' })
    await expect(editor).toBeVisible()
    await editor.fill(`${paragraph} Edited.`)
    await editor.press('Control+Enter')
    await expect(editor).toHaveCount(0)
    await page.getByText(`${paragraph} Edited.`, { exact: true }).click({ button: 'right' })
    await expect(page.getByRole('menu')).toBeVisible()
    await expect(page.getByRole('menuitem', { name: /整段加.*邊界框|上移|下移/u })).toHaveCount(0)
    await page.keyboard.press('Escape')

    const citation = page.getByText(citing, { exact: true })
    await citation.scrollIntoViewIfNeeded()
    // Use the actual text range: citation highlighting does not wrap Markdown in links.
    const point = await citation.evaluate(element => {
      const node = element.firstChild as Text
      const offset = node.data.indexOf('[1]')
      const range = document.createRange()
      range.setStart(node, offset); range.setEnd(node, offset + 3)
      const rect = range.getBoundingClientRect()
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    })
    await page.mouse.move(point.x, point.y)
    const card = page.getByRole('dialog', { name: '參考文獻', exact: true })
    await expect(card).toBeVisible()
    const bounds = await card.boundingBox()
    expect(bounds!.y + bounds!.height).toBeLessThan(point.y)
    await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2, { steps: 12 })
    await page.waitForTimeout(500)
    await expect(card).toBeVisible()
    // Keep the real user's clipboard intact while checking the browser API payload.
    await page.evaluate(() => {
      Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async (text: string) => {
        document.body.dataset.copiedReference = text
      } })
    })
    await card.getByRole('button', { name: '複製參考文獻 1', exact: true }).click()
    await expect(card.getByRole('status')).toHaveText('已複製')
    await expect(page.locator('body')).toHaveAttribute('data-copied-reference', reference)
    await page.screenshot({ path: test.info().outputPath('lite-reference-card.png') })
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: '設定', exact: true }).click()
    // One flat services page: Codex is a row with its detection, nothing folded away.
    const codex = page.locator('.lite-service[data-service="Codex"]')
    await expect(codex.getByRole('button', { name: '檢測' })).toBeVisible()
    await expect(page.getByText('高階設定')).toHaveCount(0)
    await expect(page.locator('.settings-dialog details')).toHaveCount(0)
    await page.screenshot({ path: test.info().outputPath('lite-settings.png') })
    expect(await page.locator('.settings-content-body').evaluate(body => body.scrollHeight - body.clientHeight)).toBeLessThanOrEqual(1)
  } finally {
    await app.close()
    await workspace.cleanup()
  }
})

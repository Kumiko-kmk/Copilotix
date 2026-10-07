import { expect, test } from '@playwright/test'
import { join } from 'node:path'
import { createE2EWorkspace, launchElectron, seedReaderTask } from './helpers'

for (const disableWebGL of [false, true]) {
  test(`paper archive search, navigation and reader return${disableWebGL ? ' without WebGL' : ''}`, async () => {
    const workspace = await createE2EWorkspace()
    let app: Awaited<ReturnType<typeof launchElectron>> | null = null
    try {
      await seedReaderTask(workspace, { englishTitle: 'Archive Alpha' })
      await seedReaderTask(workspace, { alignmentRegression: true, englishTitle: 'Archive Beta' })
      app = await launchElectron({
        args: [...(disableWebGL ? ['--disable-webgl'] : []), join(__dirname, '../out/main/index.js')],
        env: workspace.env
      })
      const window = await app.firstWindow()
      await window.locator('[data-edge-dock="top"]').hover()
      const navigation = window.getByRole('button', { name: '文库', exact: true })
      await expect(navigation).toBeVisible()
      await navigation.click()
      const archive = window.getByRole('region', { name: '文库', exact: true })
      await expect(archive).toBeVisible()
      const fallback = archive.getByRole('heading', { name: '当前环境无法显示三维文库' })
      const canvas = archive.locator('canvas.paper-archive-canvas[data-archive-state="ready"]')
      // A canvas alone does not prove that the model loaded. Accept only ready or explicit fallback.
      await expect(canvas.or(fallback)).toBeVisible({ timeout: 15_000 })
      if (disableWebGL) await expect(fallback).toBeVisible()
      const supported = !await fallback.isVisible()
      const quality = archive.getByRole('checkbox', { name: '流畅模式' })
      if (supported) {
        const index = archive.locator('.paper-archive-index strong')
        const first = await index.innerText()
        await archive.focus()
        await window.keyboard.press('ArrowDown')
        await expect(index).not.toHaveText(first)
        await window.keyboard.press('ArrowUp')
        await expect(index).toHaveText(first)
        await quality.check()
        await expect(quality).toBeChecked()
      } else {
        await expect(quality).toBeDisabled()
      }

      await archive.focus()
      await window.keyboard.press('/')
      const search = archive.getByRole('searchbox', { name: '搜索文库' })
      await expect(search).toBeFocused()
      await search.fill('no-such-archive-paper')
      await expect(archive.getByText('没有匹配的论文')).toBeVisible()
      await search.fill('ARCHIVE alpha')
      const results = archive.getByRole('list', { name: '搜索结果' })
      await expect(results.getByRole('button')).toHaveCount(1)
      await results.getByRole('button', { name: /Archive Alpha/u }).click()
      if (supported) {
        await expect(archive.locator('.paper-archive-title')).toHaveText('Archive Alpha.pdf')
        await archive.getByRole('button', { name: '打开阅读' }).click()
      }
      await expect(window.locator('.reader-header')).toBeVisible({ timeout: 30_000 })
      await expect(window.locator('.reader-title')).toHaveText('Archive Alpha.pdf')
      const markdown = window.locator('.reader-tab-panel.active .markdown-scroll')
      await expect(markdown).toHaveAttribute('data-render-state', /^(ready|error)$/, { timeout: 31_000 })
      await expect(markdown).toHaveAttribute('data-render-state', 'ready')
      await window.locator('.reader-header button').first().click()
      await expect(archive).toBeVisible()
      if (supported) {
        await expect(archive.locator('.paper-archive-title')).toHaveText('Archive Alpha.pdf')
        await expect(quality).toBeChecked()
      } else {
        await expect(fallback).toBeVisible()
        await expect(search).toBeVisible()
      }
    } finally {
      await app?.close()
      await workspace.cleanup()
    }
  })
}

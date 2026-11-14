import { test, expect, type Page } from '@playwright/test'
import { join } from 'node:path'
import { createE2EWorkspace, launchElectron, seedReaderTask, openPaperFromLibrary } from './helpers'
async function controls(page: Page) {
  const group = page.getByRole('group', { name: '窗口控制' })
  await expect(group).toBeVisible()
  await expect(group.getByRole('button')).toHaveCount(3)
  expect(await group.locator('button').evaluateAll(buttons => buttons.every(button => {
    const box = button.getBoundingClientRect()
    const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
    const dot = getComputedStyle(button, '::before')
    return button.contains(top) && box.width > 0 && box.y >= 0 && dot.content !== 'none' && dot.backgroundColor !== 'rgba(0, 0, 0, 0)'
  }))).toBe(true)
}
test('window controls stay visible and clickable across pages, maximize and modal overlays', async () => {
  const workspace = await createE2EWorkspace()
  const id = await seedReaderTask(workspace)
  const app = await launchElectron({ args: [join(__dirname, '../out/main/index.js')], env: workspace.env })
  try {
    const page = await app.firstWindow()
    for (const name of ['新解析', '文库', '设置', '新手教程', '新解析']) {
      await page.locator('[data-edge-dock="top"]').hover()
      await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: new RegExp(`${name}$`, 'u') }).click()
      await page.mouse.move(200, 200)
      await controls(page)
    }
    await openPaperFromLibrary(page, id)
    await expect(page.locator('.reader-header')).toBeVisible()
    await controls(page)
    await page.getByRole('button', { name: '最大化窗口', exact: true }).click()
    await expect(page.getByRole('button', { name: '还原窗口', exact: true })).toBeVisible()
    await controls(page)
    await page.getByRole('button', { name: '还原窗口', exact: true }).click()
    await page.getByRole('button', { name: '删除论文', exact: true }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await controls(page)
    await page.screenshot({ path: join(__dirname, '../../..', 'investigation/codex-live/window-controls-modal.png') })
  } finally { await app.close(); await workspace.cleanup() }
})

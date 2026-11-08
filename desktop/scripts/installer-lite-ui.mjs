import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, expect } from '@playwright/test'

// Attach to the renderer of the actual installed, fused executable. The installer
// test alone opts into a loopback CDP port; no Node inspector or product changes.
const [profile, evidence] = process.argv.slice(2)
if (!profile || !evidence) throw new Error('Expected test profile and evidence directory')
const deadline = Date.now() + 30_000
let port
while (Date.now() < deadline) {
  try {
    const candidate = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/u)[0])
    if (Number.isInteger(candidate) && candidate > 0 && candidate < 65536) { port = candidate; break }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  await new Promise(resolve => setTimeout(resolve, 200))
}
if (!port) throw new Error('Installed renderer did not expose its test CDP port')
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
try {
  const context = browser.contexts()[0]
  const page = context.pages()[0] ?? await context.waitForEvent('page', { timeout: 30_000 })
  await expect(page.getByRole('heading', { name: '今天想读些什么？' })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('navigation', { name: '论文导航' })).toBeVisible()
  await expect(page.locator('.window-controls')).toBeVisible()
  await page.screenshot({ path: join(evidence, '02-installed-home.png') })
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const sections = page.getByRole('navigation', { name: '设置分类' })
  for (const name of ['服务', '存储', '外观']) {
    await sections.getByRole('button', { name, exact: true }).click()
    await expect(page.locator('.settings-content-body')).toBeVisible()
  }
  await page.screenshot({ path: join(evidence, '02-installed-settings.png') })
  await page.getByRole('button', { name: '关闭设置' }).click()
  await expect(sections).toHaveCount(0)
  await writeFile(join(evidence, 'installed-ui.json'), JSON.stringify({
    completed: true, home: true, sidebar: true, settings: ['服务', '存储', '外观']
  }, null, 2))
  console.log('Installed Lite renderer: home, sidebar and all settings pages passed')
} finally {
  await browser.close()
}

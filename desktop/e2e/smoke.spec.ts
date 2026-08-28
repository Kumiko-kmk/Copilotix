import { _electron as electron, expect, test } from '@playwright/test'
import { join } from 'node:path'

test('opens the minimal new parse page', async () => {
  const app = await electron.launch({ args: [join(__dirname, '../out/main/index.js')] })
  const window = await app.firstWindow()
  await expect(window.getByText('智能解析')).toBeVisible()
  await expect(window.getByText('拖入 PDF 文件')).toBeVisible()
  await app.close()
})

test('opens the packaged Windows executable', async () => {
  test.skip(process.platform !== 'win32', 'Windows package only')
  const executablePath = join(__dirname, '../dist/win-unpacked/MinerU.exe')
  const app = await electron.launch({ executablePath, args: [] })
  const window = await app.firstWindow()
  const settingsResult = await window.evaluate(async () => {
    try {
      return { ok: true, value: await window.mineru.getSettings() }
    } catch (error) {
      return { ok: false, error: String(error) }
    }
  })
  expect(settingsResult, JSON.stringify(settingsResult)).toMatchObject({ ok: true })
  await expect(window.getByText('智能解析')).toBeVisible()
  await app.close()
})

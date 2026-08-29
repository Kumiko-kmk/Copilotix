import { _electron as electron, expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createE2EWorkspace } from './helpers'

const desktopPackage = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8')) as {
  version: string
  build?: { productName?: string }
}
const releaseName = `${desktopPackage.build?.productName ?? 'MinerU'}-${desktopPackage.version}-win-x64`

test('opens the minimal new parse page', async () => {
  const workspace = await createE2EWorkspace()
  const app = await electron.launch({ args: [join(__dirname, '../out/main/index.js')], env: workspace.env })
  try {
    const window = await app.firstWindow()
    await expect(window.getByText('智能解析')).toBeVisible()
    await expect(window.getByText('拖入 PDF 文件')).toBeVisible()
  } finally {
    await app.close()
    await workspace.cleanup()
  }
})

test('opens the packaged Windows executable', async () => {
  test.skip(process.platform !== 'win32', 'Windows package only')
  const workspace = await createE2EWorkspace()
  const executablePath = process.env.MINERU_E2E_EXECUTABLE_PATH
    ?? join(__dirname, `../../release/${releaseName}/MinerU.exe`)
  const app = await electron.launch({ executablePath, args: [], env: workspace.env })
  try {
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
  } finally {
    await app.close()
    await workspace.cleanup()
  }
})

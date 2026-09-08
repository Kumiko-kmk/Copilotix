import { expect, test } from '@playwright/test'
import { join } from 'node:path'
import { createE2EWorkspace, launchElectron } from './helpers'

test('exposes credential status without legacy test APIs', async () => {
  test.skip(process.env.MINERU_E2E_CREDENTIAL_CONTRACT !== 'true', 'Credential contract checks are opt-in')
  const workspace = await createE2EWorkspace()
  const app = await launchElectron({ args: [join(__dirname, '../out/main/index.js')], env: workspace.env })
  try {
    const window = await app.firstWindow()
    const settings = await window.evaluate(() => window.mineru.getSettings())
    expect(['missing', 'unknown', 'valid', 'invalid']).toContain(settings.credentials.parser.state)
    expect(settings).not.toHaveProperty('hasParserToken')
    expect(settings).not.toHaveProperty('qwenHasApiKey')
    expect(settings).not.toHaveProperty('deepseekHasApiKey')
  } finally {
    await app.close()
    await workspace.cleanup()
  }
})

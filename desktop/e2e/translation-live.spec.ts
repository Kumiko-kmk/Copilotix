import { expect, test } from '@playwright/test'
import { join } from 'node:path'
import { createE2EWorkspace, launchElectron } from './helpers'
import type { TranslationProviderId } from '../src/shared/types'

for (const provider of ['bing', 'transmart'] satisfies TranslationProviderId[]) {
  test(`checks the optional live ${provider} translation adapter`, async () => {
    test.skip(process.env.MINERU_E2E_LIVE_TRANSLATION !== 'true', 'Live translation checks are opt-in')
    const workspace = await createE2EWorkspace()
    const app = await launchElectron({ args: [join(__dirname, '../out/main/index.js')], env: workspace.env })
    try {
      const window = await app.firstWindow()
      const result = await window.evaluate((providerId) => window.mineru.testTranslationProvider(providerId), provider)
      expect(result.ok, result.message).toBe(true)
    } finally {
      await app.close()
      await workspace.cleanup()
    }
  })
}

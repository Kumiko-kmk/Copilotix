import { describe, expect, it } from 'vitest'
import { realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { resolveInstalledElectronDist } from '../scripts/package-directory.mjs'

describe('installed Electron packaging opt-in', () => {
  it('leaves the default download configuration unchanged', async () => {
    expect(await resolveInstalledElectronDist({})).toBeUndefined()
    expect(await resolveInstalledElectronDist({ COPILOTIX_USE_INSTALLED_ELECTRON: '' })).toBeUndefined()
  })

  it('rejects ambiguous environment values', async () => {
    await expect(resolveInstalledElectronDist({ COPILOTIX_USE_INSTALLED_ELECTRON: 'true' })).rejects.toThrow('must be 1')
  })

  it('resolves and verifies the installed pinned distribution', async () => {
    const require = createRequire(import.meta.url)
    const expected = await realpath(join(dirname(require.resolve('electron/package.json')), 'dist'))
    expect(await resolveInstalledElectronDist({ COPILOTIX_USE_INSTALLED_ELECTRON: '1' })).toBe(expected)
  })
})

import { describe, expect, it } from 'vitest'
import { applyReleaseFusesAfterPack } from '../scripts/after-pack.mjs'

describe('electron-builder afterPack fuse hook', () => {
  it('applies and verifies the fuses on the packaged Windows executable path', async () => {
    const calls = []
    const executablePath = await applyReleaseFusesAfterPack({
      appOutDir: 'C:/staging/win-unpacked',
      electronPlatformName: 'win32'
    }, async (path) => { calls.push(path) })

    expect(executablePath.replaceAll('\\', '/')).toBe('C:/staging/win-unpacked/Copilotix.exe')
    expect(calls).toEqual([executablePath])
  })

  it('fails if the configured Windows packaging hook receives an unexpected context', async () => {
    await expect(applyReleaseFusesAfterPack({ appOutDir: 'C:/staging', electronPlatformName: 'linux' }, async () => {}))
      .rejects.toThrow(/unexpected platform/)
    await expect(applyReleaseFusesAfterPack({ electronPlatformName: 'win32' }, async () => {}))
      .rejects.toThrow(/missing appOutDir/)
  })
})

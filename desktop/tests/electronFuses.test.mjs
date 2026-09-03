import { describe, expect, it } from 'vitest'
import { FuseV1Options, FuseVersion } from '@electron/fuses'
import { applyDesktopFuses, assertDesktopFuses, desktopFuseOptions } from '../scripts/electron-fuses.mjs'

describe('desktop fuses', () => {
  it('declares the release-time hardening switches without touching a build', () => {
    expect(desktopFuseOptions[FuseV1Options.RunAsNode]).toBe(false)
    expect(desktopFuseOptions[FuseV1Options.EnableNodeOptionsEnvironmentVariable]).toBe(false)
    expect(desktopFuseOptions[FuseV1Options.EnableNodeCliInspectArguments]).toBe(false)
    expect(desktopFuseOptions[FuseV1Options.EnableEmbeddedAsarIntegrityValidation]).toBe(true)
    expect(desktopFuseOptions[FuseV1Options.OnlyLoadAppFromAsar]).toBe(true)
  })

  it('requires an explicit executable path', async () => {
    await expect(applyDesktopFuses()).rejects.toThrow(/path is required/)
  })

  it('verifies read-back fuse states instead of trusting the write call', () => {
    const readBack = {
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: 0x30,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: 0x30,
      [FuseV1Options.EnableNodeCliInspectArguments]: 0x30,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: 0x31,
      [FuseV1Options.OnlyLoadAppFromAsar]: 0x31
    }
    expect(() => assertDesktopFuses(readBack)).not.toThrow()
    expect(() => assertDesktopFuses({ ...readBack, [FuseV1Options.OnlyLoadAppFromAsar]: 0x30 })).toThrow(/read-back mismatch/)
  })
})

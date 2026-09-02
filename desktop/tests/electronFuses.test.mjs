import { describe, expect, it } from 'vitest'
import { FuseV1Options } from '@electron/fuses'
import { applyDesktopFuses, desktopFuseOptions } from '../scripts/electron-fuses.mjs'

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
})

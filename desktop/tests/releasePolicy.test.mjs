import { describe, expect, it } from 'vitest'
import {
  MEBIBYTE,
  RELEASE_LIMITS,
  assertLocales,
  assertNoCanvasPaths,
  assertRequiredPackagedContent,
  assertReleaseMeasurements,
  assertSafeBuildOutputPath
} from '../scripts/release-policy.mjs'

describe('release policy', () => {
  it('only permits the exact desktop/out cleanup target', () => {
    const desktop = 'C:/workspace/desktop'
    expect(() => assertSafeBuildOutputPath(desktop, 'C:/workspace/desktop/out')).not.toThrow()
    expect(() => assertSafeBuildOutputPath(desktop, 'C:/workspace')).toThrow(/unexpected build output path/)
    expect(() => assertSafeBuildOutputPath(desktop, 'C:/workspace/desktop/out-old')).toThrow(/unexpected build output path/)
  })

  it('accepts release measurements at the configured limits', () => {
    expect(() => assertReleaseMeasurements(RELEASE_LIMITS)).not.toThrow()
  })

  it.each([
    ['appAsarBytes', 40],
    ['runtimeBytes', 330],
    ['zipBytes', 140]
  ])('rejects an oversized %s measurement', (key, limitMiB) => {
    const measurements = { ...RELEASE_LIMITS, [key]: (limitMiB * MEBIBYTE) + 1 }
    expect(() => assertReleaseMeasurements(measurements)).toThrow(key)
  })

  it('only accepts the simplified Chinese Electron locale', () => {
    expect(() => assertLocales(['zh-CN.pak'])).not.toThrow()
    expect(() => assertLocales(['zh-CN.pak', 'en-US.pak'])).toThrow(/Unexpected Electron locales/)
    expect(() => assertLocales([])).toThrow(/Unexpected Electron locales/)
  })

  it('rejects canvas content in packed or unpacked paths', () => {
    expect(() => assertNoCanvasPaths(['resources/app.asar', 'node_modules/@napi-rs/keyring/index.js'])).not.toThrow()
    expect(() => assertNoCanvasPaths(['node_modules/@napi-rs/canvas/index.js'])).toThrow(/canvas/)
    expect(() => assertNoCanvasPaths(['resources/app.asar.unpacked/node_modules/@napi-rs/canvas-win32-x64-msvc/skia.node'])).toThrow(/canvas/)
  })

  it('requires the application entry points and unpacked keyring dependency', () => {
    expect(() => assertRequiredPackagedContent({
      asarEntries: ['\\out/main/index.js', '/out/preload/index.js', '\\out/renderer/index.html', '/package.json'],
      runtimeFiles: [{ path: 'resources/app.asar.unpacked/node_modules/@napi-rs/keyring/index.js', size: 1 }]
    })).not.toThrow()
    expect(() => assertRequiredPackagedContent({
      asarEntries: ['out/main/index.js'],
      runtimeFiles: []
    })).toThrow(/required app.asar entries/i)
  })
})

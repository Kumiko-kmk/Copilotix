import { describe, expect, it } from 'vitest'
import {
  MEBIBYTE,
  RELEASE_LIMITS,
  assertLocales,
  assertDesktopReleaseLicenseMetadata,
  assertNoCanvasPaths,
  assertReleaseAssetNames,
  setupNameForRelease,
  assertReleaseSigningConfiguration,
  assertReleaseTagMatchesVersion,
  assertRequiredPackagedContent,
  assertReleaseMeasurements,
  assertSafeBuildOutputPath,
  assertValidAuthenticodeSignature
} from '../scripts/release-policy.mjs'

describe('release policy', () => {
  it('requires desktop release tags to match the packaged version exactly', () => {
    expect(assertReleaseTagMatchesVersion('desktop-v0.1.0', '0.1.0')).toBe('desktop-v0.1.0')
    expect(() => assertReleaseTagMatchesVersion('desktop-v0.1.1', '0.1.0')).toThrow(/does not match package version/)
    expect(() => assertReleaseTagMatchesVersion('desktop-v0.1.0', 'latest')).toThrow(/Invalid desktop release version/)
  })

  it('blocks public release while the desktop license declaration is unresolved', () => {
    expect(assertDesktopReleaseLicenseMetadata({ license: 'MIT' })).toBe('MIT')
    for (const license of [undefined, '', '  ', 'UNLICENSED', 'unlicensed', ' UnLicensed ']) {
      expect(() => assertDesktopReleaseLicenseMetadata({ license })).toThrow(/UNLICENSED is not releasable/)
    }
  })

  it('keeps local unsigned packaging available and fails closed for production without a certificate', () => {
    expect(assertReleaseSigningConfiguration({})).toBe(false)
    expect(assertReleaseSigningConfiguration({ COPILOTIX_RELEASE_MODE: 'development' })).toBe(false)
    expect(assertReleaseSigningConfiguration({ COPILOTIX_RELEASE_MODE: 'production', WIN_CSC_LINK: 'base64-certificate' })).toBe(true)
    expect(assertReleaseSigningConfiguration({ COPILOTIX_RELEASE_MODE: 'production', CSC_LINK: 'base64-certificate' })).toBe(true)
    expect(() => assertReleaseSigningConfiguration({ COPILOTIX_RELEASE_MODE: 'production' })).toThrow(/refusing to build an unsigned release/)
    expect(() => assertReleaseSigningConfiguration({ COPILOTIX_RELEASE_MODE: 'unexpected' })).toThrow(/Unsupported Copilotix release mode/)
  })

  it('only permits a complete, unique release asset set before publishing', () => {
    expect(assertReleaseAssetNames([
      'Copilotix-Setup-0.1.0-x64.exe',
      'Copilotix-0.1.0-win-x64.zip',
      'SHA256SUMS.txt',
      'release-manifest.json'
    ], 'Copilotix-0.1.0-win-x64')).toBe(true)
    expect(() => assertReleaseAssetNames(['SHA256SUMS.txt', 'release-manifest.json'], 'Copilotix-0.1.0-win-x64')).toThrow(/Unexpected release assets/)
    expect(() => assertReleaseAssetNames([
      'Copilotix-Setup-0.1.0-x64.exe',
      'Copilotix-0.1.0-win-x64.zip',
      'Copilotix-Setup-0.1.0-x64.exe',
      'Copilotix-0.1.0-win-x64.zip',
      'SHA256SUMS.txt',
      'release-manifest.json'
    ], 'Copilotix-0.1.0-win-x64')).toThrow(/Unexpected release assets/)
  })

  it('derives Setup filenames for hyphenated products and prerelease versions', () => {
    expect(setupNameForRelease('Copilotix-0.1.0-win-x64')).toBe('Copilotix-Setup-0.1.0-x64.exe')
    expect(setupNameForRelease('My-App-1.2.3-beta.1-win-x64')).toBe('My-App-Setup-1.2.3-beta.1-x64.exe')
    expect(() => setupNameForRelease('../bad')).toThrow(/Invalid Windows release name/)
  })

  it('requires a valid Authenticode result and a signer subject', () => {
    expect(assertValidAuthenticodeSignature({ status: 'Valid', signerSubject: 'CN=Copilotix Release' })).toBe('CN=Copilotix Release')
    expect(() => assertValidAuthenticodeSignature({ status: 'NotSigned' })).toThrow(/not valid/)
    expect(() => assertValidAuthenticodeSignature({ status: 'Valid', signerSubject: '' })).toThrow(/no signer certificate subject/)
  })

  it('only permits the exact desktop/out cleanup target', () => {
    const desktop = 'C:/workspace/desktop'
    expect(() => assertSafeBuildOutputPath(desktop, 'C:/workspace/desktop/out')).not.toThrow()
    expect(() => assertSafeBuildOutputPath(desktop, 'C:/workspace')).toThrow(/unexpected build output path/)
    expect(() => assertSafeBuildOutputPath(desktop, 'C:/workspace/desktop/out-old')).toThrow(/unexpected build output path/)
  })

  it('accepts release measurements at the configured limits', () => {
    expect(() => assertReleaseMeasurements(RELEASE_LIMITS)).not.toThrow()
  })

  it('accepts the measured Electron 44.1.1 Windows runtime and archive sizes', () => {
    expect(() => assertReleaseMeasurements({
      appAsarBytes: 29.22 * MEBIBYTE,
      runtimeBytes: 349.88 * MEBIBYTE,
      zipBytes: 148.78 * MEBIBYTE,
      setupBytes: 150 * MEBIBYTE
    })).not.toThrow()
  })

  it.each(['appAsarBytes', 'runtimeBytes', 'zipBytes', 'setupBytes'])('rejects an oversized %s measurement', (key) => {
    const measurements = { ...RELEASE_LIMITS, [key]: RELEASE_LIMITS[key] + 1 }
    expect(() => assertReleaseMeasurements(measurements)).toThrow(key)
  })

  it('rejects duplicate-runtime archives rather than expanding the ZIP budget', () => {
    expect(() => assertReleaseMeasurements({ ...RELEASE_LIMITS, zipBytes: 245 * MEBIBYTE })).toThrow(/zipBytes/)
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

  it('requires the application entry points, unpacked utility, and keyring dependency', () => {
    const runtimeFiles = [
      { path: 'resources/tutorial/Attention Is All You Need.pdf', size: 1 },
      { path: 'resources/app.asar.unpacked/out/utility/index.js', size: 1 },
      { path: 'resources/app.asar.unpacked/out/utility/uninstall-cleanup.js', size: 1 },
      { path: 'resources/app.asar.unpacked/node_modules/@napi-rs/keyring/index.js', size: 1 },
      { path: 'resources/app.asar.unpacked/node_modules/@napi-rs/keyring-win32-x64-msvc/package.json', size: 1 },
      { path: 'resources/app.asar.unpacked/node_modules/@napi-rs/keyring-win32-x64-msvc/keyring.win32-x64-msvc.node', size: 1 }
    ]
    expect(() => assertRequiredPackagedContent({
      asarEntries: ['\\out/main/index.js', '/out/preload/index.js', '\\out/renderer/index.html', '/package.json'],
      runtimeFiles
    })).not.toThrow()
    expect(() => assertRequiredPackagedContent({
      asarEntries: ['out/main/index.js'],
      runtimeFiles: []
    })).toThrow(/required app.asar entries/i)
    for (const missing of runtimeFiles) {
      expect(() => assertRequiredPackagedContent({
        asarEntries: ['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html', 'package.json'],
        runtimeFiles: runtimeFiles.filter((entry) => entry !== missing)
      })).toThrow(/Missing required unpacked runtime dependencies/)
    }
    expect(() => assertRequiredPackagedContent({
      asarEntries: ['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html', 'package.json'],
      runtimeFiles: runtimeFiles.map((entry, index) => index === 2 ? { ...entry, size: 0 } : entry)
    })).toThrow(/Empty required unpacked runtime dependencies/)
  })
})

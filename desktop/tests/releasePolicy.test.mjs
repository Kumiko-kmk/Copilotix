import { describe, expect, it } from 'vitest'
import { MEBIBYTE, RELEASE_LIMITS, assertLocales, assertDesktopReleaseLicenseMetadata, assertNoCanvasPaths, assertReleaseAssetNames, setupNameForRelease, assertReleaseSigningConfiguration, assertReleaseTagMatchesVersion, assertRequiredPackagedContent, assertReleaseMeasurements, assertSafeBuildOutputPath, assertValidAuthenticodeSignature } from '../scripts/release-policy.mjs'
import { applyReleaseFusesAfterPack } from '../scripts/after-pack.mjs'
import { FuseV1Options, FuseVersion } from '@electron/fuses'
import { applyDesktopFuses, assertDesktopFuses, desktopFuseOptions } from '../scripts/electron-fuses.mjs'
import { PACKAGED_SMOKE_ARG, assertDependencyRoots, assertPackagedSmokeVersions, assertPnpmInvocation, formatPackagedSmokeMarker, shouldRunPackagedSmoke, validatePackagedSmokeOutput, resolveInstalledElectronDist } from '../scripts/package-directory.mjs'
import { realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { registeredUninstallerPath, nsisDefine, buildStandaloneUninstaller } from '../scripts/build-uninstall-launcher.mjs'

describe("releasePolicy", () => {
  describe('release policy', () => {
    it('requires desktop release tags to match the packaged version exactly', () => {
      expect(assertReleaseTagMatchesVersion('desktop-v1.0.0', '1.0.0')).toBe('desktop-v1.0.0')
      expect(() => assertReleaseTagMatchesVersion('desktop-v0.1.1', '1.0.0')).toThrow(/does not match package version/)
      expect(() => assertReleaseTagMatchesVersion('desktop-v1.0.0', 'latest')).toThrow(/Invalid desktop release version/)
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
        'setup.exe',
        'Copilotix-1.0.0-win-x64.zip',
        'SHA256SUMS.txt',
        'release-manifest.json'
      ], 'Copilotix-1.0.0-win-x64')).toBe(true)
      expect(() => assertReleaseAssetNames(['SHA256SUMS.txt', 'release-manifest.json'], 'Copilotix-1.0.0-win-x64')).toThrow(/Unexpected release assets/)
      expect(() => assertReleaseAssetNames([
        'setup.exe',
        'Copilotix-1.0.0-win-x64.zip',
        'setup.exe',
        'Copilotix-1.0.0-win-x64.zip',
        'SHA256SUMS.txt',
        'release-manifest.json'
      ], 'Copilotix-1.0.0-win-x64')).toThrow(/Unexpected release assets/)
    })

    it('derives Setup filenames for hyphenated products and prerelease versions', () => {
      expect(setupNameForRelease('Copilotix-1.0.0-win-x64')).toBe('setup.exe')
      expect(setupNameForRelease('My-App-1.2.3-beta.1-win-x64')).toBe('setup.exe')
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
})

describe("afterPack", () => {
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
})

describe("electronFuses", () => {
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
})

describe("packagedSmoke", () => {
  const expectedVersions = Object.freeze({ appVersion: '0.1.0', electronVersion: '44.1.1' })

  describe('packaged startup smoke contract', () => {
    it('requires the declared pnpm version and worktree-local dependencies', () => {
      expect(() => assertPnpmInvocation({ npm_config_user_agent: 'pnpm/11.19.0 npm/? node/v24.11.1 win32 x64' })).not.toThrow()
      expect(() => assertPnpmInvocation({})).toThrow(/direct Node\/npm invocation/)
      expect(() => assertPnpmInvocation({ npm_config_user_agent: 'pnpm/10.0.0 npm/?' })).toThrow(/pnpm@10.0.0/)
      expect(() => assertDependencyRoots('C:/workspace', ['C:/workspace/node_modules', 'C:/workspace/desktop/node_modules'])).not.toThrow()
      expect(() => assertDependencyRoots('C:/workspace', ['D:/shared/node_modules'])).toThrow(/outside the current worktree/)
    })

    it('gates the dedicated mode on the packaged app flag', () => {
      expect(shouldRunPackagedSmoke([PACKAGED_SMOKE_ARG], true)).toBe(true)
      expect(shouldRunPackagedSmoke([PACKAGED_SMOKE_ARG], false)).toBe(false)
      expect(shouldRunPackagedSmoke(['--version'], true)).toBe(false)
    })

    it('uses the package-declared app version and requires exact Electron 44.1.1', () => {
      expect(assertPackagedSmokeVersions({ version: '0.1.0', devDependencies: { electron: '44.1.1' } })).toEqual(expectedVersions)
      expect(assertPackagedSmokeVersions({ version: '0.1.1', devDependencies: { electron: '44.1.1' } })).toEqual({ appVersion: '0.1.1', electronVersion: '44.1.1' })
      expect(() => assertPackagedSmokeVersions({ version: '0.1.0\nunexpected', devDependencies: { electron: '44.1.1' } })).toThrow(/Invalid app version/)
      expect(() => assertPackagedSmokeVersions({ version: '0.1.0', devDependencies: { electron: '^44.1.1' } })).toThrow(/44\.1\.1/)
    })

    it('accepts exactly one marker and rejects all extra or error output', () => {
      const marker = formatPackagedSmokeMarker(expectedVersions)
      expect(validatePackagedSmokeOutput({ stdout: marker, stderr: '' }, expectedVersions)).toBe(true)
      expect(validatePackagedSmokeOutput({ stdout: `\r\n${marker}`, stderr: '' }, expectedVersions)).toBe(true)
      expect(validatePackagedSmokeOutput({ stdout: `\r\n\r\n${marker}`, stderr: '' }, expectedVersions)).toBe(false)
      expect(validatePackagedSmokeOutput({ stdout: ` \r\n${marker}`, stderr: '' }, expectedVersions)).toBe(false)
      expect(validatePackagedSmokeOutput({ stdout: `unexpected\r\n${marker}`, stderr: '' }, expectedVersions)).toBe(false)
      expect(validatePackagedSmokeOutput({ stdout: `${marker}unexpected`, stderr: '' }, expectedVersions)).toBe(false)
      expect(validatePackagedSmokeOutput({ stdout: `${marker}${marker}`, stderr: '' }, expectedVersions)).toBe(false)
      expect(validatePackagedSmokeOutput({ stdout: marker, stderr: 'Error: unexpected diagnostic' }, expectedVersions)).toBe(false)
    })
  })
})

describe("installedElectronDist", () => {
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
})

describe("uninstallLauncher", () => {
  describe('standalone registered uninstall entry', () => {
    it.each(['uninstall.exe', 'Uninstall Copilotix.exe'])('finds only the registered %s in a custom Unicode path', (name) => {
      const root = 'C:\\使用者\\program files\\Copilotix'
      expect(registeredUninstallerPath(root, `"${root}\\${name}" /currentuser`)).toBe(`${root}\\${name}`)
    })
    it.each([
      ['relative\\Copilotix', '"relative\\Copilotix\\uninstall.exe"'],
      ['C:\\', '"C:\\uninstall.exe"'],
      ['C:\\app\\..\\Copilotix', '"C:\\app\\..\\Copilotix\\uninstall.exe"'],
      ['C:\\Copilotix', 'cmd.exe /c del C:\\Copilotix'],
      ['C:\\Copilotix', '"C:\\Other\\uninstall.exe" /currentuser'],
      ['C:\\Copilotix', '"C:\\Copilotix\\uninstall.exe" /S'],
      ['C:\\Copilotix', '"C:\\Copilotix\\uninstall.exe" /allusers'],
    ])('rejects unsafe registration %s', (root, command) => {
      expect(registeredUninstallerPath(root, command)).toBeNull()
    })
    it('rejects NSIS directive injection', () => {
      expect(() => nsisDefine('OUTPUT_PATH', 'C:\\out$INSTDIR\\uninstall.exe')).toThrow('Unsafe NSIS')
      expect(() => nsisDefine('OUTPUT_PATH', 'C:\\out\n!system del')).toThrow('Unsafe NSIS')
    })
    it('requires a trusted production signer before invoking any compiler', async () => {
      await expect(buildStandaloneUninstaller({ outputPath: 'C:\\output\\uninstall.exe', productionRelease: true })).rejects.toThrow(/Production uninstaller|requires Windows/u)
    })
  })
})

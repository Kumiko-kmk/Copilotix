import { readdir, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'

export const MEBIBYTE = 1024 * 1024

export const RELEASE_LIMITS = Object.freeze({
  appAsarBytes: 40 * MEBIBYTE,
  runtimeBytes: 360 * MEBIBYTE,
  zipBytes: 155 * MEBIBYTE,
  setupBytes: 180 * MEBIBYTE
})

const RELEASE_VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u

/** Require the pushed desktop tag to describe the version being packaged. */
export function assertReleaseTagMatchesVersion(tag, version) {
  if (typeof version !== 'string' || !RELEASE_VERSION_PATTERN.test(version)) {
    throw new Error(`Invalid desktop release version: ${String(version)}`)
  }
  const expectedTag = `desktop-v${version}`
  if (tag !== expectedTag) {
    throw new Error(`Desktop release tag ${String(tag)} does not match package version ${version}; expected ${expectedTag}`)
  }
  return expectedTag
}

/** Keep public release tags blocked until maintainers decide desktop licensing. */
export function assertDesktopReleaseLicenseMetadata(packageJson) {
  const license = packageJson?.license
  if (typeof license !== 'string' || license.trim().length === 0 || license.trim().toUpperCase() === 'UNLICENSED') {
    throw new Error('Public desktop release is blocked: desktop/package.json has no selected release license (UNLICENSED is not releasable); resolve the desktop code license before releasing')
  }
  return license.trim()
}

/** Keep local unsigned builds available and require credentials for production tags. */
export function assertReleaseSigningConfiguration(environment = process.env) {
  const mode = environment?.COPILOTIX_RELEASE_MODE ?? 'development'
  if (mode === 'development') return false
  if (mode !== 'production') throw new Error(`Unsupported Copilotix release mode: ${String(mode)}`)
  const certificate = environment?.WIN_CSC_LINK ?? environment?.CSC_LINK
  if (typeof certificate !== 'string' || certificate.trim().length === 0) {
    throw new Error('Production release requires WIN_CSC_LINK (or CSC_LINK); refusing to build an unsigned release')
  }
  return true
}

/** Require the exact release asset set before a draft can be published. */
export function setupNameForRelease(releaseName) {
  const match = /^(.+?)-((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)-win-x64$/u.exec(String(releaseName))
  if (!match) throw new Error(`Invalid Windows release name: ${String(releaseName)}`)
  return `${match[1]}-Setup-${match[2]}-x64.exe`
}

export function assertReleaseAssetNames(assetNames, releaseName) {
  if (!Array.isArray(assetNames) || typeof releaseName !== 'string' || !releaseName) {
    throw new TypeError('Release asset names and release name are required')
  }
  const expected = [setupNameForRelease(releaseName), `${releaseName}.zip`, 'SHA256SUMS.txt', 'release-manifest.json'].sort()
  const actual = assetNames.map((name) => String(name)).sort()
  if (
    actual.length !== expected.length ||
    new Set(actual).size !== actual.length ||
    actual.some((name, index) => name !== expected[index])
  ) {
    throw new Error(`Unexpected release assets: ${actual.join(', ') || '(none)'}; expected ${expected.join(', ')}`)
  }
  return true
}

/** Validate the Authenticode result returned by Windows PowerShell. */
export function assertValidAuthenticodeSignature(result) {
  if (result?.status !== 'Valid') {
    throw new Error(`Windows Authenticode signature is not valid: ${String(result?.status ?? 'missing signature')}`)
  }
  if (typeof result.signerSubject !== 'string' || result.signerSubject.trim().length === 0) {
    throw new Error('Windows Authenticode signature has no signer certificate subject')
  }
  return result.signerSubject.trim()
}

const EXPECTED_LOCALES = Object.freeze(['zh-CN.pak'])
const CANVAS_PATH_PATTERN = /(^|[\\/])@napi-rs[\\/]canvas(?:[-\\/]|$)/i
const REQUIRED_ASAR_ENTRIES = Object.freeze([
  'out/main/index.js',
  'out/preload/index.js',
  'out/renderer/index.html',
  'package.json'
])
const REQUIRED_RUNTIME_ENTRIES = Object.freeze([
  'resources/tutorial/Attention Is All You Need.pdf',
  'resources/app.asar.unpacked/out/utility/index.js',
  'resources/app.asar.unpacked/out/utility/uninstall-cleanup.js',
  'resources/app.asar.unpacked/node_modules/@napi-rs/keyring/index.js',
  'resources/app.asar.unpacked/node_modules/@napi-rs/keyring-win32-x64-msvc/package.json',
  'resources/app.asar.unpacked/node_modules/@napi-rs/keyring-win32-x64-msvc/keyring.win32-x64-msvc.node'
])

export function assertSafeBuildOutputPath(desktopDirectory, targetDirectory) {
  const desktop = resolve(desktopDirectory)
  const expected = resolve(desktop, 'out')
  const target = resolve(targetDirectory)
  if (normalizePath(target) !== normalizePath(expected) || normalizePath(dirname(target)) !== normalizePath(desktop)) {
    throw new Error(`Refusing to clean unexpected build output path: ${targetDirectory}`)
  }
}

export function assertReleaseMeasurements(measurements, limits = RELEASE_LIMITS) {
  for (const key of ['appAsarBytes', 'runtimeBytes', 'zipBytes', 'setupBytes']) {
    const actual = measurements[key]
    const limit = limits[key]
    if (!Number.isFinite(actual) || actual < 0) throw new Error(`Invalid release measurement ${key}: ${String(actual)}`)
    if (!Number.isFinite(limit) || limit <= 0) throw new Error(`Invalid release limit ${key}: ${String(limit)}`)
    if (actual > limit) {
      throw new Error(`Release size limit exceeded for ${key}: ${formatMiB(actual)} MiB > ${formatMiB(limit)} MiB`)
    }
  }
}

export function assertLocales(entryNames) {
  const actual = [...entryNames].sort()
  const expected = [...EXPECTED_LOCALES].sort()
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new Error(`Unexpected Electron locales: ${actual.join(', ') || '(none)'}; expected ${expected.join(', ')}`)
  }
}

export function assertNoCanvasPaths(paths) {
  const match = paths.find((path) => CANVAS_PATH_PATTERN.test(path))
  if (match) throw new Error(`Forbidden @napi-rs/canvas release content: ${match}`)
}

/** Verify the application entry points that make a directory build runnable. */
export function assertRequiredPackagedContent({ asarEntries, runtimeFiles }) {
  assertRequiredAsarEntries(asarEntries)
  assertRequiredRuntimeEntries(runtimeFiles)
}

export function assertRequiredAsarEntries(entryNames, requiredEntries = REQUIRED_ASAR_ENTRIES) {
  const entries = new Set([...entryNames].map(normalizeEntryName))
  const missing = requiredEntries.filter((entry) => !entries.has(normalizeEntryName(entry)))
  if (missing.length > 0) throw new Error(`Missing required app.asar entries: ${missing.join(', ')}`)
}

export function assertRequiredRuntimeEntries(files, requiredEntries = REQUIRED_RUNTIME_ENTRIES) {
  const entries = new Map([...files].map((entry) => [
    normalizeEntryName(typeof entry === 'string' ? entry : entry.path),
    typeof entry === 'string' ? null : entry.size
  ]))
  const missing = requiredEntries.filter((entry) => !entries.has(normalizeEntryName(entry)))
  if (missing.length > 0) throw new Error(`Missing required unpacked runtime dependencies: ${missing.join(', ')}`)
  const empty = requiredEntries.filter((entry) => {
    const size = entries.get(normalizeEntryName(entry))
    return size !== null && (!Number.isFinite(size) || size <= 0)
  })
  if (empty.length > 0) throw new Error(`Empty required unpacked runtime dependencies: ${empty.join(', ')}`)
}

export async function auditRelease({ runtimeDirectory, zipPath, setupPath, asarEntries = [] }) {
  const appAsarPath = join(runtimeDirectory, 'resources', 'app.asar')
  const localeDirectory = join(runtimeDirectory, 'locales')
  const [appAsarDetails, zipDetails, setupDetails, runtimeFiles, localeEntries] = await Promise.all([
    stat(appAsarPath),
    stat(zipPath),
    stat(setupPath),
    collectRelativeFiles(runtimeDirectory),
    readdir(localeDirectory, { withFileTypes: true })
  ])
  const measurements = {
    appAsarBytes: appAsarDetails.size,
    runtimeBytes: runtimeFiles.reduce((total, file) => total + file.size, 0),
    zipBytes: zipDetails.size,
    setupBytes: setupDetails.size
  }
  assertReleaseMeasurements(measurements)
  assertLocales(localeEntries.map((entry) => entry.name))
  assertNoCanvasPaths([...runtimeFiles.map((file) => file.path), ...asarEntries])
  return measurements
}

export async function collectRelativeFiles(rootDirectory) {
  const root = resolve(rootDirectory)
  const pending = [root]
  const files = []
  while (pending.length > 0) {
    const directory = pending.pop()
    if (!directory) continue
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name)
      if (entry.isDirectory()) {
        pending.push(absolutePath)
      } else if (entry.isFile()) {
        files.push({ path: relative(root, absolutePath), size: (await stat(absolutePath)).size })
      }
    }
  }
  return files
}

export function formatMiB(bytes) {
  return (bytes / MEBIBYTE).toFixed(2)
}

function normalizePath(path) {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

function normalizeEntryName(path) {
  return String(path).replaceAll('\\', '/').replace(/^\/+/u, '')
}

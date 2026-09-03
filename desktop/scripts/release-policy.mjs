import { readdir, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'

export const MEBIBYTE = 1024 * 1024

export const RELEASE_LIMITS = Object.freeze({
  appAsarBytes: 40 * MEBIBYTE,
  runtimeBytes: 360 * MEBIBYTE,
  zipBytes: 155 * MEBIBYTE
})

const EXPECTED_LOCALES = Object.freeze(['zh-CN.pak'])
const CANVAS_PATH_PATTERN = /(^|[\\/])@napi-rs[\\/]canvas(?:[-\\/]|$)/i
const REQUIRED_ASAR_ENTRIES = Object.freeze([
  'out/main/index.js',
  'out/preload/index.js',
  'out/renderer/index.html',
  'package.json'
])
const REQUIRED_RUNTIME_ENTRY_PREFIXES = Object.freeze([
  'resources/app.asar.unpacked/node_modules/@napi-rs/keyring/'
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
  for (const key of ['appAsarBytes', 'runtimeBytes', 'zipBytes']) {
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

export function assertRequiredRuntimeEntries(fileNames, requiredPrefixes = REQUIRED_RUNTIME_ENTRY_PREFIXES) {
  const entries = [...fileNames].map((entry) => normalizeEntryName(typeof entry === 'string' ? entry : entry.path))
  const missing = requiredPrefixes.filter((prefix) => !entries.some((entry) => entry.startsWith(normalizeEntryName(prefix))))
  if (missing.length > 0) throw new Error(`Missing required unpacked runtime dependencies: ${missing.join(', ')}`)
}

export async function auditRelease({ runtimeDirectory, zipPath, asarEntries = [] }) {
  const appAsarPath = join(runtimeDirectory, 'resources', 'app.asar')
  const localeDirectory = join(runtimeDirectory, 'locales')
  const [appAsarDetails, zipDetails, runtimeFiles, localeEntries] = await Promise.all([
    stat(appAsarPath),
    stat(zipPath),
    collectRelativeFiles(runtimeDirectory),
    readdir(localeDirectory, { withFileTypes: true })
  ])
  const measurements = {
    appAsarBytes: appAsarDetails.size,
    runtimeBytes: runtimeFiles.reduce((total, file) => total + file.size, 0),
    zipBytes: zipDetails.size
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

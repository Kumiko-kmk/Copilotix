import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { TextDecoder } from 'node:util'

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url))
const DEFAULT_REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, '../..')
const LICENSE_FILE_PREFIX = /^(?:LICENSE|LICENCE|NOTICE|COPYING|COPYRIGHT)/iu
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })
const WINDOWS_1252_DECODER = new TextDecoder('windows-1252')

/**
 * Collect local package license texts into desktop/out/licenses/THIRD_PARTY_LICENSES.txt.
 * The inventory is based on installed package roots only and performs no network access.
 */
export async function collectThirdPartyLicenses(options = {}) {
  const repositoryRoot = resolve(options.repositoryRoot ?? DEFAULT_REPOSITORY_ROOT)
  const repositoryRootReal = await realpath(repositoryRoot)
  const outputPath = resolve(
    options.outputPath ?? resolve(repositoryRoot, 'desktop/out/licenses/THIRD_PARTY_LICENSES.txt')
  )
  const nodeModulesPath = resolve(repositoryRoot, 'node_modules')
  const nodeModulesReal = await resolveSafeDirectory(nodeModulesPath, repositoryRootReal, true)

  let packageCandidates = []
  let sourceLayout = 'node_modules fallback'
  let storeWasPresent = false
  if (nodeModulesReal) {
    const pnpmPath = resolve(nodeModulesPath, '.pnpm')
    const pnpmReal = await resolveSafeDirectory(pnpmPath, nodeModulesReal, false)
    storeWasPresent = pnpmReal !== null
    if (pnpmReal) {
      packageCandidates = await findPnpmPackageRoots(pnpmReal, nodeModulesReal)
      if (packageCandidates.length > 0) sourceLayout = 'node_modules/.pnpm'
    }
    if (packageCandidates.length === 0) {
      packageCandidates = await findDirectPackageRoots(nodeModulesReal)
    }
  }

  const collection = await readPackageCandidates(packageCandidates, repositoryRootReal)
  const report = renderReport({
    sourceLayout,
    storeWasPresent,
    packageRootsFound: packageCandidates.length,
    collection
  })

  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, report, 'utf8')

  return {
    outputPath,
    packageCount: collection.packages.length,
    packageRootsFound: packageCandidates.length,
    packagesWithLicenseText: collection.packages.filter((item) => item.licenseTexts.length > 0).length,
    packagesWithoutLicenseText: collection.packages.filter((item) => item.licenseTexts.length === 0).length,
    skippedBinaryFiles: collection.skippedBinaryFiles,
    unreadableLicenseFiles: collection.unreadableLicenseFiles,
    unidentifiedPackageRoots: collection.unidentifiedPackageRoots
  }
}

async function findPnpmPackageRoots(pnpmReal, nodeModulesReal) {
  const roots = []
  const storeEntries = await readDirectoryEntries(pnpmReal)
  for (const storeEntry of storeEntries) {
    if (!isVisibleDirectory(storeEntry)) continue
    const storeEntryPath = resolve(pnpmReal, storeEntry.name)
    const storeEntryReal = await resolveSafeDirectory(storeEntryPath, nodeModulesReal, false)
    if (!storeEntryReal) continue

    const packageModulesPath = resolve(storeEntryReal, 'node_modules')
    const packageModulesReal = await resolveSafeDirectory(packageModulesPath, nodeModulesReal, false)
    if (!packageModulesReal) continue

    const candidates = await findPackageRootsOneLevel(
      packageModulesReal,
      nodeModulesReal,
      false
    )
    roots.push(...candidates)
  }
  return deduplicateCandidatePaths(roots)
}

async function findDirectPackageRoots(nodeModulesReal) {
  return findPackageRootsOneLevel(nodeModulesReal, nodeModulesReal, true)
}

async function findPackageRootsOneLevel(moduleDirectory, allowedRoot, allowInternalSymlinks) {
  const roots = []
  const entries = await readDirectoryEntries(moduleDirectory)
  for (const entry of entries) {
    if (!isVisibleDirectory(entry)) continue
    const entryPath = resolve(moduleDirectory, entry.name)

    if (entry.name.startsWith('@')) {
      const scopeReal = await resolveSafeDirectory(entryPath, allowedRoot, allowInternalSymlinks)
      if (!scopeReal) continue
      const scopedEntries = await readDirectoryEntries(scopeReal)
      for (const packageEntry of scopedEntries) {
        if (!isVisibleDirectory(packageEntry)) continue
        const packageRoot = await resolveSafeDirectory(
          resolve(scopeReal, packageEntry.name),
          allowedRoot,
          allowInternalSymlinks
        )
        if (!packageRoot) continue
        roots.push({
          path: packageRoot,
          fallbackName: entry.name + '/' + packageEntry.name
        })
      }
      continue
    }

    const packageRoot = await resolveSafeDirectory(entryPath, allowedRoot, allowInternalSymlinks)
    if (!packageRoot) continue
    roots.push({ path: packageRoot, fallbackName: entry.name })
  }
  return roots
}

async function readPackageCandidates(candidates, repositoryRootReal) {
  const packagesByIdentity = new Map()
  let skippedBinaryFiles = 0
  let unreadableLicenseFiles = 0
  let unidentifiedPackageRoots = 0

  for (const candidate of candidates) {
    const packageJsonPath = resolve(candidate.path, 'package.json')
    let manifest = null
    try {
      const manifestStat = await lstat(packageJsonPath)
      if (manifestStat.isFile() && !manifestStat.isSymbolicLink()) {
        manifest = JSON.parse(await readFile(packageJsonPath, 'utf8'))
      }
    } catch {
      manifest = null
    }

    const hasName = typeof manifest?.name === 'string' && manifest.name.trim().length > 0
    const hasVersion = typeof manifest?.version === 'string' && manifest.version.trim().length > 0
    const name = hasName ? manifest.name.trim() : '(unknown; directory ' + candidate.fallbackName + ')'
    const version = hasVersion ? manifest.version.trim() : '(unknown)'
    if (!hasName || !hasVersion) unidentifiedPackageRoots += 1

    const metadata = {
      license: manifest && Object.hasOwn(manifest, 'license') ? manifest.license : null,
      licenses: manifest && Object.hasOwn(manifest, 'licenses') ? manifest.licenses : null
    }
    const identity = JSON.stringify([name, version, metadata])
    let record = packagesByIdentity.get(identity)
    if (!record) {
      record = {
        name,
        version,
        metadata,
        instanceCount: 0,
        licenseTexts: new Map()
      }
      packagesByIdentity.set(identity, record)
    }
    record.instanceCount += 1

    let entries
    try {
      entries = await readDirectoryEntries(candidate.path)
    } catch {
      continue
    }

    const relativePackagePath = toReportPath(relative(repositoryRootReal, candidate.path))
    for (const entry of entries) {
      if (!LICENSE_FILE_PREFIX.test(entry.name)) continue
      if (!entry.isFile() || entry.isSymbolicLink()) continue

      const filePath = resolve(candidate.path, entry.name)
      try {
        const fileStat = await lstat(filePath)
        if (!fileStat.isFile() || fileStat.isSymbolicLink()) continue
        const buffer = await readFile(filePath)
        const decoded = decodeTextFile(buffer)
        if (decoded === null) {
          skippedBinaryFiles += 1
          continue
        }

        const digest = createHash('sha256').update(decoded, 'utf8').digest('hex')
        const dedupeKey = JSON.stringify([entry.name.toLowerCase(), digest])
        if (!record.licenseTexts.has(dedupeKey)) {
          record.licenseTexts.set(dedupeKey, {
            fileName: entry.name,
            sourcePath: toReportPath(relativePackagePath + '/' + entry.name),
            text: decoded
          })
        }
      } catch {
        unreadableLicenseFiles += 1
      }
    }
  }

  const packages = [...packagesByIdentity.values()]
    .map((record) => ({
      ...record,
      licenseTexts: [...record.licenseTexts.values()].sort((a, b) =>
        a.sourcePath.localeCompare(b.sourcePath)
      )
    }))
    .sort((a, b) =>
      a.name.localeCompare(b.name) ||
      a.version.localeCompare(b.version) ||
      stableMetadata(a.metadata).localeCompare(stableMetadata(b.metadata))
    )

  return {
    packages,
    skippedBinaryFiles,
    unreadableLicenseFiles,
    unidentifiedPackageRoots
  }
}

function decodeTextFile(buffer) {
  if (buffer.length === 0) return null
  let text
  try {
    if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
      text = new TextDecoder('utf-16le', { fatal: true }).decode(buffer.subarray(2))
    } else if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
      const swapped = Buffer.from(buffer.subarray(2))
      for (let index = 0; index + 1 < swapped.length; index += 2) {
        const first = swapped[index]
        swapped[index] = swapped[index + 1]
        swapped[index + 1] = first
      }
      text = new TextDecoder('utf-16le', { fatal: true }).decode(swapped)
    } else {
      const content = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf
        ? buffer.subarray(3)
        : buffer
      try {
        text = UTF8_DECODER.decode(content)
      } catch {
        if (hasBinaryControlBytes(content)) return null
        text = WINDOWS_1252_DECODER.decode(content)
      }
    }
  } catch {
    return null
  }

  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) return null
  const withoutBom = text.replace(/^\uFEFF/u, '')
  return withoutBom.trim().length > 0 ? withoutBom : null
}

function hasBinaryControlBytes(buffer) {
  for (const byte of buffer) {
    if (byte === 0 || byte < 0x09 || (byte > 0x0d && byte < 0x20) || byte === 0x7f) {
      return true
    }
  }
  return false
}

async function resolveSafeDirectory(candidatePath, allowedRoot, allowInternalSymlinks) {
  try {
    const linkStat = await lstat(candidatePath)
    if (!linkStat.isDirectory() && !linkStat.isSymbolicLink()) return null
    if (linkStat.isSymbolicLink() && !allowInternalSymlinks) return null

    const resolvedPath = await realpath(candidatePath)
    if (!isPathInside(allowedRoot, resolvedPath)) return null
    const targetStat = await stat(resolvedPath)
    return targetStat.isDirectory() ? resolvedPath : null
  } catch {
    return null
  }
}

function isVisibleDirectory(entry) {
  return entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.')
}

async function readDirectoryEntries(directoryPath) {
  return (await readdir(directoryPath, { withFileTypes: true }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

function deduplicateCandidatePaths(candidates) {
  const seen = new Set()
  return candidates.filter((candidate) => {
    const key = candidate.path.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function isPathInside(parentPath, childPath) {
  const relativePath = relative(parentPath, childPath)
  return relativePath === '' ||
    (relativePath !== '..' &&
      !relativePath.startsWith('..' + sep) &&
      !isAbsolute(relativePath))
}

function stableMetadata(metadata) {
  return JSON.stringify(metadata)
}

function formatMetadataValue(value) {
  if (value === null || value === undefined) return '(not declared)'
  try {
    return JSON.stringify(value)
  } catch {
    return '(unreadable metadata)'
  }
}

function toReportPath(value) {
  return value.split(sep).join('/')
}

function renderReport({ sourceLayout, storeWasPresent, packageRootsFound, collection }) {
  const textPackages = collection.packages.filter((item) => item.licenseTexts.length > 0)
  const missingPackages = collection.packages.filter((item) => item.licenseTexts.length === 0)
  const lines = [
    'THIRD-PARTY LICENSE INVENTORY',
    '',
    'Source: installed package roots from ' + sourceLayout + '.',
    'No network access was used. This inventory includes only common license and notice files directly inside discovered package roots.',
    'It is a convenience inventory, not a guarantee that every bundled, generated, optional, or dynamically loaded component is covered.',
    'Packages with metadata but no usable license text are listed explicitly; metadata is not a substitute for the complete license terms.',
    '',
    'Package roots discovered: ' + packageRootsFound,
    'Unique package identities: ' + collection.packages.length,
    'Packages with license text: ' + textPackages.length,
    'Packages without usable license text: ' + missingPackages.length,
    'Binary or undecodable candidate files skipped: ' + collection.skippedBinaryFiles,
    'Unreadable candidate files: ' + collection.unreadableLicenseFiles,
    'Roots with incomplete package metadata: ' + collection.unidentifiedPackageRoots,
    'pnpm store present: ' + (storeWasPresent ? 'yes' : 'no'),
    '',
    '========== INCLUDED LICENSE AND NOTICE TEXTS =========='
  ]

  if (textPackages.length === 0) lines.push('', '(No usable license text was found.)')
  for (const packageRecord of textPackages) {
    lines.push(
      '',
      'PACKAGE: ' + packageRecord.name + '@' + packageRecord.version,
      'license metadata: ' + formatMetadataValue(packageRecord.metadata.license),
      'licenses metadata: ' + formatMetadataValue(packageRecord.metadata.licenses),
      'installed instances represented: ' + packageRecord.instanceCount,
      ''
    )
    for (const licenseFile of packageRecord.licenseTexts) {
      lines.push(
        '----- FILE: ' + licenseFile.sourcePath + ' -----',
        licenseFile.text.replace(/\s+$/u, ''),
        '----- END FILE -----',
        ''
      )
    }
  }

  lines.push('', '========== PACKAGES WITHOUT USABLE LICENSE TEXT ==========')
  if (missingPackages.length === 0) {
    lines.push('', '(None.)')
  } else {
    for (const packageRecord of missingPackages) {
      lines.push(
        '',
        'PACKAGE: ' + packageRecord.name + '@' + packageRecord.version,
        'license metadata: ' + formatMetadataValue(packageRecord.metadata.license),
        'licenses metadata: ' + formatMetadataValue(packageRecord.metadata.licenses),
        'installed instances represented: ' + packageRecord.instanceCount,
        'No readable common license or notice text was found in the package root.'
      )
    }
  }

  return lines.join('\n') + '\n'
}

async function main() {
  const result = await collectThirdPartyLicenses()
  process.stdout.write(
    'Wrote ' + result.packageCount + ' package records to ' + result.outputPath +
    '; ' + result.packagesWithoutLicenseText + ' have no usable license text.\n'
  )
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(String(error?.stack ?? error) + '\n')
    process.exitCode = 1
  })
}

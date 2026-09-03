import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import archiver from 'archiver'
import { listPackage } from '@electron/asar'
import { build, createTargets, Platform } from 'electron-builder'
import extract from 'extract-zip'
import { applyDesktopFuses } from './electron-fuses.mjs'
import { auditRelease, assertRequiredPackagedContent, collectRelativeFiles, formatMiB, RELEASE_LIMITS } from './release-policy.mjs'
import {
  assertReleaseLayout,
  createReleaseLayout,
  pathExists,
  removePreviousRelease,
  rollbackReleaseSwap,
  swapRelease
} from './release-transaction.mjs'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const desktopDirectory = resolve(scriptDirectory, '..')
const repositoryRoot = resolve(desktopDirectory, '..')

/** Build and publish one verified Windows x64 directory release. */
export async function publishRelease({ fromBuilt = false } = {}) {
  assertWindowsX64()
  assertDesktopDirectory(desktopDirectory, repositoryRoot)
  const packageJson = JSON.parse(await readFile(join(desktopDirectory, 'package.json'), 'utf8'))
  const productName = packageJson.build?.productName ?? 'MinerU'
  const executableName = `${packageJson.build?.executableName ?? productName}.exe`
  const releaseName = `${productName}-${packageJson.version}-win-x64`
  const layout = createReleaseLayout({ repositoryRoot, buildId: createBuildId(), releaseName })
  assertReleaseLayout(layout)

  if (await pathExists(layout.stagingRoot)) {
    throw new Error(`Release staging path already exists; refusing to overwrite: ${layout.stagingRoot}`)
  }
  if (await pathExists(layout.previousRoot)) {
    throw new Error(`Release previous path already exists; refusing to overwrite: ${layout.previousRoot}`)
  }

  await mkdir(layout.stagingRoot)
  let swapped = false
  try {
    if (fromBuilt) await assertBuiltBundles()
    await runElectronBuilder(layout.builderOutput)

    const unpackedDirectory = join(layout.builderOutput, 'win-unpacked')
    const unpackedExecutable = join(unpackedDirectory, executableName)
    const unpackedAsar = join(unpackedDirectory, 'resources', 'app.asar')
    await requireFile(unpackedExecutable)
    await requireFile(unpackedAsar)
    await rename(unpackedDirectory, layout.runtimeDirectory)
    await rm(layout.builderOutput, { recursive: true, force: true })

    const executablePath = join(layout.runtimeDirectory, executableName)
    const appAsarPath = join(layout.runtimeDirectory, 'resources', 'app.asar')
    await requireFile(executablePath)
    await requireFile(appAsarPath)
    await applyDesktopFuses(executablePath)

    const asarEntries = listAsarEntries(appAsarPath)
    const runtimeFiles = await collectRelativeFiles(layout.runtimeDirectory)
    assertRequiredPackagedContent({ asarEntries, runtimeFiles })

    await createReleaseZip(layout.runtimeDirectory, layout.zipPath, releaseName)
    await verifyReleaseZip(layout.zipPath, layout.verificationDirectory, releaseName, executableName)

    const measurements = await auditRelease({
      runtimeDirectory: layout.runtimeDirectory,
      zipPath: layout.zipPath,
      asarEntries
    })
    await runPackagedSmoke(executablePath)

    const hashes = {
      executable: await sha256(executablePath),
      appAsar: await sha256(appAsarPath),
      zip: await sha256(layout.zipPath)
    }
    await writeReleaseMetadata(layout, packageJson, executableName, hashes)
    await assertReleaseMetadata(layout, releaseName, executableName, hashes)
    await assertReleaseRootContents(layout.stagingRoot, releaseName)

    const swapResult = await swapRelease(layout)
    swapped = true
    if (swapResult.previousRoot) {
      try {
        await removePreviousRelease(layout)
      } catch (error) {
        // Keeping a previous release is safer than failing after the new one is live.
        process.stderr.write(`Warning: previous release cleanup failed; retained for recovery: ${readableError(error)}\n`)
      }
    }

    process.stdout.write(`Release directory: ${join(layout.releaseRoot, releaseName)}\n`)
    process.stdout.write(`Release archive:   ${join(layout.releaseRoot, `${releaseName}.zip`)}\n`)
    process.stdout.write(`app.asar size:     ${formatMiB(measurements.appAsarBytes)} MiB / ${formatMiB(RELEASE_LIMITS.appAsarBytes)} MiB\n`)
    process.stdout.write(`Runtime size:      ${formatMiB(measurements.runtimeBytes)} MiB / ${formatMiB(RELEASE_LIMITS.runtimeBytes)} MiB\n`)
    process.stdout.write(`ZIP size:          ${formatMiB(measurements.zipBytes)} MiB / ${formatMiB(RELEASE_LIMITS.zipBytes)} MiB\n`)
    process.stdout.write(`ZIP SHA-256:       ${hashes.zip}\n`)
    return Object.freeze({ releaseName, hashes, measurements })
  } catch (error) {
    if (!swapped) {
      await rollbackReleaseSwap(layout).catch((rollbackError) => {
        process.stderr.write(`Warning: release rollback failed: ${readableError(rollbackError)}\n`)
      })
      process.stderr.write(`Release not published; diagnostic staging retained at ${layout.stagingRoot}\n`)
    }
    throw error
  }
}

export function assertWindowsX64(platform = process.platform, architecture = process.arch) {
  if (platform !== 'win32' || architecture !== 'x64') {
    throw new Error(`Windows x64 release required; received ${String(platform)}/${String(architecture)}`)
  }
}

export function createBuildId(now = Date.now(), pid = process.pid, suffix = randomUUID().slice(0, 8)) {
  if (!Number.isFinite(now) || now < 0 || !Number.isInteger(pid) || pid < 0 || typeof suffix !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(suffix)) {
    throw new TypeError('Invalid release build id inputs')
  }
  return `${Math.trunc(now).toString(36)}-${pid}-${suffix}`
}

export async function runElectronBuilder(outputDirectory) {
  if (typeof outputDirectory !== 'string' || !outputDirectory) throw new TypeError('Electron-builder output directory is required')
  const resolvedOutput = resolve(outputDirectory)
  const stagingParent = dirname(resolvedOutput)
  if (
    basename(resolvedOutput) !== 'builder' ||
    dirname(stagingParent) !== repositoryRoot ||
    !/^\.release-next-[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(basename(stagingParent))
  ) {
    throw new Error(`Refusing to build outside a release staging directory: ${outputDirectory}`)
  }
  await build({
    projectDir: desktopDirectory,
    targets: createTargets([Platform.WINDOWS], 'dir', 'x64'),
    config: {
      directories: { output: resolvedOutput }
    }
  })
}

/** Verify that electron-vite and the utility bundle were built by an earlier step. */
export async function assertBuiltBundles(outputDirectory = join(desktopDirectory, 'out')) {
  const resolvedOutput = resolve(outputDirectory)
  if (resolvedOutput !== resolve(desktopDirectory, 'out')) {
    throw new Error('Refusing to package bundles outside desktop/out: ' + outputDirectory)
  }
  for (const relativePath of ['main/index.js', 'preload/index.js', 'renderer/index.html', 'utility/index.js']) {
    await requireFile(join(resolvedOutput, relativePath))
  }
}

function listAsarEntries(archivePath) {
  return listPackage(archivePath, { isPack: false })
}

async function writeReleaseMetadata(layout, packageJson, executableName, hashes) {
  const manifest = {
    schemaVersion: 1,
    productName: packageJson.build?.productName ?? 'MinerU',
    version: packageJson.version,
    platform: 'win32',
    architecture: 'x64',
    createdAt: new Date().toISOString(),
    runtime: {
      directory: layout.releaseName,
      entryPoint: `${layout.releaseName}/${executableName}`,
      sha256: hashes.executable,
      appAsarSha256: hashes.appAsar
    },
    transport: {
      file: `${layout.releaseName}.zip`,
      sha256: hashes.zip
    }
  }
  await writeFile(layout.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  await writeFile(
    layout.checksumsPath,
    `${hashes.zip} *${layout.releaseName}.zip\n${hashes.executable} *${layout.releaseName}/${executableName}\n${hashes.appAsar} *${layout.releaseName}/resources/app.asar\n`,
    'utf8'
  )
}

async function assertReleaseMetadata(layout, releaseName, executableName, hashes) {
  const manifest = JSON.parse(await readFile(layout.manifestPath, 'utf8'))
  if (
    manifest?.runtime?.directory !== releaseName ||
    manifest?.runtime?.entryPoint !== `${releaseName}/${executableName}` ||
    manifest?.runtime?.sha256 !== hashes.executable ||
    manifest?.runtime?.appAsarSha256 !== hashes.appAsar ||
    manifest?.transport?.file !== `${releaseName}.zip` ||
    manifest?.transport?.sha256 !== hashes.zip
  ) {
    throw new Error('Release manifest hash or entry point verification failed')
  }
  const checksums = await readFile(layout.checksumsPath, 'utf8')
  const expected = `${hashes.zip} *${releaseName}.zip\n${hashes.executable} *${releaseName}/${executableName}\n${hashes.appAsar} *${releaseName}/resources/app.asar\n`
  if (checksums !== expected) throw new Error('Release SHA256SUMS verification failed')
}

async function assertReleaseRootContents(root, releaseName) {
  const expected = [releaseName, `${releaseName}.zip`, 'SHA256SUMS.txt', 'release-manifest.json'].sort()
  const actual = (await readdir(root)).sort()
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new Error(`Unexpected release staging contents: ${actual.join(', ')}`)
  }
}

async function createReleaseZip(sourceDirectory, destination, rootName) {
  await mkdir(dirname(destination), { recursive: true })
  await new Promise((resolvePromise, rejectPromise) => {
    const output = createWriteStream(destination)
    const archive = archiver('zip', { zlib: { level: 9 } })
    output.once('close', resolvePromise)
    output.once('error', rejectPromise)
    archive.once('error', rejectPromise)
    archive.pipe(output)
    archive.directory(sourceDirectory, rootName)
    void archive.finalize()
  })
}

async function verifyReleaseZip(archivePath, verificationDirectory, rootName, mainExecutable) {
  let verified = false
  try {
    await rm(verificationDirectory, { recursive: true, force: true })
    await mkdir(verificationDirectory, { recursive: true })
    await extract(archivePath, { dir: verificationDirectory })
    await requireFile(join(verificationDirectory, rootName, mainExecutable))
    await requireFile(join(verificationDirectory, rootName, 'resources', 'app.asar'))
    verified = true
  } finally {
    if (verified) await rm(verificationDirectory, { recursive: true, force: true })
  }
}

async function runPackagedSmoke(executablePath) {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executablePath, ['--version'], {
      cwd: dirname(executablePath),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    let output = ''
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error) rejectPromise(error)
      else resolvePromise()
    }
    const timeout = setTimeout(() => {
      child.kill()
      finish(new Error('Packaged smoke timed out'))
    }, 30_000)
    child.stdout?.on('data', (chunk) => { output += String(chunk) })
    child.stderr?.on('data', (chunk) => { output += String(chunk) })
    child.once('error', (error) => finish(error))
    child.once('exit', (code, signal) => {
      if (code !== 0) {
        finish(new Error(`Packaged smoke exited with ${String(code ?? signal)}`))
      } else if (!/\d+\.\d+/u.test(output)) {
        finish(new Error('Packaged smoke produced no Electron version output'))
      } else {
        finish()
      }
    })
  })
}

async function requireFile(path) {
  const details = await stat(path)
  if (!details.isFile() || details.size === 0) throw new Error(`Required release file is missing or empty: ${path}`)
}

async function sha256(path) {
  const hash = createHash('sha256')
  await new Promise((resolvePromise, rejectPromise) => {
    const input = createReadStream(path)
    input.once('error', rejectPromise)
    input.on('data', (chunk) => hash.update(chunk))
    input.once('end', resolvePromise)
  })
  return hash.digest('hex').toUpperCase()
}

function assertDesktopDirectory(desktop, root) {
  if (resolve(desktop) !== resolve(root, 'desktop')) {
    throw new Error(`Refusing to package unexpected desktop directory: ${desktop}`)
  }
}

function readableError(error) {
  return error instanceof Error ? error.message : String(error)
}

function isMainModule() {
  return Boolean(process.argv[1]) && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
}

if (isMainModule()) {
  try {
    const args = process.argv.slice(2)
    const fromBuilt = args.includes('--from-built')
    if (args.some((arg) => arg !== '--from-built')) throw new Error('Unknown package-directory option: ' + args.join(' '))
    await publishRelease({ fromBuilt })
  } catch (error) {
    process.stderr.write(`${readableError(error)}\n`)
    process.exitCode = 1
  }
}

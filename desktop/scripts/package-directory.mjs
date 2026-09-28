import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import archiver from 'archiver'
import { listPackage } from '@electron/asar'
import { build, createTargets, Platform } from 'electron-builder'
import extract from 'extract-zip'
import { verifyDesktopFuses } from './electron-fuses.mjs'
import { collectThirdPartyLicenses } from './collect-third-party-licenses.mjs'
import {
  auditRelease,
  assertReleaseSigningConfiguration,
  assertDesktopReleaseLicenseMetadata,
  assertRequiredPackagedContent,
  assertValidAuthenticodeSignature,
  collectRelativeFiles,
  formatMiB,
  RELEASE_LIMITS
} from './release-policy.mjs'
import {
  PACKAGED_SMOKE_ARG,
  formatPackagedSmokeMarker,
  shouldRunPackagedSmoke,
  validatePackagedSmokeOutput
} from '../src/shared/packagedSmoke.mjs'
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
const execFileAsync = promisify(execFile)

export {
  PACKAGED_SMOKE_ARG,
  formatPackagedSmokeMarker,
  shouldRunPackagedSmoke,
  validatePackagedSmokeOutput
}

/** Build and publish one verified Windows x64 directory release. */
export async function publishRelease({ fromBuilt = false } = {}) {
  assertWindowsX64()
  assertDesktopDirectory(desktopDirectory, repositoryRoot)
  const workspacePackageJson = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8'))
  assertPnpmInvocation(process.env, workspacePackageJson.packageManager)
  const productionRelease = assertReleaseSigningConfiguration(process.env)
  await assertLocalDependencyGraph(repositoryRoot, desktopDirectory)
  const packageJson = JSON.parse(await readFile(join(desktopDirectory, 'package.json'), 'utf8'))
  if (productionRelease) assertDesktopReleaseLicenseMetadata(packageJson)
  const packagedSmokeVersions = assertPackagedSmokeVersions(packageJson)
  const productName = packageJson.build?.productName ?? 'Copilotix'
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
    await runElectronBuilder(layout.builderOutput, { forceCodeSigning: productionRelease })

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
    await verifyDesktopFuses(executablePath)
    const signerSubject = productionRelease ? await verifyWindowsAuthenticodeSignature(executablePath) : null

    const asarEntries = listAsarEntries(appAsarPath)
    const runtimeFiles = await collectRelativeFiles(layout.runtimeDirectory)
    assertRequiredPackagedContent({ asarEntries, runtimeFiles })

    await createReleaseZip(layout.runtimeDirectory, layout.zipPath, releaseName)
    const archivedSignerSubject = await verifyReleaseZip(
      layout.zipPath,
      layout.verificationDirectory,
      releaseName,
      executableName,
      productionRelease ? verifyWindowsAuthenticodeSignature : null
    )
    if (productionRelease && archivedSignerSubject !== signerSubject) {
      throw new Error('The release archive executable signer does not match the verified runtime executable')
    }

    const measurements = await auditRelease({
      runtimeDirectory: layout.runtimeDirectory,
      zipPath: layout.zipPath,
      asarEntries
    })
    await runPackagedSmoke(executablePath, packagedSmokeVersions)

    const hashes = {
      executable: await sha256(executablePath),
      appAsar: await sha256(appAsarPath),
      zip: await sha256(layout.zipPath)
    }
    await writeReleaseMetadata(layout, packageJson, executableName, hashes, signerSubject)
    await assertReleaseMetadata(layout, releaseName, executableName, hashes, signerSubject)
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

export function assertPnpmInvocation(environment, expectedPackageManager = 'pnpm@11.19.0') {
  const match = /^pnpm@([0-9]+(?:\.[0-9]+){2})$/u.exec(String(expectedPackageManager))
  if (!match) throw new Error(`Unsupported package manager declaration: ${String(expectedPackageManager)}`)
  const actual = /^pnpm\/([^\s]+)/u.exec(String(environment?.npm_config_user_agent ?? ''))?.[1]
  if (actual !== match[1]) {
    throw new Error(`Release packaging must run through ${expectedPackageManager}; received ${actual ? `pnpm@${actual}` : 'a direct Node/npm invocation'}`)
  }
}

export function assertDependencyRoots(repository, dependencyRoots) {
  const root = resolve(repository)
  for (const candidate of dependencyRoots) {
    const resolved = resolve(candidate)
    const relation = relative(root, resolved)
    if (relation === '..' || relation.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(relation)) {
      throw new Error(`Release dependency resolves outside the current worktree: ${resolved}`)
    }
  }
}

export async function assertLocalDependencyGraph(repository, desktop) {
  const requireFromDesktop = createRequire(join(desktop, 'package.json'))
  const keyringEntry = requireFromDesktop.resolve('@napi-rs/keyring')
  const requireFromKeyring = createRequire(keyringEntry)
  const nativeManifest = requireFromKeyring.resolve('@napi-rs/keyring-win32-x64-msvc/package.json')
  const nativeBinding = join(dirname(nativeManifest), 'keyring.win32-x64-msvc.node')
  const dependencyRoots = await Promise.all([
    realpath(join(repository, 'node_modules')),
    realpath(join(desktop, 'node_modules')),
    realpath(keyringEntry),
    realpath(nativeManifest),
    realpath(nativeBinding)
  ])
  assertDependencyRoots(repository, dependencyRoots)
  await requireFile(nativeBinding)
}

export async function runElectronBuilder(outputDirectory, { forceCodeSigning = false } = {}) {
  if (typeof outputDirectory !== 'string' || !outputDirectory) throw new TypeError('Electron-builder output directory is required')
  if (typeof forceCodeSigning !== 'boolean') throw new TypeError('forceCodeSigning must be a boolean')
  const resolvedOutput = resolve(outputDirectory)
  const stagingParent = dirname(resolvedOutput)
  if (
    basename(resolvedOutput) !== 'builder' ||
    dirname(stagingParent) !== repositoryRoot ||
    !/^\.release-next-[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(basename(stagingParent))
  ) {
    throw new Error(`Refusing to build outside a release staging directory: ${outputDirectory}`)
  }
  const licenseInventory = await collectThirdPartyLicenses({ repositoryRoot })
  if (!licenseInventory.packageCount) throw new Error('No dependency license inventory could be generated')
  process.stdout.write(`Dependency licenses: ${licenseInventory.packageCount} packages; ${licenseInventory.packagesWithoutLicenseText} without root license text (see inventory)\n`)
  await build({
    projectDir: desktopDirectory,
    targets: createTargets([Platform.WINDOWS], 'dir', 'x64'),
    config: {
      directories: { output: resolvedOutput },
      forceCodeSigning
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

async function writeReleaseMetadata(layout, packageJson, executableName, hashes, signerSubject = null) {
  const manifest = {
    schemaVersion: 1,
    productName: packageJson.build?.productName ?? 'Copilotix',
    version: packageJson.version,
    platform: 'win32',
    architecture: 'x64',
    createdAt: new Date().toISOString(),
    runtime: {
      directory: layout.releaseName,
      entryPoint: `${layout.releaseName}/${executableName}`,
      sha256: hashes.executable,
      appAsarSha256: hashes.appAsar,
      ...(signerSubject ? { authenticodeSignerSubject: signerSubject } : {})
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

async function assertReleaseMetadata(layout, releaseName, executableName, hashes, signerSubject = null) {
  const manifest = JSON.parse(await readFile(layout.manifestPath, 'utf8'))
  if (
    manifest?.runtime?.directory !== releaseName ||
    manifest?.runtime?.entryPoint !== `${releaseName}/${executableName}` ||
    manifest?.runtime?.sha256 !== hashes.executable ||
    manifest?.runtime?.appAsarSha256 !== hashes.appAsar ||
    manifest?.runtime?.authenticodeSignerSubject !== (signerSubject ?? undefined) ||
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

async function verifyReleaseZip(archivePath, verificationDirectory, rootName, mainExecutable, verifySignature = null) {
  let verified = false
  try {
    await rm(verificationDirectory, { recursive: true, force: true })
    await mkdir(verificationDirectory, { recursive: true })
    await extract(archivePath, { dir: verificationDirectory })
    const extractedExecutable = join(verificationDirectory, rootName, mainExecutable)
    await requireFile(extractedExecutable)
    await requireFile(join(verificationDirectory, rootName, 'resources', 'app.asar'))
    const signerSubject = verifySignature ? await verifySignature(extractedExecutable) : null
    verified = true
    return signerSubject
  } finally {
    if (verified) await rm(verificationDirectory, { recursive: true, force: true })
  }
}

/** Fail if Windows cannot validate the executable's embedded Authenticode signature. */
export async function verifyWindowsAuthenticodeSignature(executablePath) {
  if (typeof executablePath !== 'string' || !executablePath) throw new TypeError('Executable path is required for signature verification')
  const command = [
    '$ErrorActionPreference = "Stop"',
    '$signature = Get-AuthenticodeSignature -LiteralPath $env:COPILOTIX_SIGNED_EXECUTABLE',
    '[pscustomobject]@{ status = [string]$signature.Status; signerSubject = [string]$signature.SignerCertificate.Subject } | ConvertTo-Json -Compress'
  ].join('; ')
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    command
  ], {
    env: { ...process.env, COPILOTIX_SIGNED_EXECUTABLE: executablePath },
    windowsHide: true
  })
  let result
  try {
    result = JSON.parse(stdout.trim())
  } catch {
    throw new Error('Windows Authenticode verification returned invalid output')
  }
  const signerSubject = assertValidAuthenticodeSignature(result)
  process.stdout.write(`Authenticode signature verified: ${signerSubject}\n`)
  return signerSubject
}

export function assertPackagedSmokeVersions(packageJson) {
  const appVersion = packageJson?.version
  const electronVersion = packageJson?.devDependencies?.electron ?? packageJson?.dependencies?.electron
  if (electronVersion !== '44.1.1') throw new Error('Packaged smoke requires Electron 44.1.1')
  formatPackagedSmokeMarker({ appVersion, electronVersion })
  return Object.freeze({ appVersion, electronVersion })
}

export async function runPackagedSmoke(executablePath, expectedVersions) {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executablePath, [PACKAGED_SMOKE_ARG], {
      cwd: dirname(executablePath),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    let stdout = ''
    let stderr = ''
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
    child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.once('error', (error) => finish(error))
    child.once('close', (code, signal) => {
      if (code !== 0) {
        finish(new Error(`Packaged smoke exited with ${String(code ?? signal)}`))
      } else if (!validatePackagedSmokeOutput({ stdout, stderr }, expectedVersions)) {
        finish(new Error('Packaged smoke marker validation failed'))
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

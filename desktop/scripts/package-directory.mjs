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
import { applyReleaseFusesAfterPack } from './after-pack.mjs'
import { buildStandaloneUninstaller } from './build-uninstall-launcher.mjs'
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
  setupNameForRelease,
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
  removePreviousArtifacts,
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
  await mkdir(layout.advancedDirectory)
  await mkdir(layout.stagedArtifactsDirectory)
  let swapped = false
  try {
    if (fromBuilt) await assertBuiltBundles()
    const runtimePackager = await runElectronBuilder(layout.builderOutput, { forceCodeSigning: productionRelease })

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

    const runtimeHashes = { executable: await sha256(executablePath), appAsar: await sha256(appAsarPath) }
    await runSetupBuilder(layout, { forceCodeSigning: productionRelease, signerSubject })
    await requireFile(layout.setupPath)
    const setupSignerSubject = productionRelease ? await verifyWindowsAuthenticodeSignature(layout.setupPath) : null
    if (productionRelease && setupSignerSubject !== signerSubject) throw new Error('Setup signer does not match the runtime signer')
    if (await sha256(executablePath) !== runtimeHashes.executable || await sha256(appAsarPath) !== runtimeHashes.appAsar) {
      throw new Error('Setup packaging modified the verified runtime')
    }

    const launcher = await buildStandaloneUninstaller({
      outputPath: layout.launcherPath,
      productionRelease,
      signerSubject,
      signFile: productionRelease ? (path) => runtimePackager.signIf(path) : null,
      verifySignature: verifyWindowsAuthenticodeSignature
    })
    const hashes = {
      executable: runtimeHashes.executable,
      appAsar: runtimeHashes.appAsar,
      setup: await sha256(layout.setupPath),
      launcher: await sha256(layout.launcherPath)
    }
    await writeReleaseMetadata(layout, packageJson, executableName, hashes, signerSubject, setupSignerSubject, launcher.signerSubject, { bundleOnly: true })
    await writeFile(layout.instructionsPath, `\uFEFFCopilotix 安装说明\r\n\r\n1. 解压整个压缩包。双击 ${layout.setupName}，按向导选择安装位置。\r\n2. 安装完成后，从桌面打开 Copilotix；首次使用按应用内引导配置文库和翻译服务。\r\n3. 卸载时双击本目录的 uninstall.exe，也可使用 Windows 已安装应用中的卸载入口。\r\n\r\n安装位置存放程序；文库位置在“设置 → 文件存储”中选择。\r\n升级或卸载前，请在系统托盘选择“退出”，等待后台任务结束。\r\n默认卸载保留资料；可在卸载向导选择同步清除文库、设置与凭证，并确认清理位置。\r\n完整程序已压缩在 Setup 内，安装后即可运行。advanced 仅为校验资料，不需打开。\r\n卸载会移除已安装程序；下载并解压的本目录可在不用时自行删除。\r\n`, 'utf8')
    await createReleaseZip(layout.stagingRoot, layout.zipPath, releaseName)
    await verifyReleaseZip(layout.zipPath, layout.verificationDirectory, releaseName,
      productionRelease ? verifyWindowsAuthenticodeSignature : null, hashes, signerSubject)
    const measurements = await auditRelease({
      runtimeDirectory: layout.runtimeDirectory, zipPath: layout.zipPath, setupPath: layout.setupPath,
      asarEntries
    })
    await runPackagedSmoke(executablePath, packagedSmokeVersions)
    hashes.zip = await sha256(layout.zipPath)
    await writeReleaseMetadata(layout, packageJson, executableName, hashes, signerSubject, setupSignerSubject, launcher.signerSubject)
    await assertReleaseMetadata(layout, releaseName, executableName, hashes, signerSubject, setupSignerSubject, launcher.signerSubject)
    // Keep the downloadable ZIP outside its own source directory.
    // The unique destination cannot replace a prior successful build's files.
    await mkdir(layout.artifactsRoot, { recursive: true })
    if (await pathExists(layout.artifactsDirectory)) throw new Error('Build artifacts destination already exists')
    await rename(layout.stagedArtifactsDirectory, layout.artifactsDirectory)
    await assertReleaseRootContents(layout.stagingRoot, releaseName, layout.setupName)

    const swapResult = await swapRelease(layout)
    swapped = true
    if (swapResult.previousRoot) {
      try {
        await removePreviousArtifacts(layout)
        await removePreviousRelease(layout)
      } catch (error) {
        // Keeping a previous release is safer than failing after the new one is live.
        process.stderr.write(`Warning: previous release cleanup failed; retained for recovery: ${readableError(error)}\n`)
      }
    }

    process.stdout.write(`Developer runtime: ${join(layout.artifactsDirectory, 'program')}\n`)
    process.stdout.write(`Release Setup:     ${join(layout.releaseRoot, layout.setupName)}\n`)
    process.stdout.write(`Download bundle:   ${join(layout.artifactsDirectory, `${releaseName}.zip`)}\n`)
    process.stdout.write(`app.asar size:     ${formatMiB(measurements.appAsarBytes)} MiB / ${formatMiB(RELEASE_LIMITS.appAsarBytes)} MiB\n`)
    process.stdout.write(`Runtime size:      ${formatMiB(measurements.runtimeBytes)} MiB / ${formatMiB(RELEASE_LIMITS.runtimeBytes)} MiB\n`)
    process.stdout.write(`ZIP size:          ${formatMiB(measurements.zipBytes)} MiB / ${formatMiB(RELEASE_LIMITS.zipBytes)} MiB\n`)
    process.stdout.write(`ZIP SHA-256:       ${hashes.zip}\n`)
    process.stdout.write(`Setup size:        ${formatMiB(measurements.setupBytes)} MiB / ${formatMiB(RELEASE_LIMITS.setupBytes)} MiB\n`)
    process.stdout.write(`Setup SHA-256:     ${hashes.setup}\n`)
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
  let runtimePackager
  await build({
    projectDir: desktopDirectory,
    targets: createTargets([Platform.WINDOWS], 'dir', 'x64'),
    config: {
      directories: { output: resolvedOutput },
      afterPack: async (context) => {
        await applyReleaseFusesAfterPack(context)
        runtimePackager = context.packager
      },
      forceCodeSigning
    }
  })
  return runtimePackager
}

/** Package the already verified runtime, so Setup and ZIP contain identical bytes. */
export async function runSetupBuilder(layout, { forceCodeSigning = false, signerSubject = null } = {}) {
  assertReleaseLayout(layout)
  if (forceCodeSigning && !signerSubject) throw new Error('Signed runtime subject is required before building production Setup')
  await mkdir(layout.builderOutput)
  let include = join(desktopDirectory, 'resources', 'installer.nsh')
  const gateResult = join(layout.builderOutput, 'uninstaller-signature.json')
  if (forceCodeSigning) {
    const gateConfig = join(layout.builderOutput, 'signature-gate.json')
    await writeFile(gateConfig, JSON.stringify({ signerSubject, resultPath: gateResult }), 'utf8')
    include = join(layout.builderOutput, 'installer-production.nsh')
    await writeFile(include, createProductionInstallerInclude({
      installerInclude: join(desktopDirectory, 'resources', 'installer.nsh'),
      nodePath: process.execPath,
      gateScript: join(scriptDirectory, 'verify-uninstaller-signature.mjs'),
      gateConfig
    }), 'utf8')
  }
  await build({
    projectDir: desktopDirectory,
    prepackaged: layout.runtimeDirectory,
    targets: createTargets([Platform.WINDOWS], 'nsis', 'x64'),
    config: { directories: { output: layout.builderOutput }, forceCodeSigning, nsis: { include } }
  })
  if (forceCodeSigning) {
    const verified = JSON.parse(await readFile(gateResult, 'utf8'))
    if (verified.signerSubject !== signerSubject) throw new Error('Production Setup did not verify its embedded uninstaller signer')
  }
  await requireFile(join(layout.builderOutput, layout.setupName))
  await rename(join(layout.builderOutput, layout.setupName), layout.setupPath)
  await rm(layout.builderOutput, { recursive: true, force: true })
}

export function createProductionInstallerInclude({ installerInclude, nodePath, gateScript, gateConfig }) {
  const quote = (value) => {
    if (typeof value !== 'string' || !value || /["\r\n$]/u.test(value)) throw new Error('Unsafe production NSIS gate path')
    return `"${value}"`
  }
  return `!include ${quote(installerInclude)}\n!ifndef BUILD_UNINSTALLER\n!finalize '${quote(nodePath)} ${quote(gateScript)} ${quote(gateConfig)} "\${UNINSTALLER_OUT_FILE}"' = 0\n!endif\n`
}

/** Verify that electron-vite and the utility bundle were built by an earlier step. */
export async function assertBuiltBundles(outputDirectory = join(desktopDirectory, 'out')) {
  const resolvedOutput = resolve(outputDirectory)
  if (resolvedOutput !== resolve(desktopDirectory, 'out')) {
    throw new Error('Refusing to package bundles outside desktop/out: ' + outputDirectory)
  }
  for (const relativePath of ['main/index.js', 'preload/index.js', 'renderer/index.html', 'utility/index.js', 'utility/uninstall-cleanup.js']) {
    await requireFile(join(resolvedOutput, relativePath))
  }
}

function listAsarEntries(archivePath) {
  return listPackage(archivePath, { isPack: false })
}

/** Payload metadata is inside the bundle; ZIP hash metadata is written only after ZIP creation. */
export async function writeReleaseMetadata(layout, packageJson, executableName, hashes, signerSubject = null, setupSignerSubject = null, launcherSignerSubject = null, { bundleOnly = false } = {}) {
  assertReleaseHashes(hashes, !bundleOnly)
  const manifest = {
    schemaVersion: 5,
    distribution: 'compact-setup',
    productName: packageJson.build?.productName ?? 'Copilotix',
    version: packageJson.version, platform: 'win32', architecture: 'x64',
    runtime: { directory: 'program', entryPoint: `program/${executableName}`, embeddedIn: layout.setupName, sha256: hashes.executable,
      appAsarSha256: hashes.appAsar, ...(signerSubject ? { authenticodeSignerSubject: signerSubject } : {}) },
    installer: { file: layout.setupName, sha256: hashes.setup,
      ...(setupSignerSubject ? { authenticodeSignerSubject: setupSignerSubject } : {}) },
    uninstaller: { file: 'uninstall.exe', sha256: hashes.launcher,
      ...(launcherSignerSubject ? { authenticodeSignerSubject: launcherSignerSubject } : {}) },
    transport: { file: `${layout.releaseName}.zip`, rootDirectory: layout.releaseName }
  }
  await writeFile(layout.bundleManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  await writeFile(layout.checksumsPath, payloadChecksums(layout, hashes), 'utf8')
  if (!bundleOnly) {
    await writeFile(layout.manifestPath, `${JSON.stringify({ ...manifest,
      artifactDirectory: layout.artifactsRelativeDirectory,
      runtimeArtifactDirectory: `${layout.artifactsRelativeDirectory}/program`,
      transport: { ...manifest.transport, sha256: hashes.zip }
    }, null, 2)}\n`, 'utf8')
  }
}

export async function assertReleaseMetadata(layout, releaseName, executableName, hashes, signerSubject = null, setupSignerSubject = null, launcherSignerSubject = null) {
  assertReleaseHashes(hashes)
  const manifest = JSON.parse(await readFile(layout.manifestPath, 'utf8'))
  const bundle = JSON.parse(await readFile(layout.bundleManifestPath, 'utf8'))
  if (manifest?.schemaVersion !== 5 || manifest.distribution !== 'compact-setup' ||
    manifest.artifactDirectory !== layout.artifactsRelativeDirectory ||
    manifest.runtimeArtifactDirectory !== `${layout.artifactsRelativeDirectory}/program` ||
    manifest?.installer?.file !== layout.setupName || manifest?.installer?.sha256 !== hashes.setup ||
    manifest?.installer?.authenticodeSignerSubject !== (setupSignerSubject ?? undefined) ||
    manifest?.uninstaller?.file !== 'uninstall.exe' || manifest?.uninstaller?.sha256 !== hashes.launcher ||
    manifest?.uninstaller?.authenticodeSignerSubject !== (launcherSignerSubject ?? undefined) ||
    manifest?.runtime?.directory !== 'program' || manifest?.runtime?.entryPoint !== `program/${executableName}` ||
    manifest?.runtime?.embeddedIn !== layout.setupName ||
    manifest?.runtime?.sha256 !== hashes.executable || manifest?.runtime?.appAsarSha256 !== hashes.appAsar ||
    manifest?.runtime?.authenticodeSignerSubject !== (signerSubject ?? undefined) ||
    manifest?.transport?.file !== `${releaseName}.zip` || manifest?.transport?.sha256 !== hashes.zip ||
    manifest?.transport?.rootDirectory !== releaseName) throw new Error('Release manifest hash or entry point verification failed')
  const { artifactDirectory: _artifactDirectory, runtimeArtifactDirectory: _runtimeArtifactDirectory, ...payload } = manifest
  delete payload.transport.sha256
  if (JSON.stringify(payload) !== JSON.stringify(bundle)) throw new Error('Bundle manifest must match release payload without a circular ZIP hash')
  if (await readFile(layout.checksumsPath, 'utf8') !== payloadChecksums(layout, hashes)) throw new Error('Release SHA256SUMS verification failed')
}

function payloadChecksums(layout, hashes) {
  return `${hashes.setup} *${layout.setupName}\n${hashes.launcher} *uninstall.exe\n`
}

export async function assertReleaseRootContents(root, releaseName, setupName = setupNameForRelease(releaseName)) {
  const expected = [setupName, 'uninstall.exe', '安装说明.txt', 'advanced'].sort()
  const actual = (await readdir(root)).sort()
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new Error(`Unexpected release staging contents: ${actual.join(', ')}`)
  }
  const expectedAdvanced = ['SHA256SUMS.txt', 'bundle-manifest.json', 'release-manifest.json'].sort()
  const actualAdvanced = (await readdir(join(root, 'advanced'))).sort()
  if (actualAdvanced.length !== expectedAdvanced.length || actualAdvanced.some((name, index) => name !== expectedAdvanced[index])) {
    throw new Error(`Unexpected advanced release contents: ${actualAdvanced.join(', ')}`)
  }
}

function assertReleaseHashes(hashes, requireZip = true) {
  for (const key of ['executable', 'appAsar', 'setup', 'launcher', ...(requireZip ? ['zip'] : [])]) {
    if (typeof hashes?.[key] !== 'string' || !/^[A-F0-9]{64}$/u.test(hashes[key])) throw new Error(`Invalid release SHA-256: ${key}`)
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
    archive.glob('**/*', { cwd: sourceDirectory, dot: true, ignore: ['artifacts/**', 'advanced/release-manifest.json'] }, { prefix: rootName })
    void archive.finalize()
  })
}

async function verifyReleaseZip(archivePath, verificationDirectory, rootName, verifySignature = null, hashes = null, expectedSigner = null) {
  let verified = false
  try {
    await rm(verificationDirectory, { recursive: true, force: true })
    await mkdir(verificationDirectory, { recursive: true })
    await extract(archivePath, { dir: verificationDirectory })
    const bundleRoot = join(verificationDirectory, rootName)
    const metadata = JSON.parse(await readFile(join(bundleRoot, 'advanced', 'bundle-manifest.json'), 'utf8'))
    if (metadata.schemaVersion !== 5 || metadata.distribution !== 'compact-setup' ||
      metadata.runtime.embeddedIn !== metadata.installer.file ||
      await pathExists(join(bundleRoot, 'program'))) throw new Error('Bundle must contain only the compact Setup distribution')
    if (metadata.transport.sha256 !== undefined || await pathExists(join(bundleRoot, 'advanced', 'release-manifest.json'))) throw new Error('Bundle contains circular or outer-only metadata')
    for (const [key, path] of [['setup', metadata.installer.file], ['launcher', metadata.uninstaller.file]]) {
      if (!hashes || await sha256(join(bundleRoot, path)) !== hashes[key]) throw new Error(`Extracted bundle hash mismatch: ${key}`)
    }
    await requireFile(join(bundleRoot, '安装说明.txt'))
    if (verifySignature) {
      for (const path of [metadata.installer.file, metadata.uninstaller.file]) {
        if (await verifySignature(join(bundleRoot, path)) !== expectedSigner) throw new Error('Bundle executable signer differs from runtime')
      }
    }
    verified = true
    return expectedSigner
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

import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertReleaseMetadata, assertReleaseRootContents, assertWindowsX64, createBuildId, createProductionInstallerInclude, writeReleaseMetadata } from '../scripts/package-directory.mjs'
import { verifyUninstallerSignature } from '../scripts/verify-uninstaller-signature.mjs'
import {
  assertReleaseLayout,
  createReleaseLayout,
  createSwapPlan,
  renameReleasePath,
  removePreviousRelease,
  removePreviousArtifacts,
  swapRelease
} from '../scripts/release-transaction.mjs'

const roots = []

describe('Windows release rename locks', () => {
  it('returns a nonzero CLI status for a fatal packaging invocation', () => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/package-directory.mjs', import.meta.url)), '--invalid-option'], {
      encoding: 'utf8', timeout: 30_000, windowsHide: true
    })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Unknown package-directory option')
  })

  it('recovers a temporary file lock using the same atomic rename and bounded backoff', async () => {
    const lock = Object.assign(new Error('scanner has the artifact open'), { code: 'EPERM' })
    const rename = vi.fn().mockRejectedValueOnce(lock).mockRejectedValueOnce(lock).mockResolvedValue(undefined)
    const sleep = vi.fn().mockResolvedValue(undefined)
    await renameReleasePath('owned-staging', 'owned-artifact', { rename, sleep, platform: 'win32' })
    expect(rename.mock.calls).toEqual(Array(3).fill(['owned-staging', 'owned-artifact']))
    expect(sleep.mock.calls).toEqual([[100], [200]])
  })

  it('propagates a persistent lock instead of publishing or removing either directory', async () => {
    const lock = Object.assign(new Error('permanent lock'), { code: 'EACCES' })
    const rename = vi.fn().mockRejectedValue(lock)
    const sleep = vi.fn().mockResolvedValue(undefined)
    await expect(renameReleasePath('owned-staging', 'owned-artifact', { rename, sleep, platform: 'win32' })).rejects.toBe(lock)
    expect(rename).toHaveBeenCalledTimes(7)
    expect(sleep.mock.calls).toEqual([[100], [200], [400], [800], [1600], [3200]])
  })

  it.each([['win32', 'ENOENT'], ['win32', 'EEXIST'], ['linux', 'EPERM']])('does not retry %s %s failures', async (platform, code) => {
    const failure = Object.assign(new Error('not a transient Windows lock'), { code })
    const rename = vi.fn().mockRejectedValue(failure)
    const sleep = vi.fn()
    await expect(renameReleasePath('owned-staging', 'owned-artifact', { rename, sleep, platform })).rejects.toBe(failure)
    expect(rename).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })
})

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('release transaction boundaries', () => {
  it('creates a unique sibling staging layout and rejects non-Windows targets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilotix-release-layout-'))
    roots.push(root)
    const layout = createReleaseLayout({ repositoryRoot: root, buildId: createBuildId(123, 7, 'fixture'), releaseName: 'Copilotix-1.0.0-win-x64' })

    expect(layout.stagingRoot).toBe(join(root, '.release-next-3f-7-fixture'))
    expect(layout.previousRoot).toBe(join(root, '.release-previous-3f-7-fixture'))
    expect(layout.releaseRoot).toBe(join(root, 'release'))
    expect(layout.setupPath).toBe(join(layout.stagingRoot, 'setup.exe'))
    expect(layout.artifactsDirectory).toBe(join(root, 'release-artifacts', '3f-7-fixture'))
    expect(layout.runtimeDirectory).toBe(join(layout.stagedArtifactsDirectory, 'program'))
    expect(() => assertReleaseLayout({ ...layout, artifactsDirectory: join(root, 'outside') })).toThrow(/Unexpected/)
    expect(() => assertReleaseLayout({ ...layout, setupPath: join(root, 'escaped.exe') })).toThrow(/Unexpected/)
    expect(() => assertReleaseLayout({ ...layout, setupName: 'wrong.exe' })).toThrow(/Setup name/)
    expect(() => assertWindowsX64('linux', 'x64')).toThrow(/Windows x64/)
    expect(() => assertWindowsX64('win32', 'arm64')).toThrow(/Windows x64/)
  })

  it('describes publish and rollback renames without deleting the live release', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilotix-release-swap-'))
    roots.push(root)
    const layout = createReleaseLayout({ repositoryRoot: root, buildId: 'fixture-swap', releaseName: 'Copilotix-1.0.0-win-x64' })
    await mkdir(layout.releaseRoot, { recursive: true })
    await mkdir(layout.stagingRoot, { recursive: true })
    await writeFile(join(layout.releaseRoot, 'marker.txt'), 'old', 'utf8')
    await writeFile(join(layout.stagingRoot, 'marker.txt'), 'new', 'utf8')

    const plan = createSwapPlan(layout, true)
    expect(plan.moveExisting).toEqual({ from: layout.releaseRoot, to: layout.previousRoot })
    expect(plan.publishNext).toEqual({ from: layout.stagingRoot, to: layout.releaseRoot })
    expect(plan.rollback).toEqual({ from: layout.previousRoot, to: layout.releaseRoot })

    const result = await swapRelease(layout)
    expect(result.previousRoot).toBe(layout.previousRoot)
    await expect(readFile(join(layout.releaseRoot, 'marker.txt'), 'utf8')).resolves.toBe('new')
    await expect(readFile(join(layout.previousRoot, 'marker.txt'), 'utf8')).resolves.toBe('old')
    expect(await removePreviousRelease(layout)).toBe(true)
  })

  it('restores the old release when publishing the next directory fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilotix-release-rollback-'))
    roots.push(root)
    const layout = createReleaseLayout({ repositoryRoot: root, buildId: 'fixture-rollback', releaseName: 'Copilotix-1.0.0-win-x64' })
    await mkdir(layout.releaseRoot, { recursive: true })
    await mkdir(layout.stagingRoot, { recursive: true })
    await writeFile(join(layout.releaseRoot, 'marker.txt'), 'old', 'utf8')
    await writeFile(join(layout.stagingRoot, 'marker.txt'), 'new', 'utf8')
    let renameCalls = 0
    const fileSystem = {
      rename: async (from, to) => {
        renameCalls += 1
        if (renameCalls === 2) throw new Error('simulated publish failure')
        return (await import('node:fs/promises')).rename(from, to)
      }
    }

    await expect(swapRelease(layout, fileSystem)).rejects.toThrow('simulated publish failure')
    await expect(readFile(join(layout.releaseRoot, 'marker.txt'), 'utf8')).resolves.toBe('old')
    await expect(readFile(join(layout.stagingRoot, 'marker.txt'), 'utf8')).resolves.toBe('new')
    await expect(readFile(join(layout.previousRoot, 'marker.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})


describe('Setup release metadata gates', () => {
  it('checks the signed intermediate uninstaller before builder deletes it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilotix-uninstaller-signature-'))
    roots.push(root)
    const config = join(root, 'gate.json')
    const result = join(root, 'verified.json')
    await writeFile(config, JSON.stringify({ signerSubject: 'CN=Release', resultPath: result }))
    await expect(verifyUninstallerSignature(config, 'uninstaller.exe', async () => 'CN=Other')).rejects.toThrow(/signer/)
    await expect(readFile(result)).rejects.toMatchObject({ code: 'ENOENT' })
    await verifyUninstallerSignature(config, 'uninstaller.exe', async () => 'CN=Release')
    expect(JSON.parse(await readFile(result, 'utf8'))).toEqual({ signerSubject: 'CN=Release' })
    const include = createProductionInstallerInclude({ installerInclude: 'installer.nsh', nodePath: 'node.exe', gateScript: 'gate.mjs', gateConfig: config })
    expect(include).toContain('!ifndef BUILD_UNINSTALLER')
    expect(include).toContain('${UNINSTALLER_OUT_FILE}')
    expect(include).toContain("' = 0")
    expect(() => createProductionInstallerInclude({ installerInclude: '$bad', nodePath: 'node', gateScript: 'gate', gateConfig: config })).toThrow(/Unsafe/)
  })
  it('requires Setup hashes and signer metadata alongside the embedded program payload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilotix-setup-metadata-'))
    roots.push(root)
    const layout = createReleaseLayout({ repositoryRoot: root, buildId: 'metadata', releaseName: 'Copilotix-1.0.0-win-x64' })
    await mkdir(layout.advancedDirectory, { recursive: true })
    const packageJson = { version: '1.0.0', build: { productName: 'Copilotix' } }
    const hashes = { executable: 'A'.repeat(64), appAsar: 'B'.repeat(64), zip: 'C'.repeat(64), setup: 'D'.repeat(64), launcher: 'F'.repeat(64) }
    await expect(writeReleaseMetadata(layout, packageJson, 'Copilotix.exe', { ...hashes, setup: undefined })).rejects.toThrow(/SHA-256: setup/)
    await writeReleaseMetadata(layout, packageJson, 'Copilotix.exe', hashes, 'CN=Release', 'CN=Release')
    await expect(assertReleaseMetadata(layout, layout.releaseName, 'Copilotix.exe', hashes, 'CN=Release', 'CN=Release')).resolves.toBeUndefined()
    const manifest = JSON.parse(await readFile(layout.manifestPath, 'utf8'))
    expect(manifest.schemaVersion).toBe(5)
    expect(manifest.artifactDirectory).toBe('../release-artifacts/metadata')
    expect(manifest.runtimeArtifactDirectory).toBe('../release-artifacts/metadata/program')
    expect(manifest.distribution).toBe('compact-setup')
    expect(manifest.runtime.embeddedIn).toBe(layout.setupName)
    expect(await readFile(layout.checksumsPath, 'utf8')).toBe(`${hashes.setup} *${layout.setupName}\n${hashes.launcher} *uninstall.exe\n`)
    const bundle = JSON.parse(await readFile(layout.bundleManifestPath, 'utf8'))
    expect(bundle.transport.sha256).toBeUndefined()
    expect(bundle.artifactDirectory).toBeUndefined()
    expect(bundle.runtimeArtifactDirectory).toBeUndefined()
    expect(bundle.runtime.entryPoint).toBe('program/Copilotix.exe')
    bundle.transport.sha256 = hashes.zip
    await writeFile(layout.bundleManifestPath, JSON.stringify(bundle))
    await expect(assertReleaseMetadata(layout, layout.releaseName, 'Copilotix.exe', hashes, 'CN=Release', 'CN=Release')).rejects.toThrow(/circular ZIP hash/)
    await writeReleaseMetadata(layout, packageJson, 'Copilotix.exe', hashes, 'CN=Release', 'CN=Release')
    expect(manifest.installer).toEqual({ file: layout.setupName, sha256: hashes.setup, authenticodeSignerSubject: 'CN=Release' })
    manifest.installer.sha256 = 'E'.repeat(64)
    await writeFile(layout.manifestPath, JSON.stringify(manifest))
    await expect(assertReleaseMetadata(layout, layout.releaseName, 'Copilotix.exe', hashes, 'CN=Release', 'CN=Release')).rejects.toThrow(/manifest/)
    await writeReleaseMetadata(layout, packageJson, 'Copilotix.exe', hashes)
    await writeFile(layout.checksumsPath, `${hashes.zip} *${layout.releaseName}.zip\n`)
    await expect(assertReleaseMetadata(layout, layout.releaseName, 'Copilotix.exe', hashes)).rejects.toThrow(/SHA256SUMS/)
  })

  it('prevents publishing staging with missing Setup or stray builder files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilotix-setup-contents-'))
    roots.push(root)
    const layout = createReleaseLayout({ repositoryRoot: root, buildId: 'contents', releaseName: 'Copilotix-1.0.0-win-x64' })
    await mkdir(layout.advancedDirectory, { recursive: true })
    await writeFile(layout.instructionsPath, 'fixture')
    for (const file of [layout.manifestPath, layout.bundleManifestPath, layout.checksumsPath]) await writeFile(file, 'fixture')
    await expect(assertReleaseRootContents(layout.stagingRoot, layout.releaseName, layout.setupName)).rejects.toThrow(/Unexpected/)
    await writeFile(layout.setupPath, 'fixture')
    await writeFile(layout.launcherPath, 'fixture')
    await expect(assertReleaseRootContents(layout.stagingRoot, layout.releaseName, layout.setupName)).resolves.toBeUndefined()
    await mkdir(join(layout.stagingRoot, 'program'))
    await expect(assertReleaseRootContents(layout.stagingRoot, layout.releaseName, layout.setupName)).rejects.toThrow(/Unexpected/)
    await rm(join(layout.stagingRoot, 'program'), { recursive: true })
    await writeFile(join(layout.advancedDirectory, `${layout.releaseName}.zip`), 'duplicate')
    await expect(assertReleaseRootContents(layout.stagingRoot, layout.releaseName, layout.setupName)).rejects.toThrow(/advanced/)
    await rm(join(layout.advancedDirectory, `${layout.releaseName}.zip`))
    await mkdir(layout.builderOutput)
    await expect(assertReleaseRootContents(layout.stagingRoot, layout.releaseName, layout.setupName)).rejects.toThrow(/builder/)
  })

  it('cleans only the previous successful build artifacts and rejects escaped references', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilotix-artifact-cleanup-'))
    roots.push(root)
    const layout = createReleaseLayout({ repositoryRoot: root, buildId: 'current', releaseName: 'Copilotix-1.0.0-win-x64' })
    const previousMetadata = join(layout.previousRoot, 'advanced', 'release-manifest.json')
    await mkdir(join(layout.previousRoot, 'advanced'), { recursive: true })
    await mkdir(join(layout.artifactsRoot, 'old-build'), { recursive: true })
    await mkdir(layout.artifactsDirectory)
    await writeFile(previousMetadata, JSON.stringify({ artifactDirectory: '../release-artifacts/old-build' }))
    expect(await removePreviousArtifacts(layout)).toBe(true)
    await expect(stat(join(layout.artifactsRoot, 'old-build'))).rejects.toMatchObject({ code: 'ENOENT' })
    await writeFile(previousMetadata, JSON.stringify({ artifactDirectory: '../../outside' }))
    await expect(removePreviousArtifacts(layout)).rejects.toThrow(/outside/)
    await writeFile(previousMetadata, JSON.stringify({ artifactDirectory: layout.artifactsRelativeDirectory }))
    await expect(removePreviousArtifacts(layout)).rejects.toThrow(/current/)
  })
})

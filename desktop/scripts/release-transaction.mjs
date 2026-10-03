import { setupNameForRelease } from './release-policy.mjs'
import { lstat, readFile, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

const BUILD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u
const RELEASE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u

/**
 * Build every release path once.  The caller only receives paths whose lexical
 * parent is the repository root or the build's own staging directory.
 */
export function createReleaseLayout({ repositoryRoot, buildId, releaseName }) {
  const root = resolveRequiredDirectory(repositoryRoot, 'repository root')
  assertSafeSegment(buildId, BUILD_ID_PATTERN, 'build id')
  assertSafeSegment(releaseName, RELEASE_NAME_PATTERN, 'release name')

  const layout = {
    repositoryRoot: root,
    releaseRoot: join(root, 'release'),
    stagingRoot: join(root, `.release-next-${buildId}`),
    previousRoot: join(root, `.release-previous-${buildId}`),
    artifactsRoot: join(root, 'release-artifacts'),
    artifactsDirectory: join(root, 'release-artifacts', buildId),
    artifactsRelativeDirectory: `../release-artifacts/${buildId}`,
    stagedArtifactsDirectory: join(root, `.release-next-${buildId}`, 'artifacts'),
    releaseName,
    setupName: setupNameForRelease(releaseName),
    setupPath: join(root, `.release-next-${buildId}`, setupNameForRelease(releaseName)),
    instructionsPath: join(root, `.release-next-${buildId}`, '安装说明.txt'),
    advancedDirectory: join(root, `.release-next-${buildId}`, 'advanced'),
    builderOutput: join(root, `.release-next-${buildId}`, 'builder'),
    runtimeDirectory: join(root, `.release-next-${buildId}`, 'artifacts', 'program'),
    launcherPath: join(root, `.release-next-${buildId}`, 'uninstall.exe'),
    bundleManifestPath: join(root, `.release-next-${buildId}`, 'advanced', 'bundle-manifest.json'),
    zipPath: join(root, `.release-next-${buildId}`, 'artifacts', `${releaseName}.zip`),
    manifestPath: join(root, `.release-next-${buildId}`, 'advanced', 'release-manifest.json'),
    checksumsPath: join(root, `.release-next-${buildId}`, 'advanced', 'SHA256SUMS.txt'),
    verificationDirectory: join(root, `.release-next-${buildId}`, '.verify')
  }
  assertReleaseLayout(layout)
  return Object.freeze(layout)
}

/** Refuse to operate on a path outside the repository's exact release area. */
export function assertReleaseLayout(layout) {
  if (!layout || typeof layout !== 'object') throw new TypeError('Release layout is required')
  const root = resolveRequiredDirectory(layout.repositoryRoot, 'repository root')
  const stagingBuildId = extractBuildId(layout.stagingRoot)
  const previousBuildId = extractBuildId(layout.previousRoot)
  if (stagingBuildId !== previousBuildId || !BUILD_ID_PATTERN.test(stagingBuildId)) {
    throw new Error('Release transaction paths do not share a valid build id')
  }
  assertExactChild(root, layout.releaseRoot, 'release')
  assertExactChild(root, layout.stagingRoot, `.release-next-${stagingBuildId}`)
  assertExactChild(root, layout.previousRoot, `.release-previous-${previousBuildId}`)
  assertExactChild(root, layout.artifactsRoot, 'release-artifacts')
  assertExactChild(layout.artifactsRoot, layout.artifactsDirectory, stagingBuildId)
  if (layout.artifactsRelativeDirectory !== `../release-artifacts/${stagingBuildId}`) throw new Error('Artifact reference does not match build id')
  assertExactChild(layout.stagingRoot, layout.stagedArtifactsDirectory, 'artifacts')
  assertChild(layout.stagingRoot, layout.builderOutput, 'builder output')
  assertExactChild(layout.stagingRoot, layout.instructionsPath, '安装说明.txt')
  assertExactChild(layout.stagingRoot, layout.advancedDirectory, 'advanced')
  assertExactChild(layout.stagedArtifactsDirectory, layout.runtimeDirectory, 'program')
  assertExactChild(layout.stagingRoot, layout.launcherPath, 'uninstall.exe')
  assertExactChild(layout.advancedDirectory, layout.bundleManifestPath, 'bundle-manifest.json')
  assertExactChild(layout.stagedArtifactsDirectory, layout.zipPath, `${layout.releaseName}.zip`)
  assertExactChild(layout.stagingRoot, layout.setupPath, setupNameForRelease(layout.releaseName))
  if (layout.setupName !== setupNameForRelease(layout.releaseName)) throw new Error('Setup name does not match release name')
  assertExactChild(layout.advancedDirectory, layout.manifestPath, 'release-manifest.json')
  assertExactChild(layout.advancedDirectory, layout.checksumsPath, 'SHA256SUMS.txt')
  assertChild(layout.stagingRoot, layout.verificationDirectory, 'verification directory')
  if (!RELEASE_NAME_PATTERN.test(String(layout.releaseName))) throw new Error(`Invalid release name: ${String(layout.releaseName)}`)
  if (basenameOf(layout.runtimeDirectory) !== 'program') throw new Error('Runtime directory must be program')
  return layout
}

/**
 * This is deliberately a pure description of the two renames and the only
 * allowed rollback rename.  File-system execution is kept in swapRelease so
 * tests can validate the transaction without touching a real release.
 */
export function createSwapPlan(layout, hasExistingRelease) {
  assertReleaseLayout(layout)
  if (typeof hasExistingRelease !== 'boolean') throw new TypeError('Existing release state is required')
  return Object.freeze({
    moveExisting: hasExistingRelease ? Object.freeze({ from: layout.releaseRoot, to: layout.previousRoot }) : null,
    publishNext: Object.freeze({ from: layout.stagingRoot, to: layout.releaseRoot }),
    rollback: hasExistingRelease ? Object.freeze({ from: layout.previousRoot, to: layout.releaseRoot }) : null
  })
}

export async function swapRelease(layout, fileSystem = {}) {
  assertReleaseLayout(layout)
  const exists = fileSystem.exists ?? pathExists
  const renamePath = fileSystem.rename ?? rename
  if (await exists(layout.previousRoot)) throw new Error(`Previous release path already exists: ${layout.previousRoot}`)
  if (!(await isDirectory(layout.stagingRoot))) throw new Error(`Release staging directory is missing: ${layout.stagingRoot}`)

  const hasExistingRelease = await exists(layout.releaseRoot)
  if (hasExistingRelease && !(await isDirectory(layout.releaseRoot))) {
    throw new Error(`Existing release path is not a directory: ${layout.releaseRoot}`)
  }
  const plan = createSwapPlan(layout, hasExistingRelease)
  let previousMoved = false
  try {
    if (plan.moveExisting) {
      await renamePath(plan.moveExisting.from, plan.moveExisting.to)
      previousMoved = true
    }
    await renamePath(plan.publishNext.from, plan.publishNext.to)
  } catch (error) {
    if (previousMoved) {
      try {
        await rollbackReleaseSwap(layout, fileSystem)
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'Release swap failed and rollback failed')
      }
    }
    throw error
  }
  return Object.freeze({ previousRoot: previousMoved ? layout.previousRoot : null })
}

/** Restore the previous release only when the live release path is absent. */
export async function rollbackReleaseSwap(layout, fileSystem = {}) {
  assertReleaseLayout(layout)
  const exists = fileSystem.exists ?? pathExists
  const renamePath = fileSystem.rename ?? rename
  if (await exists(layout.releaseRoot)) return false
  if (!(await exists(layout.previousRoot))) return false
  await renamePath(layout.previousRoot, layout.releaseRoot)
  return true
}

/** Cleanup is intentionally separate and must only be called after swap succeeds. */
export async function removePreviousRelease(layout, fileSystem = {}) {
  assertReleaseLayout(layout)
  const removePath = fileSystem.remove ?? rm
  if (!(await (fileSystem.exists ?? pathExists)(layout.previousRoot))) return false
  await removePath(layout.previousRoot, { recursive: true, force: true })
  return true
}

/** Delete only a previous successful build's exact owned artifact directory. */
export async function removePreviousArtifacts(layout) {
  assertReleaseLayout(layout)
  const metadataPath = join(layout.previousRoot, 'advanced', 'release-manifest.json')
  if (!(await pathExists(metadataPath))) return false
  const manifest = JSON.parse(await readFile(metadataPath, 'utf8'))
  if (!manifest.artifactDirectory) return false // Earlier compact-layout revisions.
  const match = /^\.\.\/release-artifacts\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/u.exec(manifest.artifactDirectory)
  if (!match) throw new Error('Previous artifact reference is outside the owned build area')
  const target = join(layout.artifactsRoot, match[1])
  if (target === layout.artifactsDirectory) throw new Error('Refusing to remove current build artifacts')
  if (!(await pathExists(target))) return false
  for (const path of [layout.artifactsRoot, target]) {
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Artifact cleanup refuses symbolic links or non-directories')
  }
  await rm(target, { recursive: true, force: true })
  return true
}

export async function pathExists(path) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

function resolveRequiredDirectory(path, label) {
  if (typeof path !== 'string' || path.length === 0) throw new TypeError(`${label} is required`)
  return resolve(path)
}

function assertSafeSegment(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`Invalid ${label}: ${String(value)}`)
}

function assertExactChild(parent, child, expectedName) {
  const resolvedParent = resolve(parent)
  const resolvedChild = resolveRequiredDirectory(child, expectedName)
  if (dirname(resolvedChild) !== resolvedParent || basenameOf(resolvedChild) !== expectedName) {
    throw new Error(`Unexpected ${expectedName} path: ${resolvedChild}`)
  }
}

function assertChild(parent, child, label) {
  const resolvedParent = resolve(parent)
  const resolvedChild = resolveRequiredDirectory(child, label)
  const pathFromParent = relative(resolvedParent, resolvedChild)
  if (!pathFromParent || pathFromParent.startsWith('..') || isAbsolute(pathFromParent)) {
    throw new Error(`${label} must stay inside staging: ${resolvedChild}`)
  }
}

async function isDirectory(path) {
  try {
    return (await lstat(path)).isDirectory()
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

function basenameOf(path) {
  return resolve(path).split(/[\\/]/u).at(-1) ?? ''
}

function extractBuildId(path) {
  const name = basenameOf(path)
  const match = name.match(/^\.release-(?:next|previous)-(.+)$/u)
  if (!match) throw new Error(`Unexpected release transaction path: ${path}`)
  return match[1] ?? ''
}

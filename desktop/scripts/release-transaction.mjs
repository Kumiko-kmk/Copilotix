import { lstat, rename, rm } from 'node:fs/promises'
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
    releaseName,
    builderOutput: join(root, `.release-next-${buildId}`, 'builder'),
    runtimeDirectory: join(root, `.release-next-${buildId}`, releaseName),
    zipPath: join(root, `.release-next-${buildId}`, `${releaseName}.zip`),
    manifestPath: join(root, `.release-next-${buildId}`, 'release-manifest.json'),
    checksumsPath: join(root, `.release-next-${buildId}`, 'SHA256SUMS.txt'),
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
  assertChild(layout.stagingRoot, layout.builderOutput, 'builder output')
  assertChild(layout.stagingRoot, layout.runtimeDirectory, 'runtime directory')
  assertChild(layout.stagingRoot, layout.zipPath, 'release archive')
  assertChild(layout.stagingRoot, layout.manifestPath, 'release manifest')
  assertChild(layout.stagingRoot, layout.checksumsPath, 'release checksums')
  assertChild(layout.stagingRoot, layout.verificationDirectory, 'verification directory')
  if (!RELEASE_NAME_PATTERN.test(String(layout.releaseName))) throw new Error(`Invalid release name: ${String(layout.releaseName)}`)
  if (basenameOf(layout.runtimeDirectory) !== layout.releaseName) throw new Error('Runtime directory does not match release name')
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

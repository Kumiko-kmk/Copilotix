import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertWindowsX64, createBuildId } from '../scripts/package-directory.mjs'
import {
  createReleaseLayout,
  createSwapPlan,
  removePreviousRelease,
  swapRelease
} from '../scripts/release-transaction.mjs'

const roots = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('release transaction boundaries', () => {
  it('creates a unique sibling staging layout and rejects non-Windows targets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mineru-release-layout-'))
    roots.push(root)
    const layout = createReleaseLayout({ repositoryRoot: root, buildId: createBuildId(123, 7, 'fixture'), releaseName: 'MinerU-0.1.0-win-x64' })

    expect(layout.stagingRoot).toBe(join(root, '.release-next-3f-7-fixture'))
    expect(layout.previousRoot).toBe(join(root, '.release-previous-3f-7-fixture'))
    expect(layout.releaseRoot).toBe(join(root, 'release'))
    expect(() => assertWindowsX64('linux', 'x64')).toThrow(/Windows x64/)
    expect(() => assertWindowsX64('win32', 'arm64')).toThrow(/Windows x64/)
  })

  it('describes publish and rollback renames without deleting the live release', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mineru-release-swap-'))
    roots.push(root)
    const layout = createReleaseLayout({ repositoryRoot: root, buildId: 'fixture-swap', releaseName: 'MinerU-0.1.0-win-x64' })
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
    const root = await mkdtemp(join(tmpdir(), 'mineru-release-rollback-'))
    roots.push(root)
    const layout = createReleaseLayout({ repositoryRoot: root, buildId: 'fixture-rollback', releaseName: 'MinerU-0.1.0-win-x64' })
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

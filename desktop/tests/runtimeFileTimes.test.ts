import { describe, expect, it } from 'vitest'
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { stampRuntimeFileTimes } from '../scripts/runtime-file-times.mjs'

describe('runtime distribution file dates', () => {
  it('updates copied 1980 dates while preserving source dates and every file byte', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilotix-runtime-dates-'))
    try {
      const source = join(root, 'source.dll')
      const runtime = join(root, 'program')
      await mkdir(join(runtime, 'resources'), { recursive: true })
      await writeFile(source, 'unchanged Electron resource')
      const old = new Date('1980-01-01T00:00:00Z')
      await utimes(source, old, old)
      const copied = join(runtime, 'resource.dll')
      await copyFile(source, copied)
      await utimes(copied, old, old)
      const asar = join(runtime, 'resources', 'app.asar')
      await writeFile(asar, 'unchanged signed application data')
      const built = new Date('2026-10-10T04:00:00Z')
      expect(await stampRuntimeFileTimes(runtime, built)).toBe(2)
      expect((await stat(copied)).mtime.toISOString()).toBe(built.toISOString())
      expect((await stat(asar)).mtime.toISOString()).toBe(built.toISOString())
      expect((await stat(source)).mtime.toISOString()).toBe(old.toISOString())
      expect(await readFile(copied)).toEqual(await readFile(source))
      expect(await readFile(asar, 'utf8')).toBe('unchanged signed application data')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})

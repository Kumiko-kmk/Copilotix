import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PathPolicy, resolveLexicalWithinRoot } from '@main/pathPolicy'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('PathPolicy', () => {
  it('covers injectable POSIX, Windows drive, and UNC lexical fixtures', () => {
    expect(resolveLexicalWithinRoot('/workspace', '/workspace/documents-v2/document-1', 'posix'))
      .toBe('/workspace/documents-v2/document-1')
    expect(() => resolveLexicalWithinRoot('/workspace', '/workspace/../outside', 'posix')).toThrow(/\.\./)

    const winRoot = String.raw`C:\Copilotix`
    expect(resolveLexicalWithinRoot(winRoot, String.raw`C:\Copilotix\documents-v2\document-1`, 'win32'))
      .toBe(String.raw`C:\Copilotix\documents-v2\document-1`)
    expect(() => resolveLexicalWithinRoot(winRoot, String.raw`D:\outside\document`, 'win32')).toThrow()

    const uncRoot = String.raw`\\server\share\Copilotix`
    expect(resolveLexicalWithinRoot(uncRoot, String.raw`\\server\share\Copilotix\documents-v2\document-1`, 'win32'))
      .toBe(String.raw`\\server\share\Copilotix\documents-v2\document-1`)
    expect(() => resolveLexicalWithinRoot(uncRoot, String.raw`\\server\share\outside`, 'win32')).toThrow()
    expect(() => resolveLexicalWithinRoot('/workspace', 'C:\\outside', 'posix')).toThrow()
  })

  it('allows a real child on POSIX/Windows paths and rejects root, parent, NUL, and other volumes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'copilotix-path-'))
    directories.push(directory)
    const root = join(directory, 'root')
    await mkdir(root)
    const policy = new PathPolicy()
    expect(policy.resolveChild(root, join(root, 'documents-v2', 'document-1'))).toContain('document-1')
    expect(() => policy.resolveChild(root, root)).toThrow()
    expect(() => policy.resolveChild(root, `${root}${process.platform === 'win32' ? '\\' : '/'}..${process.platform === 'win32' ? '\\' : '/'}outside`)).toThrow(/\.\./)
    expect(() => policy.resolveChild(root, `safe\0name`)).toThrow(/NUL/)
    const otherVolume = process.platform === 'win32' ? 'Z:\\outside\\document' : '/other-volume/document'
    expect(() => policy.resolveChild(root, otherVolume)).toThrow()
    expect(() => policy.resolveChild(root, '\\\\server\\share\\document')).toThrow()
  })

  it('rejects symlink/junction escape but permits a link that resolves inside root', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'copilotix-symlink-'))
    directories.push(directory)
    const root = join(directory, 'root')
    const outside = join(directory, 'outside')
    const inside = join(root, 'inside')
    await mkdir(root)
    await mkdir(outside)
    await mkdir(inside, { recursive: true })
    const outsideLink = join(root, 'outside-link')
    const insideLink = join(root, 'inside-link')
    const linkType = process.platform === 'win32' ? 'junction' : 'dir'
    await symlink(outside, outsideLink, linkType)
    await symlink(inside, insideLink, linkType)
    const policy = new PathPolicy()
    expect(() => policy.resolveChild(root, join(outsideLink, 'escape.txt'))).toThrow(/symlink|junction/)
    expect(policy.resolveChild(root, join(insideLink, 'safe.txt'))).toContain('safe.txt')
  })
})

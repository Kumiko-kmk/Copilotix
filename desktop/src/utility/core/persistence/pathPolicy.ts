import { existsSync, realpathSync } from 'node:fs'
import { posix, win32 } from 'node:path'

export type PathFlavor = 'posix' | 'win32'

export interface PathPolicyPort {
  resolveChild(root: string, candidate: string): string
}

interface PathApi {
  resolve(...paths: string[]): string
  relative(from: string, to: string): string
  isAbsolute(path: string): boolean
  basename(path: string): string
  dirname(path: string): string
  separator: string
}

const APIs: Record<PathFlavor, PathApi> = {
  posix: { resolve: (...paths) => posix.resolve(...paths), relative: (from, to) => posix.relative(from, to), isAbsolute: (path) => posix.isAbsolute(path), basename: (path) => posix.basename(path), dirname: (path) => posix.dirname(path), separator: posix.sep },
  win32: { resolve: (...paths) => win32.resolve(...paths), relative: (from, to) => win32.relative(from, to), isAbsolute: (path) => win32.isAbsolute(path), basename: (path) => win32.basename(path), dirname: (path) => win32.dirname(path), separator: win32.sep }
}
const HOST_FLAVOR: PathFlavor = process.platform === 'win32' ? 'win32' : 'posix'

export function resolveLexicalWithinRoot(root: string, candidate: string, flavor: PathFlavor): string {
  const api = APIs[flavor]
  assertNoNul(root); assertNoNul(candidate)
  if (candidate.split(/[\\/]+/u).some((segment) => segment === '..')) throw new Error('path escapes root')
  if (flavor === 'posix' && (/^[A-Za-z]:[\\/]/u.test(candidate) || /^\\\\[^\\/]+[\\/][^\\/]+/u.test(candidate))) throw new Error('cross-platform path')
  const rootResolved = api.resolve(root)
  const candidateResolved = api.resolve(rootResolved, candidate)
  assertInside(api, rootResolved, candidateResolved)
  return candidateResolved
}

export class PathPolicy implements PathPolicyPort {
  constructor(private readonly flavor: PathFlavor = HOST_FLAVOR) {}

  resolveChild(root: string, candidate: string): string {
    const api = APIs[this.flavor]
    const lexical = resolveLexicalWithinRoot(root, candidate, this.flavor)
    const rootReal = realpathSync.native(api.resolve(root))
    const candidateReal = existingOrFuture(lexical, api)
    assertInside(api, rootReal, candidateReal)
    return candidateReal
  }
}

function existingOrFuture(candidate: string, api: PathApi): string {
  if (existsSync(candidate)) return realpathSync.native(candidate)
  const suffix: string[] = []
  let current = candidate
  while (!existsSync(current)) {
    const parent = api.dirname(current)
    if (parent === current) throw new Error('cannot resolve path ancestor')
    suffix.unshift(api.basename(current)); current = parent
  }
  return api.resolve(realpathSync.native(current), ...suffix)
}

function assertInside(api: PathApi, root: string, candidate: string): void {
  const relative = api.relative(root, candidate)
  if (!relative || relative === '..' || relative.startsWith(`..${api.separator}`) || api.isAbsolute(relative)) throw new Error('path escapes root')
}

function assertNoNul(value: string): void {
  if (value.includes('\0')) throw new Error('NUL in path')
}

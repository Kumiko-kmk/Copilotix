import { existsSync, realpathSync } from 'node:fs'
import { posix, win32 } from 'node:path'
import type { PathPolicyPort } from '@core/ports'

export type PathFlavor = 'posix' | 'win32'

interface PathApi {
  resolve(...paths: string[]): string
  relative(from: string, to: string): string
  isAbsolute(path: string): boolean
  basename(path: string): string
  dirname(path: string): string
  separator: string
}

const POSIX_PATH_API: PathApi = {
  resolve: (...paths) => posix.resolve(...paths),
  relative: (from, to) => posix.relative(from, to),
  isAbsolute: (path) => posix.isAbsolute(path),
  basename: (path) => posix.basename(path),
  dirname: (path) => posix.dirname(path),
  separator: posix.sep
}

const WIN32_PATH_API: PathApi = {
  resolve: (...paths) => win32.resolve(...paths),
  relative: (from, to) => win32.relative(from, to),
  isAbsolute: (path) => win32.isAbsolute(path),
  basename: (path) => win32.basename(path),
  dirname: (path) => win32.dirname(path),
  separator: win32.sep
}

const HOST_FLAVOR: PathFlavor = process.platform === 'win32' ? 'win32' : 'posix'

/** Pure lexical check used by both host resolution and cross-platform tests. */
export function resolveLexicalWithinRoot(root: string, candidate: string, flavor: PathFlavor): string {
  const api = pathApi(flavor)
  assertNoNul(root)
  assertNoNul(candidate)
  assertNoParentSegment(candidate)
  if (flavor === 'posix' && (/^[A-Za-z]:[\\/]/u.test(candidate) || /^\\\\[^\\/]+[\\/][^\\/]+/u.test(candidate))) {
    throw new Error('拒绝跨平台绝对路径')
  }
  const rootResolved = api.resolve(root)
  const candidateResolved = api.resolve(rootResolved, candidate)
  assertInside(api, rootResolved, candidateResolved, '路径必须位于根目录内')
  return candidateResolved
}

/**
 * Host filesystem implementation. `realpath` is injectable so lexical
 * Windows/POSIX fixtures remain deterministic while symlink/junction checks
 * still use the real host filesystem in integration tests.
 */
export class PathPolicy implements PathPolicyPort {
  constructor(
    private readonly flavor: PathFlavor = HOST_FLAVOR,
    private readonly exists: (path: string) => boolean = existsSync,
    private readonly realpath: (path: string) => string = realpathSync.native
  ) {}

  resolveChild(root: string, candidate: string): string {
    const api = pathApi(this.flavor)
    const candidateResolved = resolveLexicalWithinRoot(root, candidate, this.flavor)
    const rootReal = this.realpath(api.resolve(root))
    const candidateReal = resolveExistingOrFuture(candidateResolved, api, this.exists, this.realpath)
    assertInside(api, rootReal, candidateReal, '拒绝 symlink/junction 越界路径')
    return candidateReal
  }
}

function pathApi(flavor: PathFlavor): PathApi {
  return flavor === 'win32' ? WIN32_PATH_API : POSIX_PATH_API
}

function resolveExistingOrFuture(candidate: string, api: PathApi, exists: (path: string) => boolean, realpath: (path: string) => string): string {
  if (exists(candidate)) return realpath(candidate)

  const suffix: string[] = []
  let current = candidate
  while (!exists(current)) {
    const parent = api.dirname(current)
    if (parent === current) throw new Error('无法解析路径祖先')
    suffix.unshift(api.basename(current))
    current = parent
  }
  return api.resolve(realpath(current), ...suffix)
}

function assertInside(api: PathApi, root: string, candidate: string, message: string): void {
  const pathFromRoot = api.relative(root, candidate)
  if (!pathFromRoot || pathFromRoot === '..' || pathFromRoot.startsWith(`..${api.separator}`) || api.isAbsolute(pathFromRoot)) {
    throw new Error(message)
  }
}

function assertNoNul(value: string): void {
  if (value.includes('\0')) throw new Error('路径不能包含 NUL 字符')
}

function assertNoParentSegment(value: string): void {
  if (value.split(/[\\/]+/u).some((segment) => segment === '..')) {
    throw new Error('路径不能包含 ..')
  }
}

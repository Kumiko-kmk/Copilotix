import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, rmdir, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export interface UninstallCleanupOptions {
  appData: string
  installDirectory: string
  protectedDirectories?: string[]
  forbiddenDirectories?: string[]
}

export interface UninstallCleanupPlan {
  userData: string
  libraryPaths: string[]
  documentCount: number
  outputRoot?: string
  token: string
  options: UninstallCleanupOptions
}

const databaseName = 'copilotix-desktop-v2.sqlite3'
const failure = () => new Error('Unable to safely remove application data. No unsafe path will be removed.')
const normalized = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
const contains = (parent: string, child: string) => {
  const part = relative(normalized(parent), normalized(child))
  return part === '' || (!part.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && part !== '..' && !isAbsolute(part))
}
const overlaps = (a: string, b: string) => contains(a, b) || contains(b, a)

function absolute(path: string): string {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0') || path.length > 32768) throw failure()
  const result = resolve(path)
  if (result === parse(result).root) throw failure()
  return result
}

async function inspect(path: string) {
  try { return await lstat(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw failure()
  }
}

async function ancestors(path: string): Promise<void> {
  let candidate = resolve(path)
  while (true) {
    const stat = await inspect(candidate)
    if (stat?.isSymbolicLink() || (stat && candidate !== path && !stat.isDirectory())) throw failure()
    const parent = dirname(candidate)
    if (parent === candidate) return
    candidate = parent
  }
}

async function snapshot(path: string, records: string[]): Promise<void> {
  await ancestors(path)
  const stat = await inspect(path)
  if (!stat) { records.push(JSON.stringify([path, 'missing'])); return }
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw failure()
  records.push(JSON.stringify([path, stat.isDirectory() ? 'directory' : 'file', stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]))
  if (stat.isDirectory()) {
    for (const name of (await readdir(path)).sort()) await snapshot(join(path, name), records)
  }
}

/** Reads the existing SQLite file without migrations or starting the translation queue. */
export async function prepareUninstallCleanup(options: UninstallCleanupOptions): Promise<UninstallCleanupPlan> {
  const appData = absolute(options.appData)
  const installDirectory = absolute(options.installDirectory)
  const userData = join(appData, 'Copilotix-Translation-v2')
  if (overlaps(userData, installDirectory)) throw failure()
  const protectedDirectories = (options.protectedDirectories ?? []).map(absolute)
  const forbiddenDirectories = (options.forbiddenDirectories ?? []).map(absolute)
  if (protectedDirectories.some((path) => contains(userData, path)) || forbiddenDirectories.some((path) => overlaps(path, userData))) throw failure()
  await ancestors(userData)
  const databasePath = join(userData, databaseName)
  const databaseStat = await inspect(databasePath)
  const rows: Array<{ id: string; storage_path: string }> = []
  let outputRoot: string | undefined
  if (databaseStat) {
    if (!databaseStat.isFile() || databaseStat.isSymbolicLink()) throw failure()
    let database: DatabaseSync | undefined
    try {
      database = new DatabaseSync(databasePath, { readOnly: true })
      database.exec('PRAGMA trusted_schema=OFF')
      const schema = database.prepare("SELECT type FROM sqlite_master WHERE name='documents'").get() as { type: string } | undefined
      if (schema?.type !== 'table') throw failure()
      rows.push(...database.prepare('SELECT id,storage_path FROM documents ORDER BY id LIMIT 100001').all() as typeof rows)
      if (rows.length > 100000) throw failure()
      const setting = database.prepare("SELECT value FROM settings WHERE key='outputRoot'").get() as { value: string } | undefined
      if (setting) {
        const value: unknown = JSON.parse(setting.value)
        if (typeof value === 'string') outputRoot = value
      }
    } catch { throw failure() } finally { database?.close() }
  }
  const libraryPaths = rows.map((row) => {
    if (typeof row.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(row.id)) throw failure()
    const path = absolute(row.storage_path)
    if (basename(path) !== row.id || basename(dirname(path)) !== 'documents-v2' || overlaps(path, appData) || overlaps(path, installDirectory)) throw failure()
    if (protectedDirectories.some((protectedPath) => contains(path, protectedPath)) || forbiddenDirectories.some((forbiddenPath) => overlaps(path, forbiddenPath))) throw failure()
    return path
  })
  if (new Set(libraryPaths.map(normalized)).size !== libraryPaths.length) throw failure()
  const records: string[] = [JSON.stringify({ userData, libraryPaths, rows, outputRoot, installDirectory, protectedDirectories, forbiddenDirectories })]
  for (const path of [...libraryPaths, userData]) await snapshot(path, records)
  // Include database bytes so even same-size database updates invalidate confirmation.
  if (databaseStat) records.push(createHash('sha256').update(await readFile(databasePath)).digest('hex'))
  return { userData, libraryPaths, documentCount: rows.length, ...(outputRoot ? { outputRoot } : {}), token: createHash('sha256').update(records.join('\n')).digest('hex'), options: { appData, installDirectory, protectedDirectories, forbiddenDirectories } }
}

async function removeTree(path: string): Promise<void> {
  await ancestors(path)
  const stat = await inspect(path)
  if (!stat) return
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw failure()
  if (stat.isDirectory()) {
    // Keep the database and its journals until every other entry has been removed.
    const priority = (name: string) => name === databaseName ? 2 : name.startsWith(databaseName + '-') ? 1 : 0
    const names = (await readdir(path)).sort((a, b) => priority(a) - priority(b) || a.localeCompare(b))
    for (const name of names) await removeTree(join(path, name))
    await ancestors(path)
    const current = await inspect(path)
    if (!current || !current.isDirectory() || current.isSymbolicLink() || current.ino !== stat.ino || current.dev !== stat.dev) throw failure()
    await rmdir(path)
  } else {
    await ancestors(path)
    const current = await inspect(path)
    if (!current || !current.isFile() || current.isSymbolicLink() || current.ino !== stat.ino || current.dev !== stat.dev) throw failure()
    await unlink(path)
  }
}

/** Complete safety preflight happens before any removal; only database-recorded library folders are eligible. */
export async function executeUninstallCleanup(plan: UninstallCleanupPlan, options: UninstallCleanupOptions = plan.options): Promise<void> {
  const current = await prepareUninstallCleanup(options)
  if (current.token !== plan.token) throw failure()
  for (const path of current.libraryPaths) await removeTree(path)
  await removeTree(current.userData)
}

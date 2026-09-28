import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, open, readdir, readFile, realpath, rename, statfs, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { LibraryRequest, LibraryResult } from '@shared/librarySchemas'
import type { V2Database } from './persistence/v2Database'

const itemSchema = z.object({
  path: z.string().min(1).max(32768), bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u)
}).strict()
const manifestSchema = z.object({
  format: z.literal('copilotix-library'), version: z.literal(1),
  createdAt: z.string(), documents: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/u)).max(100000),
  files: z.array(itemSchema).max(1000000)
}).strict()
type Manifest = z.infer<typeof manifestSchema>
type DocumentRow = { id: string; storage_path: string }
const ACTIVE = "status IN ('queued','running','retry-wait')"

export function assertLibraryIdle(database: V2Database): void {
  if (database.connection.prepare('SELECT id FROM jobs WHERE ' + ACTIVE + ' LIMIT 1').get()) {
    throw new Error('文档库中仍有排队或执行中的任务，请等待任务完成后再操作。')
  }
}

/** Invoked on the Utility persistence lane with Main IPC exclusively locked. */
export async function manageLibrary(
  database: V2Database, databasePath: string, request: LibraryRequest & { path: string }, signal?: AbortSignal
): Promise<LibraryResult> {
  assertLibraryIdle(database)
  const selected = await safeDirectory(request.path)
  const documents = database.connection.prepare('SELECT id,storage_path FROM documents ORDER BY id').all() as DocumentRow[]
  for (const document of documents) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(document.id)) throw new Error('文档标识无效，无法安全备份。')
    const source = await safeDirectory(document.storage_path)
    if (inside(source, selected)) throw new Error('目标目录不能位于现有文档目录内部。')
  }
  signal?.throwIfAborted()
  if (request.action === 'backup') {
    const path = await createBackup(database, documents, selected, signal)
    return { status: 'completed', path, restartRequired: false }
  }
  if (request.action === 'migrate') {
    if ((await readdir(selected)).length !== 0) throw new Error('请选择一个空目录作为迁移目标，现有文件不会被覆盖。')
    const stage = join(selected, '.copilotix-staging-' + randomUUID())
    await mkdir(stage)
    await copyDocuments(documents, stage, signal)
    await requireSpace(selected, 1024 * 1024)
    const target = join(selected, 'documents-v2')
    signal?.throwIfAborted()
    // Files become durable before a single database transaction changes references.
    await rename(join(stage, 'documents'), target)
    const recovery = await databaseSnapshot(database, dirname(databasePath), 'before-library-migration')
    signal?.throwIfAborted()
    database.transaction(() => {
      for (const document of documents) {
        database.connection.prepare('UPDATE documents SET storage_path=? WHERE id=?').run(join(target, document.id), document.id)
      }
      saveOutputRoot(database.connection, selected)
    })
    await writeFile(join(stage, 'migration-complete.json'), JSON.stringify({ recovery, target }), 'utf8').catch(() => undefined)
    return { status: 'completed', path: selected, restartRequired: true }
  }

  const manifest = await verifyBackup(selected, signal)
  const incomingPath = join(selected, 'library.sqlite3')
  validateIncomingDatabase(database.connection, incomingPath, manifest)
  const oldOutputRow = database.connection.prepare("SELECT value FROM settings WHERE key='outputRoot'").get() as { value: string } | undefined
  const oldOutput = oldOutputRow ? JSON.parse(oldOutputRow.value) as string : dirname(databasePath)
  const restoreParent = await safeDirectory(oldOutput)
  // Retain a complete pre-restore library, not just a database pointing to missing files.
  const recoveryParent = join(dirname(databasePath), 'library-recovery')
  await mkdir(recoveryParent, { recursive: true })
  const recovery = await createBackup(database, documents, await safeDirectory(recoveryParent), signal)
  const restoredRoot = join(restoreParent, 'restored-library-' + randomUUID())
  await mkdir(restoredRoot)
  const restoredDocuments = manifest.documents.map((id) => ({ id, storage_path: join(selected, 'documents', id) }))
  const restoredFiles = await copyDocuments(restoredDocuments, restoredRoot, signal)
  const expectedFiles = new Map(manifest.files.map((file) => [file.path, file]))
  for (const file of restoredFiles) {
    const expected = expectedFiles.get(file.path)
    if (!expected || file.bytes !== expected.bytes || file.sha256 !== expected.sha256) throw new Error('恢复源文件在复制过程中发生变化。')
  }
  if (restoredFiles.length !== manifest.files.length - 1) throw new Error('恢复文件清单不完整。')
  const target = join(restoredRoot, 'documents-v2')
  await rename(join(restoredRoot, 'documents'), target)
  // Copy the DB too: verify the exact copy we will attach, guarding source changes.
  const stagedDatabase = join(restoredRoot, 'library.sqlite3')
  await checkedCopy(incomingPath, stagedDatabase, manifest.files.find((item) => item.path === 'library.sqlite3')!, signal)
  validateIncomingDatabase(database.connection, stagedDatabase, manifest)
  signal?.throwIfAborted()
  replaceDatabaseContents(database, stagedDatabase, manifest.documents, target, restoredRoot)
  await writeFile(join(restoredRoot, 'restore-complete.json'), JSON.stringify({ recovery }), 'utf8').catch(() => undefined)
  return { status: 'completed', path: restoredRoot, restartRequired: true }
}

async function databaseSnapshot(database: V2Database, parent: string, label: string): Promise<string> {
  const path = join(parent, label + '-' + randomUUID() + '.sqlite3')
  database.connection.prepare('VACUUM INTO ?').run(path)
  await syncFile(path)
  return path
}

async function createBackup(database: V2Database, documents: DocumentRow[], parent: string, signal?: AbortSignal): Promise<string> {
  for (const document of documents) {
    if (inside(await safeDirectory(document.storage_path), parent)) throw new Error('备份目标不能位于文档目录内部。')
  }
  const id = new Date().toISOString().replace(/[:.]/gu, '-') + '-' + randomUUID().slice(0, 8)
  const staging = join(parent, '.copilotix-backup-' + id)
  const destination = join(parent, 'Copilotix-backup-' + id)
  await mkdir(staging)
  // On failure retain only this clearly named staging directory; never delete user data.
  const files = await copyDocuments(documents, staging, signal)
  const databaseFile = join(staging, 'library.sqlite3')
  database.connection.prepare('VACUUM INTO ?').run(databaseFile)
  const snapshot = new DatabaseSync(databaseFile)
  try {
    snapshot.exec('PRAGMA journal_mode=DELETE')
    const keys = snapshot.prepare('SELECT key FROM settings').all() as Array<{ key: string }>
    for (const { key } of keys) if (/credential|token|api.?key|password|secret/iu.test(key)) {
      snapshot.prepare('DELETE FROM settings WHERE key=?').run(key)
    }
    // Rebuild pages so removed legacy secrets cannot remain in SQLite free space.
    snapshot.exec('VACUUM')
  } finally { snapshot.close() }
  await syncFile(databaseFile)
  files.push({ path: 'library.sqlite3', ...(await fingerprint(databaseFile, signal)) })
  const manifest: Manifest = { format: 'copilotix-library', version: 1, createdAt: new Date().toISOString(),
    documents: documents.map((item) => item.id), files }
  const manifestPath = join(staging, 'manifest.json')
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), { encoding: 'utf8', flag: 'wx' })
  await syncFile(manifestPath)
  validateIncomingDatabase(database.connection, databaseFile, manifest)
  await verifyBackup(staging, signal)
  signal?.throwIfAborted()
  await rename(staging, destination)
  return destination
}

async function copyDocuments(documents: DocumentRow[], destination: string, signal?: AbortSignal): Promise<Manifest['files']> {
  const files: Manifest['files'] = []
  await mkdir(join(destination, 'documents'), { recursive: true })
  for (const document of documents) {
    const source = await safeDirectory(document.storage_path)
    const target = join(destination, 'documents', document.id)
    await mkdir(target, { recursive: true })
    const pending = [{ from: source, to: target, prefix: 'documents/' + document.id }]
    while (pending.length) {
      signal?.throwIfAborted()
      const entry = pending.pop()!
      for (const child of await readdir(entry.from, { withFileTypes: true })) {
        const path = entry.prefix + '/' + child.name
        validateRelativePath(path)
        const from = join(entry.from, child.name), to = join(entry.to, child.name)
        const details = await lstat(from)
        if (details.isSymbolicLink()) throw new Error('文档库含符号链接，无法安全复制。')
        if (details.isDirectory()) {
          await mkdir(to)
          pending.push({ from, to, prefix: path })
        } else if (details.isFile()) {
          const expected = await fingerprint(from, signal)
          await requireSpace(destination, expected.bytes)
          await checkedCopy(from, to, { path, ...expected }, signal)
          files.push({ path, ...expected })
        } else throw new Error('文档库包含不支持的文件类型。')
      }
    }
  }
  return files
}

export async function verifyBackup(directory: string, signal?: AbortSignal): Promise<Manifest> {
  const root = await safeDirectory(directory)
  const manifestPath = await safeFile(root, 'manifest.json')
  if ((await lstat(manifestPath)).size > 64 * 1024 * 1024) throw new Error('备份清单过大。')
  const manifest = manifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')))
  if (new Set(manifest.documents).size !== manifest.documents.length) throw new Error('备份文档标识重复。')
  const seen = new Set<string>()
  for (const item of manifest.files) {
    validateRelativePath(item.path)
    const key = item.path.toLowerCase()
    if (seen.has(key)) throw new Error('备份文件路径重复。')
    seen.add(key)
    if (item.path !== 'library.sqlite3' &&
      !manifest.documents.some((id) => item.path.startsWith('documents/' + id + '/'))) throw new Error('备份文件不属于文档库。')
    const file = await safeFile(root, item.path)
    const actual = await fingerprint(file, signal)
    if (actual.bytes !== item.bytes || actual.sha256 !== item.sha256) throw new Error('备份文件校验失败：' + item.path)
  }
  if (!seen.has('library.sqlite3')) throw new Error('备份缺少数据库。')
  for (const id of manifest.documents) {
    if (!seen.has(('documents/' + id + '/original.pdf').toLowerCase())) throw new Error('备份缺少原始 PDF。')
  }
  // Reject additional files, including unlisted symlinks and unchecked document content.
  const pending = [root]
  while (pending.length) {
    const current = pending.pop()!
    for (const name of await readdir(current)) {
      const path = join(current, name), info = await lstat(path)
      if (info.isSymbolicLink()) throw new Error('备份中不允许符号链接。')
      if (info.isDirectory()) pending.push(path)
      else if (!info.isFile() || (path !== manifestPath && !seen.has(relative(root, path).split(sep).join('/').toLowerCase()))) {
        throw new Error('备份含清单之外的文件。')
      }
    }
  }
  return manifest
}

function validateIncomingDatabase(current: DatabaseSync, path: string, manifest: Manifest): void {
  const incoming = new DatabaseSync(path, { readOnly: true })
  try {
    incoming.exec('PRAGMA trusted_schema=OFF')
    const integrity = incoming.prepare('PRAGMA integrity_check').all()
    if (integrity.length !== 1 || Object.values(integrity[0]!)[0] !== 'ok') throw new Error('备份数据库完整性检查失败。')
    const migrations = (db: DatabaseSync): string => JSON.stringify(db.prepare('SELECT version,name,checksum FROM schema_migrations ORDER BY version').all())
    if (migrations(incoming) !== migrations(current)) throw new Error('备份数据库版本与当前应用不兼容，请使用匹配的应用版本恢复。')
    const schema = (db: DatabaseSync): string => JSON.stringify(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all())
    if (schema(incoming) !== schema(current)) throw new Error('备份数据库结构不匹配。')
    if (incoming.prepare('PRAGMA foreign_key_check').all().length) throw new Error('备份数据库关联数据损坏。')
    const ids = (incoming.prepare('SELECT id FROM documents ORDER BY id').all() as Array<{ id: string }>).map((row) => row.id)
    if (JSON.stringify(ids) !== JSON.stringify([...manifest.documents].sort())) throw new Error('备份清单与数据库文档不一致。')
    if (incoming.prepare('SELECT id FROM jobs WHERE ' + ACTIVE + ' LIMIT 1').get()) throw new Error('备份包含未完成的活动任务，不能直接恢复。')
    for (const row of incoming.prepare('SELECT relative_path FROM artifacts').all() as Array<{ relative_path: string }>) validateRelativePath(row.relative_path)
  } finally { incoming.close() }
}

function replaceDatabaseContents(database: V2Database, source: string, ids: string[], target: string, outputRoot: string): void {
  const db = database.connection
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='schema_migrations' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name)
  if (tables.some((name) => !/^[a-z_]+$/u.test(name))) throw new Error('数据库表名称异常。')
  db.prepare('ATTACH DATABASE ? AS library_restore').run(source)
  db.exec('PRAGMA foreign_keys=OFF')
  try {
    database.transaction(() => {
      for (const name of tables) db.exec('DELETE FROM main."' + name + '"')
      for (const name of tables) db.exec('INSERT INTO main."' + name + '" SELECT * FROM library_restore."' + name + '"')
      for (const id of ids) db.prepare('UPDATE documents SET storage_path=? WHERE id=?').run(join(target, id), id)
      saveOutputRoot(db, outputRoot)
      if (db.prepare('PRAGMA main.foreign_key_check').all().length) throw new Error('恢复后的数据关联校验失败。')
    })
  } finally {
    db.exec('PRAGMA foreign_keys=ON')
    db.exec('DETACH DATABASE library_restore')
  }
}
function saveOutputRoot(db: DatabaseSync, outputRoot: string): void {
  db.prepare("INSERT INTO settings(key,value) VALUES('outputRoot',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(outputRoot))
}
function inside(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || (!path.startsWith('..' + sep) && path !== '..' && !isAbsolute(path))
}
function validateRelativePath(value: string): void {
  if (isAbsolute(value) || value.includes('\\') || (value.includes(':') || [...value].some((character) => character.charCodeAt(0) < 32)) ||
    value.split('/').some((part) => !part || part === '.' || part === '..' || /[. ]$/u.test(part))) {
    throw new Error('备份含不安全的相对路径。')
  }
}
async function safeDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error('目录必须为绝对路径。')
  let candidate = resolve(path)
  while (true) {
    const info = await lstat(candidate)
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('目录不能包含符号链接。')
    const parent = dirname(candidate)
    if (parent === candidate) break
    candidate = parent
  }
  return realpath(path)
}
async function safeFile(root: string, path: string): Promise<string> {
  validateRelativePath(path)
  const file = join(root, ...path.split('/'))
  if (!inside(root, file)) throw new Error('文件超出备份目录。')
  const parent = await safeDirectory(dirname(file))
  if (!inside(root, parent)) throw new Error('文件超出备份目录。')
  const details = await lstat(file)
  if (!details.isFile() || details.isSymbolicLink()) throw new Error('备份文件类型无效。')
  return file
}
async function fingerprint(path: string, signal?: AbortSignal): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(path)) {
    signal?.throwIfAborted()
    bytes += chunk.length
    hash.update(chunk)
  }
  return { bytes, sha256: hash.digest('hex') }
}
async function checkedCopy(source: string, destination: string, expected: Manifest['files'][number], signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  if ((await lstat(source)).isSymbolicLink()) throw new Error('不能复制符号链接。')
  await copyFile(source, destination, constants.COPYFILE_EXCL)
  await syncFile(destination)
  const actual = await fingerprint(destination, signal)
  if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) throw new Error('文件复制后校验失败：' + basename(source))
}
async function syncFile(path: string): Promise<void> {
  const file = await open(path, 'r+')
  try { await file.sync() } finally { await file.close() }
}
async function requireSpace(path: string, bytes: number): Promise<void> {
  const info = await statfs(path)
  if (info.bavail * info.bsize < bytes + 32 * 1024 * 1024) throw new Error('目标磁盘剩余空间不足，请至少预留 32 MiB。')
}

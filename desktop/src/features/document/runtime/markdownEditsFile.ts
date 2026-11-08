import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { MARKDOWN_EDITS_FILE, MARKDOWN_EDITS_MAX_BYTES, emptyMarkdownEdits, markdownEditsFileSchema, type MarkdownEditsFile } from '../contract/markdownEdits'
import { PathPolicy } from '@platform/files/runtime/pathPolicy'

const policy = new PathPolicy()
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT'

/** A missing file means no edits. An unreadable or foreign one is an error and is never replaced. */
export async function readMarkdownEditsFile(root: string, documentId: string): Promise<MarkdownEditsFile> {
  const path = policy.resolveChild(root, MARKDOWN_EDITS_FILE)
  let info
  try { info = await lstat(join(root, MARKDOWN_EDITS_FILE)) } catch (error) { if (missing(error)) return emptyMarkdownEdits(documentId); throw error }
  if (!info.isFile() || info.isSymbolicLink() || info.size > MARKDOWN_EDITS_MAX_BYTES) throw new Error('段落修改文件无效或过大')
  const handle = await open(path, 'r')
  let file: MarkdownEditsFile
  try { file = markdownEditsFileSchema.parse(JSON.parse(await handle.readFile('utf8'))) } finally { await handle.close() }
  if (file.documentId !== documentId) throw new Error('段落修改文件不属于当前论文')
  return file
}

/** Temporary file, fsync, then rename; a failure leaves the previous file in place. */
export async function writeMarkdownEditsFile(root: string, file: MarkdownEditsFile): Promise<void> {
  const value = markdownEditsFileSchema.parse(file)
  const body = JSON.stringify(value)
  if (Buffer.byteLength(body) > MARKDOWN_EDITS_MAX_BYTES) throw new Error('段落修改超过保存上限')
  const directory = policy.resolveChild(root, 'edits')
  try {
    const info = await lstat(join(root, 'edits'))
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('段落修改目录无效')
  } catch (error) { if (!missing(error)) throw error; await mkdir(directory) }
  const target = policy.resolveChild(root, MARKDOWN_EDITS_FILE)
  try { if ((await lstat(join(root, MARKDOWN_EDITS_FILE))).isSymbolicLink()) throw new Error('段落修改文件不能是符号链接') } catch (error) { if (!missing(error)) throw error }
  const temporary = policy.resolveChild(root, `edits/.pending-${randomUUID()}`)
  try {
    const handle = await open(temporary, 'wx')
    try { await handle.writeFile(body, 'utf8'); await handle.sync() } finally { await handle.close() }
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, target); break } catch (error) {
        if (attempt >= 6 || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
        await delay(100 * 2 ** attempt)
      }
    }
  } finally { await unlink(temporary).catch(() => undefined) }
}

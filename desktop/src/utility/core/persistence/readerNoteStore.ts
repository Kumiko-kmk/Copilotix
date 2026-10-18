import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { READER_NOTES_MAX, READER_NOTES_MAX_BYTES, readerNoteSchema, type ReaderNote, type ReaderNotes } from '@shared/readerNotes'
import { PathPolicy } from '@runtime/pathPolicy'

const FILE = 'notes.v1.json'
const notesFileSchema = z.object({ version: z.literal(1), documentId: z.string(), notes: z.array(readerNoteSchema).max(READER_NOTES_MAX) }).strict()
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT'

/**
 * Reader sticky notes, one atomic file per paper. Called only on the Utility data lane, so the
 * read-modify-write of an upsert or delete is never interleaved with another one.
 */
export class ReaderNoteStore {
  private readonly policy = new PathPolicy()
  constructor(private readonly directory: (documentId: string) => string | null) {}

  private async root(documentId: string, create = false): Promise<string> {
    const document = this.directory(documentId)
    if (!document) throw new Error('论文不存在，无法读取或保存笔记')
    const documentStat = await lstat(document)
    if (!documentStat.isDirectory() || documentStat.isSymbolicLink()) throw new Error('文献目录无效')
    const root = this.policy.resolveChild(document, 'notes')
    try {
      const details = await lstat(root)
      if (!details.isDirectory() || details.isSymbolicLink()) throw new Error('笔记目录无效')
    } catch (error) {
      if (!missing(error)) throw error
      if (create) await mkdir(root)
    }
    return root
  }

  async list(documentId: string): Promise<ReaderNotes> {
    let path: string
    let details
    try {
      path = this.policy.resolveChild(await this.root(documentId), FILE)
      details = await lstat(path)
    } catch (error) { if (missing(error)) return { notes: [] }; throw error }
    if (!details.isFile() || details.isSymbolicLink() || details.size > READER_NOTES_MAX_BYTES) throw new Error('笔记文件无效或超过大小限制')
    const handle = await open(path, 'r')
    let raw: unknown
    try { raw = JSON.parse(await handle.readFile('utf8')) } finally { await handle.close() }
    const record = notesFileSchema.parse(raw)
    if (record.documentId !== documentId) throw new Error('笔记文件不属于当前论文')
    return { notes: record.notes }
  }

  async upsert(documentId: string, raw: ReaderNote): Promise<ReaderNotes> {
    const note = readerNoteSchema.parse(raw)
    const { notes } = await this.list(documentId)
    const index = notes.findIndex((item) => item.id === note.id)
    if (index >= 0 && notes[index]!.view !== note.view) throw new Error('笔记视图不可更改')
    const next = index >= 0 ? notes.map((item, i) => i === index ? { ...note, createdAt: item.createdAt } : item) : [...notes, note]
    if (next.length > READER_NOTES_MAX) throw new Error(`每篇论文最多 ${READER_NOTES_MAX} 条笔记`)
    await this.write(documentId, next)
    return { notes: next }
  }

  async delete(documentId: string, noteId: string): Promise<ReaderNotes> {
    const { notes } = await this.list(documentId)
    const next = notes.filter((note) => note.id !== noteId)
    if (next.length !== notes.length) await this.write(documentId, next)
    return { notes: next }
  }

  private async write(documentId: string, notes: ReaderNote[]): Promise<void> {
    const content = JSON.stringify({ version: 1, documentId, notes })
    if (Buffer.byteLength(content, 'utf8') > READER_NOTES_MAX_BYTES) throw new Error('笔记总量超过大小限制')
    const root = await this.root(documentId, true)
    const target = this.policy.resolveChild(root, FILE)
    try { if ((await lstat(join(root, FILE))).isSymbolicLink()) throw new Error('笔记文件不能是符号链接') } catch (error) { if (!missing(error)) throw error }
    const temporary = this.policy.resolveChild(root, `.pending-${randomUUID()}`)
    const handle = await open(temporary, 'wx')
    try {
      await handle.writeFile(content, 'utf8')
      await handle.sync()
    } finally { await handle.close() }
    try { await rename(temporary, target) } finally { await unlink(temporary).catch(() => undefined) }
  }
}

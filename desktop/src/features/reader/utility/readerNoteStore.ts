import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { READER_NOTES_MAX, READER_NOTES_MAX_BYTES, readerNoteSchema, type ReaderNote, type ReaderNotes } from '../contract/readerNotes'
import { PathPolicy } from '@platform/files/runtime/pathPolicy'

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
    if (!document) throw new Error('論文不存在，無法讀取或儲存筆記')
    const documentStat = await lstat(document)
    if (!documentStat.isDirectory() || documentStat.isSymbolicLink()) throw new Error('文獻目錄無效')
    const root = this.policy.resolveChild(document, 'notes')
    try {
      const details = await lstat(root)
      if (!details.isDirectory() || details.isSymbolicLink()) throw new Error('筆記目錄無效')
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
    if (!details.isFile() || details.isSymbolicLink() || details.size > READER_NOTES_MAX_BYTES) throw new Error('筆記檔案無效或超過大小限制')
    const handle = await open(path, 'r')
    let raw: unknown
    try { raw = JSON.parse(await handle.readFile('utf8')) } finally { await handle.close() }
    const record = notesFileSchema.parse(raw)
    if (record.documentId !== documentId) throw new Error('筆記檔案不屬於當前論文')
    return { notes: record.notes }
  }

  async upsert(documentId: string, raw: ReaderNote): Promise<ReaderNotes> {
    const note = readerNoteSchema.parse(raw)
    const { notes } = await this.list(documentId)
    const index = notes.findIndex((item) => item.id === note.id)
    if (index >= 0 && notes[index]!.view !== note.view) throw new Error('筆記檢視不可更改')
    const next = index >= 0 ? notes.map((item, i) => i === index ? { ...note, createdAt: item.createdAt } : item) : [...notes, note]
    if (next.length > READER_NOTES_MAX) throw new Error(`每篇論文最多 ${READER_NOTES_MAX} 條筆記`)
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
    if (Buffer.byteLength(content, 'utf8') > READER_NOTES_MAX_BYTES) throw new Error('筆記總量超過大小限制')
    const root = await this.root(documentId, true)
    const target = this.policy.resolveChild(root, FILE)
    try { if ((await lstat(join(root, FILE))).isSymbolicLink()) throw new Error('筆記檔案不能是符號連結') } catch (error) { if (!missing(error)) throw error }
    const temporary = this.policy.resolveChild(root, `.pending-${randomUUID()}`)
    const handle = await open(temporary, 'wx')
    try {
      await handle.writeFile(content, 'utf8')
      await handle.sync()
    } finally { await handle.close() }
    try { await rename(temporary, target) } finally { await unlink(temporary).catch(() => undefined) }
  }
}

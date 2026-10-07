import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { ragWireByteLength } from '@shared/ragSchemas'
import { PAPER_CHAT_MAX_BYTES } from '@shared/paperChatSchemas'
import { emptyPaperChatSession, paperChatCursorSchema, paperChatSessionSchema, paperChatTurnSchema, type PaperChatPage, type PaperChatSession, type StoredPaperChatTurn } from '@shared/paperChatStorageSchemas'
import { PathPolicy } from './pathPolicy'

const turnFileSchema = z.object({ version: z.literal(1), documentId: z.string(), turn: paperChatTurnSchema }).strict()
const sessionFileSchema = z.object({ version: z.literal(1), documentId: z.string(), session: paperChatSessionSchema }).strict()
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT'

/** Called only on the Utility data lane; each turn is an atomic, bounded file. */
export class PaperChatStore {
  private readonly policy = new PathPolicy()
  constructor(private readonly directory: (documentId: string) => string | null) {}

  private async root(documentId: string, create = false): Promise<string> {
    const document = this.directory(documentId)
    if (!document) throw new Error('论文不存在，无法读取或保存对话')
    const documentStat = await lstat(document)
    if (!documentStat.isDirectory() || documentStat.isSymbolicLink()) throw new Error('文献目录无效')
    const root = this.policy.resolveChild(document, 'chat')
    try {
      const details = await lstat(join(document, 'chat'))
      if (!details.isDirectory() || details.isSymbolicLink()) throw new Error('对话目录无效')
    } catch (error) {
      if (!missing(error)) throw error
      if (create) await mkdir(root)
    }
    return root
  }

  private async read(path: string): Promise<unknown> {
    const details = await lstat(path)
    if (!details.isFile() || details.isSymbolicLink() || details.size > PAPER_CHAT_MAX_BYTES) throw new Error('对话文件无效或超过大小限制')
    const handle = await open(path, 'r')
    try { return JSON.parse(await handle.readFile('utf8')) as unknown } finally { await handle.close() }
  }

  private async write(documentId: string, name: string, value: unknown): Promise<void> {
    const root = await this.root(documentId, true)
    const target = this.policy.resolveChild(root, name)
    try { if ((await lstat(join(root, name))).isSymbolicLink()) throw new Error('对话文件不能是符号链接') } catch (error) { if (!missing(error)) throw error }
    const temporary = this.policy.resolveChild(root, `.pending-${randomUUID()}`)
    const handle = await open(temporary, 'wx')
    try {
      await handle.writeFile(JSON.stringify(value), 'utf8')
      await handle.sync()
    } finally { await handle.close() }
    try { await rename(temporary, target) } finally { await unlink(temporary).catch(() => undefined) }
  }

  async saveTurn(documentId: string, raw: StoredPaperChatTurn): Promise<{ saved: true }> {
    const turn = paperChatTurnSchema.parse(raw)
    for (const [id, citation] of Object.entries(turn.citations)) {
      if (citation.documentId !== documentId || citation.locator.documentId !== documentId || citation.evidenceId !== id) throw new Error('对话引用不属于当前论文')
    }
    const name = `${String(Date.parse(turn.createdAt)).padStart(13, '0')}-${turn.id}.json`
    paperChatCursorSchema.parse(name)
    await this.write(documentId, name, { version: 1, documentId, turn })
    return { saved: true }
  }

  async load(documentId: string, before?: string): Promise<PaperChatPage> {
    const root = await this.root(documentId)
    let names: string[]
    try { names = (await readdir(root)).filter((name) => paperChatCursorSchema.safeParse(name).success && (!before || name < before)).sort().reverse() }
    catch (error) { if (missing(error)) return { turns: [], next: null }; throw error }
    const turns: StoredPaperChatTurn[] = []
    let bytes = 128
    let next: string | null = null
    for (const name of names) {
      this.policy.resolveChild(root, name)
      const record = turnFileSchema.parse(await this.read(join(root, name)))
      if (record.documentId !== documentId) throw new Error('对话文件不属于当前论文')
      for (const [id, citation] of Object.entries(record.turn.citations)) {
        if (citation.documentId !== documentId || citation.locator.documentId !== documentId || citation.evidenceId !== id) throw new Error('对话引用无效')
      }
      const turn = record.turn.status === 'pending' ? { ...record.turn, status: 'cancelled' as const } : record.turn
      const size = ragWireByteLength(turn) + 1
      if (turns.length >= 20 || bytes + size > PAPER_CHAT_MAX_BYTES - 256) break
      turns.unshift(turn); bytes += size; next = name
    }
    return { turns, next: names.length > turns.length ? next : null }
  }

  async session(documentId: string): Promise<PaperChatSession> {
    const root = await this.root(documentId)
    try {
      this.policy.resolveChild(root, 'session.json')
      const record = sessionFileSchema.parse(await this.read(join(root, 'session.json')))
      if (record.documentId !== documentId) throw new Error('对话草稿不属于当前论文')
      return record.session
    } catch (error) { if (missing(error)) return emptyPaperChatSession(); throw error }
  }

  async saveSession(documentId: string, raw: PaperChatSession): Promise<{ saved: true }> {
    const session = paperChatSessionSchema.parse(raw)
    await this.write(documentId, 'session.json', { version: 1, documentId, session })
    return { saved: true }
  }

  async clear(documentId: string): Promise<{ cleared: true }> {
    const root = await this.root(documentId)
    let names: string[]
    try { names = await readdir(root) } catch (error) { if (missing(error)) return { cleared: true }; throw error }
    // Remove only our recognized turn files. Keep drafts and all paper artifacts.
    for (const name of names) if (paperChatCursorSchema.safeParse(name).success) {
      const path = this.policy.resolveChild(root, name)
      if ((await lstat(join(root, name))).isSymbolicLink()) throw new Error('对话文件不能是符号链接')
      await unlink(path)
    }
    return { cleared: true }
  }
}

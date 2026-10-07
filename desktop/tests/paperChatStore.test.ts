import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PAPER_CHAT_MAX_BYTES } from '@shared/paperChatSchemas'
import { emptyPaperChatSession, paperChatPageSchema, type StoredPaperChatTurn } from '@shared/paperChatStorageSchemas'
import { PaperChatStore } from '../src/utility/core/persistence/paperChatStore'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'copilotix-chat-store-')); roots.push(root)
  const ids = [randomUUID(), randomUUID()]
  for (const id of ids) await mkdir(join(root, id))
  const store = () => new PaperChatStore((id) => ids.includes(id) ? join(root, id) : null)
  const turn = (index = 0): StoredPaperChatTurn => ({ id: randomUUID(), createdAt: new Date(1_790_000_000_000 + index).toISOString(), provider: 'deepseek', model: 'deepseek-flash', question: `问题 ${index}`, answer: `回答 ${index}`, citations: {}, status: 'completed' })
  return { root, doc: ids[0]!, other: ids[1]!, store, turn }
}

describe('paper-local chat storage', () => {
  it('reopens full text, verified citations and session from disk, keeping papers isolated', async () => {
    const f = await fixture(), first = f.store()
    const turn = f.turn()
    turn.answer = '完整回答 😀 $x^2$ [E1]'
    turn.citations.E1 = { citationId: randomUUID(), evidenceId: 'E1', documentId: f.doc, chunkId: 'chunk1', excerpt: '论文原文',
      locator: { documentId: f.doc, artifactId: randomUUID(), contentRevisionId: 'revision1', contentHash: 'a'.repeat(64), mappingIds: ['m1'], pageStart: 0, pageEnd: 0, sourceStartOffset: 0, sourceEndOffset: 4, offsetUnit: 'utf16' }, scoreProvenance: [{ source: 'full-text', rank: 1, score: 1 }] }
    await first.saveTurn(f.doc, turn)
    const session = { ...emptyPaperChatSession(), draft: '下一個問題', selectedModel: { provider: 'deepseek' as const, model: 'deepseek-v4-pro', custom: false }, pinned: [{ view: 'original' as const, text: '论文原文', contentRevisionId: 'revision1', fragments: [{ mappingIds: ['m1'], quote: '论文原文', startOffset: 0, endOffset: 4 }] }] }
    await first.saveSession(f.doc, session)
    expect(await f.store().load(f.doc)).toEqual({ turns: [turn], next: null })
    expect(await f.store().session(f.doc)).toEqual(session)
    expect(await f.store().load(f.other)).toEqual({ turns: [], next: null })
    expect(await f.store().session(f.other)).toEqual(emptyPaperChatSession())
    const files = await readdir(join(f.root, f.doc, 'chat'))
    expect(files).toHaveLength(2); expect(files.some((name) => name.startsWith('.pending-'))).toBe(false)
    expect(await readFile(join(f.root, f.doc, 'chat', files.find((name) => name !== 'session.json')!), 'utf8')).not.toMatch(/api.?key|secret|Authorization/iu)
  })
  it('paginates more than 12 turns without trimming persisted history or exceeding the wire budget', async () => {
    const f = await fixture(), store = f.store()
    const original = Array.from({ length: 45 }, (_, i) => ({ ...f.turn(i), answer: '文'.repeat(32_768) }))
    for (const turn of original) await store.saveTurn(f.doc, turn)
    let before: string | undefined
    let restored: StoredPaperChatTurn[] = []
    do {
      const page = paperChatPageSchema.parse(await store.load(f.doc, before))
      expect(page.turns.length).toBeLessThanOrEqual(20)
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(PAPER_CHAT_MAX_BYTES)
      restored = [...page.turns, ...restored]; before = page.next ?? undefined
    } while (before)
    expect(restored).toEqual(original)
    expect(await readdir(join(f.root, f.doc, 'chat'))).toHaveLength(45)
  })
  it('recovers interrupted output as cancelled and clears only the current paper turns', async () => {
    const f = await fixture(), store = f.store(), turn = { ...f.turn(), status: 'pending' as const, answer: '中斷前文字' }
    await store.saveTurn(f.doc, turn); await store.saveTurn(f.other, f.turn())
    await store.saveSession(f.doc, { ...emptyPaperChatSession(), draft: '保留草稿' })
    await writeFile(join(f.root, f.doc, 'original.pdf'), 'source')
    await writeFile(join(f.root, f.doc, 'chat', 'user-notes.txt'), 'notes')
    expect((await f.store().load(f.doc)).turns[0]).toMatchObject({ answer: '中斷前文字', status: 'cancelled' })
    await store.clear(f.doc)
    expect((await store.load(f.doc)).turns).toEqual([])
    expect((await store.load(f.other)).turns).toHaveLength(1)
    expect((await store.session(f.doc)).draft).toBe('保留草稿')
    expect(await readFile(join(f.root, f.doc, 'original.pdf'), 'utf8')).toBe('source')
    expect(await readFile(join(f.root, f.doc, 'chat', 'user-notes.txt'), 'utf8')).toBe('notes')
    expect(await store.clear(f.other)).toEqual({ cleared: true })
    await expect(store.load(randomUUID())).rejects.toThrow('论文不存在')
  })
  it('preserves a corrupt file for recovery, rejects unknown fields and refuses a linked chat directory', async () => {
    const f = await fixture(), store = f.store()
    await expect(store.saveSession(f.doc, { ...emptyPaperChatSession(), key: 'secret' } as never)).rejects.toThrow()
    await store.saveTurn(f.doc, f.turn())
    const root = join(f.root, f.doc, 'chat'), name = (await readdir(root))[0]!
    await writeFile(join(root, name), 'invalid JSON')
    await expect(store.load(f.doc)).rejects.toThrow()
    expect(await readFile(join(root, name), 'utf8')).toBe('invalid JSON')
    const outside = join(f.root, 'outside'); await mkdir(outside)
    await symlink(outside, join(f.root, f.other, 'chat'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(store.saveTurn(f.other, f.turn())).rejects.toThrow()
    expect(await readdir(outside)).toEqual([])
  })
})

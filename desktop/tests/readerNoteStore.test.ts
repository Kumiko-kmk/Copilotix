import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ReaderNote } from '@shared/readerNotes'
import { ReaderNoteStore } from '../src/utility/core/persistence/readerNoteStore'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'copilotix-note-store-')); roots.push(root)
  const ids: string[] = [randomUUID(), randomUUID()]
  for (const id of ids) await mkdir(join(root, id))
  const store = () => new ReaderNoteStore((id) => ids.includes(id) ? join(root, id) : null)
  const note = (body = '这段的推导值得再看'): ReaderNote => ({
    id: randomUUID(), view: 'translated', body, createdAt: '2026-10-17T08:00:00.000Z', updatedAt: '2026-10-17T08:00:00.000Z',
    anchors: [{ blockKey: 'translated:m1', startOffset: 2, endOffset: 8, quote: '能量守恒定律', prefix: '根据', suffix: '可得' }]
  })
  return { root, doc: ids[0]!, other: ids[1]!, store, note }
}

describe('reader sticky note storage', () => {
  it('keeps notes per paper across reopening, edits in place and deletes atomically', async () => {
    const f = await fixture()
    expect(await f.store().list(f.doc)).toEqual({ notes: [] })
    const first = f.note(), second = f.note('第二条 😀')
    await f.store().upsert(f.doc, first)
    await f.store().upsert(f.doc, second)
    const edited = { ...first, body: '改过的笔记', createdAt: '2030-01-01T00:00:00.000Z', updatedAt: '2026-10-17T09:00:00.000Z' }
    expect((await f.store().upsert(f.doc, edited)).notes).toEqual([{ ...edited, createdAt: first.createdAt }, second])
    expect((await new ReaderNoteStore(() => join(f.root, f.doc)).list(f.doc)).notes.map(note => note.body)).toEqual(['改过的笔记', '第二条 😀'])
    expect(await f.store().list(f.other)).toEqual({ notes: [] })
    await expect(f.store().upsert(f.doc, { ...first, view: 'original' })).rejects.toThrow('笔记视图不可更改')
    expect((await f.store().delete(f.doc, first.id)).notes).toEqual([second])
    expect((await readdir(join(f.root, f.doc, 'notes'))).filter(name => name.startsWith('.pending-'))).toEqual([])
    expect(JSON.parse(await readFile(join(f.root, f.doc, 'notes', 'notes.v1.json'), 'utf8'))).toMatchObject({ version: 1, documentId: f.doc, notes: [second] })
  })

  it('rejects empty notes, files of another paper, symbolic links and unknown papers', async () => {
    const f = await fixture()
    await expect(f.store().upsert(f.doc, f.note('   '))).rejects.toThrow()
    await f.store().upsert(f.other, f.note())
    await mkdir(join(f.root, f.doc, 'notes'))
    await writeFile(join(f.root, f.doc, 'notes', 'notes.v1.json'), await readFile(join(f.root, f.other, 'notes', 'notes.v1.json')))
    await expect(f.store().list(f.doc)).rejects.toThrow('笔记文件不属于当前论文')
    await expect(f.store().list(randomUUID())).rejects.toThrow('论文不存在')
    await rm(join(f.root, f.doc, 'notes'), { recursive: true })
    try { await symlink(join(f.root, f.other, 'notes'), join(f.root, f.doc, 'notes'), 'junction') } catch { return }
    await expect(f.store().list(f.doc)).rejects.toThrow()
  })
})

import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { DocumentModelStore } from '@features/document/utility'
import { getSnapshot, resolveAnchor, resolveTranslations } from '@features/document/core'
import { emptyMarkdownEdits } from '@features/document/contract/markdownEdits'
import { documentContextChunks } from '../../../src/features/chat/utility/documentContextChunks'
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
async function fixture(markdown = "# 中 English\n\nFirst $x^2$ paragraph.\n\nSecond paragraph.\n") {
  const root = await mkdtemp(join(tmpdir(), 'document-model-'))
  await writeFile(join(root, 'full.md'), markdown)
  await writeFile(join(root, 'block_list.json'), JSON.stringify({ version: 1, mappings: [] }))
  return { root, documentId: randomUUID() }
}
describe('canonical document model', () => {
  it('builds on demand, reuses across restarts and edits, and rebuilds corrupt/partial cache', async () => {
    const { root, documentId } = await fixture()
    const store = new DocumentModelStore()
    const [base, concurrent] = await Promise.all([store.ensureBase(documentId, root), store.ensureBase(documentId, root)])
    expect(base).toBe(concurrent)
    expect(store.builds).toBe(1)
    const restart = new DocumentModelStore()
    expect(await restart.ensureBase(documentId, root)).toEqual(base)
    expect(restart.builds).toBe(0)
    await mkdir(join(root, 'edits'))
    await writeFile(join(root, 'edits', 'markdown-edits.v1.json'), JSON.stringify(emptyMarkdownEdits(documentId)))
    expect((await store.ensureBase(documentId, root)).sourceVersion).toBe(base.sourceVersion)
    await writeFile(join(root, 'model', 'base.v1.json'), '{broken')
    await writeFile(join(root, 'model', 'base.v1.crash.partial'), '{unfinished')
    const rebuilt = new DocumentModelStore()
    expect(await rebuilt.ensureBase(documentId, root)).toEqual(base)
    expect(rebuilt.builds).toBe(1)
    expect(JSON.parse(await readFile(join(root, 'model', 'base.v1.json'), 'utf8')).digest).toBe(hash(JSON.stringify(base)))
  })
  it('projects the same edits, deletions and order into reading, export and chat without rebuilding', async () => {
    const { root, documentId } = await fixture()
    const store = new DocumentModelStore(), base = await store.ensureBase(documentId, root)
    const file = { ...emptyMarkdownEdits(documentId), revision: 1, blocks: [{ index: 1, mappingIds: [], baseHash: hash(base.content[1]!.markdown), sourceVersion: base.sourceVersion, original: { markdown: '用户修订 $x^3$', editedAt: new Date().toISOString() } }, { index: 2, mappingIds: [], baseHash: hash(base.content[2]!.markdown), sourceVersion: base.sourceVersion, deletedAt: new Date().toISOString() }], order: { count: 3, sequence: [1, 0, 2], updatedAt: new Date().toISOString(), sourceVersion: base.sourceVersion } }
    const snapshot = getSnapshot(base, '', null, file, hash)
    const shown = snapshot.original.filter(b => b.role === 'content').map(b => b.source)
    expect(shown).toEqual(['用户修订 $x^3$', '# 中 English'])
    expect(snapshot.originalText).toBe("用户修订 $x^3$\n\n# 中 English\n")
    expect(documentContextChunks(snapshot, 'revision', []).map(c => c.sourceText)).toEqual(shown)
    expect(store.builds).toBe(1)
  })
  it('never guesses between duplicated paragraphs after reparse; orphan edits remain intact', async () => {
    const { root, documentId } = await fixture("Repeated.\n\nRepeated.\n")
    const store = new DocumentModelStore(), base = await store.ensureBase(documentId, root)
    const file = { ...emptyMarkdownEdits(documentId), blocks: [{ index: 0, mappingIds: [], baseHash: hash(base.content[0]!.markdown), sourceVersion: base.sourceVersion, original: { markdown: 'my edit', editedAt: new Date().toISOString() } }] }
    await writeFile(join(root, 'full.md'), "Inserted.\n\nRepeated.\n\nRepeated.\n")
    const next = await store.ensureBase(documentId, root)
    const snapshot = getSnapshot(next, '', null, file, hash)
    expect(snapshot.edits?.orphans).toBe(1)
    expect(file.blocks[0]!.original.markdown).toBe('my edit')
    expect(resolveAnchor(next, { documentId, sourceVersion: base.sourceVersion, blockId: base.blocks[0]!.id, contentHash: hash(base.blocks[0]!.markdown) }, hash).status).toBe('unmatched')
  })
  it('invalidates when mappings change without a count or text change', async () => {
    const { root, documentId } = await fixture()
    const store = new DocumentModelStore(), first = await store.ensureBase(documentId, root)
    await writeFile(join(root, 'block_list.json'), JSON.stringify({ version: 2, mappings: [] }))
    const second = await store.ensureBase(documentId, root)
    expect(second.sourceVersion).not.toBe(first.sourceVersion)
    expect(store.builds).toBe(2)
  })
})

it('remaps retranslated content only by a unique hash across source versions', async () => {
  const { root, documentId } = await fixture('Alpha.\n\nBeta.\n')
  const store = new DocumentModelStore(), first = await store.ensureBase(documentId, root)
  const translated = first.content.map((block, sourceIndex) => ({ markdown: '译 ' + block.markdown, sourceIndex, sourceVersion: first.sourceVersion, sourceHash: hash(block.markdown), mappingIds: [] }))
  await writeFile(join(root, 'full.md'), 'Beta.\n\nAlpha.\n')
  const second = await store.ensureBase(documentId, root)
  expect(resolveTranslations(second, translated, hash)?.map(b => b.sourceIndex)).toEqual([1, 0])
  await writeFile(join(root, 'full.md'), 'Alpha.\n\nAlpha.\n')
  const ambiguous = await store.ensureBase(documentId, root)
  expect(resolveTranslations(ambiguous, translated, hash)?.every(b => b.unmatched && b.sourceIndex === undefined)).toBe(true)
  expect(translated.map(b => b.markdown)).toEqual(['译 Alpha.', '译 Beta.'])
})

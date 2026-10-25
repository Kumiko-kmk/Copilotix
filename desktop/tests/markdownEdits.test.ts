import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BLOCK_MAPPING_VERSION } from '@features/parsing/core/blockMapping'
import type { RagChunk } from '@core/types'
import type { BlockMapping, CopilotixTask } from '@shared/types'
import { MARKDOWN_EDITS_FILE, emptyMarkdownEdits, inReadingOrder, moveInOrder, optimisticEdits, resolveMarkdownEdits, validOrder, type MarkdownEditsFile } from '@shared/markdownEdits'
import { buildOriginalReaderBlocks, buildTranslatedReaderBlocks } from '@shared/readerDocument'
import { readMarkdownEditsFile } from '@runtime/markdownEditsFile'
import { resolveReaderEdits } from '../src/main/artifactService'
import { applyChunkEdits } from '../src/features/chat/utility/paperContextBuilder'
import { MarkdownEditStore } from '../src/utility/core/persistence/markdownEditStore'
import { MarkdownTranslationPlanManager } from '../src/features/translation/utility/markdownTranslationPlan'
import { V2Database } from '../src/platform/database/utility/v2Database'
import { V2TaskRepositoryCompat } from '../src/features/library/utility/v2TaskRepositoryCompat'
import { SqliteJobRepository } from '../src/platform/jobs/utility/sqliteJobRepository'

const DOC = '11111111-1111-4111-8111-111111111111'
const sha = (text: string): string => createHash('sha256').update(text).digest('hex')
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

const MARKDOWN = 'First paragraph about cracks.\n\nSecond paragraph about damage.\n\nJournal of Noise 12 (2026) 1-20\n'
const mapping = (id: string, order: number, text: string, type = 'text'): BlockMapping =>
  ({ id, order, type, sourceText: text, boxes: [{ pageIndex: 0, bbox: [0, order * 20, 100, order * 20 + 10], pageSize: [612, 792], blockPosition: String(order) }] })
const MAPPINGS = [mapping('m0', 0, 'First paragraph about cracks.'), mapping('m1', 1, 'Second paragraph about damage.'),
  mapping('m2', 2, 'Journal of Noise 12 (2026) 1-20'), mapping('h0', 3, 'Running header', 'header')]

async function paperDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'copilotix-edits-')); roots.push(root)
  await writeFile(join(root, 'full.md'), MARKDOWN)
  await writeFile(join(root, 'block_list.json'), JSON.stringify({ version: BLOCK_MAPPING_VERSION, mappings: MAPPINGS }))
  return root
}
const target = (index: number) => ({ kind: 'content' as const, index, mappingIds: [`m${index}`] })

describe('reader edit layer', () => {
  it('finds each edit again after a repair moves or rewrites its block, and never applies it to the wrong one', () => {
    const file: MarkdownEditsFile = { ...emptyMarkdownEdits(DOC), blocks: [
      { index: 0, mappingIds: ['b'], baseHash: sha('old text'), original: { markdown: 'mine', editedAt: '2026-10-22T00:00:00.000Z' } },
      { index: 5, mappingIds: [], baseHash: sha('same text'), deletedAt: '2026-10-22T00:00:00.000Z' },
      { index: 1, mappingIds: ['gone'], baseHash: sha('missing'), deletedAt: '2026-10-22T00:00:00.000Z' }
    ] }
    const { byIndex, orphans } = resolveMarkdownEdits([{ markdown: 'a', mappingIds: ['a'] }, { markdown: 'repaired text', mappingIds: ['b'] }, { markdown: 'same text', mappingIds: [] }], file, sha)
    expect(byIndex.get(1)).toMatchObject({ original: { markdown: 'mine' }, baseChanged: true })
    expect(byIndex.get(2)).toMatchObject({ deletedAt: expect.any(String), baseChanged: false })
    expect(orphans.map(entry => entry.mappingIds)).toEqual([['gone']])
  })

  it('saves atomically with revisions, refuses stale or mismatched requests and never replaces an unreadable file', async () => {
    const root = await paperDir()
    const store = new MarkdownEditStore(() => root)
    await expect(store.apply({ documentId: DOC, expectedRevision: 0, target: target(1), action: 'set-original', markdown: 'Second paragraph, corrected.' })).resolves.toEqual({ revision: 1 })
    await expect(store.apply({ documentId: DOC, expectedRevision: 0, target: target(2), action: 'delete' })).rejects.toThrow('刷新')
    await expect(store.apply({ documentId: DOC, expectedRevision: 1, target: { ...target(2), mappingIds: ['m1'] }, action: 'delete' })).rejects.toThrow('位置已变化')
    await store.apply({ documentId: DOC, expectedRevision: 1, target: target(2), action: 'delete' })
    await store.apply({ documentId: DOC, expectedRevision: 2, target: { kind: 'supplemental', mappingId: 'h0' }, action: 'delete' })
    const saved = await readMarkdownEditsFile(root, DOC)
    expect(saved).toMatchObject({ revision: 3, supplementalDeleted: [{ mappingId: 'h0' }], blocks: [
      { index: 1, mappingIds: ['m1'], baseHash: sha('Second paragraph about damage.'), original: { markdown: 'Second paragraph, corrected.' } },
      { index: 2, deletedAt: expect.any(String) }] })
    expect((await readdir(join(root, 'edits'))).filter(name => name.startsWith('.pending'))).toEqual([])
    // Restoring and reverting leave no empty entries behind.
    await store.apply({ documentId: DOC, expectedRevision: 3, target: target(2), action: 'restore' })
    await store.apply({ documentId: DOC, expectedRevision: 4, target: target(1), action: 'revert-original' })
    expect((await readMarkdownEditsFile(root, DOC)).blocks).toEqual([])
    await writeFile(join(root, MARKDOWN_EDITS_FILE), '{broken')
    await expect(store.apply({ documentId: DOC, expectedRevision: 5, target: target(0), action: 'delete' })).rejects.toThrow()
    expect(await readFile(join(root, MARKDOWN_EDITS_FILE), 'utf8')).toBe('{broken')
  })

  it('shows edits in place: keys, mappings and page furniture stay; deleted blocks leave both views', async () => {
    const root = await paperDir()
    const store = new MarkdownEditStore(() => root)
    await store.apply({ documentId: DOC, expectedRevision: 0, target: target(1), action: 'set-original', markdown: 'Second paragraph, corrected.' })
    await store.apply({ documentId: DOC, expectedRevision: 1, target: target(2), action: 'delete' })
    await store.apply({ documentId: DOC, expectedRevision: 2, target: { kind: 'supplemental', mappingId: 'h0' }, action: 'delete' })
    const translated = ['第一段。', '第二段。', '期刊噪声。'].map((markdown, sourceIndex) => ({ sourceIndex, markdown, mappingIds: [`m${sourceIndex}`], sourceHash: sha(MARKDOWN.split('\n\n')[sourceIndex]!.trim()) }))
    const edits = resolveReaderEdits(MARKDOWN, MAPPINGS, translated, await readMarkdownEditsFile(root, DOC))
    expect(edits.blocks.find(block => block.index === 1)).toMatchObject({ stale: true, mappingIds: ['m1'], excerpt: 'Second paragraph, corrected.' })
    const original = buildOriginalReaderBlocks(MARKDOWN, MAPPINGS, edits).filter(block => block.role === 'content')
    expect(original.map(block => [block.annotationKey, block.markdown, block.mappingIds, block.edit?.edited ?? false])).toEqual([
      ['content:0', 'First paragraph about cracks.', ['m0'], false], ['content:1', 'Second paragraph, corrected.', ['m1'], true]])
    expect(buildOriginalReaderBlocks(MARKDOWN, MAPPINGS, edits).some(block => block.annotationKey === 'supplemental:h0')).toBe(false)
    const zh = buildTranslatedReaderBlocks(MARKDOWN, translated.map(block => block.markdown).join('\n\n'), translated, MAPPINGS, edits).filter(block => block.role === 'content')
    expect(zh.map(block => [block.markdown, block.edit?.stale ?? false])).toEqual([['第一段。', false], ['第二段。', true]])
  })

  it('translates edited originals, skips deleted blocks and clears the stale mark once retranslated', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilotix-edits-plan-')); roots.push(root)
    const outputDir = join(root, 'document'); await mkdir(outputDir)
    await writeFile(join(outputDir, 'full.md'), MARKDOWN)
    await writeFile(join(outputDir, 'block_list.json'), JSON.stringify({ version: BLOCK_MAPPING_VERSION, mappings: MAPPINGS }))
    const database = new V2Database(join(root, 'db.sqlite3'))
    const repository = new V2TaskRepositoryCompat(database)
    const now = '2026-10-22T00:00:00.000Z'
    const task: CopilotixTask = { id: DOC, originalName: 'paper.pdf', title: null, name: 'paper.pdf', sourcePath: join(outputDir, 'original.pdf'), sourceHash: 'h',
      outputDir, status: 'uploading', progress: 0, translationProvider: 'qwen', remoteBatchId: null, remoteDataId: null, remoteResultUrl: null, error: null, createdAt: now, updatedAt: now }
    repository.insertTask(task); repository.updateTask(DOC, { status: 'translating', progress: 0 })
    const jobId = (database.connection.prepare("SELECT id FROM jobs WHERE document_id=? AND kind='translate'").get(DOC) as { id: string }).id
    try {
      const store = new MarkdownEditStore(() => outputDir)
      await store.apply({ documentId: DOC, expectedRevision: 0, target: target(1), action: 'set-original', markdown: 'Second paragraph, corrected.' })
      await store.apply({ documentId: DOC, expectedRevision: 1, target: target(2), action: 'delete' })
      const manager = new MarkdownTranslationPlanManager(repository)
      expect((await manager.open(DOC, jobId)).sourceHash).not.toBe(sha(MARKDOWN))
      const work = (await manager.listWork(DOC, jobId)).items
      expect(work.map(item => item.status)).toEqual(['pending', 'pending', 'completed'])
      for (const item of work.filter(unit => unit.status === 'pending')) {
        const request = JSON.parse(await readFile(join(outputDir, ...item.requestPath.split('/')), 'utf8'))
        await writeFile(join(outputDir, ...item.responsePath.split('/')), JSON.stringify({ protocol: request.protocol, unitId: request.unitId, sourceHash: request.sourceHash,
          translations: request.segments.map((segment: { id: string; text: string }) => ({ id: segment.id, text: `译:${segment.text}` })) }))
        await manager.apply(DOC, jobId, item.unitId, item.responsePath, 'qwen', 'fixture')
      }
      await manager.finalize(DOC, jobId)
      const manifest = JSON.parse(await readFile(join(outputDir, 'translation.manifest.json'), 'utf8'))
      expect(manifest.blocks.map((block: { markdown: string }) => block.markdown)).toEqual(['译:First paragraph about cracks.', '译:Second paragraph, corrected.', ''])
      const blocks = manifest.blocks.map((block: { sourceIndex: number; markdown: string; sourceHash: string }) => ({ sourceIndex: block.sourceIndex, markdown: block.markdown, mappingIds: [], sourceHash: block.sourceHash }))
      expect(resolveReaderEdits(MARKDOWN, MAPPINGS, blocks, await readMarkdownEditsFile(outputDir, DOC)).blocks.find(block => block.index === 1)?.stale).toBe(false)
      expect(manifest.generatedAt).toEqual(expect.any(String))

      // 重新翻译此段: a new run translates only that block, past the cache; the others keep their translation.
      database.connection.prepare("UPDATE jobs SET status='succeeded' WHERE id=?").run(jobId)
      await store.apply({ documentId: DOC, expectedRevision: 2, target: target(0), action: 'retranslate' })
      const rerun = new SqliteJobRepository(database).enqueue({ documentId: DOC, kind: 'translate', checkpoint: { stage: 'queued', reason: 'edited' }, now: '2026-10-22T00:01:00.000Z' })
      const again = new MarkdownTranslationPlanManager(repository)
      await again.open(DOC, rerun.id)
      const rework = (await again.listWork(DOC, rerun.id)).items
      expect(rework.map(item => item.status)).toEqual(['pending', 'completed', 'completed'])
      await expect(again.tryCache(DOC, rerun.id, rework[0]!.unitId, 'qwen', 'fixture')).resolves.toMatchObject({ status: 'pending' })
      const request = JSON.parse(await readFile(join(outputDir, ...rework[0]!.requestPath.split('/')), 'utf8'))
      await writeFile(join(outputDir, ...rework[0]!.responsePath.split('/')), JSON.stringify({ protocol: request.protocol, unitId: request.unitId, sourceHash: request.sourceHash,
        translations: request.segments.map((segment: { id: string }) => ({ id: segment.id, text: '重译的第一段' })) }))
      await again.apply(DOC, rerun.id, rework[0]!.unitId, rework[0]!.responsePath, 'qwen', 'fixture')
      await again.finalize(DOC, rerun.id)
      const rerunManifest = JSON.parse(await readFile(join(outputDir, 'translation.manifest.json'), 'utf8'))
      expect(rerunManifest.blocks.map((block: { markdown: string }) => block.markdown)).toEqual(['重译的第一段', '译:Second paragraph, corrected.', ''])
    } finally { repository.close() }
  })

  it('frames whole blocks from the PDF view, content or page furniture, and removes the frame again', async () => {
    const root = await paperDir()
    const store = new MarkdownEditStore(() => root)
    await store.apply({ documentId: DOC, expectedRevision: 0, target: { kind: 'block', mappingId: 'm1' }, action: 'box' })
    await store.apply({ documentId: DOC, expectedRevision: 1, target: { kind: 'block', mappingId: 'h0' }, action: 'box' })
    expect(() => store.apply({ documentId: DOC, expectedRevision: 2, target: target(1), action: 'box' })).toThrow('Frames')
    const edits = resolveReaderEdits(MARKDOWN, MAPPINGS, null, await readMarkdownEditsFile(root, DOC))
    expect(edits.boxMarks).toEqual(['m1', 'h0'])
    const blocks = buildOriginalReaderBlocks(MARKDOWN, MAPPINGS, edits)
    expect(blocks.filter(block => block.boxed).map(block => block.annotationKey)).toEqual(['content:1'])
    await store.apply({ documentId: DOC, expectedRevision: 2, target: { kind: 'block', mappingId: 'm1' }, action: 'unbox' })
    expect((await readMarkdownEditsFile(root, DOC)).boxMarks.map(item => item.mappingId)).toEqual(['h0'])
  })

  it('gives chat the edited text and drops deleted blocks without losing chunk locators', () => {
    const chunk = (id: string, text: string, mappingIds: string[]) => ({ chunkId: id, sourceText: text, mappingIds }) as unknown as RagChunk
    const chunks = [chunk('c0', 'first', ['m0']), chunk('c1a', 'second part a', ['m1']), chunk('c1b', 'second part b', ['m1']), chunk('c2', 'journal noise', ['m2'])]
    const file: MarkdownEditsFile = { ...emptyMarkdownEdits(DOC), blocks: [
      { index: 1, mappingIds: ['m1'], baseHash: sha('x'), original: { markdown: 'second, corrected', editedAt: '2026-10-22T00:00:00.000Z' } },
      { index: 2, mappingIds: ['m2'], baseHash: sha('y'), deletedAt: '2026-10-22T00:00:00.000Z' }] }
    expect(applyChunkEdits(chunks, file).map(item => [item.chunkId, item.sourceText])).toEqual([['c0', 'first'], ['c1a', 'second, corrected']])
  })

  it('keeps a reading order of whole blocks for reading, translation, chat and export, and ignores it for another parse', async () => {
    const root = await paperDir()
    const store = new MarkdownEditStore(() => root)
    await expect(store.apply({ documentId: DOC, expectedRevision: 0, target: { kind: 'order', sequence: [1, 0] }, action: 'reorder' })).rejects.toThrow('位置已变化')
    expect(() => store.apply({ documentId: DOC, expectedRevision: 0, target: { kind: 'order', sequence: [2, 0, 1] }, action: 'delete' })).toThrow('Reordering')
    await store.apply({ documentId: DOC, expectedRevision: 0, target: { kind: 'order', sequence: moveInOrder([0, 1, 2], [2], 0) }, action: 'reorder' })
    await store.apply({ documentId: DOC, expectedRevision: 1, target: target(1), action: 'delete' })
    const file = await readMarkdownEditsFile(root, DOC)
    expect(file.order).toMatchObject({ count: 3, sequence: [2, 0, 1] })
    const edits = resolveReaderEdits(MARKDOWN, MAPPINGS, null, file)
    expect(edits.order).toEqual([2, 0, 1])
    // Content changes places; keys, mappings and the page furniture's slots stay.
    const blocks = buildOriginalReaderBlocks(MARKDOWN, MAPPINGS, edits)
    expect(blocks.filter(block => block.role === 'content').map(block => [block.annotationKey, block.mappingIds])).toEqual([['content:2', ['m2']], ['content:0', ['m0']]])
    expect(blocks.map(block => block.role)).toEqual(buildOriginalReaderBlocks(MARKDOWN, MAPPINGS, { ...edits, order: undefined }).map(block => block.role))
    const translated = ['第一段。', '第二段。', '期刊噪声。'].map((markdown, sourceIndex) => ({ sourceIndex, markdown, mappingIds: [`m${sourceIndex}`] }))
    expect(buildTranslatedReaderBlocks(MARKDOWN, translated.map(block => block.markdown).join('\n\n'), translated, MAPPINGS, edits)
      .filter(block => block.role === 'content').map(block => block.markdown)).toEqual(['期刊噪声。', '第一段。'])
    // Chat reads chunks in the same order; export joins blocks in it.
    const chunk = (id: string, mappingIds: string[]) => ({ chunkId: id, sourceText: id, mappingIds }) as unknown as RagChunk
    expect(applyChunkEdits([chunk('c0', ['m0']), chunk('c0b', []), chunk('c1', ['m1']), chunk('c2', ['m2'])], file, await store.readingOrder(DOC)).map(item => item.chunkId))
      .toEqual(['c2', 'c0', 'c0b'])
    expect(inReadingOrder(['a', 'b', 'c'], validOrder(file.order, 3), item => ['a', 'b', 'c'].indexOf(item))).toEqual(['c', 'a', 'b'])
    expect(validOrder(file.order, 4)).toBeNull()
    // The reader's optimistic view matches; the parsed order is stored as no order at all.
    expect(optimisticEdits(null, { target: { kind: 'order', sequence: [2, 0, 1] }, action: 'reorder' }).order).toEqual([2, 0, 1])
    expect(optimisticEdits(edits, { target: { kind: 'order', sequence: [0, 1, 2] }, action: 'reorder' }).order).toBeUndefined()
    await store.apply({ documentId: DOC, expectedRevision: 2, target: { kind: 'order', sequence: [] }, action: 'reset-order' })
    expect((await readMarkdownEditsFile(root, DOC)).order).toBeUndefined()
  })
})

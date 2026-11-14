import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CopilotixTask } from '@features/library/contract/documentTypes'
import type { ArtifactKind } from '@features/library/contract/artifacts'
import type { ArtifactReference } from '@features/library/utility/taskRepositoryCompat'
import { FIGURE_INSIGHT_PROMPT_VERSION } from '../../../src/features/insight/contract/figureInsight'
import { FigureInsightStore } from '../../../src/features/insight/utility/figureInsightStore'

const roots: string[] = []
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'archive-cover-source-'))
  roots.push(root)
  const documentId = randomUUID()
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2l1sAAAAASUVORK5CYII=', 'base64')
  const figure = {
    figureId: 'reader-figure-1', imagePath: `images/figures/figure-p2-${'a'.repeat(24)}.png`,
    sourceRevision: hash('figure revision'), pageIndex: 1, cropBox: [0, 0, 300, 180],
    mappingIds: ['figure-1'], sourceAssets: ['images/source.jpg'], width: 1, height: 1, pngSha256: hash(png)
  }
  const refs = new Map<ArtifactKind, ArtifactReference>(['source_pdf', 'parsed_markdown', 'layout', 'block_mappings'].map((kind) => [
    kind as ArtifactKind, { id: randomUUID(), documentId, kind: kind as ArtifactKind, revision: 1,
      relativePath: 'not-read-by-cover-source', contentHash: hash(kind), metadata: {} }
  ]))
  const task = { id: documentId, outputDir: root, sourceHash: hash('source PDF') } as CopilotixTask
  const store = new FigureInsightStore({ getTask: id => id === documentId ? task : null,
    getLatestArtifactReference: (_id, kind) => refs.get(kind) ?? null })
  await mkdir(join(root, 'images', 'figures'), { recursive: true })
  await mkdir(join(root, 'insight', 'figures'), { recursive: true })
  await writeFile(join(root, figure.imagePath), png)
  const manifestPath = join(root, 'figures.json')
  await writeFile(manifestPath, JSON.stringify({ version: 1, figures: [figure] }))
  const score = { version: 1, documentId, figure,
    content: { displayWeight: 75, overview: '核心机制。', takeaway: '关注输入与输出。' },
    provenance: { sourceRevision: hash('context'), promptVersion: FIGURE_INSIGHT_PROMPT_VERSION,
      model: { provider: 'codex', name: 'fixture-model' }, generatedAt: '2026-10-26T00:00:00.000Z' } }
  const scorePath = join(root, 'insight', 'figures', `${hash(figure.figureId)}.v1.json`)
  await writeFile(scorePath, JSON.stringify(score))
  return { root, documentId, figure, refs, store, manifestPath, scorePath, score, png }
}

describe('archive cover source', () => {
  it('projects saved weights without needing paper text, layout, mapping files or descriptor work', async () => {
    const f = await fixture()
    const descriptor = vi.spyOn(f.store, 'descriptor')
    const result = await f.store.coverSource(f.documentId)
    expect(result).toMatchObject({ hasManifest: true, figures: [{ figureId: f.figure.figureId, displayWeight: 75 }] })
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/u)
    expect(descriptor).not.toHaveBeenCalled()
    expect(result.figures[0]).not.toHaveProperty('pngSha256')
    expect(result.figures[0]).not.toHaveProperty('sourceAssets')
  })

  it('invalidates a cover for artifact or saved-score changes even without document updatedAt changes', async () => {
    const f = await fixture()
    const initial = await f.store.coverSource(f.documentId)
    f.refs.get('block_mappings')!.contentHash = hash('new mappings')
    const remapped = await f.store.coverSource(f.documentId)
    expect(remapped.fingerprint).not.toBe(initial.fingerprint)
    f.score.content.overview = '更新后的核心机制。'
    await writeFile(f.scorePath, JSON.stringify(f.score))
    const rescored = await f.store.coverSource(f.documentId)
    expect(rescored.fingerprint).not.toBe(remapped.fingerprint)
    expect(rescored.figures[0]?.displayWeight).toBe(75)
  })

  it('ignores a mismatched score while keeping the confirmed manifest candidate', async () => {
    const f = await fixture()
    f.score.documentId = randomUUID()
    await writeFile(f.scorePath, JSON.stringify(f.score))
    const result = await f.store.coverSource(f.documentId)
    expect(result.figures).toHaveLength(1)
    expect(result.figures[0]).not.toHaveProperty('displayWeight')
    await writeFile(f.scorePath, 'malformed saved score')
    const malformed = await f.store.coverSource(f.documentId)
    expect(malformed.figures).toHaveLength(1)
    expect(malformed.figures[0]).not.toHaveProperty('displayWeight')
    expect(malformed.fingerprint).not.toBe(result.fingerprint)
  })

  it('distinguishes a missing manifest from damaged or unsafe manifest data', async () => {
    const f = await fixture()
    await rm(f.manifestPath)
    expect(await f.store.coverSource(f.documentId)).toMatchObject({ hasManifest: false, figures: [] })
    await writeFile(f.manifestPath, '{broken')
    await expect(f.store.coverSource(f.documentId)).rejects.toThrow('无法读取本地封面来源')
    await writeFile(f.manifestPath, JSON.stringify({ version: 1, figures: [{ ...f.figure, imagePath: '../../outside.png' }] }))
    await expect(f.store.coverSource(f.documentId)).rejects.toThrow('无法读取本地封面来源')
  })

  it('retains missing PNG candidates and changes the fingerprint when the image becomes available', async () => {
    const f = await fixture()
    await rm(join(f.root, f.figure.imagePath))
    const missing = await f.store.coverSource(f.documentId)
    expect(missing.hasManifest).toBe(true)
    expect(missing.figures).toHaveLength(1)
    await writeFile(join(f.root, f.figure.imagePath), f.png)
    const available = await f.store.coverSource(f.documentId)
    expect(available.fingerprint).not.toBe(missing.fingerprint)
  })

  it('enforces manifest and score byte budgets independently', async () => {
    const f = await fixture()
    await writeFile(f.scorePath, Buffer.alloc(64 * 1024 + 1, 32))
    expect((await f.store.coverSource(f.documentId)).figures[0]).not.toHaveProperty('displayWeight')
    await writeFile(f.manifestPath, Buffer.alloc(2 * 1024 * 1024 + 1, 32))
    await expect(f.store.coverSource(f.documentId)).rejects.toThrow('无法读取本地封面来源')
  })
})

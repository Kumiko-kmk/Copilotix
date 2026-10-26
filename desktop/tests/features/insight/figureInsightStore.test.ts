import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, stat, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BLOCK_MAPPING_VERSION } from '@features/parsing/core/blockMapping'
import { buildReaderFigureGeometries } from '@features/reader/core/readerFigureGroups'
import type { BlockMapping } from '@features/parsing/contract/blocks'
import type { CopilotixTask } from '@features/library/contract/documentTypes'
import { FigureInsightStore } from '../../../src/features/insight/utility/figureInsightStore'
import { PaperChatFigureStore } from '../../../src/features/chat/utility/paperChatFigureStore'

const roots: string[] = []
const hash = (v: string | Buffer): string => createHash('sha256').update(v).digest('hex')
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'figure-insight-')); roots.push(root)
  const id = randomUUID(), sourceHash = hash('original source')
  const mapping = (id: string, order: number, type: string, bbox: [number, number, number, number], text: string, asset?: string): BlockMapping =>
    ({ id, order, type, sourceText: text, ...(asset ? { sourceAsset: asset } : {}), boxes: [{ pageIndex: 0, bbox, pageSize: [612, 792], blockPosition: String(order) }] })
  const mappings = [
    mapping('prose', 0, 'text', [50, 30, 560, 60], 'Figure 1 shows the core pipeline. Figure 10 shows unrelated ablations.'),
    mapping('image', 1, 'image', [100, 100, 200, 200], '', 'images/a.jpg'),
    mapping('caption', 2, 'image_caption', [100, 210, 200, 230], 'Figure 1. Input and output.'),
    mapping('next', 3, 'text', [50, 280, 560, 310], 'We evaluate the proposed mechanism.')
  ]
  const geometry = buildReaderFigureGeometries(mappings, '{}').find(g => g.status === 'complete')!
  expect(geometry).toBeDefined()
  await writeFile(join(root, 'original.pdf'), '%PDF-fixture')
  const pdf = await stat(join(root, 'original.pdf'))
  const revision = hash(JSON.stringify([sourceHash, pdf.size, pdf.mtimeMs, hash('{}')]))
  const imagePath = 'images/figures/figure-p1-' + hash(revision + geometry.id + JSON.stringify([geometry.pageIndex, geometry.cropBox, geometry.pageSize])).slice(0, 24) + '.png'
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2l1sAAAAASUVORK5CYII=', 'base64')
  const figure = { figureId: geometry.id, imagePath, sourceRevision: revision, pageIndex: geometry.pageIndex,
    cropBox: geometry.cropBox, mappingIds: geometry.mappingIds, sourceAssets: geometry.assetSources, width: 1, height: 1, pngSha256: hash(png) }
  await mkdir(join(root, 'images', 'figures'), { recursive: true })
  await writeFile(join(root, imagePath), png)
  await writeFile(join(root, 'figures.json'), JSON.stringify({ version: 1, figures: [figure] }))
  await writeFile(join(root, 'block_list.json'), JSON.stringify({ version: BLOCK_MAPPING_VERSION, mappings }))
  await writeFile(join(root, 'layout.json'), '{}')
  await writeFile(join(root, 'full.md'), '# Paper\n\n## Abstract\n\nWe propose a core mechanism.\n\n## Method\n\nThe method has inputs and outputs.\n\n## Conclusion\n\nThe mechanism improves predictions.')
  const task = { id, sourceHash, outputDir: root } as CopilotixTask
  const store = new FigureInsightStore({ getTask: () => task })
  const request = { documentId: id, figureId: geometry.id }
  const content = { displayWeight: 90, overview: '核心方法图。', takeaway: '关注输入输出。' }
  return { root, store, request, figure, content, task }
}

describe('figure insight persistence', () => {
  it('resolves confirmed whole figures and context, saves location metadata and returns stale after text changes', async () => {
    const f = await fixture(), descriptor = await f.store.descriptor(f.request)
    expect(descriptor.context.caption).toContain('Input and output')
    expect(descriptor.context.related.join('\n')).toContain('core pipeline')
    expect(descriptor.context.paperOverview.join('\n')).toContain('mechanism')
    await f.store.save({ ...f.request, sourceRevision: descriptor.sourceRevision, content: f.content, model: { provider: 'deepseek', name: 'deepseek-flash' } })
    const result = await f.store.get(f.request)
    expect(result).toMatchObject({ status: 'ready', stale: false, record: { figure: f.figure, content: f.content } })
    const file = join(f.root, 'insight', 'figures', hash(f.request.figureId) + '.v1.json')
    expect(JSON.parse(await readFile(file, 'utf8')).content).toEqual(f.content)
    await writeFile(join(f.root, 'full.md'), '# Different paper content')
    expect(await f.store.get(f.request)).toMatchObject({ status: 'ready', stale: true })
    await expect(f.store.save({ ...f.request, sourceRevision: descriptor.sourceRevision, content: f.content, model: { provider: 'deepseek', name: 'deepseek-flash' } })).rejects.toThrow('已更新')
  })

  it('rejects tampered or missing whole images and never substitutes individual panels', async () => {
    const f = await fixture()
    await writeFile(join(f.root, f.figure.imagePath), 'tampered')
    await expect(f.store.descriptor(f.request)).rejects.toThrow('校验失败')
    await rm(join(f.root, f.figure.imagePath))
    await expect(f.store.descriptor(f.request)).rejects.toThrow()
    expect(await f.store.get(f.request)).toEqual({ status: 'missing' })
  })

  it('gives chat the verified crop, else the parsed panels, as paths and hashes only', async () => {
    const f = await fixture()
    const chat = new PaperChatFigureStore({ getTask: () => f.task }, f.store)
    const whole = await chat.source(f.request)
    expect(whole).toMatchObject({ label: 'Figure 1', key: '1', whole: true, captionMappingIds: ['caption'], images: [{ path: f.figure.imagePath, sha256: f.figure.pngSha256, mimeType: 'image/png' }] })
    expect(JSON.stringify(whole)).not.toContain('iVBOR')
    // Until the reader saves a crop (or when it no longer verifies), the panels stand in.
    await rm(join(f.root, 'figures.json'))
    await writeFile(join(f.root, 'images', 'a.jpg'), Buffer.from('ffd8ffe000', 'hex'))
    expect(await chat.source(f.request)).toMatchObject({ whole: false, images: [{ path: 'images/a.jpg', mimeType: 'image/jpeg', bytes: 5, sha256: hash(Buffer.from('ffd8ffe000', 'hex')) }] })
    await writeFile(join(f.root, 'images', 'a.jpg'), 'not an image')
    await expect(chat.source(f.request)).rejects.toThrow('格式')
    await expect(chat.source({ ...f.request, figureId: 'reader-figure-missing' })).rejects.toThrow('不在当前解析版本')
  })

  it('rejects traversal in a manifest path', async () => {
    const f = await fixture()
    await writeFile(join(f.root, 'figures.json'), JSON.stringify({ version: 1, figures: [{ ...f.figure, imagePath: '../../outside.png' }] }))
    await expect(f.store.descriptor(f.request)).rejects.toThrow()
  })

  it('rejects a symlinked insight directory even if its destination is inside the document', async () => {
    const f = await fixture(), descriptor = await f.store.descriptor(f.request)
    await mkdir(join(f.root, 'redirect'))
    await symlink(join(f.root, 'redirect'), join(f.root, 'insight'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(f.store.save({ ...f.request, sourceRevision: descriptor.sourceRevision, content: f.content, model: { provider: 'deepseek', name: 'deepseek-flash' } })).rejects.toThrow('目录无效')
  })
})

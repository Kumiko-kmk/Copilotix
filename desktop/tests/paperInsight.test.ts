import { briefContent, briefGeneration } from './fixtures/paperBrief'
import { assembleBrief, buildBriefContext, buildFullBriefContext, PAPER_BRIEF_REQUEST } from '@shared/paperBrief'
import type { BriefContextResult } from '@shared/paperBrief/contracts'
import { randomUUID, createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/constants'
import { paperInsightContentSchema, paperInsightRecordSchema, paperInsightRequestSchema, paperInsightSchema, paperInsightStateSchema, type PaperInsight, type PaperInsightState } from '@shared/paperInsight'
import { PaperInsightService, loadFullBriefContext, type PaperInsightDependencies } from '../src/main/chat/paperInsightService'
import { PaperInsightStore } from '../src/utility/core/persistence/paperInsightStore'
import { turnError } from '../src/runtime/codexRuntime'

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, rename: vi.fn(fs.rename) }
})

const content = { summary: '仅依据摘录的概述', researchQuestion: '如何改进论文阅读？', method: '结构化分析方法', contributions: ['提出方法'], findings: ['效率改善'], limitations: [], keywords: ['论文'] }
const insight = (sourceRevision = 'revision-1'): PaperInsight => ({ ...content, model: { provider: 'qwen', name: 'qwen-plus' }, generatedAt: new Date().toISOString(), sourceRevision })
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
function fixture() {
  const id = randomUUID()
  const states: PaperInsightState[] = []
  const settings = structuredClone(DEFAULT_SETTINGS)
  settings.chatConsentVersion = 2
  settings.credentials.qwen = { state: 'valid' }
  const stored = new Map<string, PaperInsightState>()
  const deps: PaperInsightDependencies = {
    settings: vi.fn(async () => settings), key: vi.fn(async () => 'never-persist-this-key'),
    get: vi.fn(async (documentId: string): Promise<PaperInsightState> => stored.get(documentId) ?? { status: 'missing' }),
    context: vi.fn(async (documentId: string): Promise<BriefContextResult> => ({ documentId, sourceRevision: 'revision-1', context: buildBriefContext('# Title\n\n## Abstract\n\nPaper content.\n\n## Method\n\nStructured analysis.', '') })),
    save: vi.fn(async (documentId, brief, anchors) => { stored.set(documentId, { status: 'ready', brief, anchors, stale: false, promptOutdated: false }) }),
    stream: vi.fn(async ({ onDelta }) => { await onDelta(JSON.stringify(briefGeneration)); return null }),
    recordUsage: vi.fn(async () => undefined), changed: vi.fn((_id, state) => states.push(state)), canStart: () => true, log: vi.fn()
  }
  return { id, deps, settings, states, stored, service: new PaperInsightService(deps) }
}
async function idle(f: ReturnType<typeof fixture>) { await vi.waitFor(() => expect(f.states.at(-1)?.status).not.toBe('generating')) }

describe('structured paper insight', () => {
  it('strictly bounds content, providers, models, IDs and state payloads', () => {
    const value = insight()
    expect(paperInsightSchema.parse(value)).toEqual(value)
    for (const invalid of [{ ...content, extra: true }, { ...content, method: 'x'.repeat(4001) }, { ...content, keywords: Array(21).fill('x') }]) expect(paperInsightContentSchema.safeParse(invalid).success).toBe(false)
    expect(paperInsightSchema.safeParse({ ...insight(), model: { provider: 'qwen', name: 'deepseek-flash' } }).success).toBe(false)
    expect(paperInsightRequestSchema.safeParse({ documentId: '../escape' }).success).toBe(false)
    expect(paperInsightStateSchema.safeParse({ status: 'missing', insight: insight() }).success).toBe(false)
  })
  it.each(['key', 'unverified', 'provider'])('does not send paper content when %s is unavailable', async (kind) => {
    const f = fixture()
    if (kind === 'key') f.deps.key = async () => null
    if (kind === 'unverified') f.settings.credentials.qwen = { state: 'invalid' }
    if (kind === 'provider') f.settings.enabledTranslationProviders = []
    expect((await f.service.get(f.id)).status).toBe('unavailable')
    await f.service.generate(f.id); await idle(f)
    expect(f.states.at(-1)?.status).toBe('unavailable')
    expect(f.deps.context).not.toHaveBeenCalled(); expect(f.deps.stream).not.toHaveBeenCalled()
    await f.service.dispose()
  })
  it('retries invalid JSON exactly once and stores only validated content and provenance', async () => {
    const f = fixture()
    vi.mocked(f.deps.stream).mockImplementationOnce(async ({ onDelta }) => { await onDelta('```bad'); return null })
    await f.service.generate(f.id); await idle(f)
    expect(f.deps.stream).toHaveBeenCalledTimes(2)
    expect(vi.mocked(f.deps.stream).mock.lastCall?.[0]).toMatchObject(PAPER_BRIEF_REQUEST)
    const repair = vi.mocked(f.deps.stream).mock.lastCall![0].messages
    expect(repair.at(-2)).toEqual({ role: 'assistant', content: '```bad' })
    expect(repair.at(-1)?.content).toContain('JSON')
    expect(f.deps.save).toHaveBeenCalledWith(f.id, expect.objectContaining({ checks: [{ grounded: true, numbersVerified: false }, { grounded: true, numbersVerified: true }, { grounded: true, numbersVerified: true }] }), expect.arrayContaining([expect.objectContaining({ id: 'E1' })]))
    expect(f.states.at(-1)).toMatchObject({ status: 'ready', stale: false })
    expect(JSON.stringify(f.stored.get(f.id))).not.toContain('never-persist-this-key')
    await f.service.dispose()
  })
  it('stops after a second invalid response and sanitizes provider errors', async () => {
    const f = fixture()
    vi.mocked(f.deps.stream).mockImplementation(async ({ onDelta }) => { await onDelta('{"apiKey":"never-persist-this-key"}'); return null })
    await f.service.generate(f.id); await idle(f)
    expect(f.deps.stream).toHaveBeenCalledTimes(2); expect(f.deps.save).not.toHaveBeenCalled()
    expect(f.states.at(-1)?.status).toBe('failed'); expect(JSON.stringify(f.states)).not.toContain('never-persist')
    expect(f.deps.log).toHaveBeenCalledWith(expect.objectContaining({ documentId: f.id, status: 'failed', stage: 'parse', attempts: 2, category: 'invalid-structured-response' }))
    expect(JSON.stringify(vi.mocked(f.deps.log!).mock.calls)).not.toContain('never-persist')
    await f.service.dispose()
  })
  it('logs the classified Codex failure and shows its fixed message instead of the generic one', async () => {
    const f = fixture()
    vi.mocked(f.deps.stream).mockRejectedValue(turnError({ responseStreamDisconnected: { httpStatusCode: null } }))
    await f.service.generate(f.id); await idle(f)
    expect(f.states.at(-1)).toEqual({ status: 'failed', error: 'Codex 连接中断或服务暂时不可用，请稍后重试' })
    expect(f.deps.log).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', stage: 'generate', category: 'codex:responseStreamDisconnected' }))
    vi.mocked(f.deps.stream).mockRejectedValue(turnError({ responseTooManyFailedAttempts: { httpStatusCode: 429 } }))
    await f.service.generate(f.id); await vi.waitFor(() => expect(f.states.at(-1)).toEqual({ status: 'failed', error: '服务商限流，请稍后重试。' }))
    await f.service.dispose()
  })
  it('single-flights each paper, limits two pipelines and drains queued work on cancellation', async () => {
    const f = fixture()
    let active = 0, peak = 0
    vi.mocked(f.deps.stream).mockImplementation(async ({ signal }) => {
      active++; peak = Math.max(peak, active)
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
      active--; signal.throwIfAborted(); return null
    })
    await f.service.generate(f.id); await f.service.generate(f.id)
    await f.service.generate(randomUUID()); await f.service.generate(randomUUID())
    await vi.waitFor(() => expect(active).toBe(2))
    await f.service.pause()
    expect(peak).toBe(2); expect(active).toBe(0); expect(f.deps.save).not.toHaveBeenCalled()
    await expect(f.service.generate(f.id)).rejects.toThrow('维护')
    f.service.resume(); await f.service.dispose()
  })
  it('waits for an in-flight atomic save before deleting and rejects new work during deletion', async () => {
    const f = fixture()
    let commit!: () => void
    let started = false
    f.deps.save = async () => { started = true; await new Promise<void>((resolve) => { commit = resolve }) }
    await f.service.generate(f.id); await vi.waitFor(() => expect(started).toBe(true))
    const remove = vi.fn(async () => undefined)
    const deletion = f.service.deleteDocument(f.id, remove)
    expect(remove).not.toHaveBeenCalled()
    commit(); await deletion
    expect(remove).toHaveBeenCalledOnce()
    await f.service.dispose()
  })
  it('starts after parsing, overlaps translation, and skips fresh original results after translation', async () => {
    const f = fixture()
    await f.service.onJobChanged({ kind: 'parse', status: 'succeeded', documentId: f.id })
    await idle(f)
    expect(f.deps.stream).toHaveBeenCalledOnce()
    f.settings.autoGeneratePaperInsight = false // a stale stored value no longer turns it off
    await f.service.onJobChanged({ kind: 'translate', status: 'succeeded', documentId: f.id }); await idle(f)
    await vi.waitFor(async () => expect((await f.service.get(f.id)).status).toBe('ready'))
    await f.service.onJobChanged({ kind: 'translate', status: 'succeeded', documentId: f.id }); await idle(f)
    expect(f.deps.stream).toHaveBeenCalledOnce()
    await f.service.dispose()
  })
  it('recovers missing authors in the same analysis call and saves their source anchors', async () => {
    const f = fixture()
    const context = buildFullBriefContext('# Local Paper\n\n' + 'Publisher '.repeat(430) + '\n\n## Authors\n\nalice smith; bob jones\n\n## Abstract\n\nA method with its evidence.', '')
    const authorAnchor = context.excerpts.find(excerpt => excerpt.text.includes('alice smith'))!.id
    expect(authorAnchor).not.toBe('E1')
    f.deps.context = async documentId => ({ documentId, sourceRevision: 'revision-1', context })
    vi.mocked(f.deps.stream).mockImplementationOnce(async ({ messages, onDelta }) => {
      expect(messages[1]?.content).toContain('"missingMetadata":["authors","year","venue","doi"]')
      await onDelta(JSON.stringify({ ...briefGeneration, metadata: { ...briefGeneration.metadata,
        authors: { value: 'alice smith; bob jones', evidence: 'alice smith; bob jones', anchors: [authorAnchor] } } }))
      return null
    })
    await f.service.generate(f.id); await idle(f)
    expect(f.deps.stream).toHaveBeenCalledOnce()
    expect(f.deps.save).toHaveBeenCalledWith(f.id, expect.objectContaining({ metadata: expect.objectContaining({ authors:
      expect.objectContaining({ value: 'alice smith; bob jones', anchors: [authorAnchor] }) }) }), expect.arrayContaining([expect.objectContaining({ id: authorAnchor })]))
    await f.service.dispose()
  })
})

async function diskFixture() {
  const root = await mkdtemp(join(tmpdir(), 'copilotix-insight-')); roots.push(root)
  const id = randomUUID()
  let revision = 1
  let translatedRevision: number | undefined
  const ref = (kind: string) => ({ id: kind, documentId: id, kind, revision: kind === 'translated_markdown' ? translatedRevision ?? revision : revision, relativePath: kind === 'parsed_markdown' ? 'original.md' : 'translated.md', contentHash: 'a'.repeat(64), metadata: {} })
  await writeFile(join(root, 'original.md'), '# English title\n\n## Abstract\n\nOriginal paper content sufficient for a structured summary.')
  await writeFile(join(root, 'translated.md'), '# 中文标题\n# 摘要\n翻译内容是这篇论文的完整摘要，用于校验读取。\n# 结论\n结论内容说明研究发现。')
  const repository = { getTask: () => ({ outputDir: root }), getLatestArtifactReference: (_id: string, kind: string) => ref(kind) } as unknown as ConstructorParameters<typeof PaperInsightStore>[0]
  const store = new PaperInsightStore(repository)
  return { root, id, store, repository, revise: () => { revision++ }, reviseTranslation: () => { translatedRevision = (translatedRevision ?? revision) + 1 } }
}
/** v1 insights are no longer generated; existing files are only read, so tests seed them directly. */
async function writeV1(f: Awaited<ReturnType<typeof diskFixture>>, sourceRevision: string) {
  await mkdir(join(f.root, 'insight'), { recursive: true })
  await writeFile(join(f.root, 'insight', 'insight.v1.json'), JSON.stringify(paperInsightRecordSchema.parse({ version: 1, documentId: f.id, insight: insight(sourceRevision) })))
}
async function briefFor(f: Awaited<ReturnType<typeof diskFixture>>) {
  const context = await f.store.briefContext(f.id, new AbortController().signal)
  const brief = assembleBrief(briefContent, context.context, { provider: 'deepseek', model: 'deepseek-flash', sourceRevision: context.sourceRevision })
  return { context, brief, anchors: context.context.excerpts.map(({ id, section, text }) => ({ id, section, text })) }
}
describe('paper insight atomic storage', () => {
  it('keeps an original-text analysis fresh when only the translated artifact changes', async () => {
    const f = await diskFixture()
    const { brief, anchors } = await briefFor(f)
    await f.store.saveBrief(f.id, brief, anchors)
    f.reviseTranslation()
    expect(await f.store.get(f.id)).toMatchObject({ status: 'ready', stale: false })
    f.revise()
    expect(await f.store.get(f.id)).toMatchObject({ status: 'ready', stale: true })
  })
  it('loads a complete paper larger than Core RPC through a small descriptor and rejects changed content', async () => {
    const f = await diskFixture()
    const markdown = '# Full paper\n\n' + '全文保留公式 $x_i$ 与表格。\n\n'.repeat(50000) + 'References: LAST_ENTRY'
    const path = join(f.root, 'original.md')
    await writeFile(path, markdown)
    const descriptor = { documentId: f.id, sourceRevision: 'revision', sources: [{ path, hash: createHash('sha256').update(markdown).digest('hex'), language: 'original' as const }] }
    expect(Buffer.byteLength(JSON.stringify(descriptor))).toBeLessThan(2048)
    const context = await loadFullBriefContext(f.id, new AbortController().signal, async () => descriptor)
    expect(context.context.excerpts.map(item => item.text).join('')).toBe(markdown)
    expect(context.context.coverage.sourceBytes).toBeGreaterThan(1024 * 1024)
    await writeFile(path, 'changed')
    await expect(loadFullBriefContext(f.id, new AbortController().signal, async () => descriptor)).rejects.toThrow('正在更新')
    const aborted = new AbortController(); aborted.abort()
    const getSource = vi.fn(async () => descriptor)
    await expect(loadFullBriefContext(f.id, aborted.signal, getSource)).rejects.toThrow()
    expect(getSource).not.toHaveBeenCalled()
  })

  it('prefers v2, preserves v1, separates prompt updates from source staleness and reopens anchors', async () => {
    const f = await diskFixture()
    const { context, brief, anchors } = await briefFor(f)
    expect(context.context.language).toBe('original')
    await writeV1(f, context.sourceRevision)
    await f.store.saveBrief(f.id, { ...brief, provenance: { ...brief.provenance, promptVersion: 'older-prompt' } }, anchors)
    expect(await new PaperInsightStore(f.repository).get(f.id)).toMatchObject({ status: 'ready', brief: { checks: brief.checks }, anchors, stale: false, promptOutdated: true })
    expect(await readdir(join(f.root, 'insight'))).toEqual(['brief.v2.json', 'insight.v1.json'])
    const metadata = { title: null, authors: { value: 'Alice Smith', evidence: 'Alice Smith', anchors: ['E1'] }, year: null, venue: null, doi: null }
    await f.store.saveBrief(f.id, { ...brief, metadata, provenance: { ...brief.provenance, promptVersion: 'older-prompt' } }, anchors)
    expect(await new PaperInsightStore(f.repository).get(f.id)).toMatchObject({ brief: { metadata } })
    f.revise()
    expect(await f.store.get(f.id)).toMatchObject({ stale: true, promptOutdated: true })
    const path = join(f.root, 'insight', 'brief.v2.json'), prior = await readFile(path, 'utf8')
    vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('disk failure'), { code: 'EIO' }))
    await expect(f.store.saveBrief(f.id, brief, anchors)).rejects.toThrow('disk failure')
    expect(await readFile(path, 'utf8')).toBe(prior)
    expect((await readdir(join(f.root, 'insight'))).some((name) => name.startsWith('.pending'))).toBe(false)
    await writeFile(path, '{broken')
    await expect(f.store.get(f.id)).rejects.toThrow()
  })
  it('uses translated text only when the original is absent or empty', async () => {
    const f = await diskFixture()
    await writeFile(join(f.root, 'original.md'), '')
    const context = await f.store.briefContext(f.id, new AbortController().signal)
    expect(context.context.language).toBe('translated')
    expect(JSON.stringify(context)).toContain('翻译内容')
  })
  it('reads old missing and v1 files with revision staleness', async () => {
    const f = await diskFixture()
    expect(await f.store.get(f.id)).toEqual({ status: 'missing' })
    const { context } = await briefFor(f)
    await writeV1(f, context.sourceRevision)
    expect(await new PaperInsightStore(f.repository).get(f.id)).toMatchObject({ status: 'ready', stale: false })
    f.revise(); expect(await f.store.get(f.id)).toMatchObject({ status: 'ready', stale: true })
    await writeFile(join(f.root, 'insight', '.pending-interrupted'), 'partial')
    expect((await f.store.get(f.id)).status).toBe('ready')
    await writeFile(join(f.root, 'insight', 'insight.v1.json'), '{broken'); await expect(f.store.get(f.id)).rejects.toThrow()
  })
  it('keeps the committed brief when validation fails', async () => {
    const f = await diskFixture()
    const { brief, anchors } = await briefFor(f)
    await f.store.saveBrief(f.id, brief, anchors)
    const path = join(f.root, 'insight', 'brief.v2.json'), prior = await readFile(path, 'utf8')
    await expect(f.store.saveBrief(f.id, { ...brief, tldr: '' }, anchors)).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe(prior)
    expect(await readdir(join(f.root, 'insight'))).toEqual(['brief.v2.json'])
  })
  it('rejects an insight directory junction and cancelled content reads', async () => {
    const f = await diskFixture(), outside = join(f.root, 'outside')
    const { brief, anchors } = await briefFor(f)
    await mkdir(outside)
    await symlink(outside, join(f.root, 'insight'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(f.store.saveBrief(f.id, brief, anchors)).rejects.toThrow('目录')
    expect(await readdir(outside)).toEqual([])
    const controller = new AbortController(); controller.abort()
    await expect(f.store.briefContext(f.id, controller.signal)).rejects.toThrow()
  })
})

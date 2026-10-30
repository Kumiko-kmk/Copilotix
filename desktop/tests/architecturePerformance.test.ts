import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { DocumentFeed } from '../src/features/library/main/documentFeed'
import { ArtifactService } from '../src/features/reader/main/artifactService'
import { DocumentModelStore } from '@features/document/utility'
import { buildReaderBase } from '@features/document/core'
import { PathPolicy } from '@platform/files/runtime/pathPolicy'
import { ModelRuntime } from '@platform/models/runtime/modelRuntime'
import { defaultConnections } from '@platform/models/contract/models'
import { TranslationHttpError } from '@features/translation/main/providers'
import type { DocumentSummary } from '@features/library/contract/documentSchemas'
const BASELINE = '82aab2d'
/** Execute trusted repository baseline components, keeping the working tree intact. */
async function baseline<T>(path: string): Promise<T> {
  const source = execFileSync('git', ['show', BASELINE + ':desktop/src/' + path], { encoding: 'utf8' })
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const imports = new Map<string, unknown>()
  for (const match of compiled.matchAll(/require\("([^"]+)"\)/gu)) {
    const name = match[1]!
    const location = name.startsWith('.') ? resolve('src', dirname(path), name) : name
    imports.set(name, await vi.importActual(location))
  }
  const module = { exports: {} }
  new Function('exports', 'require', 'module', compiled)(module.exports, (name: string) => imports.get(name), module)
  return module.exports as T
}
const summarize = (samples: number[]) => ({ medianMs: [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)], p95Ms: [...samples].sort((a, b) => a - b)[Math.floor(samples.length * 0.95)] })
describe.skipIf(process.env.COPILOTIX_ARCH_BENCH !== '1')('architecture component benchmark', () => {
  it('records the same dataset before and after without asserting an invented speedup', async () => {
    const oldFeed = await baseline<{ DocumentFeed: typeof DocumentFeed }>('features/library/main/documentFeed.ts')
    const oldReader = await baseline<{ ArtifactService: typeof ArtifactService }>('features/reader/main/artifactService.ts')
    const oldRetry = await baseline<{ withRetry<T>(run: () => Promise<T>, signal: AbortSignal): Promise<T> }>('features/translation/main/translationPlanOrchestrator.ts')
    const rows: DocumentSummary[] = Array.from({ length: 128 }, (_, i) => ({ id: randomUUID(), originalName: 'paper-' + i + '.pdf', displayName: 'paper-' + i, sourceHash: 'hash', workflow: { status: 'parsing', progress: 0, activeJobKind: 'parse', error: null }, processing: { translationProvider: 'qwen' }, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }))
    const feedMetrics: Array<{ fullLibraryQueries: number; documentQueries: number; events: number }> = []
    for (const Feed of [oldFeed.DocumentFeed, DocumentFeed]) {
      const all = vi.fn(async () => structuredClone(rows)), one = vi.fn(async (id: string) => structuredClone(rows.find(r => r.id === id)!))
      let events = 0
      vi.useFakeTimers()
      const feed = new Feed({ listDocumentSummaries: all, getDocumentSummary: one }, () => { events++ }, () => { throw new Error('feed failed') })
      await feed.load(); all.mockClear()
      for (let i = 1; i <= 60; i++) { rows[0]!.workflow.progress = i; feed.refresh({ documentId: rows[0]!.id, kind: 'progress' }); await vi.advanceTimersByTimeAsync(200); await vi.runAllTimersAsync() }
      vi.useRealTimers()
      feedMetrics.push({ fullLibraryQueries: all.mock.calls.length, documentQueries: one.mock.calls.length, events })
    }
    const root = await mkdtemp(join(tmpdir(), 'architecture-bench-')), id = rows[0]!.id
    const markdown = Array.from({ length: 120 }, (_, i) => '# Section ' + i + String.fromCharCode(10, 10) + '中文 English paragraph ' + i + ' $x^2+y^2=z^2$. '.repeat(20)).join(String.fromCharCode(10, 10))
    await writeFile(join(root, 'full.md'), markdown)
    await writeFile(join(root, 'block_list.json'), JSON.stringify({ version: 3, mappings: [] }))
    const task = { id, outputDir: root, sourceHash: 'hash' }
    const model = new DocumentModelStore(), repository = { getTask: async () => task }
    const current = new ArtifactService(repository as never, { ensureDocumentModel: () => model.descriptor(id, root) } as never, new PathPolicy())
    const prior = new oldReader.ArtifactService(repository as never, {} as never, new PathPolicy())
    let baselineReaderPreparations = 0
    const reading: Array<{ label: string; medianMs: number | undefined; p95Ms: number | undefined; samples: number; coldMs: number }> = []
    for (const [label, service] of [['baseline', prior], ['current', current]] as const) {
      const samples: number[] = []
      let coldMs = 0
      for (let i = 0; i < 21; i++) {
        const started = performance.now(), doc = await service.getDocument(id)
        if (!doc.base) { baselineReaderPreparations++; buildReaderBase(doc.markdown, doc.mappings) }
        const elapsed = performance.now() - started
        if (i) samples.push(elapsed)
        else coldMs = elapsed
      }
      reading.push({ label, coldMs, ...summarize(samples), samples: samples.length })
    }
    let previousRequests = 0, currentRequests = 0
    const signal = new AbortController().signal, runtime = new ModelRuntime()
    for (let i = 0; i < 100; i++) {
      await oldRetry.withRetry(async () => { previousRequests++; throw new TranslationHttpError('offline', 503, 0) }, signal).catch(() => undefined)
      await runtime.run(defaultConnections()[0]!, 'background', signal, async () => { currentRequests++; throw new TranslationHttpError('offline', 503, 0) }).catch(() => undefined)
    }
    expect(feedMetrics[1]!.fullLibraryQueries).toBe(0)
    expect(currentRequests).toBe(1)
    const report = { baseline: BASELINE, dataset: { documents: 128, progressEvents: 60, paragraphs: 120, markdownSha256: createHash('sha256').update(markdown).digest('hex'), bytes: Buffer.byteLength(markdown), failedLogicalRequests: 100 }, feed: feedMetrics, readingPreparation: reading, baselineReaderPreparations, currentBaseBuilds: model.builds, failureRequests: { baseline: previousRequests, current: currentRequests }, limitations: 'Component measurement: Main file read and reader base preparation; excludes IPC, browser layout, PDF/GPU and real network latency. Medians exclude first invocation. ColdMs means first invocation in a shared process, not a cold application launch. HTTP failures are simulated; no claim about full UI speed.' }
    await mkdir('unit-test-results', { recursive: true })
    await writeFile('unit-test-results/architecture-performance.json', JSON.stringify(report, null, 2))
  }, 60_000)
})

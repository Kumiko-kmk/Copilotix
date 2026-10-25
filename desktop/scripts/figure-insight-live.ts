import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join, relative, isAbsolute } from 'node:path'
import { DEFAULT_SETTINGS } from '../src/shared/constants'
import type { CopilotixTask, AppSettings } from '../src/shared/types'
import { FigureInsightStore } from '../src/utility/core/persistence/figureInsightStore'
import { FigureInsightService } from '../src/main/chat/figureInsightService'
import { ChatProvider } from '../src/main/chat/chatProvider'
import { WindowsCredentialVault } from '../src/platform/credentials/main/credentialVault'
import { figureInsightContentSchema, type FigureInsightDescriptor, type FigureInsightRequest, type FigureInsightState } from '../src/shared/figureInsight'

// Explicit live-test entry. Preflight is read-only; --execute sends images and saves results.
const execute = process.argv.includes('--execute')
const nonStream = process.argv.includes('--non-stream')
const limitArg = process.argv.find(arg => arg.startsWith('--limit='))
const limit = limitArg ? Number(limitArg.slice(8)) : Infinity
if (!(limit > 0)) throw new Error('Invalid limit')
const library = resolve('F:/12479/文档/Copilotix/documents-v2')
const evidence = resolve(process.cwd(), '../../investigation/figure-insight-live-20261011')
const selected = [
  '1af0b11d-9e8a-47a0-a9d8-7c667b7ae11a', // Transformer
  '2c3d4c36-4798-438d-a31b-02b7ab521ef1', // AlphaFold
  '737bc65c-43a3-44c5-b5fa-10bd86964d7a', // DDPM
  'd8184376-ed12-463a-a0e2-8d2891086c70', // Neural operators
  'fcaa433f-cd37-4bbe-9001-704a4215b069', // Graph simulation
  '4ca35161-60ba-41ee-a4fb-d02ed196e75b' // GAN
]

async function main() {
  const database = new DatabaseSync('C:/Users/12479/AppData/Roaming/Copilotix-Translation-v2/copilotix-desktop-v2.sqlite3', { readOnly: true })
  const tasks = new Map<string, CopilotixTask>(), titles = new Map<string, string>()
  try {
    for (const id of selected) {
      const row = database.prepare('SELECT * FROM documents WHERE id = ?').get(id) as Record<string, string> | undefined
      if (!row) throw new Error('Selected document missing: ' + id)
      const outputDir = resolve(row.storage_path!)
      const child = relative(library, outputDir)
      if (!child || child.startsWith('..') || isAbsolute(child)) throw new Error('Document is outside the selected library')
      tasks.set(id, { id, outputDir, sourceHash: row.source_checksum! } as CopilotixTask)
      titles.set(id, row.display_title || row.original_filename!)
    }
  } finally { database.close() }
  const store = new FigureInsightStore({ getTask: id => tasks.get(id) ?? null })
  const descriptors: FigureInsightDescriptor[] = []
  for (const [id, task] of tasks) {
    const manifest = JSON.parse(await readFile(join(task.outputDir, 'figures.json'), 'utf8'))
    for (const figure of manifest.figures) descriptors.push(await store.descriptor({ documentId: id, figureId: figure.figureId }))
  }
  const key = await new WindowsCredentialVault().get('deepseek-api-key')
  if (!key) throw new Error('Existing DeepSeek credential unavailable')
  const picked = descriptors.slice(0, limit)
  console.log(JSON.stringify({ mode: execute ? 'execute' : 'preflight', credentialAvailable: true,
    papers: [...tasks].map(([id]) => ({ id, title: titles.get(id), figures: descriptors.filter(d => d.documentId === id).length })),
    selectedFigures: picked.length, bytes: picked.reduce((sum, d) => sum + d.imageBytes, 0) }))
  if (!execute) return
  await mkdir(evidence, { recursive: true })
  try { await writeFile(join(evidence, 'report-before-' + Date.now() + '.json'), await readFile(join(evidence, 'report.json'))) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  let report: any = { startedAt: new Date().toISOString(), model: 'deepseek-flash', library,
    input: 'one complete image (PNG or full-size JPEG98) + caption + related paragraphs + paper overview per request', selectedFigures: picked.length,
    papers: [...tasks].map(([id]) => ({ id, title: titles.get(id) })), results: [], calls: [], usage: [], totals: {} }
  try {
    const previous = JSON.parse(await readFile(join(evidence, 'report.json'), 'utf8'))
    if (previous.selectedFigures === picked.length && previous.model === report.model) {
      report = previous
      report.input = 'one complete image (PNG or full-size JPEG98) + caption + related paragraphs + paper overview per request'
      report.results = report.results.filter((r: any) => r.status === 'ready')
      delete report.finishedAt
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  let checkpoints = Promise.resolve()
  const checkpoint = () => { const snapshot = JSON.stringify(report, null, 2); checkpoints = checkpoints.then(() => writeFile(join(evidence, 'report.json'), snapshot)) }
  const provider = new ChatProvider(async (url, init) => {
    const body = JSON.parse(String(init.body)), started = Date.now()
    if (nonStream) { body.stream = false; delete body.stream_options; init = { ...init, body: JSON.stringify(body) } }
    const call: any = { startedAt: new Date().toISOString(), requestBytes: Buffer.byteLength(String(init.body)), imageCount: body.messages.flatMap((m: any) => Array.isArray(m.content) ? m.content : []).filter((p: any) => p.type === 'image_url').length }
    call.responseMode = nonStream ? 'json' : 'sse'
    const image = body.messages.flatMap((m: any) => Array.isArray(m.content) ? m.content : []).find((p: any) => p.type === 'image_url')
    call.uploadMimeType = image?.image_url.url.slice(5, image.image_url.url.indexOf(';'))
    report.calls.push(call)
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          call.fetchAttempts = (call.fetchAttempts ?? 0) + 1
          // The image service already bounds first-byte time to 120s and the whole run to 5min.
          // Do not impose a 30s upload/body deadline on multi-MiB PNGs.
          const response = await fetch(url, { ...init, headers: { ...init.headers, Connection: 'close' } })
          call.status = response.status; call.headerMs = Date.now() - started
          if (!nonStream || !response.ok) return response
          const result = await response.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: unknown }
          const content = result.choices?.[0]?.message?.content
          if (typeof content !== 'string') throw new Error('Missing model content')
          // Adapt a real JSON completion to the existing streaming interface; model content is unchanged.
          return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content } }], usage: result.usage }) + '\n\ndata: [DONE]\n\n')
        }
        catch (error) {
          const cause = (error as { cause?: { code?: string } }).cause
          call.transportErrors ??= []
          call.transportErrors.push({ name: (error as Error).name, code: cause?.code, elapsedMs: Date.now() - started })
          if (attempt >= 2 || init.signal?.aborted) throw error
          await new Promise(resolve => setTimeout(resolve, 1000))
        }
      }
    }
    catch (error) { call.networkFailed = true; call.elapsedMs = Date.now() - started; call.errorName = (error as Error).name; throw new Error('DeepSeek network request failed') }
    finally { checkpoint() }
  })
  const settings: AppSettings = { ...structuredClone(DEFAULT_SETTINGS), translationProvider: 'deepseek', enabledTranslationProviders: ['deepseek'],
    chatConsentProvider: 'deepseek', chatConsentVersion: 2, credentials: { ...DEFAULT_SETTINGS.credentials, deepseek: { state: 'valid' } } }
  const waiters = new Map<string, (state: FigureInsightState) => void>()
  const identity = (r: FigureInsightRequest) => JSON.stringify([r.documentId, r.figureId])
  const service = new FigureInsightService({ settings: async () => settings, key: async () => key,
    descriptor: (r, signal) => store.descriptor(r, signal), get: r => store.get(r), save: r => store.save(r),
    encodeImage: async png => {
      if (png.length <= 2 * 1024 * 1024) return { bytes: png, mimeType: 'image/png' }
      const filename = createHash('sha256').update(png).digest('hex') + '.jpg'
      const jpeg = await readFile(join(evidence, 'uploads', filename))
      return jpeg.length < png.length ? { bytes: jpeg, mimeType: 'image/jpeg', jpegQuality: 98 } : { bytes: png, mimeType: 'image/png' }
    },
    stream: async input => {
      let answer = ''
      try { return await provider.stream({ ...input, onDelta: async delta => { answer += delta; await input.onDelta(delta) } }) }
      catch (error) { if (report.calls.at(-1)) report.calls.at(-1).providerErrorCode = (error as { code?: string }).code; throw error }
      finally {
        const call = report.calls.at(-1)
        if (call) {
          call.answer = answer
          try { const parsed = figureInsightContentSchema.safeParse(JSON.parse(answer)); if (!parsed.success) call.validationIssues = parsed.error.issues }
          catch { call.invalidJson = true }
          checkpoint()
        }
      }
    }, recordUsage: async (providerName, usage) => { report.usage.push({ provider: providerName, ...usage }); checkpoint() },
    canStart: () => true, changed: (r, state) => { if (state.status !== 'generating') waiters.get(identity(r))?.(state) } })
  try {
    // Sequential calls associate usage with images. Resume skips saved successes; transient failures do not block other papers.
    for (const d of picked) {
      const request = { documentId: d.documentId, figureId: d.figureId }
      const previous = report.results.find((r: any) => r.documentId === request.documentId && r.figureId === request.figureId)
      if (previous) {
        const current = await store.get(request)
        if (current.status === 'ready' && !current.stale && JSON.stringify(current.record) === JSON.stringify(previous.record)) {
          console.log(JSON.stringify({ resumed: true, paper: titles.get(d.documentId), page: d.figure.pageIndex + 1, weight: current.record.content.displayWeight })); continue
        }
        report.results = report.results.filter((r: any) => r !== previous)
      }
      const filename = createHash('sha256').update(d.figureId).digest('hex') + '.v1.json'
      const recordPath = join(tasks.get(d.documentId)!.outputDir, 'insight', 'figures', filename)
      try { const previous = await readFile(recordPath); await mkdir(join(evidence, 'previous-results', d.documentId), { recursive: true }); await writeFile(join(evidence, 'previous-results', d.documentId, filename), previous) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      const begin = Date.now(), callStart = report.calls.length, usageStart = report.usage.length
      const done = new Promise<FigureInsightState>(resolve => waiters.set(identity(request), resolve))
      await service.generate(request)
      const state = await done
      waiters.delete(identity(request))
      const result: any = { ...request, title: titles.get(d.documentId), page: d.figure.pageIndex + 1, imagePath: d.figure.imagePath,
        width: d.figure.width, height: d.figure.height, imageBytes: d.imageBytes, caption: d.context.caption,
        relatedParagraphs: d.context.related.length, overviewSections: d.context.paperOverview.length,
        elapsedMs: Date.now() - begin, calls: report.calls.slice(callStart), usage: report.usage.slice(usageStart), status: state.status }
      if (state.status === 'ready') {
        figureInsightContentSchema.parse(state.record.content)
        const saved = await store.get(request)
        if (state.stale || saved.status !== 'ready' || saved.stale || JSON.stringify(saved.record) !== JSON.stringify(state.record)) throw new Error('Saved result validation failed')
        result.recordPath = recordPath; result.record = state.record
      } else result.error = state.status === 'failed' ? state.error : state.status === 'unavailable' ? state.reason : 'Unexpected terminal state'
      report.results.push(result); checkpoint(); await checkpoints
      console.log(JSON.stringify({ completed: report.results.length, total: picked.length, paper: titles.get(d.documentId), page: result.page, status: result.status, weight: result.record?.content.displayWeight, calls: result.calls.length }))
      if (['CHAT_CREDENTIALS_REQUIRED', 'EMBEDDING_RATE_LIMITED'].includes(report.calls.at(-1)?.providerErrorCode)) throw new Error('Stopped batch after authentication/rate-limit error; inspect report.json')
    }
  } finally {
    await service.dispose()
    report.finishedAt = new Date().toISOString()
    report.totals = { successes: report.results.filter((r: any) => r.status === 'ready').length,
      failures: report.results.filter((r: any) => r.status !== 'ready').length, calls: report.calls.length,
      promptTokens: report.usage.reduce((s: number, u: any) => s + u.promptTokens, 0),
      completionTokens: report.usage.reduce((s: number, u: any) => s + u.completionTokens, 0),
      totalTokens: report.usage.reduce((s: number, u: any) => s + u.totalTokens, 0) }
    checkpoint(); await checkpoints
    console.log(JSON.stringify(report.totals))
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })

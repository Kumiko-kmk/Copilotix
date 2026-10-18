import { createHash, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/constants'
import { FIGURE_INSIGHT_PROMPT_VERSION, figureInsightContentSchema, figureInsightRequestSchema, resolveFigureInsightModel,
  type FigureInsightDescriptor, type FigureInsightState, type FigureInsightSave } from '@shared/figureInsight'
import { buildFigureInsightMessages } from '@shared/figureInsightPrompt'
import { FigureInsightService, type FigureInsightDependencies } from '../src/main/chat/figureInsightService'
import { ChatProvider } from '../src/main/chat/chatProvider'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2l1sAAAAASUVORK5CYII=', 'base64')
const digest = createHash('sha256').update(png).digest('hex')
const content = { displayWeight: 87, overview: '完整方法图展示输入如何经过各模块得到输出。', takeaway: '读者应关注核心模块与输入输出的关系。' }
afterEach(() => vi.restoreAllMocks())

function fixture() {
  const request = { documentId: randomUUID(), figureId: 'reader-figure-1-caption:0' }
  const settings = structuredClone(DEFAULT_SETTINGS)
  settings.chatConsentVersion = 2; settings.credentials.qwen = { state: 'valid' }
  const descriptor: FigureInsightDescriptor = { ...request, sourceRevision: 'a'.repeat(64), imagePath: '/private/root/image.png', imageBytes: png.length,
    figure: { figureId: request.figureId, sourceRevision: 'rev', imagePath: 'images/figures/figure-p1-' + 'b'.repeat(24) + '.png',
      pageIndex: 0, cropBox: [10, 20, 110, 120], mappingIds: ['a', 'caption'], sourceAssets: ['a.jpg'], width: 100, height: 100, pngSha256: digest },
    context: { title: 'Paper', caption: 'Figure 1. Whole method.', related: ['Figure 1 shows the core method.'], paperOverview: ['Abstract: Context.'] }
  }
  const states: FigureInsightState[] = []
  let state: FigureInsightState = { status: 'missing' }
  const deps: FigureInsightDependencies = {
    settings: vi.fn(async () => settings), key: vi.fn(async () => 'secret-key'),
    descriptor: vi.fn(async () => descriptor), get: vi.fn(async () => state), readImage: vi.fn(async () => png),
    save: vi.fn(async (value: FigureInsightSave) => {
      state = { status: 'ready', stale: false, record: { version: 1, documentId: value.documentId, figure: descriptor.figure,
        content: value.content, provenance: { sourceRevision: value.sourceRevision, promptVersion: FIGURE_INSIGHT_PROMPT_VERSION, model: value.model, generatedAt: new Date().toISOString(), ...(value.upload ? { upload: value.upload } : {}) } } }
    }),
    stream: vi.fn(async input => { await input.onDelta(JSON.stringify(content)); return { promptTokens: 2, completionTokens: 3, totalTokens: 5 } }),
    recordUsage: vi.fn(async () => undefined), canStart: () => true, changed: (_request, next) => states.push(next)
  }
  const service = new FigureInsightService(deps)
  return { request, settings, descriptor, deps, service, states }
}
async function idle(f: ReturnType<typeof fixture>): Promise<void> {
  await vi.waitFor(() => expect(f.states.at(-1)?.status).not.toBe('generating'))
}

describe('figure insight pipeline', () => {
  it('records JPEG upload identity while preserving the original PNG source and position', async () => {
    const f = fixture(), jpeg = Buffer.from('ffd8ffe00010ffd9', 'hex')
    f.deps.encodeImage = async () => ({ bytes: jpeg, mimeType: 'image/jpeg', jpegQuality: 98 })
    await f.service.generate(f.request); await idle(f)
    expect(JSON.stringify(vi.mocked(f.deps.stream).mock.calls[0]![0].messages)).toContain('data:image/jpeg;base64,')
    expect(vi.mocked(f.deps.save).mock.calls[0]![0].upload).toEqual({ mimeType: 'image/jpeg', byteLength: jpeg.length,
      sha256: createHash('sha256').update(jpeg).digest('hex'), jpegQuality: 98 })
    expect(f.states.at(-1)).toMatchObject({ status: 'ready', record: { figure: f.descriptor.figure } })
  })
  it('rejects invalid encoded image bytes before sending a model request', async () => {
    const f = fixture()
    f.deps.encodeImage = async () => ({ bytes: Buffer.from('not a JPEG'), mimeType: 'image/jpeg', jpegQuality: 98 })
    await f.service.generate(f.request); await idle(f)
    expect(f.states.at(-1)?.status).toBe('failed')
    expect(f.deps.stream).not.toHaveBeenCalled()
  })
  it('enforces exactly the three content fields and permits empty pure-formula results', () => {
    expect(figureInsightContentSchema.parse(content)).toEqual(content)
    expect(figureInsightContentSchema.parse({ displayWeight: 0, overview: '', takeaway: '' })).toEqual({ displayWeight: 0, overview: '', takeaway: '' })
    for (const value of [{ ...content, supports: [] }, { ...content, coverSuitable: true }, { ...content, displayWeight: 101 },
      { ...content, displayWeight: 1.5 }, { ...content, overview: '' }, { ...content, takeaway: '字'.repeat(161) }]) {
      expect(figureInsightContentSchema.safeParse(value).success).toBe(false)
    }
    expect(figureInsightRequestSchema.safeParse({ documentId: '../bad', figureId: 'x' }).success).toBe(false)
    expect(figureInsightRequestSchema.safeParse({ documentId: randomUUID(), figureId: 'x', imagePath: '/private.png' }).success).toBe(false)
  })

  it('sends one complete image with caption, related paragraphs and paper context, without local paths or credentials', async () => {
    const f = fixture()
    await f.service.generate(f.request); await idle(f)
    expect(f.states.at(-1)?.status).toBe('ready')
    expect(f.deps.stream).toHaveBeenCalledTimes(1)
    const input = vi.mocked(f.deps.stream).mock.calls[0]![0]
    expect(input.model).toBe('qwen3.8-flash')
    const serialized = JSON.stringify(input.messages)
    expect(serialized).toContain('Figure 1. Whole method.')
    expect(serialized).toContain('core method')
    expect(serialized).toContain('Abstract: Context.')
    expect(serialized.match(/data:image\/png;base64,/gu)).toHaveLength(1)
    expect(serialized).not.toContain('/private/root')
    expect(serialized).not.toContain('secret-key')
    expect(f.deps.recordUsage).toHaveBeenCalledTimes(1)
    expect(vi.mocked(f.deps.save).mock.calls[0]![0]).toMatchObject({ ...f.request, content, sourceRevision: f.descriptor.sourceRevision })
  })

  it.each(['key', 'valid', 'enabled'] as const)('never reads or uploads an image without %s', async kind => {
    const f = fixture()
    if (kind === 'key') f.deps.key = async () => null
    if (kind === 'valid') f.settings.credentials.qwen.state = 'unknown'
    if (kind === 'enabled') f.settings.enabledTranslationProviders = []
    await f.service.generate(f.request); await idle(f)
    expect(f.states.at(-1)?.status).toBe('unavailable')
    expect(f.deps.descriptor).not.toHaveBeenCalled()
    expect(f.deps.stream).not.toHaveBeenCalled()
  })

  it('rejects changed image bytes before the provider call', async () => {
    const f = fixture(); f.deps.readImage = async () => Buffer.from('changed image')
    await f.service.generate(f.request); await idle(f)
    expect(f.states.at(-1)?.status).toBe('failed')
    expect(f.deps.stream).not.toHaveBeenCalled(); expect(f.deps.save).not.toHaveBeenCalled()
  })

  it('repairs malformed output once and still rejects extra fields', async () => {
    const f = fixture()
    f.deps.stream = vi.fn(async input => { await input.onDelta(JSON.stringify({ ...content, supports: [] })); return null })
    await f.service.generate(f.request); await idle(f)
    expect(f.deps.stream).toHaveBeenCalledTimes(2)
    expect(f.deps.save).not.toHaveBeenCalled()
    expect(f.states.at(-1)?.status).toBe('failed')
  })

  it('does not start uploads on reads and routes only to supported vision models', async () => {
    const f = fixture()
    expect(await f.service.get(f.request)).toEqual({ status: 'missing' })
    expect(f.deps.stream).not.toHaveBeenCalled()
    expect(resolveFigureInsightModel('deepseek', 'deepseek-v4-pro')).toBe('deepseek-flash')
    expect(resolveFigureInsightModel('qwen', 'qwen3.8-max')).toBe('qwen3.8-max')
  })

  it('waits for a started atomic save before deletion', async () => {
    const f = fixture()
    let started!: () => void, release!: () => void
    const saving = new Promise<void>(resolve => { started = resolve })
    const committed = new Promise<void>(resolve => { release = resolve })
    f.deps.save = async () => { started(); await committed }
    await f.service.generate(f.request); await saving
    const remove = vi.fn(async () => undefined)
    const deleting = f.service.deleteDocument(f.request.documentId, remove)
    await Promise.resolve(); expect(remove).not.toHaveBeenCalled()
    release(); await deleting
    expect(remove).toHaveBeenCalledTimes(1)
  })

  it('cancels active and queued requests and drains maintenance without uploading queued images', async () => {
    const f = fixture()
    f.deps.descriptor = async request => ({ ...f.descriptor, ...request, figure: { ...f.descriptor.figure, figureId: request.figureId } })
    f.deps.stream = vi.fn(async input => new Promise<null>((_, reject) => {
      if (input.signal.aborted) reject(new Error('cancelled'))
      else input.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
    }))
    for (let i = 0; i < 5; i++) await f.service.generate({ ...f.request, figureId: 'figure-' + i })
    await vi.waitFor(() => expect(f.deps.stream).toHaveBeenCalledTimes(2))
    await f.service.pause()
    expect(f.states.at(-1)?.status).toBe('failed')
    expect(f.deps.save).not.toHaveBeenCalled()
    expect(f.deps.stream).toHaveBeenCalledTimes(2)
    f.service.resume()
  })

  it.each(['qwen', 'deepseek'] as const)('serializes real multimodal content for %s with thinking disabled and usage intact', async provider => {
    const f = fixture()
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => new Response('data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120}}\n\ndata: [DONE]\n\n'))
    const usage = await new ChatProvider(fetcher).stream({ provider,
      baseUrl: provider === 'qwen' ? DEFAULT_SETTINGS.qwenBaseUrl : DEFAULT_SETTINGS.deepseekBaseUrl,
      model: provider === 'qwen' ? 'qwen3.8-flash' : 'deepseek-flash', key: 'secret',
      messages: buildFigureInsightMessages(f.descriptor, png), signal: new AbortController().signal, onDelta: () => undefined,
      responseFormat: { type: 'json_object' }, maxOutputTokens: 1400, maxRequestBytes: 20 * 1024 * 1024 })
    const body = JSON.parse(String(fetcher.mock.calls[0]![1].body))
    expect(body.messages[1].content[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,' + png.toString('base64') } })
    expect(provider === 'qwen' ? body.enable_thinking : body.thinking.type).toBe(provider === 'qwen' ? false : 'disabled')
    expect(usage?.totalTokens).toBe(120)
  })
})

import { expect, it, vi } from 'vitest'
import { CodexTranslationProvider } from '../src/main/translation/codexTranslationProvider'
import type { CodexRuntime } from '../src/runtime/codexRuntime'
import type { PlainTranslationRequest } from '@shared/translationPlanProtocol'
import { flattenSegments } from '@shared/translationPlanProtocol'
import { buildTableTranslationPlan } from '../src/utility/core/compute/tableTranslation'
const request: PlainTranslationRequest = { protocol: 'copilotix-translation-plain-v1', unitId: '11111111-1111-4111-8111-111111111111', sourceHash: 'a'.repeat(64), targetLanguage: 'zh-CN', segments: [{ id: 'one', text: 'First segment' }, { id: 'two', text: 'Second segment' }] }
it('translates all segments of one paragraph in one correlated model request', async () => {
  const generate = vi.fn(async input => { const sent = JSON.parse(input.messages[1].content); input.onDelta(JSON.stringify({ protocol: 'copilotix-translation-segments-v1', translations: sent.segments.map((s: { id: string }) => ({ id: s.id, text: '译文' })) })); return null })
  const provider = new CodexTranslationProvider('model', { generate } as unknown as CodexRuntime)
  expect((await provider.translatePlain(request, new AbortController().signal)).translations).toHaveLength(2)
  expect(generate).toHaveBeenCalledOnce()
})
it('rejects duplicate, omitted, or foreign segment IDs before accepting output', async () => {
  const generate = vi.fn(async input => { input.onDelta(JSON.stringify({ protocol: 'copilotix-translation-segments-v1', translations: [{ id: 's0', text: '甲' }, { id: 's0', text: '乙' }] })); return null })
  const provider = new CodexTranslationProvider('model', { generate } as unknown as CodexRuntime)
  await expect(provider.translatePlain(request, new AbortController().signal)).rejects.toThrow('不匹配')
})
it('batches concurrent paragraphs from one job and restores their original IDs independently', async () => {
  const generate = vi.fn(async input => { const sent = JSON.parse(input.messages[1].content); input.onDelta(JSON.stringify({ protocol: sent.protocol, translations: sent.segments.map((s: { id: string; text: string }) => ({ id: s.id, text: '译:'+s.text })) })); return null })
  const provider = new CodexTranslationProvider('model', { generate } as unknown as CodexRuntime)
  const signal = new AbortController().signal
  const [plain, text] = await Promise.all([provider.translatePlain(request, signal), provider.translate('Other paragraph', signal)])
  expect(plain.translations.map(s => s.id)).toEqual(['one', 'two'])
  expect(text).toBe('译:Other paragraph')
  expect(generate).toHaveBeenCalledOnce()
})
it('cancels a queued batch without sending content and never combines separate job signals', async () => {
  const generate = vi.fn(async input => { const sent = JSON.parse(input.messages[1].content); input.onDelta(JSON.stringify({ protocol: sent.protocol, translations: sent.segments.map((s: { id: string }) => ({ id: s.id, text: '译文' })) })); return null })
  const provider = new CodexTranslationProvider('model', { generate } as unknown as CodexRuntime)
  const cancelled = new AbortController()
  const promise = provider.translate('Cancelled', cancelled.signal)
  const rejection = expect(promise).rejects.toThrow('cancelled')
  cancelled.abort(new Error('cancelled'))
  await rejection
  expect(generate).not.toHaveBeenCalled()
  await Promise.all([provider.translate('A', new AbortController().signal), provider.translate('B', new AbortController().signal)])
  expect(generate).toHaveBeenCalledTimes(2)
})
it('shortens table wire IDs and restores every original cell/caption ID without changing geometry', async () => {
  const table = buildTableTranslationPlan([{ sourceIndex: 0, markdown: 'Table 1. Results', mappingIds: [] }, { sourceIndex: 1, markdown: '<table><tr><td rowspan="2">Accuracy</td><td>Recall</td></tr><tr><td>Score</td></tr></table>', mappingIds: [] }])!.request
  const generate = vi.fn(async input => {
    const sent = JSON.parse(input.messages[1].content)
    const segments = flattenSegments(sent)
    expect(segments.every(s => /^t\d+$/u.test(s.id))).toBe(true)
    expect(sent.tables[0].rows[0][0].rowspan).toBe(2)
    input.onDelta(JSON.stringify({ protocol: table.protocol, translations: segments.map(s => ({ id: s.id, text: '译:'+s.text })) }))
    return null
  })
  const provider = new CodexTranslationProvider('model', { generate } as unknown as CodexRuntime)
  const result = await provider.translateTable(table)
  expect(result.translations.map(s => s.id)).toEqual(flattenSegments(table).map(s => s.id))
  expect(generate).toHaveBeenCalledOnce()
})

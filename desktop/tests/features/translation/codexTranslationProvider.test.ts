import { expect, it, vi } from 'vitest'
import { CodexTranslationProvider, segmentsAligned } from '../../../src/features/translation/main/codexTranslationProvider'
import { translationCacheKey } from '@features/translation/contract/translationPlanProtocol'
import { legacyCacheKey } from '../../../src/features/translation/utility/planModel'
import type { CodexRuntime } from '../../../src/platform/codex/runtime/codexRuntime'
import type { PlainTranslationRequest } from '@features/translation/contract/translationPlanProtocol'
import { flattenSegments } from '@features/translation/contract/translationPlanProtocol'
import { buildTableTranslationPlan } from '../../../src/features/translation/utility/tableTranslation'
const request: PlainTranslationRequest = { protocol: 'copilotix-translation-plain-v1', unitId: '11111111-1111-4111-8111-111111111111', sourceHash: 'a'.repeat(64), targetLanguage: 'zh-CN', segments: [{ id: 'one', text: 'First segment' }, { id: 'two', text: 'Second segment' }] }
it('translates all segments of one paragraph in one correlated model request', async () => {
  const generate = vi.fn(async input => { const sent = JSON.parse(input.messages[1].content); input.onDelta(JSON.stringify({ protocol: sent.protocol, translations: sent.segments.map((s: { id: string; text: string }) => ({ id: s.id, source: s.text, text: '译文' })) })); return null })
  const provider = new CodexTranslationProvider('model', { generate } as unknown as CodexRuntime)
  expect((await provider.translatePlain(request, new AbortController().signal)).translations).toHaveLength(2)
  expect(generate).toHaveBeenCalledOnce()
})
it('rejects duplicate, omitted, or foreign segment IDs before accepting output', async () => {
  const generate = vi.fn(async input => { input.onDelta(JSON.stringify({ protocol: 'copilotix-translation-segments-v2', translations: [{ id: 's0', source: 'First segment', text: '甲' }, { id: 's0', source: 'First segment', text: '乙' }] })); return null })
  const provider = new CodexTranslationProvider('model', { generate } as unknown as CodexRuntime)
  await expect(provider.translatePlain(request, new AbortController().signal)).rejects.toThrow('不匹配')
})
it('batches concurrent paragraphs from one job and restores their original IDs independently', async () => {
  const generate = vi.fn(async input => { const sent = JSON.parse(input.messages[1].content); input.onDelta(JSON.stringify({ protocol: sent.protocol, translations: sent.segments.map((s: { id: string; text: string }) => ({ id: s.id, source: s.text, text: '译:'+s.text })) })); return null })
  const provider = new CodexTranslationProvider('model', { generate } as unknown as CodexRuntime)
  const signal = new AbortController().signal
  const [plain, text] = await Promise.all([provider.translatePlain(request, signal), provider.translate('Other paragraph', signal)])
  expect(plain.translations.map(s => s.id)).toEqual(['one', 'two'])
  expect(text).toBe('译:Other paragraph')
  expect(generate).toHaveBeenCalledOnce()
})
it('cancels a queued batch without sending content and never combines separate job signals', async () => {
  const generate = vi.fn(async input => { const sent = JSON.parse(input.messages[1].content); input.onDelta(JSON.stringify({ protocol: sent.protocol, translations: sent.segments.map((s: { id: string; text: string }) => ({ id: s.id, source: s.text, text: '译文' })) })); return null })
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

const paragraphs = ['A dataset comprises multiple samples or training examples.', 'Raw data often requires several processing steps before training.', 'Neural network architecture']
it('re-sends each paragraph alone when a batch answer slides onto the next segment', async () => {
  // The batch answer is shifted by one: s1 carries the translation (and echo) of s0, and so on.
  const generate = vi.fn(async input => {
    const sent = JSON.parse(input.messages[1].content) as { protocol: string; segments: Array<{ id: string; text: string }> }
    const translations = sent.segments.length > 1
      ? sent.segments.map((s, index) => { const from = sent.segments[Math.max(0, index - 1)]!; return { id: s.id, source: from.text, text: '译:' + from.text } })
      : sent.segments.map(s => ({ id: s.id, source: s.text, text: '译:' + s.text }))
    input.onDelta(JSON.stringify({ protocol: sent.protocol, translations }))
    return null
  })
  const provider = new CodexTranslationProvider('model', { generate } as unknown as CodexRuntime)
  const signal = new AbortController().signal
  const results = await Promise.all(paragraphs.map(text => provider.translate(text, signal)))
  expect(results).toEqual(paragraphs.map(text => '译:' + text))
  expect(generate).toHaveBeenCalledTimes(1 + paragraphs.length)
})
it('rejects a single paragraph whose echo belongs to another segment instead of caching it', async () => {
  const generate = vi.fn(async input => { const sent = JSON.parse(input.messages[1].content); input.onDelta(JSON.stringify({ protocol: sent.protocol, translations: [{ id: 's0', source: 'Neural network architecture', text: '神经网络架构' }] })); return null })
  const provider = new CodexTranslationProvider('model', { generate } as unknown as CodexRuntime)
  await expect(provider.translate(paragraphs[1]!, new AbortController().signal)).rejects.toMatchObject({ code: 'TRANSLATION_ALIGNMENT_MISMATCH' })
})
it('accepts translations that share acronyms with a neighbour but rejects one carrying only the neighbour anchors', () => {
  const sources = [{ text: 'As shown in Figure 4, LAAF-PINN and SA-PINN converge faster than PINN, with a gap to PINO.' }, { text: 'Note that the contribution of PINO is orthogonal; PINN techniques transfer to PINO.' }]
  const correct = [{ source: 'As shown in Figure 4', text: '如图 4 所示，LAAF-PINN 和 SA-PINN 收敛快于 PINN，与 PINO 仍有差距。' }, { source: 'Note that the contribution', text: '需要注意的是，PINO 的贡献是正交的；PINN 技术可迁移到 PINO。' }]
  expect(segmentsAligned(sources, correct)).toBe(true)
  const moved = [{ source: 'As shown in Figure 4', text: correct[0]!.text }, { source: 'Note that the contribution', text: '如图 4 所示，LAAF-PINN 和 SA-PINN 收敛更快。' }]
  expect(segmentsAligned([sources[0]!, { text: 'Results for ResNet-50 and U-Net in Table 3 differ.' }], moved)).toBe(false)
})
it('keys Codex cache entries by alignment version so earlier unchecked batch answers are not reused', () => {
  expect(translationCacheKey('h', 'qwen', 'm', 'plain')).toBe(translationCacheKey('h', 'qwen', 'm', 'plain'))
  expect(translationCacheKey('h', 'qwen', 'm', 'plain')).toContain(':h:qwen:m')
  expect(translationCacheKey('h', 'codex', 'm', 'plain')).not.toContain(':h:codex:m')
  expect(legacyCacheKey('h', 'codex', 'm', 'plain')).not.toBe(legacyCacheKey('h', 'qwen', 'm', 'plain').replace('qwen', 'codex'))
})

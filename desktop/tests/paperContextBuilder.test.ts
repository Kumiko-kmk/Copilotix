import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { RagChunk } from '@core/types'
import { PAPER_CHAT_MAX_BYTES, paperContextResultSchema, type PaperContextRequest } from '@shared/paperChatSchemas'
import { ragWireByteLength } from '@shared/ragSchemas'
import { PaperContextBuilder, rankPaperChunks, tokenizePaperQuery } from '../src/utility/core/paperContextBuilder'
import type { RagContentRevisionRecord, RagDocumentKnowledge } from '../src/utility/core/persistence/sqliteRagRepository'

const doc = '10000000-0000-4000-8000-000000000001'
const artifact = '10000000-0000-4000-8000-000000000002'
const revision = 'rag-content-revision-' + 'a'.repeat(64)
const sha = (s: string): string => createHash('sha256').update(s).digest('hex')
function fixture(texts: string[]) {
  let offset = 0
  const chunks: RagChunk[] = texts.map((text, ordinal) => {
    const start = offset; offset += text.length
    return { chunkId: `chunk-${ordinal}`, contentRevisionId: revision, ordinal, contentHash: sha(text), sourceText: text, sectionPath: [ordinal === 0 ? 'Abstract' : `Section ${ordinal}`], mappingIds: [`m${ordinal}`], pageStart: ordinal, pageEnd: ordinal, sourceStartOffset: start, sourceEndOffset: offset, offsetUnit: 'utf16', contentType: 'paragraph', tokenCount: Math.ceil(text.length / 4), mappingConfidence: 'exact' }
  })
  const knowledge = { documentId: doc, localState: 'ready', activeContentRevisionId: revision } as RagDocumentKnowledge
  const record = { documentId: doc, artifactId: artifact, contentRevisionId: revision, state: 'ready' } as RagContentRevisionRecord
  const repository = { getDocumentKnowledge: vi.fn(() => knowledge), getContentRevision: vi.fn(() => record), listChunks: vi.fn(() => chunks) }
  const input: PaperContextRequest = { documentId: doc, question: 'contribution', pinned: [], budgetChars: 48_000 }
  return { chunks, knowledge, record, repository, input, builder: new PaperContextBuilder(repository) }
}

describe('PaperContextBuilder', () => {
  it('sends a short paper in source order, retaining UTF-16 locations and full-text provenance', () => {
    const f = fixture(['摘要😀贡献', 'A contribution using attention.'])
    const context = f.builder.build(f.input)
    expect(context.truncated).toBe(false)
    expect(context.evidence.map((e) => e.evidenceId)).toEqual(['E1', 'E2'])
    expect(context.evidence[1]!.locator.sourceStartOffset).toBe('摘要😀贡献'.length)
    expect(context.evidence[0]!.scoreProvenance[0]!.source).toBe('full-text')
    expect(paperContextResultSchema.safeParse(context).success).toBe(true)
    expect(f.repository.listChunks).toHaveBeenCalledWith(revision)
  })
  it('reserves pinned chunks and both neighbors before BM25; emits deduplicated source order', () => {
    const f = fixture(Array.from({ length: 20 }, (_, i) => `paragraph ${i} ` + 'x '.repeat(150)))
    f.input.budgetChars = 2_000
    f.input.pinned = [{ view: 'original', text: 'paragraph 10', contentRevisionId: revision, fragments: [{ quote: 'paragraph 10', mappingIds: ['m10'], startOffset: 0, endOffset: 12 }] }]
    const context = f.builder.build(f.input)
    expect(context.truncated).toBe(true)
    expect(context.evidence.map((e) => e.chunkId)).toEqual(expect.arrayContaining(['chunk-9', 'chunk-10', 'chunk-11']))
    const ordinals = context.evidence.map((e) => Number(e.chunkId.split('-')[1]))
    expect(ordinals).toEqual([...new Set(ordinals)].sort((a, b) => a - b))
    expect(context.evidence.reduce((n, e) => n + e.text.length, 0)).toBeLessThanOrEqual(2000)
  })
  it('validates original fragments with whitespace normalization; refuses forged and stale selections', () => {
    const f = fixture(['A valid\n source text.'])
    const pin = { view: 'original' as const, text: 'valid source', contentRevisionId: revision, fragments: [{ quote: 'valid source', mappingIds: ['m0'], startOffset: 2, endOffset: 14 }] }
    f.input.pinned = [pin]
    expect(f.builder.build(f.input).evidence[0]!.scoreProvenance[0]!.source).toBe('selection')
    for (const change of [{ text: 'forged', fragments: [{ ...pin.fragments[0]!, quote: 'forged' }] }, { contentRevisionId: 'old-revision' }, { fragments: [{ ...pin.fragments[0]!, mappingIds: ['another-paper'] }] }, { text: 'forged' }]) {
      f.input.pinned = [{ ...pin, ...change }]
      expect(() => f.builder.build(f.input)).toThrow(expect.objectContaining({ code: 'SELECTION_STALE' }))
    }
  })
  it('supports quotes spanning consecutive chunks and translated selections as unverified data', () => {
    const f = fixture(['original part ', 'continued text'])
    f.chunks[1]!.mappingIds = ['m0']
    f.input.pinned = [{ view: 'original', text: 'part continued', contentRevisionId: revision, fragments: [{ quote: 'part continued', mappingIds: ['m0'], startOffset: 9, endOffset: 23 }] }]
    expect(f.builder.build(f.input).evidence).toHaveLength(2)
    f.input.pinned = [{ ...f.input.pinned[0]!, view: 'translated', text: '译文😀内容', fragments: [{ quote: '译文😀内容', mappingIds: ['m0'], startOffset: 0, endOffset: 7 }] }]
    const result = f.builder.build(f.input)
    expect(result.evidence.every((e) => e.mappingConfidence === 'translated')).toBe(true)
    expect(result.evidence[0]!.translatedSelections).toEqual(['译文😀内容'])
    expect(result.evidence[0]!.text).toBe('original part ')
  })
  it('validates a visible selection containing Markdown formatting against trusted source text', () => {
    const f = fixture(['A **bold** contribution using [attention](https://example.test).'])
    f.input.pinned = [{ view: 'original', text: 'bold contribution using attention', contentRevisionId: revision, fragments: [{ quote: 'bold contribution using attention', mappingIds: ['m0'], startOffset: 2, endOffset: 35 }] }]
    expect(f.builder.build(f.input).evidence[0]!.scoreProvenance[0]!.source).toBe('selection')
    f.input.pinned[0]!.text = 'bold fabricated contribution'
    f.input.pinned[0]!.fragments[0]!.quote = 'bold fabricated contribution'
    expect(() => f.builder.build(f.input)).toThrow(expect.objectContaining({ code: 'SELECTION_STALE' }))
  })
  it('distinguishes unindexed/indexing states, and checks revision readiness and document scope', () => {
    const f = fixture(['test'])
    f.repository.getDocumentKnowledge.mockReturnValueOnce(null as unknown as RagDocumentKnowledge)
    expect(() => f.builder.build(f.input)).toThrow('尚未建立')
    f.knowledge.localState = 'indexing'
    expect(() => f.builder.build(f.input)).toThrow('正在索引')
    f.knowledge.localState = 'ready'; f.record.state = 'building'
    expect(() => f.builder.build(f.input)).toThrow(expect.objectContaining({ code: 'CONTENT_NOT_READY' }))
    f.record.state = 'ready'; f.record.documentId = artifact
    expect(() => f.builder.build(f.input)).toThrow(expect.objectContaining({ code: 'QUERY_SCOPE_INVALID' }))
  })
  it('enforces byte bounds for wide Unicode, without splitting source chunks', () => {
    const f = fixture(Array.from({ length: 100 }, () => '汉'.repeat(900)))
    f.input.budgetChars = 96_000
    const result = f.builder.build(f.input)
    expect(result.truncated).toBe(true)
    expect(ragWireByteLength(result)).toBeLessThanOrEqual(PAPER_CHAT_MAX_BYTES)
    expect(result.evidence.every((e) => e.text.length === 900)).toBe(true)
  })
  it('rejects pinned context that cannot fit and empty evidence; respects abort', () => {
    const f = fixture(['x'.repeat(1100)])
    f.input.budgetChars = 1024
    f.input.pinned = [{ view: 'original', text: 'x', contentRevisionId: revision, fragments: [{ quote: 'x', mappingIds: ['m0'], startOffset: 0, endOffset: 1 }] }]
    expect(() => f.builder.build(f.input)).toThrow(expect.objectContaining({ code: 'RAG_LIMIT_EXCEEDED' }))
    f.input.pinned = []; expect(() => f.builder.build(f.input)).toThrow(expect.objectContaining({ code: 'RAG_LIMIT_EXCEEDED' }))
    f.repository.listChunks.mockReturnValue([])
    expect(() => f.builder.build(f.input)).toThrow(expect.objectContaining({ code: 'INSUFFICIENT_EVIDENCE' }))
    const controller = new AbortController(); controller.abort()
    expect(() => f.builder.build(f.input, controller.signal)).toThrow()
  })
  it('scores Latin words and CJK bigrams without splitting emoji or supplementary Han characters', () => {
    expect(tokenizePaperQuery('ATTENTION 模型贡献😀𠀀𠀁')).toEqual(['attention', '模型', '型贡', '贡献', '𠀀𠀁'])
    const f = fixture(['unrelated', 'Attention attention.', '模型贡献'])
    expect(rankPaperChunks(f.chunks, 'attention')[0]!.index).toBe(1)
    expect(rankPaperChunks(f.chunks, '贡献')[0]!.index).toBe(2)
    expect(rankPaperChunks([], 'empty')).toEqual([])
  })
  it('builds a thousand-chunk paper with a bounded pack', () => {
    const f = fixture(Array.from({ length: 1000 }, (_, i) => `section ${i} attention ` + 'data '.repeat(80)))
    const start = performance.now()
    const result = f.builder.build(f.input)
    expect(result.truncated).toBe(true)
    expect(performance.now() - start).toBeLessThan(500)
  })
})

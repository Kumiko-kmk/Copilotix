import type { RagChunk } from '@core/types'
import { PAPER_CHAT_MAX_BYTES, paperContextRequestSchema, paperContextResultSchema, type PaperContext, type PaperContextRequest, type PaperEvidence } from '@shared/paperChatSchemas'
import { ragWireByteLength } from '@shared/ragSchemas'
import type { SqliteRagRepository } from './persistence/sqliteRagRepository'
import { paperSelectionText } from './paperSelectionText'

export class PaperContextError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) { super(message) }
}

/** Latin words plus Unicode CJK bigrams. Array.from preserves surrogate pairs. */
export function tokenizePaperQuery(text: string): string[] {
  const tokens: string[] = text.toLowerCase().match(/[\p{Script=Latin}\p{N}]+/gu) ?? []
  for (const run of text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu) ?? []) {
    const chars = Array.from(run)
    if (chars.length === 1) tokens.push(chars[0]!)
    else for (let i = 1; i < chars.length; i++) tokens.push(chars[i - 1]! + chars[i]!)
  }
  return tokens
}

export function rankPaperChunks(chunks: readonly RagChunk[], question: string): Array<{ index: number; score: number }> {
  const query = new Set(tokenizePaperQuery(question))
  const docs = chunks.map((chunk) => {
    const tokens = tokenizePaperQuery(chunk.sourceText)
    const frequencies = new Map<string, number>()
    for (const token of tokens) if (query.has(token)) frequencies.set(token, (frequencies.get(token) ?? 0) + 1)
    return { length: tokens.length, frequencies }
  })
  const average = docs.reduce((sum, doc) => sum + doc.length, 0) / (docs.length || 1) || 1
  const df = new Map<string, number>()
  for (const doc of docs) for (const token of doc.frequencies.keys()) df.set(token, (df.get(token) ?? 0) + 1)
  return docs.map((doc, index) => {
    let score = 0
    for (const [token, tf] of doc.frequencies) {
      const count = df.get(token)!
      const idf = Math.log(1 + (docs.length - count + 0.5) / (count + 0.5))
      score += idf * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * doc.length / average))
    }
    return { index, score }
  }).sort((a, b) => b.score - a.score || a.index - b.index)
}

const compact = (text: string): string => text.replace(/\s/gu, '')

export class PaperContextBuilder {
  constructor(private readonly rag: Pick<SqliteRagRepository, 'getDocumentKnowledge' | 'getContentRevision' | 'listChunks'>) {}

  build(raw: PaperContextRequest, signal?: AbortSignal): PaperContext {
    signal?.throwIfAborted()
    const input = paperContextRequestSchema.parse(raw)
    const knowledge = this.rag.getDocumentKnowledge(input.documentId)
    const revision = knowledge?.activeContentRevisionId ? this.rag.getContentRevision(knowledge.activeContentRevisionId) : null
    if (knowledge?.localState !== 'ready' || !revision || revision.state !== 'ready') {
      const indexing = knowledge?.localState === 'indexing' || knowledge?.localState === 'queued'
      throw new PaperContextError('CONTENT_NOT_READY', indexing ? '论文正在索引，请稍后重试' : '论文尚未建立可用索引，请先完成解析', true)
    }
    if (revision.documentId !== input.documentId) throw new PaperContextError('QUERY_SCOPE_INVALID', '论文索引范围不一致')
    const chunks = this.rag.listChunks(revision.contentRevisionId)
    if (!chunks.length) throw new PaperContextError('INSUFFICIENT_EVIDENCE', '论文中没有找到依据')
    const mappingIndex = new Map<string, number[]>()
    chunks.forEach((chunk, index) => {
      if (chunk.contentRevisionId !== revision.contentRevisionId) throw new PaperContextError('QUERY_SCOPE_INVALID', '论文索引范围不一致')
      for (const mapping of chunk.mappingIds) {
        const indices = mappingIndex.get(mapping) ?? []
        indices.push(index)
        mappingIndex.set(mapping, indices)
      }
    })
    const pinnedIndices = new Set<number>()
    const translations = new Map<number, string[]>()
    const visible = new Map<number, string>()
    const visibleText = (index: number): string => {
      let text = visible.get(index)
      if (text === undefined) { text = compact(paperSelectionText(chunks[index]!.sourceText)); visible.set(index, text) }
      return text
    }
    for (const pin of input.pinned) {
      if (pin.contentRevisionId !== revision.contentRevisionId) throw new PaperContextError('SELECTION_STALE', '选区来源已更新，请重新选择')
      for (const fragment of pin.fragments) {
        const candidates = [...new Set(fragment.mappingIds.flatMap((id) => mappingIndex.get(id) ?? []))].sort((a, b) => a - b)
        if (!fragment.mappingIds.length || fragment.mappingIds.some((id) => !mappingIndex.has(id))) throw new PaperContextError('SELECTION_STALE', '选区无法对应当前论文')
        let matching = candidates
        if (pin.view === 'original') {
          const quote = compact(fragment.quote)
          if (!quote || !compact(pin.text).includes(quote)) throw new PaperContextError('SELECTION_STALE', '选区文本与片段不一致')
          matching = candidates.filter((i) => compact(chunks[i]!.sourceText).includes(quote))
          if (!matching.length) matching = candidates.filter((i) => visibleText(i).includes(quote))
          // A formula/paragraph can span several consecutive structural chunks.
          if (!matching.length && candidates.every((n, i) => i === 0 || n === candidates[i - 1]! + 1) && (compact(candidates.map((i) => chunks[i]!.sourceText).join('')).includes(quote) || candidates.map(visibleText).join('').includes(quote))) matching = candidates
          if (!matching.length) throw new PaperContextError('SELECTION_STALE', '选区文本不属于当前论文版本')
        }
        for (const index of matching) {
          pinnedIndices.add(index)
          if (index > 0) pinnedIndices.add(index - 1)
          if (index + 1 < chunks.length) pinnedIndices.add(index + 1)
          if (pin.view === 'translated') translations.set(index, [...new Set([...(translations.get(index) ?? []), pin.text])])
        }
      }
    }
    signal?.throwIfAborted()
    const totalChars = chunks.reduce((n, c) => n + c.sourceText.length, 0)
    const fullText = totalChars <= input.budgetChars
    const ranked = fullText ? [] : rankPaperChunks(chunks, input.question)
    const scoreByIndex = new Map(ranked.map((item, rank) => [item.index, { ...item, rank: rank + 1 }]))
    const outline = [...new Set(chunks.flatMap((c) => c.sectionPath))].slice(0, 128).map((s) => s.slice(0, 512))
    const pack: PaperContext = { documentId: input.documentId, contentRevisionId: revision.contentRevisionId, evidence: [], outline, truncated: !fullText }
    const chosen = new Map<number, PaperEvidence>()
    let bytes = ragWireByteLength(pack)
    let chars = outline.reduce((n, s) => n + s.length, 0)
    const add = (index: number, required = false): void => {
      if (chosen.has(index)) return
      const chunk = chunks[index]!
      const translatedSelections = translations.get(index) ?? []
      const length = chunk.sourceText.length + translatedSelections.reduce((n, s) => n + s.length, 0)
      const rank = scoreByIndex.get(index)
      const evidence: PaperEvidence = {
        evidenceId: `E${chosen.size + 1}`, chunkId: chunk.chunkId,
        locator: { documentId: input.documentId, artifactId: revision.artifactId, contentRevisionId: revision.contentRevisionId, contentHash: chunk.contentHash, mappingIds: [...chunk.mappingIds], pageStart: chunk.pageStart, pageEnd: chunk.pageEnd, sourceStartOffset: chunk.sourceStartOffset, sourceEndOffset: chunk.sourceEndOffset, offsetUnit: 'utf16' },
        sectionPath: [...chunk.sectionPath], text: chunk.sourceText, translatedSelections,
        mappingConfidence: translatedSelections.length ? 'translated' : 'source',
        scoreProvenance: [{ source: pinnedIndices.has(index) ? 'selection' : fullText || !rank?.score ? 'full-text' : 'lexical', rank: rank?.rank ?? index + 1, score: pinnedIndices.has(index) || fullText ? 1 : rank?.score ?? 0, ...(!fullText && !pinnedIndices.has(index) && rank?.score ? { algorithm: 'bm25' as const } : {}) }]
      }
      const evidenceBytes = ragWireByteLength(evidence) + (chosen.size ? 1 : 0)
      if (chars + length > input.budgetChars || chosen.size >= 9_999 || bytes + evidenceBytes > PAPER_CHAT_MAX_BYTES) {
        pack.truncated = true
        if (required) throw new PaperContextError('RAG_LIMIT_EXCEEDED', '选区及相邻内容超过上下文预算，请减少选区')
        return
      }
      chosen.set(index, evidence)
      chars += length
      bytes += evidenceBytes
    }
    for (const index of pinnedIndices) add(index, true)
    if (fullText) for (let i = 0; i < chunks.length; i++) add(i)
    else {
      // Give short-paper summaries priority even when the question is Chinese.
      const introductory = chunks.map((c, i) => ({ c, i })).filter(({ c }) => /abstract|introduction|摘要|引言/iu.test(c.sectionPath.join(' '))).slice(0, 4)
      for (const { i } of introductory) add(i)
      for (const { index, score } of ranked) if (score > 0) add(index)
      // No cross-language match: supply a bounded sample following the outline.
      for (let i = 0; i < chunks.length; i++) add(i)
    }
    pack.evidence = [...chosen.entries()].sort(([a], [b]) => a - b).map(([, e], i) => ({ ...e, evidenceId: `E${i + 1}` }))
    pack.truncated ||= pack.evidence.length < chunks.length
    if (!pack.evidence.length) throw new PaperContextError('RAG_LIMIT_EXCEEDED', '论文段落超过上下文预算')
    signal?.throwIfAborted()
    return paperContextResultSchema.parse(pack)
  }
}

import { createHash } from 'node:crypto'
import type { DocumentSnapshot } from '@features/document/contract/documentModel'
import type { RagChunk } from '../contract/ragChunk'
import { estimateTokens, structureAwareChunk, DEFAULT_CHUNK_HARD_MAX_TOKENS } from './structureAwareChunker'
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
export function documentContextChunks(snapshot: DocumentSnapshot, revision: string, indexed: readonly RagChunk[]): RagChunk[] {
  let section: readonly string[] = []
  const chunks = snapshot.original.filter(block => block.role === 'content').map<RagChunk>((block, ordinal) => {
    const source = snapshot.base.blocks[block.contentIndex!]!
    const text = block.source ?? block.markdown
    const previous = indexed.find(chunk => source.mappingIds.length && chunk.mappingIds.some(id => source.mappingIds.includes(id)))
    const heading = /^(#{1,6})\s+(.+)/u.exec(text)
    section = heading ? [...section.slice(0, heading[1]!.length - 1), heading[2]!] : previous?.sectionPath ?? section
    const pages = source.regions.map(region => region.pageIndex)
    return { chunkId: hash(source.id + ':' + hash(text)), contentRevisionId: revision, ordinal, contentHash: hash(text), sourceText: text, sectionPath: section,
      mappingIds: source.mappingIds, pageStart: pages.length ? Math.min(...pages) : null, pageEnd: pages.length ? Math.max(...pages) : null,
      sourceStartOffset: null, sourceEndOffset: null, offsetUnit: 'utf16', tokenCount: estimateTokens(text), contentType: heading ? 'heading' as const : previous?.contentType ?? 'paragraph' as const, mappingConfidence: source.mappingIds.length ? 'exact' : 'none' }
  })
  return chunks.flatMap(chunk => chunk.tokenCount <= DEFAULT_CHUNK_HARD_MAX_TOKENS ? [chunk] : structureAwareChunk({ documentId: snapshot.base.documentId, contentRevisionId: revision, contentHash: chunk.contentHash, sourceText: chunk.sourceText, mappings: snapshot.base.mappings, alignedBlocks: [{ markdown: chunk.sourceText, mappingIds: [...chunk.mappingIds] }] }).map(part => ({ ...part, chunkId: hash(chunk.chunkId + part.chunkId), sectionPath: part.sectionPath.length ? part.sectionPath : chunk.sectionPath, sourceStartOffset: null, sourceEndOffset: null }))).map((chunk, ordinal) => ({ ...chunk, ordinal }))
}

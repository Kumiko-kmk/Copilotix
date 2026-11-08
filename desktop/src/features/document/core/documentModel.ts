import type { BlockMapping } from '../contract/blocks'
import type { DocumentAnchor, DocumentBase, AnchorResolution } from '../contract/documentModel'
import { buildReaderBase } from './readerDocument'
import { buildReaderFigureGeometries } from './readerFigureGroups'
export const DOCUMENT_MODEL_VERSION = 1
export function buildDocumentBase(documentId: string, sourceVersion: string, markdown: string, mappings: BlockMapping[], layoutJson: string): DocumentBase {
  const reader = buildReaderBase(markdown, mappings)
  const byId = new Map(mappings.map(m => [m.id, m]))
  const blocks = reader.content.map((block, index) => ({
    id: sourceVersion + ':' + index, kind: byId.get(block.mappingIds[0] ?? '')?.type ?? 'text', markdown: block.markdown, mappingIds: block.mappingIds,
    regions: block.mappingIds.flatMap(id => byId.get(id)?.boxes ?? []),
    resources: [...new Set(block.mappingIds.flatMap(id => byId.get(id)?.sourceAsset ? [byId.get(id)!.sourceAsset!] : []))]
  }))
  reader.original = reader.original.map(block => block.contentIndex === undefined ? block : { ...block, annotationKey: 'document:' + blocks[block.contentIndex]!.id })
  return { ...reader, markdown, mappings, layoutJson, documentId, modelVersion: DOCUMENT_MODEL_VERSION, sourceVersion, blocks, readingOrder: blocks.map(b => b.id), figures: buildReaderFigureGeometries(mappings, layoutJson) }
}
export function resolveAnchor(base: DocumentBase, anchor: DocumentAnchor, hash: (value: string) => string): AnchorResolution {
  if (anchor.documentId !== base.documentId) return { status: 'unmatched', anchor }
  const candidates = anchor.sourceVersion === base.sourceVersion
    ? base.blocks.filter(b => b.id === anchor.blockId)
    : anchor.contentHash ? base.blocks.filter(b => hash(b.markdown) === anchor.contentHash) : []
  const block = candidates.length === 1 ? candidates[0] : undefined
  return block && (!anchor.quote || block.markdown.includes(anchor.quote)) ? { status: 'matched', block } : { status: 'unmatched', anchor }
}

import type { BlockBox, BlockMapping } from './blocks'
import type { ReaderBase } from '../core/readerDocument'
import type { ReaderFigureGeometry } from '../core/readerFigureGroups'
import type { ResolvedMarkdownEdits } from './markdownEdits'
export interface DocumentBlock { id: string; kind: string; markdown: string; mappingIds: string[]; regions: BlockBox[]; resources: string[] }
export interface DocumentBase extends ReaderBase {
  markdown: string; mappings: BlockMapping[]; layoutJson: string;
  documentId: string; modelVersion: 1; sourceVersion: string; blocks: DocumentBlock[]; readingOrder: string[]; figures: ReaderFigureGeometry[]
}
export interface DocumentSnapshot { base: DocumentBase; translationVersion: string; editVersion: number; edits: ResolvedMarkdownEdits | null; original: import('../core/readerDocument').ReaderBlock[]; translated: import('../core/readerDocument').ReaderBlock[]; originalText: string; translatedText: string }
export interface DocumentAnchor { documentId: string; sourceVersion: string; blockId: string; quote?: string; contentHash?: string; offset?: number }
export type AnchorResolution = { status: 'matched'; block: DocumentBlock } | { status: 'unmatched'; anchor: DocumentAnchor }
export interface DocumentModelDescriptor { documentId: string; sourceVersion: string; path: 'model/base.v1.json'; digest: string }

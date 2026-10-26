
/** Selections, annotations and chat selections of the reader views. */

export type BlockSelectionOrigin = 'pdf' | 'markdown' | 'scroll' | 'citation'

export interface BlockSelection {
  mappingId: string
  blockPosition?: string
  origin: BlockSelectionOrigin
}

export type ReaderAnnotationView = 'original' | 'translated'
export type ReaderAnnotationKind = 'highlight' | 'underline'
export type HighlightColor = 'yellow' | 'green' | 'blue' | 'pink' | 'purple'

export interface ReaderAnnotation {
  id: string
  taskId: string
  view: ReaderAnnotationView
  kind: ReaderAnnotationKind
  color: HighlightColor | null
  blockKey: string
  startOffset: number
  endOffset: number
  quote: string
  prefix: string
  suffix: string
  createdAt: string
  updatedAt: string
}

export interface ReplaceReaderAnnotationsRequest {
  taskId: string
  view: ReaderAnnotationView
  annotations: ReaderAnnotation[]
}

export interface ReaderChatSelectionFragment {
  blockKey: string
  startOffset: number
  endOffset: number
  quote: string
  mappingIds: string[]
  pageIndex?: number
}

export interface ReaderChatSelection {
  taskId: string
  view: ReaderAnnotationView
  text: string
  fragments: ReaderChatSelectionFragment[]
}


/** Document identity and the artifact kinds stored per document. */

export type DocumentId = string

export type ArtifactKind =
  | 'source_pdf'
  | 'parsed_markdown'
  | 'layout'
  | 'block_mappings'
  | 'content_list'
  | 'translated_markdown'
  | 'manifest'

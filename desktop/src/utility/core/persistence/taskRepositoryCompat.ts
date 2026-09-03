import type { ArtifactKind } from '@core/types'

/** Persistence-side artifact reference; it is never exposed as a renderer DTO. */
export interface ArtifactReference {
  id: string
  documentId: string
  kind: ArtifactKind
  revision: number
  relativePath: string
  contentHash: string
  metadata: Record<string, unknown>
}

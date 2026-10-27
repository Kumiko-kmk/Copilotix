
/** Parser layout boxes and the block mappings that tie PDF regions to Markdown blocks. */

export interface BlockBox {
  pageIndex: number
  bbox: [number, number, number, number]
  pageSize: [number, number]
  blockPosition: string
  isDiscarded?: boolean
  mergeRole?: 'source' | 'continuation'
}

export interface BlockMapping {
  id: string
  order: number
  type: string
  sourceText: string
  sourceAsset?: string
  boxes: BlockBox[]
}

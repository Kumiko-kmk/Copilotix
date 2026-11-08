import type { DocumentBase } from '../contract/documentModel'
import type { TranslatedMarkdownBlock } from '../contract/translation'
/** Keep historical text, but never attach a changed parse by its old ordinal. */
export function resolveTranslations(base: DocumentBase, blocks: TranslatedMarkdownBlock[] | null, hash: (text: string) => string): TranslatedMarkdownBlock[] | null {
  if (!blocks) return null
  const indexes = new Map<string, number[]>()
  base.content.forEach((block, index) => { const key = hash(block.markdown); indexes.set(key, [...(indexes.get(key) ?? []), index]) })
  const used = new Map<string, number>()
  for (const block of blocks) if (block.sourceHash) used.set(block.sourceHash, (used.get(block.sourceHash) ?? 0) + 1)
  return blocks.map(block => {
    if (block.sourceVersion === base.sourceVersion) return block
    const matches = block.sourceHash ? indexes.get(block.sourceHash) ?? [] : []
    const index = matches.length === 1 && used.get(block.sourceHash!) === 1 ? matches[0] : undefined
    return index === undefined
      ? { ...block, sourceIndex: undefined, mappingIds: [], unmatched: true, sourceChanged: true }
      : { ...block, sourceIndex: index, mappingIds: base.content[index]!.mappingIds, sourceVersion: base.sourceVersion, unmatched: undefined }
  })
}

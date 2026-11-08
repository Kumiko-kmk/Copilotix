import type { BlockMapping } from '../contract/blocks'
import type { TranslatedMarkdownBlock } from '../contract/translation'
import { type EditableBlock, editExcerpt, resolveMarkdownEdits, validOrder, type MarkdownEditsFile, type ResolvedMarkdownEdits } from '../contract/markdownEdits'
import { alignMarkdownBlocks } from './markdownBlocks'
import { readerContentMappings } from './readerDocument'
export function resolveReaderEdits(markdown: string, mappings: BlockMapping[], translatedBlocks: readonly TranslatedMarkdownBlock[] | null, file: MarkdownEditsFile, aligned: readonly EditableBlock[] | undefined, sha256: (text: string) => string, sourceVersion?: string): ResolvedMarkdownEdits {
  const mappingById = new Map(mappings.map((mapping) => [mapping.id, mapping]))
  const supplementalDeleted = file.supplementalDeleted.map(({ mappingId }) => ({ mappingId, excerpt: editExcerpt(mappingById.get(mappingId)?.sourceText ?? '') }))
  if (!file.blocks.length && !file.order) return { revision: file.revision, blocks: [], supplementalDeleted, boxMarks: file.boxMarks.map(item => item.mappingId), orphans: 0 }
  const base = aligned ?? alignMarkdownBlocks(markdown, readerContentMappings(mappings))
  const order = validOrder(file.order, base.length, sourceVersion)
  const { byIndex, orphans } = resolveMarkdownEdits(base, file, sha256, sourceVersion)
  const translatedBySource = new Map((translatedBlocks ?? []).map((block) => [block.sourceIndex, block]))
  const blocks = [...byIndex.entries()].sort(([a], [b]) => a - b).map(([index, entry]) => {
    const original = entry.original?.markdown ?? base[index]!.markdown
    const machine = translatedBySource.get(index)
    const stale = entry.translated ? entry.translated.sourceHash !== sha256(original)
      : Boolean(entry.original && machine && machine.sourceHash !== sha256(original))
    return {
      index, mappingIds: [...base[index]!.mappingIds], deleted: Boolean(entry.deletedAt), stale, excerpt: editExcerpt(original),
      ...(entry.original ? { original: entry.original.markdown } : {}),
      ...(entry.translated ? { translated: entry.translated.markdown } : {})
    }
  })
  return { revision: file.revision, blocks, supplementalDeleted, boxMarks: file.boxMarks.map(item => item.mappingId), ...(order ? { order } : {}), orphans: orphans.length }
}

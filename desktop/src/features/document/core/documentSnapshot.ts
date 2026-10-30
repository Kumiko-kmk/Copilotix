import { resolveTranslations } from './legacyTranslations'
import type { DocumentBase, DocumentSnapshot } from '../contract/documentModel'
import type { TranslatedMarkdownBlock } from '../contract/translation'
import { joinVisibleBlocks, type MarkdownEditsFile } from '../contract/markdownEdits'
import { resolveReaderEdits } from './legacyEdits'
import { buildTranslatedBase, withReaderEdits, type ReaderBlock } from './readerDocument'
export function getSnapshot(base: DocumentBase, translatedMarkdown: string, translatedBlocks: TranslatedMarkdownBlock[] | null, file: MarkdownEditsFile | null, hash: (text: string) => string): DocumentSnapshot {
  translatedBlocks = resolveTranslations(base, translatedBlocks, hash)
  const edits = file ? resolveReaderEdits(base.markdown, base.mappings, translatedBlocks, file, base.content, hash, base.sourceVersion) : null
  const translation = buildTranslatedBase(base, translatedMarkdown, translatedBlocks, base.mappings)
  const original = withReaderEdits(base.original, edits, 'original')
  const translated = translation.indexed ? withReaderEdits(translation.blocks, edits, 'translated') : translation.blocks
  const text = (blocks: ReaderBlock[]) => joinVisibleBlocks(blocks.filter(b => b.role === 'content').map(b => ({ markdown: b.source ?? b.markdown })))
  return { base, translationVersion: hash(JSON.stringify([translatedMarkdown, translatedBlocks])), editVersion: file?.revision ?? 0, edits, original, translated, originalText: text(original), translatedText: text(translated) }
}

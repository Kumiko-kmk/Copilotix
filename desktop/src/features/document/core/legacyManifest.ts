import type { DocumentBase } from '../contract/documentModel'
import type { TranslatedMarkdownBlock, TranslationProviderId } from '../contract/translation'
import { TRANSLATION_PIPELINE_VERSION, LEGACY_TRANSLATION_PIPELINE_VERSION, STANDARD_TRANSLATION_PIPELINE_VERSION, TABLE_TRANSLATION_PROTOCOL, BLOCK_MAPPING_VERSION, MARKDOWN_MAPPING_ALGORITHM_VERSION } from '../contract/artifactVersions'
export function readLegacyTranslations(manifest: unknown, base: DocumentBase, hash: (text: string) => string): TranslatedMarkdownBlock[] | null {
      if (!isRecord(manifest) || manifest.version !== 2 || manifest.taskId !== base.documentId ||
        ![TRANSLATION_PIPELINE_VERSION, LEGACY_TRANSLATION_PIPELINE_VERSION, STANDARD_TRANSLATION_PIPELINE_VERSION].includes(manifest.translationPipelineVersion as typeof TRANSLATION_PIPELINE_VERSION) ||
        manifest.tableTranslationProtocol !== TABLE_TRANSLATION_PROTOCOL ||
        !Array.isArray(manifest.blocks)) return null
      const changed = new Set(manifest.blocks.flatMap(block => isRecord(block) && typeof block.sourceIndex === 'number' && typeof block.sourceHash === 'string' && base.content[block.sourceIndex] && hash(base.content[block.sourceIndex]!.markdown) !== block.sourceHash ? [block.sourceIndex] : []))
      const blocks = manifest.blocks.map((block) => {
        if (!isRecord(block) || !Number.isInteger(block.sourceIndex) || (block.sourceIndex as number) < 0 || typeof block.markdown !== 'string') return null
        const mappingIds = Array.isArray(block.mappingIds) && block.mappingIds.every((id) => typeof id === 'string')
          ? [...block.mappingIds] as string[]
          : null
        // Older manifests may lack provider fields; those blocks simply carry no fallback mark.
        const fallbackProvider = block.status === 'completed' && isTranslationProvider(block.provider) &&
          isTranslationProvider(manifest.preferredProvider) && block.provider !== manifest.preferredProvider ? block.provider : undefined
        const sourceHash = typeof block.sourceHash === 'string' && /^[a-f0-9]{64}$/u.test(block.sourceHash) ? block.sourceHash : undefined
        const sourceChanged = changed.has(block.sourceIndex as number) ? true as const : undefined
        return { sourceIndex: block.sourceIndex as number, markdown: block.markdown, mappingIds, fallbackProvider, sourceHash, sourceChanged }
      })
      if (blocks.some((block) => block === null)) return null
      const validBlocks = blocks as Array<{ sourceIndex: number; markdown: string; mappingIds: string[] | null; fallbackProvider?: TranslationProviderId; sourceHash?: string; sourceChanged?: true }>
      const sourceIndexes = validBlocks.map((block) => block.sourceIndex)
      const validSourceOrder = new Set(sourceIndexes).size === sourceIndexes.length &&
        [...sourceIndexes].sort((left, right) => left - right).every((sourceIndex, index) => sourceIndex === index)
      const ordered = validSourceOrder
        ? [...validBlocks].sort((left, right) => left.sourceIndex - right.sourceIndex)
        : validBlocks
      const trustMappings = validSourceOrder && manifest.mappingAlgorithmVersion === MARKDOWN_MAPPING_ALGORITHM_VERSION &&
        manifest.blockMappingVersion === BLOCK_MAPPING_VERSION &&
        ordered.every((block) => Array.isArray(block.mappingIds))
      return ordered.map(({ sourceIndex, markdown, mappingIds, fallbackProvider, sourceHash, sourceChanged }) => ({
        sourceIndex,
        ...(typeof manifest.sourceVersion === 'string' ? { sourceVersion: manifest.sourceVersion } : {}),
        markdown,
        mappingIds: trustMappings ? mappingIds ?? [] : [],
        ...(fallbackProvider ? { fallbackProvider } : {}),
        ...(sourceHash ? { sourceHash } : {}),
        ...(sourceChanged ? { sourceChanged } : {})
      }))
}
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)) }
function isTranslationProvider(value: unknown): value is TranslationProviderId { return ['qwen', 'deepseek', 'codex', 'bing', 'transmart'].includes(String(value)) }

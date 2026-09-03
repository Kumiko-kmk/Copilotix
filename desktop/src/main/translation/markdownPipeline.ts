import { createHash } from 'node:crypto'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkStringify from 'remark-stringify'
import PQueue from 'p-queue'
import type {
  BlockMapping,
  MinerUTask,
  TranslatedMarkdownBlock,
  TranslationBlockRecord,
  TranslationProviderId
} from '@shared/types'
import type {
  TranslationBatchBlock,
  TranslationCacheEntry,
  TranslationCheckpointSummary
} from '@core/types'
import { alignMarkdownBlocks } from '@shared/markdownBlocks'
import { FALLBACK_PROVIDER_ORDER } from '@shared/constants'
import type { TaskRepositoryCompat } from '../taskRepositoryCompat'
import type { TranslationProvider } from './providers'
import { TranslationHttpError } from './providers'
import {
  applyTableTranslation,
  buildTableTranslationUnits,
  TABLE_TRANSLATION_CACHE_VERSION,
  validateTableTranslationResponse,
  type TableTranslationUnit
} from './tableTranslation'

interface PipelineOptions {
  task: MinerUTask
  /** Explicit durable job binding; omitted by legacy standalone callers. */
  jobId?: string
  markdown: string
  mappings: BlockMapping[]
  providers: Map<TranslationProviderId, TranslationProvider>
  repository: TaskRepositoryCompat
  onProgress(completed: number, total: number, failed: number, failedBlockIds?: readonly string[]): void | Promise<void>
}

export interface TranslationBlockResult extends TranslatedMarkdownBlock {
  blockId: string
  sourceIndex: number
  sourceHash: string
  sourceMarkdown: string
  provider: TranslationProviderId | null
  model: string | null
  status: TranslationBlockRecord['status']
  error: string | null
}

export interface TranslationResult {
  markdown: string
  blocks: TranslationBlockResult[]
  failedBlockIds: string[]
}

export const TRANSLATION_PIPELINE_VERSION = 'markdown-logical-block-v4-table-json-v2-references'
const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkStringify, { bullet: '-', fences: true, listItemIndent: 'one' })

export async function translateMarkdown(options: PipelineOptions): Promise<TranslationResult> {
  const sourceBlocks = alignMarkdownBlocks(options.markdown, options.mappings)
  const referenceActions = buildReferenceActions(sourceBlocks, options.mappings)
  const existing = new Map(
    (await options.repository.listTranslationBlocks(options.task.id, options.jobId)).map((block) => [block.blockId, block])
  )
  const results = new Array<TranslationBlockResult | undefined>(sourceBlocks.length)
  const tableUnits = buildTableTranslationUnits(sourceBlocks, options.mappings)
  const tableBySourceIndex = new Map<number, TableTranslationUnit>()
  const tableStartIndexes = new Set<number>()
  for (const unit of tableUnits) {
    const startIndex = Math.min(...unit.blocks.map((block) => block.sourceIndex))
    tableStartIndexes.add(startIndex)
    for (const block of unit.blocks) tableBySourceIndex.set(block.sourceIndex, unit)
  }
  type WorkItem =
    | { kind: 'table'; unit: TableTranslationUnit }
    | { kind: 'reference'; sourceBlock: (typeof sourceBlocks)[number]; sourceIndex: number; markdown: string }
    | { kind: 'block'; sourceBlock: (typeof sourceBlocks)[number]; sourceIndex: number }
  const workItems: WorkItem[] = []
  sourceBlocks.forEach((sourceBlock, sourceIndex) => {
    const referenceMarkdown = referenceActions.get(sourceIndex)
    if (referenceMarkdown !== undefined) {
      workItems.push({ kind: 'reference', sourceBlock, sourceIndex, markdown: referenceMarkdown })
      return
    }
    const tableUnit = tableBySourceIndex.get(sourceIndex)
    if (tableUnit) {
      if (tableStartIndexes.has(sourceIndex)) workItems.push({ kind: 'table', unit: tableUnit })
      return
    }
    workItems.push({ kind: 'block', sourceBlock, sourceIndex })
  })
  const queue = new PQueue({ concurrency: 3 })
  let completed = 0
  let failed = 0
  const committer = new TranslationBatchCommitter(options)

  const workPromises = workItems.map((workItem) =>
    queue.add(async () => {
        if (workItem.kind === 'reference') {
          const sourceHash = sha256(workItem.sourceBlock.markdown)
          const blockId = translationBlockId(options.task.id, workItem.sourceIndex, workItem.sourceBlock.mappingIds)
          const result = createBlockResult({
            blockId,
            sourceIndex: workItem.sourceIndex,
            sourceHash,
            sourceMarkdown: workItem.sourceBlock.markdown,
            markdown: workItem.markdown,
            mappingIds: workItem.sourceBlock.mappingIds,
            provider: null,
            model: null,
            status: 'completed',
            error: null
          })
          results[workItem.sourceIndex] = result
          completed += 1
          await committer.add([result], [], checkpointForResults(sourceBlocks.length, completed, failed, results))
          await options.onProgress(completed, sourceBlocks.length, failed, failedBlockIdsForResults(results))
          return
        }
        if (workItem.kind === 'table') {
          const tableResult = await translateTableWorkItem(workItem.unit, options, existing, results)
          const blockCount = workItem.unit.blocks.length
          if (workItem.unit.blocks.every((block) => results[block.sourceIndex]?.status === 'completed')) completed += blockCount
          else failed += blockCount
          await committer.add(
            tableResult.blocks,
            tableResult.cacheEntries,
            checkpointForResults(sourceBlocks.length, completed, failed, results)
          )
          await options.onProgress(completed, sourceBlocks.length, failed, failedBlockIdsForResults(results))
          return
        }

        const { sourceBlock, sourceIndex } = workItem
        const sourceMarkdown = sourceBlock.markdown
        const sourceHash = sha256(sourceMarkdown)
        const blockId = translationBlockId(options.task.id, sourceIndex, sourceBlock.mappingIds)
        const saved = existing.get(blockId)
        if (saved?.status === 'completed' && saved.sourceHash === sourceHash && saved.translatedMarkdown) {
          results[sourceIndex] = createBlockResult({
            blockId,
            sourceIndex,
            sourceHash,
            sourceMarkdown,
            markdown: saved.translatedMarkdown,
            mappingIds: sourceBlock.mappingIds,
            provider: saved.provider,
            model: saved.model,
            status: 'completed',
            error: null
          })
          completed += 1
          await options.onProgress(completed, sourceBlocks.length, failed, failedBlockIdsForResults(results))
          return
        }

        const sourceTree = processor.parse(sourceMarkdown) as any
        if (!containsTranslatableText(sourceTree)) {
          results[sourceIndex] = createBlockResult({
            blockId,
            sourceIndex,
            sourceHash,
            sourceMarkdown,
            markdown: sourceMarkdown,
            mappingIds: sourceBlock.mappingIds,
            provider: null,
            model: null,
            status: 'completed',
            error: null
          })
          completed += 1
          await committer.add([results[sourceIndex]!], [], checkpointForResults(sourceBlocks.length, completed, failed, results))
          await options.onProgress(completed, sourceBlocks.length, failed, failedBlockIdsForResults(results))
          return
        }

        let translated: Awaited<ReturnType<typeof translateBlock>>
        try {
          translated = await translateBlock(
            sourceTree,
            sourceHash,
            options.task.translationProvider,
            options.providers,
            options.repository
          )
          results[sourceIndex] = createBlockResult({
            blockId,
            sourceIndex,
            sourceHash,
            sourceMarkdown,
            markdown: translated.markdown,
            mappingIds: sourceBlock.mappingIds,
            provider: translated.provider,
            model: translated.model,
            status: 'completed',
            error: null
          })
          completed += 1
        } catch (error) {
          const message = readableError(error)
          results[sourceIndex] = createBlockResult({
            blockId,
            sourceIndex,
            sourceHash,
            sourceMarkdown,
            markdown: sourceMarkdown,
            mappingIds: sourceBlock.mappingIds,
            provider: null,
            model: null,
            status: 'failed',
            error: message
          })
          failed += 1
          await committer.add([results[sourceIndex]!], [], checkpointForResults(sourceBlocks.length, completed, failed, results))
          await options.onProgress(completed, sourceBlocks.length, failed, failedBlockIdsForResults(results))
          return
        }
        await committer.add(
          [results[sourceIndex]!],
          translated.cacheEntry ? [translated.cacheEntry] : [],
          checkpointForResults(sourceBlocks.length, completed, failed, results)
        )
        await options.onProgress(completed, sourceBlocks.length, failed, failedBlockIdsForResults(results))
    })
  )
  const settled = await Promise.allSettled(workPromises)
  await queue.onIdle()
  const workerFailure = settled.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
  let flushError: unknown
  try {
    // All queue work is settled before this final flush, so no worker can append
    // after the last batch has been submitted.
    await committer.flush()
  } catch (error) {
    flushError = error
  }
  if (workerFailure) throw workerFailure.reason
  if (flushError !== undefined) throw flushError

  const orderedBlocks = results.map((result, index) => {
    if (!result) throw new Error(`翻译区块 ${index} 未生成结果`)
    return result
  })
  return {
    markdown: joinMarkdownBlocks(orderedBlocks.map((block) => block.markdown)),
    blocks: orderedBlocks,
    failedBlockIds: orderedBlocks.filter((block) => block.status === 'failed').map((block) => block.blockId)
  }
}

async function translateTableWorkItem(
  unit: TableTranslationUnit,
  options: PipelineOptions,
  existing: Map<string, TranslationBlockRecord>,
  results: Array<TranslationBlockResult | undefined>
): Promise<{ blocks: TranslationBlockResult[]; cacheEntries: TranslationCacheEntry[] }> {
  const savedBlocks = unit.blocks.map((sourceBlock) => {
    const sourceHash = sha256(sourceBlock.markdown)
    const blockId = translationBlockId(options.task.id, sourceBlock.sourceIndex, sourceBlock.mappingIds)
    return { sourceBlock, sourceHash, blockId, saved: existing.get(blockId) }
  })
  if (savedBlocks.every(({ saved, sourceHash }) => saved?.status === 'completed' && saved.sourceHash === sourceHash && saved.translatedMarkdown)) {
    const translatedBlocks: TranslationBlockResult[] = []
    for (const { sourceBlock, sourceHash, blockId, saved } of savedBlocks) {
      const result = createBlockResult({
        blockId,
        sourceIndex: sourceBlock.sourceIndex,
        sourceHash,
        sourceMarkdown: sourceBlock.markdown,
        markdown: saved!.translatedMarkdown!,
        mappingIds: sourceBlock.mappingIds,
        provider: saved!.provider,
        model: saved!.model,
        status: 'completed',
        error: null
      })
      results[sourceBlock.sourceIndex] = result
      translatedBlocks.push(result)
    }
    return { blocks: translatedBlocks, cacheEntries: [] }
  }

  if (!unit.plan.hasTranslatableText) {
    const translatedBlocks: TranslationBlockResult[] = []
    for (const { sourceBlock, sourceHash, blockId } of savedBlocks) {
      const result = createBlockResult({
        blockId,
        sourceIndex: sourceBlock.sourceIndex,
        sourceHash,
        sourceMarkdown: sourceBlock.markdown,
        markdown: sourceBlock.markdown,
        mappingIds: sourceBlock.mappingIds,
        provider: null,
        model: null,
        status: 'completed',
        error: null
      })
      results[sourceBlock.sourceIndex] = result
      translatedBlocks.push(result)
    }
    return { blocks: translatedBlocks, cacheEntries: [] }
  }

  try {
    const translated = await translateTableUnit(
      unit,
      options.task.translationProvider,
      options.providers,
      options.repository
    )
    const translatedBlocks: TranslationBlockResult[] = []
    for (const { sourceBlock, sourceHash, blockId } of savedBlocks) {
      const markdown = translated.markdownBySourceIndex.get(sourceBlock.sourceIndex)
      if (markdown === undefined) throw new Error(`表格区块 ${sourceBlock.sourceIndex} 未生成译文`)
      const result = createBlockResult({
        blockId,
        sourceIndex: sourceBlock.sourceIndex,
        sourceHash,
        sourceMarkdown: sourceBlock.markdown,
        markdown,
        mappingIds: sourceBlock.mappingIds,
        provider: translated.provider,
        model: translated.model,
        status: 'completed',
        error: null
      })
      results[sourceBlock.sourceIndex] = result
      translatedBlocks.push(result)
    }
    return {
      blocks: translatedBlocks,
      cacheEntries: translated.cacheEntry ? [translated.cacheEntry] : []
    }
  } catch (error) {
    const message = readableError(error)
    const failedBlocks: TranslationBlockResult[] = []
    for (const { sourceBlock, sourceHash, blockId } of savedBlocks) {
      const result = createBlockResult({
        blockId,
        sourceIndex: sourceBlock.sourceIndex,
        sourceHash,
        sourceMarkdown: sourceBlock.markdown,
        markdown: sourceBlock.markdown,
        mappingIds: sourceBlock.mappingIds,
        provider: null,
        model: null,
        status: 'failed',
        error: message
      })
      results[sourceBlock.sourceIndex] = result
      failedBlocks.push(result)
    }
    return { blocks: failedBlocks, cacheEntries: [] }
  }
}

async function translateTableUnit(
  unit: TableTranslationUnit,
  preferred: TranslationProviderId,
  providers: Map<TranslationProviderId, TranslationProvider>,
  repository: TaskRepositoryCompat
): Promise<{
  markdownBySourceIndex: Map<number, string>
  provider: TranslationProviderId
  model: string
  cacheEntry?: TranslationCacheEntry
}> {
  const sourceHash = sha256(unit.blocks.map((block) => `${block.sourceIndex}\u0000${block.markdown}`).join('\u0000'))
  const order = [preferred, ...FALLBACK_PROVIDER_ORDER.filter((provider) => provider !== preferred)]
  const errors: string[] = []
  for (const providerId of order) {
    const provider = providers.get(providerId)
    if (!provider || !(await provider.isAvailable())) continue
    const cacheKey = sha256(
      `${TRANSLATION_PIPELINE_VERSION}|table|${TABLE_TRANSLATION_CACHE_VERSION}|${provider.id}|${provider.model}|zh-CN|${sourceHash}`
    )
    const cached = await repository.getCache(cacheKey)
    if (cached) {
      try {
        const cache = JSON.parse(cached) as { version?: unknown; sourceHash?: unknown; response?: unknown }
        if (cache.version !== TABLE_TRANSLATION_CACHE_VERSION || cache.sourceHash !== sourceHash) {
          throw new Error('表格缓存版本或来源不匹配')
        }
        const response = validateTableTranslationResponse(cache.response, unit.plan.request)
        applyTableTranslation(unit.plan, response)
        return {
          markdownBySourceIndex: new Map(unit.plan.blocks.map((block) => [block.sourceIndex, block.render()])),
          provider: provider.id,
          model: provider.model
        }
      } catch {
        // Ignore an invalid cache entry and request a fresh complete-table translation.
      }
    }

    try {
      const response = await withRetry(() => provider.translateTable(unit.plan.request))
      applyTableTranslation(unit.plan, response)
      return {
        markdownBySourceIndex: new Map(unit.plan.blocks.map((block) => [block.sourceIndex, block.render()])),
        provider: provider.id,
        model: provider.model,
        cacheEntry: {
          cacheKey,
          translated: JSON.stringify({ version: TABLE_TRANSLATION_CACHE_VERSION, sourceHash, response }),
          provider: provider.id,
          model: provider.model
        }
      }
    } catch (error) {
      errors.push(`${providerId}: ${readableError(error)}`)
    }
  }
  throw new Error(errors.length > 0 ? errors.join('；') : '没有可用的翻译源')
}

async function translateBlock(
  sourceTree: any,
  sourceHash: string,
  preferred: TranslationProviderId,
  providers: Map<TranslationProviderId, TranslationProvider>,
  repository: TaskRepositoryCompat
): Promise<{
  markdown: string
  provider: TranslationProviderId
  model: string
  cacheEntry?: TranslationCacheEntry
}> {
  const order = [preferred, ...FALLBACK_PROVIDER_ORDER.filter((provider) => provider !== preferred)]
  const errors: string[] = []
  for (const providerId of order) {
    const provider = providers.get(providerId)
    if (!provider || !(await provider.isAvailable())) continue
    const cacheKey = sha256(`${TRANSLATION_PIPELINE_VERSION}|${provider.id}|${provider.model}|zh-CN|${sourceHash}`)
    const cached = await repository.getCache(cacheKey)
    if (cached) return { markdown: cached, provider: provider.id, model: provider.model }

    try {
      const clone = structuredClone(sourceTree)
      await translateTextNodes(clone, provider)
      const markdown = stringifyTree(clone)
      return {
        markdown,
        provider: provider.id,
        model: provider.model,
        cacheEntry: { cacheKey, translated: markdown, provider: provider.id, model: provider.model }
      }
    } catch (error) {
      errors.push(`${providerId}: ${readableError(error)}`)
    }
  }
  throw new Error(errors.length > 0 ? errors.join('；') : '没有可用的翻译源')
}

async function translateTextNodes(node: any, provider: TranslationProvider, protectedAncestor = false): Promise<void> {
  const protectedHere = protectedAncestor || ['code', 'inlineCode', 'math', 'inlineMath', 'html'].includes(node?.type)
  if (node?.type === 'text' && !protectedHere && shouldTranslate(node.value)) {
    const source = String(node.value)
    node.value = await withRetry(async () => normalizeTranslatedText(source, await translateLongText(source, provider)))
    return
  }
  if (!Array.isArray(node?.children)) return
  for (const child of node.children) await translateTextNodes(child, provider, protectedHere)
}

function normalizeTranslatedText(source: string, translated: string): string {
  const leadingWhitespace = source.match(/^[\p{Zs}\t]+/u)?.[0] ?? ''
  const trailingWhitespace = source.match(/[\p{Zs}\t]+$/u)?.[0] ?? ''
  const value = translated.trim()
  if (!value) throw new Error('翻译源返回了空译文')
  const normalized = value.replace(/\r\n?/g, '\n')
  const content = !/[\r\n]/.test(source)
    ? normalized.replace(/[ \t]*\n+[ \t]*/g, ' ')
    : normalized.replace(/\n{2,}/g, '\n')
  return `${leadingWhitespace}${content}${trailingWhitespace}`
}

async function translateLongText(text: string, provider: TranslationProvider): Promise<string> {
  if (text.length <= 4_000) return provider.translate(text)
  const parts = splitText(text, 4_000)
  const translated: string[] = []
  for (const part of parts) translated.push(await provider.translate(part))
  return translated.join('')
}

async function withRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (attempt === 2) break
      const retryAfter = error instanceof TranslationHttpError ? error.retryAfterMs : undefined
      await delay(retryAfter ?? 1_000 * 2 ** attempt)
    }
  }
  throw lastError
}

function containsTranslatableText(node: any, protectedAncestor = false): boolean {
  const protectedHere = protectedAncestor || ['code', 'inlineCode', 'math', 'inlineMath', 'html'].includes(node?.type)
  if (node?.type === 'text' && !protectedHere && shouldTranslate(node.value)) return true
  return Array.isArray(node?.children) && node.children.some((child: any) => containsTranslatableText(child, protectedHere))
}

export function shouldTranslate(value: unknown): boolean {
  if (typeof value !== 'string' || !/[A-Za-z\p{L}]/u.test(value)) return false
  const letters = value.match(/[A-Za-z]/g)?.length ?? 0
  const han = value.match(/[\p{Script=Han}]/gu)?.length ?? 0
  return letters > 0 || han === 0
}

function stringifyTree(tree: any): string {
  return String(processor.stringify(tree)).trimEnd()
}

function joinMarkdownBlocks(blocks: string[]): string {
  return blocks.length > 0 ? `${blocks.map((block) => block.trimEnd()).join('\n\n')}\n` : ''
}

function splitText(text: string, limit: number): string[] {
  const parts: string[] = []
  let remaining = text
  while (remaining.length > limit) {
    const slice = remaining.slice(0, limit)
    const boundary = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('。'), slice.lastIndexOf('; '), slice.lastIndexOf(' '))
    const end = boundary > limit / 2 ? boundary + 1 : limit
    parts.push(remaining.slice(0, end))
    remaining = remaining.slice(end)
  }
  if (remaining) parts.push(remaining)
  return parts
}

function buildReferenceActions(
  sourceBlocks: Array<{ markdown: string; mappingIds: string[] }>,
  mappings: BlockMapping[]
): Map<number, string> {
  const mappingById = new Map(mappings.map((mapping) => [mapping.id, mapping]))
  const actions = new Map<number, string>()
  let preserveUnmappedEntries = false

  sourceBlocks.forEach((block, sourceIndex) => {
    const node = parseSingleBlockNode(block.markdown)
    const headingLevel = referenceHeadingLevel(node)
    if (headingLevel !== null) {
      actions.set(sourceIndex, `${'#'.repeat(headingLevel)} 参考文献`)
      preserveUnmappedEntries = true
      return
    }

    const mappedReference = block.mappingIds.some((id) => isReferenceMappingType(mappingById.get(id)?.type))
    if (mappedReference) {
      actions.set(sourceIndex, block.markdown)
      return
    }

    if (node?.type === 'heading') {
      preserveUnmappedEntries = false
      return
    }
    if (preserveUnmappedEntries && (node?.type === 'paragraph' || node?.type === 'list')) {
      actions.set(sourceIndex, block.markdown)
      return
    }
    if (preserveUnmappedEntries) preserveUnmappedEntries = false
  })

  return actions
}

function parseSingleBlockNode(markdown: string): any | null {
  const tree = processor.parse(markdown) as any
  return Array.isArray(tree.children) && tree.children.length === 1 ? tree.children[0] : null
}

function referenceHeadingLevel(node: any): number | null {
  if (node?.type !== 'heading' || typeof node.depth !== 'number') return null
  const title = visibleNodeText(node)
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/\s+/g, ' ')
    .replace(/[.:：。]+$/u, '')
  return REFERENCE_HEADINGS.has(title) ? node.depth : null
}

function visibleNodeText(node: any): string {
  if (!node || typeof node !== 'object') return ''
  if (typeof node.value === 'string' && ['text', 'inlineCode'].includes(node.type)) return node.value
  return Array.isArray(node.children) ? node.children.map(visibleNodeText).join('') : ''
}

function isReferenceMappingType(value: unknown): boolean {
  return typeof value === 'string' && ['ref_text', 'reference', 'bibliography'].includes(value.toLocaleLowerCase('en-US'))
}

const REFERENCE_HEADINGS = new Set([
  'references',
  'reference',
  'bibliography',
  'works cited',
  'literature cited',
  '参考文献',
  '參考文獻',
  '引用'
])

function createBlockResult(result: TranslationBlockResult): TranslationBlockResult {
  return { ...result, mappingIds: [...result.mappingIds] }
}

class TranslationBatchCommitter {
  private static readonly MAX_BLOCKS = 32
  private static readonly MAX_PAYLOAD_BYTES = 768 * 1024
  /** Leave room for the RPC version, request id, operation, and response envelope. */
  private static readonly ENVELOPE_RESERVE_BYTES = 4 * 1024
  private static readonly MAX_SEND_BYTES = TranslationBatchCommitter.MAX_PAYLOAD_BYTES - TranslationBatchCommitter.ENVELOPE_RESERVE_BYTES
  private blocks: TranslationBatchBlock[] = []
  private cacheEntries: TranslationCacheEntry[] = []
  private checkpointSnapshot: TranslationCheckpointSummary | undefined
  private tail: Promise<void> = Promise.resolve()

  constructor(private readonly options: PipelineOptions) {}

  add(
    blocks: TranslationBlockResult[],
    cacheEntries: TranslationCacheEntry[] = [],
    checkpoint?: TranslationCheckpointSummary
  ): Promise<void> {
    const snapshot = checkpoint ? cloneCheckpoint(checkpoint) : undefined
    const operation = this.tail.then(() => this.addNow(blocks, cacheEntries, snapshot))
    // Keep the serial chain usable after a rejected operation. The returned
    // operation still rejects so the originating worker reports the failure.
    this.tail = operation.catch(() => undefined)
    return operation
  }

  flush(): Promise<void> {
    const operation = this.tail.then(() => this.flushNow())
    this.tail = operation.catch(() => undefined)
    return operation
  }

  private async addNow(
    blocks: TranslationBlockResult[],
    cacheEntries: TranslationCacheEntry[],
    checkpoint?: TranslationCheckpointSummary
  ): Promise<void> {
    const batchBlocks = blocks.map(toBatchBlock)
    if (batchBlocks.length > TranslationBatchCommitter.MAX_BLOCKS || cacheEntries.length > TranslationBatchCommitter.MAX_BLOCKS) {
      throw new Error('翻译批次超过 32 条限制')
    }
    const candidateBlocks = [...this.blocks, ...batchBlocks]
    const candidateCacheEntries = [...this.cacheEntries, ...cacheEntries]
    const candidateCheckpoint = checkpoint ?? this.checkpointSnapshot
    if (this.hasBufferedEntries() &&
      (candidateBlocks.length > TranslationBatchCommitter.MAX_BLOCKS ||
        candidateCacheEntries.length > TranslationBatchCommitter.MAX_BLOCKS ||
        estimateTranslationBatchBytes(this.options, candidateBlocks, candidateCacheEntries, candidateCheckpoint) > TranslationBatchCommitter.MAX_SEND_BYTES)) {
      await this.flushNow()
    }

    const standaloneBytes = estimateTranslationBatchBytes(this.options, batchBlocks, cacheEntries, checkpoint)
    if (standaloneBytes > TranslationBatchCommitter.MAX_SEND_BYTES) {
      throw new Error('翻译批次 UTF-8 大小超过 768KiB（已预留 RPC envelope 空间）')
    }
    this.blocks.push(...batchBlocks)
    this.cacheEntries.push(...cacheEntries)
    if (checkpoint) this.checkpointSnapshot = checkpoint
    const bufferedBytes = estimateTranslationBatchBytes(this.options, this.blocks, this.cacheEntries, this.checkpointSnapshot)
    if (this.blocks.length >= TranslationBatchCommitter.MAX_BLOCKS ||
      this.cacheEntries.length >= TranslationBatchCommitter.MAX_BLOCKS ||
      bufferedBytes >= TranslationBatchCommitter.MAX_SEND_BYTES) {
      await this.flushNow()
    }
  }

  private async flushNow(): Promise<void> {
    if (!this.hasBufferedEntries()) return
    const blocks = this.blocks
    const cacheEntries = this.cacheEntries
    const checkpoint = this.checkpointSnapshot

    if (this.options.jobId && this.options.repository.commitTranslationBatch) {
      await this.options.repository.commitTranslationBatch({
        taskId: this.options.task.id,
        jobId: this.options.jobId,
        blocks,
        cacheEntries,
        ...(checkpoint ? { checkpoint } : {})
      })
    } else {
      // Legacy standalone callers do not have the durable batch RPC; keep them
      // compatible while durable runners always take the single-transaction path.
      for (const block of blocks) {
        await this.options.repository.upsertTranslationBlock({
          taskId: this.options.task.id,
          ...(this.options.jobId ? { jobId: this.options.jobId } : {}),
          blockId: block.blockId,
          sourceHash: block.sourceHash,
          sourceMarkdown: block.sourceMarkdown,
          translatedMarkdown: block.status === 'completed' ? block.translatedMarkdown : null,
          provider: block.provider,
          model: block.model,
          status: block.status,
          error: block.error
        })
      }
      for (const entry of cacheEntries) {
        await this.options.repository.putCache(entry.cacheKey, entry.translated, entry.provider, entry.model)
      }
    }
    // Clear only after the complete batch has been accepted. On rejection the
    // arrays remain intact, allowing a later final flush to retry explicitly.
    this.blocks = []
    this.cacheEntries = []
    this.checkpointSnapshot = undefined
  }

  private hasBufferedEntries(): boolean {
    return this.blocks.length > 0 || this.cacheEntries.length > 0
  }
}

function toBatchBlock(block: TranslationBlockResult): TranslationBatchBlock {
  return {
    blockId: block.blockId,
    sourceHash: block.sourceHash,
    sourceMarkdown: block.sourceMarkdown,
    translatedMarkdown: block.status === 'completed' ? block.markdown : null,
    provider: block.provider,
    model: block.model,
    status: block.status,
    error: block.error
  }
}

function estimateTranslationBatchBytes(
  options: PipelineOptions,
  blocks: TranslationBatchBlock[],
  cacheEntries: TranslationCacheEntry[],
  checkpoint?: TranslationCheckpointSummary
): number {
  const payload = {
    taskId: options.task.id,
    ...(options.jobId ? { jobId: options.jobId } : {}),
    blocks,
    cacheEntries,
    ...(checkpoint ? { checkpoint } : {})
  }
  return utf8JsonByteLength(JSON.stringify(payload))
}

function utf8JsonByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function failedBlockIdsForResults(results: Array<TranslationBlockResult | undefined>): string[] {
  return results
    .filter((result): result is TranslationBlockResult => result?.status === 'failed')
    .map((result) => result.blockId)
    .slice(0, 64)
}

function checkpointForResults(
  totalBlocks: number,
  completedBlocks: number,
  failedBlocks: number,
  results: Array<TranslationBlockResult | undefined>
): TranslationCheckpointSummary {
  return {
    totalBlocks,
    completedBlocks,
    failedBlocks,
    failedBlockIds: failedBlockIdsForResults(results)
  }
}

function cloneCheckpoint(checkpoint: TranslationCheckpointSummary): TranslationCheckpointSummary {
  return { ...checkpoint, failedBlockIds: [...checkpoint.failedBlockIds].slice(0, 64) }
}

function translationBlockId(taskId: string, sourceIndex: number, mappingIds: string[]): string {
  const digest = sha256(`${TRANSLATION_PIPELINE_VERSION}|${taskId}|${sourceIndex}|${mappingIds.join('|')}`)
  return `translation-${digest.slice(0, 20)}`
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function readableError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

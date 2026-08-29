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
import { alignMarkdownBlocks } from '@shared/markdownBlocks'
import { FALLBACK_PROVIDER_ORDER } from '@shared/constants'
import type { TaskRepository } from '../database'
import type { TranslationProvider } from './providers'
import { TranslationHttpError } from './providers'

interface PipelineOptions {
  task: MinerUTask
  markdown: string
  mappings: BlockMapping[]
  providers: Map<TranslationProviderId, TranslationProvider>
  repository: TaskRepository
  onProgress(completed: number, total: number, failed: number): void
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

const TRANSLATION_PIPELINE_VERSION = 'markdown-logical-block-v2'
const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkStringify, { bullet: '-', fences: true, listItemIndent: 'one' })

export async function translateMarkdown(options: PipelineOptions): Promise<TranslationResult> {
  const sourceBlocks = alignMarkdownBlocks(options.markdown, options.mappings)
  const existing = new Map(
    options.repository.listTranslationBlocks(options.task.id).map((block) => [block.blockId, block])
  )
  const results = new Array<TranslationBlockResult | undefined>(sourceBlocks.length)
  const queue = new PQueue({ concurrency: 3 })
  let completed = 0
  let failed = 0

  await Promise.all(
    sourceBlocks.map((sourceBlock, sourceIndex) =>
      queue.add(async () => {
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
          options.onProgress(completed, sourceBlocks.length, failed)
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
          saveBlock(options.repository, options.task.id, results[sourceIndex]!)
          completed += 1
          options.onProgress(completed, sourceBlocks.length, failed)
          return
        }

        try {
          const translated = await translateBlock(
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
          saveBlock(options.repository, options.task.id, results[sourceIndex]!)
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
          saveBlock(options.repository, options.task.id, results[sourceIndex]!)
        }
        options.onProgress(completed, sourceBlocks.length, failed)
      })
    )
  )

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

async function translateBlock(
  sourceTree: any,
  sourceHash: string,
  preferred: TranslationProviderId,
  providers: Map<TranslationProviderId, TranslationProvider>,
  repository: TaskRepository
): Promise<{ markdown: string; provider: TranslationProviderId; model: string }> {
  const order = [preferred, ...FALLBACK_PROVIDER_ORDER.filter((provider) => provider !== preferred)]
  const errors: string[] = []
  for (const providerId of order) {
    const provider = providers.get(providerId)
    if (!provider || !(await provider.isAvailable())) continue
    const cacheKey = sha256(`${TRANSLATION_PIPELINE_VERSION}|${provider.id}|${provider.model}|zh-CN|${sourceHash}`)
    const cached = repository.getCache(cacheKey)
    if (cached) return { markdown: cached, provider: provider.id, model: provider.model }

    try {
      const clone = structuredClone(sourceTree)
      await translateTextNodes(clone, provider)
      const markdown = stringifyTree(clone)
      repository.putCache(cacheKey, markdown, provider.id, provider.model)
      return { markdown, provider: provider.id, model: provider.model }
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

function createBlockResult(result: TranslationBlockResult): TranslationBlockResult {
  return { ...result, mappingIds: [...result.mappingIds] }
}

function saveBlock(repository: TaskRepository, taskId: string, block: TranslationBlockResult): void {
  repository.upsertTranslationBlock({
    taskId,
    blockId: block.blockId,
    sourceHash: block.sourceHash,
    sourceMarkdown: block.sourceMarkdown,
    translatedMarkdown: block.status === 'completed' ? block.markdown : null,
    provider: block.provider,
    model: block.model,
    status: block.status,
    error: block.error
  })
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

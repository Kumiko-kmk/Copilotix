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

interface TranslationResult {
  markdown: string
  failedBlockIds: string[]
}

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkStringify, { bullet: '-', fences: true, listItemIndent: 'one' })

export async function translateMarkdown(options: PipelineOptions): Promise<TranslationResult> {
  const tree = processor.parse(options.markdown) as any
  const children: any[] = Array.isArray(tree.children) ? tree.children : []
  const alignedBlocks = alignMarkdownBlocks(options.markdown, options.mappings)
  const existing = new Map(
    options.repository.listTranslationBlocks(options.task.id).map((block) => [block.blockId, block])
  )
  const results = new Array<string>(children.length)
  const failedBlockIds: string[] = []
  const queue = new PQueue({ concurrency: 3 })
  let completed = 0

  await Promise.all(
    children.map((child, index) =>
      queue.add(async () => {
        const sourceMarkdown = stringifyNode(child)
        const sourceHash = sha256(sourceMarkdown)
        const blockId = alignedBlocks[index]?.mappingIds[0] ?? `markdown-${index}-${sourceHash.slice(0, 12)}`
        const saved = existing.get(blockId)
        if (saved?.status === 'completed' && saved.sourceHash === sourceHash && saved.translatedMarkdown) {
          results[index] = saved.translatedMarkdown
          completed += 1
          options.onProgress(completed, children.length, failedBlockIds.length)
          return
        }

        if (!containsTranslatableText(child)) {
          results[index] = sourceMarkdown
          saveBlock(options.repository, options.task.id, blockId, sourceHash, sourceMarkdown, sourceMarkdown, null, null, 'completed', null)
          completed += 1
          options.onProgress(completed, children.length, failedBlockIds.length)
          return
        }

        try {
          const translated = await translateBlock(
            child,
            sourceHash,
            options.task.translationProvider,
            options.providers,
            options.repository
          )
          results[index] = translated.markdown
          saveBlock(
            options.repository,
            options.task.id,
            blockId,
            sourceHash,
            sourceMarkdown,
            translated.markdown,
            translated.provider,
            translated.model,
            'completed',
            null
          )
          completed += 1
        } catch (error) {
          results[index] = sourceMarkdown
          failedBlockIds.push(blockId)
          saveBlock(
            options.repository,
            options.task.id,
            blockId,
            sourceHash,
            sourceMarkdown,
            null,
            null,
            null,
            'failed',
            readableError(error)
          )
        }
        options.onProgress(completed, children.length, failedBlockIds.length)
      })
    )
  )

  return { markdown: results.join('\n\n').trimEnd() + '\n', failedBlockIds }
}

async function translateBlock(
  sourceNode: any,
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
    const cacheKey = sha256(`${provider.id}|${provider.model}|zh-CN|${sourceHash}`)
    const cached = repository.getCache(cacheKey)
    if (cached) return { markdown: cached, provider: provider.id, model: provider.model }

    try {
      const clone = structuredClone(sourceNode)
      await translateTextNodes(clone, provider)
      const markdown = stringifyNode(clone)
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
    node.value = await withRetry(() => translateLongText(String(node.value), provider))
    return
  }
  if (!Array.isArray(node?.children)) return
  for (const child of node.children) await translateTextNodes(child, provider, protectedHere)
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

function stringifyNode(node: any): string {
  return String(processor.stringify({ type: 'root', children: [node] } as any)).trimEnd()
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

function saveBlock(
  repository: TaskRepository,
  taskId: string,
  blockId: string,
  sourceHash: string,
  sourceMarkdown: string,
  translatedMarkdown: string | null,
  provider: TranslationProviderId | null,
  model: string | null,
  status: TranslationBlockRecord['status'],
  error: string | null
): void {
  repository.upsertTranslationBlock({
    taskId,
    blockId,
    sourceHash,
    sourceMarkdown,
    translatedMarkdown,
    provider,
    model,
    status,
    error
  })
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

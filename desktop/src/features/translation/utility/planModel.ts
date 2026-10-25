import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { unified } from 'unified'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkParse from 'remark-parse'
import remarkStringify from 'remark-stringify'
import type { TranslationBatchCommit } from '@core/types'
import type { BlockMapping, TranslationBlockRecord, TranslationProviderId } from '@shared/types'
import { type AlignedMarkdownBlock } from '@shared/markdownBlocks'
import { MARKDOWN_MAPPING_ALGORITHM_VERSION, TABLE_TRANSLATION_CACHE_VERSION, TABLE_TRANSLATION_PROTOCOL, TRANSLATION_PIPELINE_VERSION, translationPlanMutationResultSchema, type TableTranslationResponse, type TranslationPlanMutationResult, type TranslationPlanRequest, type TranslationPlanUnitKind, type TranslationPlanWorkDescriptor } from '../contract/translationPlanProtocol'
import { type TableTranslationPlan } from './tableTranslation'
import type { TranslationJobBinding } from '../../../utility/core/persistence/v2TaskRepositoryCompat'

/** State, metadata shapes and pure helpers of the translation plan; the stateful manager is in ./markdownTranslationPlan. */
export const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkStringify, { bullet: '-', fences: true, listItemIndent: 'one' })

export const PROTECTED_NODE_TYPES = new Set(['code', 'inlineCode', 'math', 'inlineMath', 'html'])

export const REFERENCE_HEADINGS = new Set([
  'references',
  'reference',
  'bibliography',
  'works cited',
  'literature cited',
  '参考文献',
  '參考文獻',
  '引用'
])

export const MAX_TRANSLATION_BATCH_ITEMS = 32

export const MAX_TRANSLATION_BATCH_BYTES = 768 * 1024

export const MAX_TRANSLATION_FIELD_BYTES = 262_144

/** Narrow utility-side persistence surface used by the file-backed manager. */
export interface TranslationPlanRepository {
  requireTranslationJobBinding(taskId: string, jobId: string): TranslationJobBinding
  listTranslationBlocks(taskId: string, jobId?: string): TranslationBlockRecord[]
  getCache(cacheKey: string): string | null
  commitTranslationBatch(input: TranslationBatchCommit): void
  recordArtifactRevision?(
    taskId: string,
    kind: 'translated_markdown' | 'manifest',
    path: string,
    checksum: string,
    metadata?: Record<string, unknown>,
    jobId?: string
  ): void
}

export interface TranslationPlanManagerOptions {
  /** Override the mapping-file version for focused utility fixtures. */
  blockMappingVersion?: number
  /** Configured utility output root; bindings must resolve to its document. */
  outputRoot?: string
}

export interface UnitState {
  descriptor: TranslationPlanWorkDescriptor
  blockIds: string[]
  sourceIndexes: number[]
  mappingIds: string[][]
  sourceMarkdowns: string[]
  blockResultPaths: string[]
  request: TranslationPlanRequest
  tablePlan?: TableTranslationPlan
  status: TranslationPlanWorkDescriptor['status']
  provider: TranslationProviderId | null
  model: string | null
  error: string | null
  initialResults: string[]
  cacheResponse?: TableTranslationResponse
}

export interface PlanState {
  binding: TranslationJobBinding
  taskId: string
  jobId: string
  root: string
  jobRoot: string
  planPath: string
  planId: string
  sourceHash: string
  mappingHash: string
  sourceMarkdown: string
  sourceBlocks: AlignedMarkdownBlock[]
  mappings: BlockMapping[]
  units: UnitState[]
  unitById: Map<string, UnitState>
  blockToUnit: Map<string, { unit: UnitState; index: number }>
}

export interface PlanMetadataUnit {
  unitId: string
  kind: TranslationPlanUnitKind
  sourceHash: string
  blockIds: string[]
  requestPath: string
  responsePath: string
  resultPath: string
  resultBlockPaths: string[]
  sourceIndexes: number[]
  mappingIds: string[][]
  status: TranslationPlanWorkDescriptor['status']
}

export interface PlanMetadata {
  formatVersion: 1
  planId: string
  taskId: string
  jobId: string
  attempt: number
  preferredProvider: TranslationProviderId
  sourceHash: string
  mappingHash: string
  pipelineVersion: typeof TRANSLATION_PIPELINE_VERSION
  mappingAlgorithmVersion: typeof MARKDOWN_MAPPING_ALGORITHM_VERSION
  blockMappingVersion: number
  tableTranslationProtocol: typeof TABLE_TRANSLATION_PROTOCOL
  tableTranslationCacheVersion: typeof TABLE_TRANSLATION_CACHE_VERSION
  units: PlanMetadataUnit[]
}

export function isAutomaticUnit(unit: UnitState): boolean {
  return unit.request.protocol === 'copilotix-translation-plain-v1'
    ? unit.request.segments.length === 0
    : unit.tablePlan?.hasTranslatableText === false
}

export function countsFor(state: PlanState): { total: number; completed: number; failed: number } {
  return {
    total: state.units.reduce((sum, unit) => sum + unit.blockIds.length, 0),
    completed: state.units.filter((unit) => unit.status === 'completed').reduce((sum, unit) => sum + unit.blockIds.length, 0),
    failed: state.units.filter((unit) => unit.status === 'failed').reduce((sum, unit) => sum + unit.blockIds.length, 0)
  }
}

export function mutationFor(state: PlanState, unit: UnitState): TranslationPlanMutationResult {
  return translationPlanMutationResultSchema.parse({ ...countsFor(state), unitId: unit.descriptor.unitId, status: unit.status })
}

export function checkpointFor(state: PlanState): { totalBlocks: number; completedBlocks: number; failedBlocks: number; failedBlockIds: string[] } {
  const counts = countsFor(state)
  return {
    totalBlocks: counts.total,
    completedBlocks: counts.completed,
    failedBlocks: counts.failed,
    failedBlockIds: state.units.filter((unit) => unit.status === 'failed').flatMap((unit) => unit.blockIds).slice(0, 64)
  }
}

export function collectPlainSegments(tree: any, unitId: string): Array<{ id: string; source: string; node: { value: string } }> {
  const result: Array<{ id: string; source: string; node: { value: string } }> = []
  const stack: Array<{ node: any; protectedAncestor: boolean }> = [{ node: tree, protectedAncestor: false }]
  while (stack.length > 0) {
    const current = stack.pop()!
    const protectedHere = current.protectedAncestor || PROTECTED_NODE_TYPES.has(current.node?.type)
    if (current.node?.type === 'text' && !protectedHere && typeof current.node.value === 'string' && shouldTranslate(current.node.value)) {
      const id = `${unitId}-segment-${result.length}`
      result.push({ id, source: current.node.value, node: current.node })
      continue
    }
    if (Array.isArray(current.node?.children)) {
      for (let index = current.node.children.length - 1; index >= 0; index -= 1) {
        stack.push({ node: current.node.children[index], protectedAncestor: protectedHere })
      }
    }
  }
  return result
}

export function shouldTranslate(value: unknown): boolean {
  if (typeof value !== 'string' || !/[A-Za-z\p{L}]/u.test(value)) return false
  const letters = value.match(/[A-Za-z]/g)?.length ?? 0
  const han = value.match(/[\p{Script=Han}]/gu)?.length ?? 0
  return letters > 0 || han === 0
}

export function normalizeTranslatedText(source: string, translated: string): string {
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

export function buildReferenceActions(sourceBlocks: Array<{ markdown: string; mappingIds: string[] }>, mappings: BlockMapping[]): Map<number, string> {
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

export function parseSingleBlockNode(markdown: string): any | null {
  const tree = processor.parse(markdown) as any
  return Array.isArray(tree.children) && tree.children.length === 1 ? tree.children[0] : null
}

export function referenceHeadingLevel(node: any): number | null {
  if (node?.type !== 'heading' || typeof node.depth !== 'number') return null
  const title = visibleNodeText(node)
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/\s+/g, ' ')
    .replace(/[.:：。]+$/u, '')
  return REFERENCE_HEADINGS.has(title) ? node.depth : null
}

export function visibleNodeText(node: any): string {
  if (!node || typeof node !== 'object') return ''
  if (typeof node.value === 'string' && ['text', 'inlineCode'].includes(node.type)) return node.value
  return Array.isArray(node.children) ? node.children.map(visibleNodeText).join('') : ''
}

export function isReferenceMappingType(value: unknown): boolean {
  return typeof value === 'string' && ['ref_text', 'reference', 'bibliography'].includes(value.toLocaleLowerCase('en-US'))
}

export function translationBlockId(taskId: string, sourceIndex: number, mappingIds: string[]): string {
  return `translation-${sha256(`${TRANSLATION_PIPELINE_VERSION}|${taskId}|${sourceIndex}|${mappingIds.join('|')}`).slice(0, 20)}`
}

export function stableUuid(value: string): string {
  const digest = createHash('sha256').update(value).digest()
  digest[6] = (digest[6]! & 0x0f) | 0x40
  digest[8] = (digest[8]! & 0x3f) | 0x80
  const hex = digest.subarray(0, 16).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function joinMarkdownBlocks(blocks: string[]): string {
  return blocks.length > 0 ? `${blocks.map((block) => block.trimEnd()).join('\n\n')}\n` : ''
}

export function unitMarkdownMap(unit: UnitState, markdown: string): Map<string, string> {
  return new Map([[unit.blockIds[0]!, markdown]])
}

export function legacyCacheKey(sourceHash: string, provider: string, model: string, kind: TranslationPlanUnitKind): string {
  return sha256(kind === 'table'
    ? `${TRANSLATION_PIPELINE_VERSION}|table|${TABLE_TRANSLATION_CACHE_VERSION}|${provider}|${model}|zh-CN|${sourceHash}`
    : `${TRANSLATION_PIPELINE_VERSION}|${provider}|${model}|zh-CN|${sourceHash}`)
}

export function assertPersistableTranslationBatch(input: TranslationBatchCommit): void {
  for (const block of input.blocks) {
    assertTranslationField(block.sourceMarkdown, `翻译块 ${block.blockId} 的原文`)
    if (block.translatedMarkdown !== null) assertTranslationField(block.translatedMarkdown, `翻译块 ${block.blockId} 的译文`)
  }
  for (const entry of input.cacheEntries) assertTranslationField(entry.translated, `翻译缓存 ${entry.cacheKey}`)
}

export function assertTranslationField(value: string, label: string): void {
  if (Buffer.byteLength(value, 'utf8') > MAX_TRANSLATION_FIELD_BYTES) {
    throw new Error(`${label}超过 262KiB 持久化字段限制，请保留正文文件并避免通过 RPC`)
  }
}

export function translationBatchFits(input: TranslationBatchCommit): boolean {
  return input.blocks.length <= MAX_TRANSLATION_BATCH_ITEMS &&
    input.cacheEntries.length <= MAX_TRANSLATION_BATCH_ITEMS &&
    Buffer.byteLength(JSON.stringify(input), 'utf8') <= MAX_TRANSLATION_BATCH_BYTES
}

export function assertTranslationBatchSize(input: TranslationBatchCommit): void {
  if (!translationBatchFits(input)) throw new Error('翻译批次 UTF-8 大小超过 768KiB')
}

export function planKey(taskId: string, jobId: string): string {
  return `${taskId}\u0000${jobId}`
}

export function normalizeCursor(value: number): number {
  if (!Number.isInteger(value) || value < 0) throw new Error('翻译计划 cursor 无效')
  return value
}

export function normalizeLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 32) throw new Error('翻译计划 limit 必须在 1 到 32 之间')
  return value
}

export function parseJson(value: string): unknown {
  try { return JSON.parse(value) as unknown } catch { throw new Error('翻译计划 JSON 无效') }
}

export function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export function isPlanMetadata(value: unknown): value is PlanMetadata {
  if (!isRecord(value) || value.formatVersion !== 1 || typeof value.planId !== 'string' || typeof value.taskId !== 'string' || typeof value.jobId !== 'string' ||
    typeof value.attempt !== 'number' || !Number.isInteger(value.attempt) || value.attempt < 0 ||
    !isTranslationProviderId(value.preferredProvider) ||
    typeof value.sourceHash !== 'string' || typeof value.mappingHash !== 'string' || !Array.isArray(value.units)) return false
  return value.units.every((unit: unknown) => isRecord(unit) && typeof unit.unitId === 'string' && typeof unit.kind === 'string' &&
    typeof unit.sourceHash === 'string' && Array.isArray(unit.blockIds) && Array.isArray(unit.resultBlockPaths) &&
    Array.isArray(unit.sourceIndexes) && Array.isArray(unit.mappingIds) && typeof unit.requestPath === 'string' &&
    typeof unit.responsePath === 'string' && typeof unit.resultPath === 'string' && typeof unit.status === 'string')
}

export interface PreviousManifest {
  generatedAt: string | null
  blocks: Map<number, { status: 'completed' | 'failed'; markdown: string; sourceHash: string; error: string | null; provider: TranslationProviderId | null; model: string | null }>
}

export function isTranslationProviderId(value: unknown): value is TranslationProviderId {
  return value === 'codex' || value === 'qwen' || value === 'deepseek' || value === 'bing' || value === 'transmart'
}

export function arraysEqual(left: unknown, right: unknown): boolean {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => value === right[index])
}

export function nestedArraysEqual(left: unknown, right: unknown): boolean {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => arraysEqual(value, right[index]))
}

export function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('\\\\')
}

export async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, 'r')
    try { await handle.sync() } finally { await handle.close() }
  } catch {
    // Windows does not support opening directories for fsync; the file fsync
    // and atomic rename above still provide the durable publication boundary.
  }
}

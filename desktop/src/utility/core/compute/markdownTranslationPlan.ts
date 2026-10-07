import { createHash, randomUUID } from 'node:crypto'
import { prepareReaderMarkdown, READER_MARKDOWN_FORMAT_VERSION } from '@shared/standardMarkdown'
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { unified } from 'unified'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkParse from 'remark-parse'
import remarkStringify from 'remark-stringify'
import { z } from 'zod'
import type { TranslationBatchBlock, TranslationBatchCommit, TranslationCacheEntry } from '@core/types'
import { BLOCK_MAPPING_VERSION } from '@core/blockMapping'
import type { BlockMapping, TranslationBlockRecord, TranslationProviderId } from '@shared/types'
import { blockMappingSchema } from '@shared/ipcSchemas'
import {
  alignMarkdownBlocks,
  type AlignedMarkdownBlock
} from '@shared/markdownBlocks'
import {
  MARKDOWN_MAPPING_ALGORITHM_VERSION,
  TABLE_TRANSLATION_CACHE_VERSION,
  TABLE_TRANSLATION_PROTOCOL,
  TRANSLATION_PIPELINE_VERSION,
  plainTranslationResponseSchema,
  tableTranslationRequestSchema,
  tableTranslationResponseSchema,
  translationCacheKey,
  translationPlanFinalizeResultSchema,
  translationPlanListResultSchema,
  translationPlanMutationResultSchema,
  translationPlanOpenResultSchema,
  translationPlanResponseEnvelopeSchema,
  type PlainTranslationRequest,
  type PlainTranslationResponse,
  type TableTextSegment,
  type TableTranslationResponse,
  type TranslationPlanFinalizeResult,
  type TranslationPlanListResult,
  type TranslationPlanMutationResult,
  type TranslationPlanOpenResult,
  type TranslationPlanRequest,
  type TranslationPlanResponse,
  type TranslationPlanUnitKind,
  type TranslationPlanWorkDescriptor
} from '@shared/translationPlanProtocol'
import {
  applyTableTranslation,
  buildTableTranslationUnits,
  type TableTranslationPlan,
  type TableTranslationUnit
} from './tableTranslation'
import { PathPolicy, type PathPolicyPort } from '../persistence/pathPolicy'
import type { TranslationJobBinding, V2TaskRepositoryCompat } from '../persistence/v2TaskRepositoryCompat'

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkStringify, { bullet: '-', fences: true, listItemIndent: 'one' })

const PROTECTED_NODE_TYPES = new Set(['code', 'inlineCode', 'math', 'inlineMath', 'html'])
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

const MAX_TRANSLATION_BATCH_ITEMS = 32
const MAX_TRANSLATION_BATCH_BYTES = 768 * 1024
const MAX_TRANSLATION_FIELD_BYTES = 262_144

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

interface UnitState {
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

interface PlanState {
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

interface PlanMetadataUnit {
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

interface PlanMetadata {
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

/**
 * Durable, restartable translation planning owned by the utility process.
 * Documents and responses remain on disk; only bounded metadata crosses the
 * eventual RPC boundary.
 */
export class MarkdownTranslationPlanManager {
  private readonly plans = new Map<string, PlanState>()
  private readonly metadataWriteTails = new Map<string, Promise<void>>()
  private readonly blockMappingVersion: number
  private readonly outputRoot: string | undefined

  constructor(
    private readonly repository: TranslationPlanRepository | V2TaskRepositoryCompat,
    private readonly pathPolicy: PathPolicyPort = new PathPolicy(),
    options: TranslationPlanManagerOptions = {}
  ) {
    this.blockMappingVersion = options.blockMappingVersion ?? BLOCK_MAPPING_VERSION
    this.outputRoot = options.outputRoot
  }

  async open(taskId: string, jobId: string): Promise<TranslationPlanOpenResult> {
    const binding = this.repository.requireTranslationJobBinding(taskId, jobId)
    await this.assertBindingOutputDir(binding)
    await mkdir(binding.outputDir, { recursive: true })
    const sourceMarkdown = await this.readOutputFile(binding.outputDir, 'full.md')
    const mappings = await this.readMappings(binding.outputDir)
    const sourceHash = sha256(sourceMarkdown)
    const mappingHash = sha256(JSON.stringify({ version: this.blockMappingVersion, mappings }))
    const key = planKey(taskId, jobId)
    const planPath = this.resolveOutputPath(binding.outputDir, `.translation/${jobId}/plan.json`)
    const existingMetadata = await this.readMetadata(planPath)
    const candidate = this.buildState(binding, sourceMarkdown, mappings, sourceHash, mappingHash, existingMetadata)
    const planMatches = existingMetadata !== null && this.metadataMatches(existingMetadata, candidate)

    if (!planMatches) {
      await this.removeExactJobPlan(binding.outputDir, jobId)
      await mkdir(candidate.jobRoot, { recursive: true })
      await this.writeInitialFiles(candidate)
    } else {
      await this.prepareExistingFiles(candidate, existingMetadata!)
    }

    const savedBlocks = this.repository.listTranslationBlocks(taskId, jobId)
    const attemptChanged = planMatches && existingMetadata !== null && existingMetadata.attempt !== binding.attempt
    await this.restorePersistedBlocks(candidate, savedBlocks, attemptChanged)
    await this.persistAutoCompleted(candidate, savedBlocks)
    await this.writeMetadata(candidate)
    this.plans.set(key, candidate)
    const counts = countsFor(candidate)
    return translationPlanOpenResultSchema.parse({
      planId: candidate.planId,
      taskId,
      jobId,
      sourceHash,
      reused: planMatches,
      ...counts
    })
  }

  async listWork(taskId: string, jobId: string, cursor = 0, limit = 32): Promise<TranslationPlanListResult> {
    const state = await this.ensurePlan(taskId, jobId)
    const start = normalizeCursor(cursor)
    const count = normalizeLimit(limit)
    const items = state.units.slice(start, start + count).map((unit) => ({ ...unit.descriptor, status: unit.status }))
    const nextCursor = start + items.length < state.units.length ? start + items.length : null
    return translationPlanListResultSchema.parse({ items, nextCursor, counts: countsFor(state) })
  }

  /** Try a utility-side cache entry. A miss leaves the unit pending. */
  async tryCache(
    taskId: string,
    jobId: string,
    unitId: string,
    provider: TranslationProviderId,
    model: string
  ): Promise<TranslationPlanMutationResult> {
    const state = await this.ensurePlan(taskId, jobId)
    const unit = this.requireUnit(state, unitId)
    if (unit.status !== 'pending') return mutationFor(state, unit)

    const keys = [
      translationCacheKey(unit.descriptor.sourceHash, provider, model, unit.descriptor.kind),
      legacyCacheKey(unit.descriptor.sourceHash, provider, model, unit.descriptor.kind)
    ]
    const seen = new Set<string>()
    for (const cacheKey of keys) {
      if (seen.has(cacheKey)) continue
      seen.add(cacheKey)
      const cached = this.repository.getCache(cacheKey)
      if (!cached) continue
      try {
        if (unit.descriptor.kind === 'table') {
          const parsed = parseJson(cached)
          if (!isRecord(parsed) || parsed.version !== TABLE_TRANSLATION_CACHE_VERSION || parsed.sourceHash !== unit.descriptor.sourceHash) continue
          const response = tableTranslationResponseSchema.parse(parsed.response)
          await this.applyTableResponse(state, unit, response, provider, model)
        } else {
          if (!cached.trim()) continue
          // Preserve the complete cached Markdown, including intentional
          // leading/trailing whitespace; only use trim for the emptiness test.
          await this.completeUnit(state, unit, unitMarkdownMap(unit, cached), provider, model)
        }
        return mutationFor(state, unit)
      } catch {
        // Invalid/stale cache entries are ignored; a provider can fill the unit.
      }
    }
    return mutationFor(state, unit)
  }

  async apply(
    taskId: string,
    jobId: string,
    unitId: string,
    responsePath?: string,
    provider: TranslationProviderId | null = null,
    model: string | null = null
  ): Promise<TranslationPlanMutationResult> {
    const state = await this.ensurePlan(taskId, jobId)
    const unit = this.requireUnit(state, unitId)
    if (unit.status !== 'pending') return mutationFor(state, unit)
    const selectedPath = responsePath ?? unit.descriptor.responsePath
    if (selectedPath !== unit.descriptor.responsePath) throw new Error('翻译响应路径与计划不匹配')
    const absolute = this.resolvePlanPath(state, selectedPath)
    const raw = await readFile(absolute, 'utf8')
    const value = parseJson(raw)
    const response = this.parseResponse(value, unit)
    if (unit.descriptor.kind === 'table') {
      await this.applyTableResponse(state, unit, response as TableTranslationResponse, provider, model)
    } else {
      const plain = response as PlainTranslationResponse
      const translated = this.applyPlainResponse(unit, plain)
      await this.completeUnit(state, unit, new Map([[unit.blockIds[0]!, translated]]), provider, model)
    }
    return mutationFor(state, unit)
  }

  async fail(
    taskId: string,
    jobId: string,
    unitId: string,
    error = '翻译失败'
  ): Promise<TranslationPlanMutationResult> {
    const state = await this.ensurePlan(taskId, jobId)
    const unit = this.requireUnit(state, unitId)
    if (unit.status === 'failed') return mutationFor(state, unit)
    const message = String(error).replace(/\p{Cc}/gu, ' ').trim().slice(0, 32_768) || '翻译失败'
    const output = new Map(unit.blockIds.map((blockId, index) => [blockId, unit.sourceMarkdowns[index] ?? '']))
    await this.writeUnitResults(state, unit, output)
    unit.status = 'failed'
    unit.error = message
    unit.provider = null
    unit.model = null
    await this.commitUnit(state, unit)
    await this.writeMetadata(state)
    return mutationFor(state, unit)
  }

  async finalize(taskId: string, jobId: string): Promise<TranslationPlanFinalizeResult> {
    const state = await this.ensurePlan(taskId, jobId)
    if (state.units.some((unit) => unit.status === 'pending')) throw new Error('翻译计划尚未完成')

    const orderedMarkdown = new Array<string>(state.sourceBlocks.length).fill('')
    const manifestBlocks: Array<Record<string, unknown>> = []
    for (const unit of state.units) {
      for (let index = 0; index < unit.blockIds.length; index += 1) {
        const blockId = unit.blockIds[index]!
        const resultPath = unit.blockResultPaths[index]!
        const markdown = prepareReaderMarkdown(await readFile(this.resolvePlanPath(state, resultPath), 'utf8')).trimEnd()
        const sourceIndex = unit.sourceIndexes[index]
        if (sourceIndex !== undefined) orderedMarkdown[sourceIndex] = markdown
        manifestBlocks.push({
          blockId,
          sourceIndex,
          mappingIds: unit.mappingIds[index] ?? [],
          sourceHash: sha256(unit.sourceMarkdowns[index] ?? ''),
          markdown,
          provider: unit.provider,
          model: unit.model,
          status: unit.status,
          error: unit.status === 'failed' ? unit.error : null
        })
      }
    }

    const translated = joinMarkdownBlocks(orderedMarkdown)
    const failedBlockIds = state.units
      .filter((unit) => unit.status === 'failed')
      .flatMap((unit) => unit.blockIds)
    const translatedRelativePath = 'full.zh-CN.md'
    const manifestRelativePath = 'translation.manifest.json'
    const checkpointRelativePath = 'translation.checkpoint.json'
    const manifest = {
      version: 2,
      mappingAlgorithmVersion: MARKDOWN_MAPPING_ALGORITHM_VERSION,
      markdownFormat: READER_MARKDOWN_FORMAT_VERSION,
      blockMappingVersion: this.blockMappingVersion,
      taskId,
      jobId,
      targetLanguage: 'zh-CN',
      preferredProvider: state.binding.translationProvider,
      translationPipelineVersion: TRANSLATION_PIPELINE_VERSION,
      tableTranslationProtocol: TABLE_TRANSLATION_PROTOCOL,
      failedBlockIds,
      // Units are constructed in source order and table attachments retain
      // their source indexes, so preserve that order without an O(n log n)
      // final sort.
      blocks: manifestBlocks
    }
    const counts = countsFor(state)
    const checkpoint = {
      taskId,
      jobId,
      totalBlocks: counts.total,
      completedBlocks: counts.completed,
      failedBlocks: counts.failed,
      failedBlockIds: failedBlockIds.slice(0, 64),
      updatedAt: new Date().toISOString()
    }
    await this.atomicOutputWrite(state, translatedRelativePath, `${translated}`)
    await this.atomicOutputWrite(state, manifestRelativePath, `${JSON.stringify(manifest, null, 2)}\n`)
    await this.atomicOutputWrite(state, checkpointRelativePath, `${JSON.stringify(checkpoint, null, 2)}\n`)

    const translatedHash = sha256(translated)
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`
    const checkpointText = `${JSON.stringify(checkpoint, null, 2)}\n`
    const manifestHash = sha256(manifestText)
    const checkpointHash = sha256(checkpointText)
    if (this.repository.recordArtifactRevision) {
      await Promise.resolve(this.repository.recordArtifactRevision(
        taskId,
        'translated_markdown',
        this.resolveOutputPath(state.root, translatedRelativePath),
        translatedHash,
        { version: 2, jobId },
        jobId
      ))
      await Promise.resolve(this.repository.recordArtifactRevision(
        taskId,
        'manifest',
        this.resolveOutputPath(state.root, manifestRelativePath),
        manifestHash,
        { version: 2, jobId },
        jobId
      ))
    }
    const result = {
      ...counts,
      status: failedBlockIds.length > 0 ? 'partial' as const : 'succeeded' as const,
      failedBlockIdsSample: failedBlockIds.slice(0, 64),
      translatedRelativePath,
      manifestRelativePath,
      checkpointRelativePath,
      hashes: { translated: translatedHash, manifest: manifestHash, checkpoint: checkpointHash }
    }
    return translationPlanFinalizeResultSchema.parse(result)
  }

  /** Useful to lifecycle code when a utility process is drained. */
  clear(taskId?: string, jobId?: string): void {
    if (taskId && jobId) this.plans.delete(planKey(taskId, jobId))
    else this.plans.clear()
  }

  private async ensurePlan(taskId: string, jobId: string): Promise<PlanState> {
    const existing = this.plans.get(planKey(taskId, jobId))
    if (existing) {
      const binding = this.repository.requireTranslationJobBinding(taskId, jobId)
      if (binding.outputDir === existing.binding.outputDir && binding.attempt === existing.binding.attempt) return existing
    }
    await this.open(taskId, jobId)
    const state = this.plans.get(planKey(taskId, jobId))
    if (!state) throw new Error('翻译计划未打开')
    return state
  }

  private buildState(
    binding: TranslationJobBinding,
    sourceMarkdown: string,
    mappings: BlockMapping[],
    sourceHash: string,
    mappingHash: string,
    existing: PlanMetadata | null
  ): PlanState {
    const sourceBlocks = alignMarkdownBlocks(sourceMarkdown, mappings)
    const referenceActions = buildReferenceActions(sourceBlocks, mappings)
    const tableUnits = buildTableTranslationUnits(sourceBlocks, mappings)
    const tableBySourceIndex = new Map<number, TableTranslationUnit>()
    const tableStarts = new Set<number>()
    for (const tableUnit of tableUnits) {
      const start = Math.min(...tableUnit.blocks.map((block) => block.sourceIndex))
      tableStarts.add(start)
      for (const block of tableUnit.blocks) tableBySourceIndex.set(block.sourceIndex, tableUnit)
    }

    const units: UnitState[] = []
    for (let sourceIndex = 0; sourceIndex < sourceBlocks.length; sourceIndex += 1) {
      const sourceBlock = sourceBlocks[sourceIndex]!
      const referenceMarkdown = referenceActions.get(sourceIndex)
      if (referenceMarkdown !== undefined) {
        const unitId = stableUuid(`plain|${binding.taskId}|${binding.jobId}|${sourceIndex}|reference`)
        units.push(this.makePlainUnit(binding, sourceBlock, sourceIndex, unitId, [], 'completed', referenceMarkdown))
        continue
      }
      const tableUnit = tableBySourceIndex.get(sourceIndex)
      if (tableUnit) {
        if (tableStarts.has(sourceIndex)) units.push(this.makeTableUnit(binding, tableUnit))
        continue
      }
      const unitId = stableUuid(`plain|${binding.taskId}|${binding.jobId}|${sourceIndex}|${sourceBlock.mappingIds.join('|')}`)
      const tree = processor.parse(sourceBlock.markdown) as any
      const plainBindings = collectPlainSegments(tree, unitId)
      const segments = plainBindings.map(({ id, source }) => ({ id, text: source }))
      const status = segments.length === 0 ? 'completed' : 'pending'
      units.push(this.makePlainUnit(binding, sourceBlock, sourceIndex, unitId, segments, status))
    }

    const expectedPlanId = stableUuid(`plan|${binding.taskId}|${binding.jobId}|${binding.translationProvider}`)
    const planId = existing?.planId === expectedPlanId ? existing.planId : expectedPlanId
    const state: PlanState = {
      binding,
      taskId: binding.taskId,
      jobId: binding.jobId,
      root: binding.outputDir,
      jobRoot: this.resolveOutputPath(binding.outputDir, `.translation/${binding.jobId}`),
      planPath: this.resolveOutputPath(binding.outputDir, `.translation/${binding.jobId}/plan.json`),
      planId,
      sourceHash,
      mappingHash,
      sourceMarkdown,
      sourceBlocks,
      mappings,
      units,
      unitById: new Map(),
      blockToUnit: new Map()
    }
    for (const unit of units) {
      state.unitById.set(unit.descriptor.unitId, unit)
      for (let index = 0; index < unit.blockIds.length; index += 1) state.blockToUnit.set(unit.blockIds[index]!, { unit, index })
    }
    return state
  }

  private makePlainUnit(
    binding: TranslationJobBinding,
    sourceBlock: AlignedMarkdownBlock,
    sourceIndex: number,
    unitId: string,
    segments: TableTextSegment[],
    status: TranslationPlanWorkDescriptor['status'],
    completedMarkdown?: string
  ): UnitState {
    const sourceHash = sha256(sourceBlock.markdown)
    const blockId = translationBlockId(binding.taskId, sourceIndex, sourceBlock.mappingIds)
    const prefix = `.translation/${binding.jobId}`
    const requestPath = `${prefix}/requests/${unitId}.json`
    const responsePath = `${prefix}/responses/${unitId}.json`
    const resultPath = `${prefix}/results/${unitId}.md`
    const request: PlainTranslationRequest = {
      protocol: 'copilotix-translation-plain-v1',
      targetLanguage: 'zh-CN',
      unitId,
      sourceHash,
      segments
    }
    return {
      descriptor: { unitId, kind: 'plain', sourceHash, blockIds: [blockId], requestPath, responsePath, resultPath, status },
      blockIds: [blockId],
      sourceIndexes: [sourceIndex],
      mappingIds: [[...sourceBlock.mappingIds]],
      sourceMarkdowns: [sourceBlock.markdown],
      blockResultPaths: [`${prefix}/results/${blockId}.md`],
      request,
      status,
      provider: null,
      model: null,
      error: null,
      initialResults: [completedMarkdown ?? sourceBlock.markdown]
    }
  }

  private makeTableUnit(binding: TranslationJobBinding, tableUnit: TableTranslationUnit): UnitState {
    const sourceKey = tableUnit.blocks.map((block) => `${block.sourceIndex}\u0000${block.markdown}`).join('\u0000')
    const unitId = stableUuid(`table|${binding.taskId}|${binding.jobId}|${sourceKey}`)
    const sourceHash = sha256(sourceKey)
    const blockIds = tableUnit.blocks.map((block) => translationBlockId(binding.taskId, block.sourceIndex, block.mappingIds))
    const prefix = `.translation/${binding.jobId}`
    const requestPath = `${prefix}/requests/${unitId}.json`
    const responsePath = `${prefix}/responses/${unitId}.json`
    const resultPath = `${prefix}/results/${unitId}.md`
    const request = tableTranslationRequestSchema.parse(tableUnit.plan.request)
    return {
      descriptor: { unitId, kind: 'table', sourceHash, blockIds, requestPath, responsePath, resultPath, status: tableUnit.plan.hasTranslatableText ? 'pending' : 'completed' },
      blockIds: [...blockIds],
      sourceIndexes: tableUnit.blocks.map((block) => block.sourceIndex),
      mappingIds: tableUnit.blocks.map((block) => [...block.mappingIds]),
      sourceMarkdowns: tableUnit.blocks.map((block) => block.markdown),
      blockResultPaths: blockIds.map((blockId) => `${prefix}/results/${blockId}.md`),
      request,
      tablePlan: tableUnit.plan,
      status: tableUnit.plan.hasTranslatableText ? 'pending' : 'completed',
      provider: null,
      model: null,
      error: null,
      initialResults: tableUnit.blocks.map((block) => block.markdown)
    }
  }

  private metadataMatches(metadata: PlanMetadata, state: PlanState): boolean {
    if (
      metadata.formatVersion !== 1 || metadata.planId !== state.planId || metadata.taskId !== state.taskId || metadata.jobId !== state.jobId ||
      metadata.preferredProvider !== state.binding.translationProvider || metadata.sourceHash !== state.sourceHash || metadata.mappingHash !== state.mappingHash ||
      metadata.pipelineVersion !== TRANSLATION_PIPELINE_VERSION ||
      metadata.mappingAlgorithmVersion !== MARKDOWN_MAPPING_ALGORITHM_VERSION ||
      metadata.blockMappingVersion !== this.blockMappingVersion ||
      metadata.tableTranslationProtocol !== TABLE_TRANSLATION_PROTOCOL ||
      metadata.tableTranslationCacheVersion !== TABLE_TRANSLATION_CACHE_VERSION ||
      !Array.isArray(metadata.units) || metadata.units.length !== state.units.length
    ) return false
    return state.units.every((unit, index) => {
      const saved = metadata.units[index]
      return Boolean(saved) && saved!.unitId === unit.descriptor.unitId && saved!.kind === unit.descriptor.kind &&
        saved!.sourceHash === unit.descriptor.sourceHash && arraysEqual(saved!.blockIds, unit.descriptor.blockIds) &&
        saved!.requestPath === unit.descriptor.requestPath && saved!.responsePath === unit.descriptor.responsePath &&
        saved!.resultPath === unit.descriptor.resultPath && arraysEqual(saved!.resultBlockPaths, unit.blockResultPaths) &&
        arraysEqual(saved!.sourceIndexes, unit.sourceIndexes) && nestedArraysEqual(saved!.mappingIds, unit.mappingIds)
    })
  }

  private async writeInitialFiles(state: PlanState): Promise<void> {
    const prefix = `.translation/${state.jobId}`
    for (const directory of ['blocks', 'requests', 'responses', 'results']) {
      await mkdir(this.resolvePlanPath(state, `${prefix}/${directory}`), { recursive: true })
    }
    for (const unit of state.units) {
      for (let index = 0; index < unit.blockIds.length; index += 1) {
        await this.atomicPlanWrite(state, `.translation/${state.jobId}/blocks/${unit.blockIds[index]!}.md`, unit.sourceMarkdowns[index] ?? '')
      }
      await this.atomicPlanWrite(state, unit.descriptor.requestPath, `${JSON.stringify(unit.request, null, 2)}\n`)
      if (unit.status === 'completed') {
        const output = new Map(unit.blockIds.map((blockId, index) => [blockId, unit.initialResults[index] ?? unit.sourceMarkdowns[index] ?? '']))
        await this.writeUnitResults(state, unit, output)
      }
    }
  }

  private async prepareExistingFiles(state: PlanState, metadata: PlanMetadata): Promise<void> {
    const attemptChanged = metadata.attempt !== state.binding.attempt
    for (let index = 0; index < state.units.length; index += 1) {
      const unit = state.units[index]!
      const saved = metadata.units[index]!
      // A manual retry starts only failed units over. Completed units and a
      // same-attempt failed unit are durable and must survive utility restart.
      unit.status = attemptChanged && saved.status === 'failed' ? 'pending' : saved.status
      unit.descriptor.status = saved.status
      if (attemptChanged && saved.status === 'failed') unit.descriptor.status = 'pending'
      if (unit.status === 'completed' && !(await this.unitResultsExist(state, unit))) {
        unit.status = 'pending'
        unit.descriptor.status = 'pending'
      }
      for (let blockIndex = 0; blockIndex < unit.blockIds.length; blockIndex += 1) {
        const blockPath = `.translation/${state.jobId}/blocks/${unit.blockIds[blockIndex]!}.md`
        if (!(await this.fileExists(this.resolvePlanPath(state, blockPath)))) {
          await this.atomicPlanWrite(state, blockPath, unit.sourceMarkdowns[blockIndex] ?? '')
        }
      }
      if (!(await this.fileExists(this.resolvePlanPath(state, unit.descriptor.requestPath)))) {
        await this.atomicPlanWrite(state, unit.descriptor.requestPath, `${JSON.stringify(unit.request, null, 2)}\n`)
      }
    }
  }

  private async restorePersistedBlocks(state: PlanState, records: TranslationBlockRecord[], attemptChanged = false): Promise<void> {
    const byBlockId = new Map(records.filter((record) => record.jobId === undefined || record.jobId === state.jobId).map((record) => [record.blockId, record]))
    for (const unit of state.units) {
      // References, protected content and tables without text are local results.
      // They must remain complete even when no DB record exists yet, or an older
      // run incorrectly persisted them as failed.
      if (isAutomaticUnit(unit)) {
        await this.writeUnitResults(state, unit, new Map(unit.blockIds.map((id, index) => [id, unit.initialResults[index] ?? ''])))
        unit.status = 'completed'
        unit.descriptor.status = 'completed'
        unit.provider = null
        unit.model = null
        unit.error = null
        continue
      }
      const members = unit.blockIds.map((blockId, index) => ({ blockId, index, record: byBlockId.get(blockId) }))
      const completed = members.every(({ record, index }) => Boolean(record && record.status === 'completed' && record.sourceHash === sha256(unit.sourceMarkdowns[index] ?? '') && record.translatedMarkdown))
      const failed = members.every(({ record, index }) => Boolean(record && record.status === 'failed' && record.sourceHash === sha256(unit.sourceMarkdowns[index] ?? '')))
      if (completed) {
        const output = new Map(members.map(({ blockId, record }) => [blockId, record!.translatedMarkdown!]))
        await this.writeUnitResults(state, unit, output)
        unit.status = 'completed'
        unit.descriptor.status = 'completed'
        unit.provider = members[0]!.record!.provider
        unit.model = members[0]!.record!.model
        unit.error = null
      } else if (failed && !attemptChanged) {
        const output = new Map(members.map(({ blockId, index }) => [blockId, unit.sourceMarkdowns[index] ?? '']))
        await this.writeUnitResults(state, unit, output)
        unit.status = 'failed'
        unit.descriptor.status = 'failed'
        unit.provider = null
        unit.model = null
        unit.error = members[0]!.record!.error ?? '翻译失败'
      } else if (unit.status === 'completed') {
        unit.status = 'pending'
        unit.descriptor.status = 'pending'
      }
    }
  }

  private async persistAutoCompleted(state: PlanState, records: TranslationBlockRecord[]): Promise<void> {
    const persisted = new Map(records.map((record) => [record.blockId, record]))
    for (const unit of state.units) {
      if (unit.status !== 'completed' || !isAutomaticUnit(unit)) continue
      if (unit.blockIds.every((blockId, index) => {
        const record = persisted.get(blockId)
        return record?.status === 'completed' && record.sourceHash === sha256(unit.sourceMarkdowns[index] ?? '') &&
          record.translatedMarkdown === unit.initialResults[index]
      })) continue
      await this.commitUnit(state, unit)
    }
  }

  private async applyTableResponse(
    state: PlanState,
    unit: UnitState,
    response: TableTranslationResponse,
    provider: TranslationProviderId | null,
    model: string | null
  ): Promise<void> {
    if (!unit.tablePlan) throw new Error('表格翻译计划缺失')
    applyTableTranslation(unit.tablePlan, response)
    unit.cacheResponse = response
    const output = new Map(unit.tablePlan.blocks.map((block, index) => [unit.blockIds[index]!, block.render()]))
    await this.completeUnit(state, unit, output, provider, model)
  }

  private applyPlainResponse(unit: UnitState, response: PlainTranslationResponse): string {
    const source = unit.sourceMarkdowns[0] ?? ''
    const tree = processor.parse(source) as any
    const bindings = collectPlainSegments(tree, unit.descriptor.unitId)
    const expected = unit.descriptor.kind === 'plain' && unit.request.protocol === 'copilotix-translation-plain-v1' ? unit.request.segments : []
    if (bindings.length !== expected.length || response.translations.length !== expected.length) throw new Error('普通翻译响应数量不匹配')
    const translations = new Map<string, string>()
    for (const segment of response.translations) {
      if (!expected.some((candidate) => candidate.id === segment.id) || translations.has(segment.id) || !segment.text.trim()) {
        throw new Error('普通翻译响应包含无效 segment')
      }
      translations.set(segment.id, segment.text)
    }
    for (const segment of expected) {
      const value = translations.get(segment.id)
      if (value === undefined) throw new Error('普通翻译响应缺少 segment')
    }
    bindings.forEach((binding) => {
      binding.node.value = normalizeTranslatedText(binding.source, translations.get(binding.id)!)
    })
    return String(processor.stringify(tree)).trimEnd()
  }

  private parseResponse(value: unknown, unit: UnitState): TranslationPlanResponse {
    const envelope = translationPlanResponseEnvelopeSchema.safeParse(value)
    if (envelope.success) {
      if (envelope.data.unitId !== unit.descriptor.unitId || envelope.data.kind !== unit.descriptor.kind || envelope.data.sourceHash !== unit.descriptor.sourceHash) {
        throw new Error('翻译响应 envelope 与计划不匹配')
      }
      return envelope.data.response
    }
    if (unit.descriptor.kind === 'plain') {
      const response = plainTranslationResponseSchema.parse(value)
      if (response.unitId !== unit.descriptor.unitId || response.sourceHash !== unit.descriptor.sourceHash) throw new Error('普通翻译响应与计划不匹配')
      return response
    }
    return tableTranslationResponseSchema.parse(value)
  }

  private async completeUnit(
    state: PlanState,
    unit: UnitState,
    output: Map<string, string>,
    provider: TranslationProviderId | null,
    model: string | null
  ): Promise<void> {
    await this.writeUnitResults(state, unit, output)
    const previous = {
      status: unit.status,
      descriptorStatus: unit.descriptor.status,
      provider: unit.provider,
      model: unit.model,
      error: unit.error,
      cacheResponse: unit.cacheResponse
    }
    unit.status = 'completed'
    unit.descriptor.status = 'completed'
    unit.provider = provider
    unit.model = model
    unit.error = null
    try {
      await this.commitUnit(state, unit)
      await this.writeMetadata(state)
    } catch (error) {
      // A size/protocol rejection must not leave the in-memory plan claiming
      // completion when its durable DB batch was never accepted.
      unit.status = previous.status
      unit.descriptor.status = previous.descriptorStatus
      unit.provider = previous.provider
      unit.model = previous.model
      unit.error = previous.error
      unit.cacheResponse = previous.cacheResponse
      throw error
    }
  }

  private async writeUnitResults(state: PlanState, unit: UnitState, output: Map<string, string>): Promise<void> {
    const ordered = unit.blockIds.map((blockId) => output.get(blockId) ?? '')
    for (let index = 0; index < unit.blockResultPaths.length; index += 1) {
      await this.atomicPlanWrite(state, unit.blockResultPaths[index]!, ordered[index] ?? '')
    }
    await this.atomicPlanWrite(state, unit.descriptor.resultPath, joinMarkdownBlocks(ordered))
  }

  private async commitUnit(state: PlanState, unit: UnitState): Promise<void> {
    const blocks: TranslationBatchBlock[] = unit.blockIds.map((blockId, index) => ({
      blockId,
      sourceHash: sha256(unit.sourceMarkdowns[index] ?? ''),
      sourceMarkdown: unit.sourceMarkdowns[index] ?? '',
      translatedMarkdown: null,
      provider: unit.status === 'completed' ? unit.provider : null,
      model: unit.status === 'completed' ? unit.model : null,
      status: unit.status,
      error: unit.status === 'failed' ? unit.error : null
    }))
    const translated = await Promise.all(blocks.map(async (block, index) => {
      if (unit.status !== 'completed') return block
      const markdown = await readFile(this.resolvePlanPath(state, unit.blockResultPaths[index]!), 'utf8')
      return { ...block, translatedMarkdown: markdown }
    }))
    await this.commitTranslationBatches({
      taskId: state.taskId,
      jobId: state.jobId,
      blocks: translated,
      cacheEntries: await this.cacheEntriesForUnit(state, unit),
      checkpoint: checkpointFor(state)
    })
  }

  /**
   * Commit utility-side batches using the exact wire payload limits.  The
   * utility repository is normally behind the RPC boundary, but keeping this
   * check here also prevents a future direct repository from constructing an
   * oversized batch or silently relying on SQLite TEXT's unbounded size.
   */
  private async commitTranslationBatches(input: TranslationBatchCommit): Promise<void> {
    assertPersistableTranslationBatch(input)
    let blockIndex = 0
    let cacheIndex = 0
    while (blockIndex < input.blocks.length || cacheIndex < input.cacheEntries.length) {
      const blocks: TranslationBatchBlock[] = []
      const cacheEntries: TranslationCacheEntry[] = []

      // A successful unit's cache entry and its blocks must share the first
      // transaction.  If that complete batch cannot fit, fail before any DB
      // mutation while leaving all plan files available for recovery.
      if (blockIndex < input.blocks.length && cacheIndex < input.cacheEntries.length) {
        const firstBlocks = [input.blocks[blockIndex]!]
        const firstCacheEntries = [input.cacheEntries[cacheIndex]!]
        const firstBatch = this.translationBatch({ ...input, blocks: firstBlocks, cacheEntries: firstCacheEntries })
        assertTranslationBatchSize(firstBatch)
        blocks.push(input.blocks[blockIndex]!)
        cacheEntries.push(input.cacheEntries[cacheIndex]!)
        blockIndex += 1
        cacheIndex += 1
      }

      let progressed = blocks.length > 0 || cacheEntries.length > 0
      while (blockIndex < input.blocks.length && blocks.length < MAX_TRANSLATION_BATCH_ITEMS) {
        const candidate = this.translationBatch({
          ...input,
          blocks: [...blocks, input.blocks[blockIndex]!],
          cacheEntries
        })
        if (!translationBatchFits(candidate)) break
        blocks.push(input.blocks[blockIndex]!)
        blockIndex += 1
        progressed = true
      }
      while (cacheIndex < input.cacheEntries.length && cacheEntries.length < MAX_TRANSLATION_BATCH_ITEMS) {
        const candidate = this.translationBatch({
          ...input,
          blocks,
          cacheEntries: [...cacheEntries, input.cacheEntries[cacheIndex]!]
        })
        if (!translationBatchFits(candidate)) break
        cacheEntries.push(input.cacheEntries[cacheIndex]!)
        cacheIndex += 1
        progressed = true
      }

      if (!progressed) {
        throw new Error('翻译批次 UTF-8 大小超过 768KiB，或单个持久化字段超过 262KiB')
      }
      this.repository.commitTranslationBatch(this.translationBatch({ ...input, blocks, cacheEntries }))
    }
  }

  private translationBatch(input: TranslationBatchCommit): TranslationBatchCommit {
    return {
      taskId: input.taskId,
      jobId: input.jobId,
      blocks: input.blocks,
      cacheEntries: input.cacheEntries,
      ...(input.checkpoint ? { checkpoint: input.checkpoint } : {})
    }
  }

  private async cacheEntriesForUnit(state: PlanState, unit: UnitState): Promise<TranslationCacheEntry[]> {
    if (unit.status !== 'completed' || !unit.provider || !unit.model) return []
    let translated: string
    if (unit.descriptor.kind === 'table') {
      if (!unit.cacheResponse) return []
      translated = JSON.stringify({
        version: TABLE_TRANSLATION_CACHE_VERSION,
        sourceHash: unit.descriptor.sourceHash,
        response: unit.cacheResponse
      })
    } else {
      // Cache the complete rendered Markdown unit (including its normalized
      // trailing newline), never the provider-facing segment list.
      translated = await readFile(this.resolvePlanPath(state, unit.descriptor.resultPath), 'utf8')
    }
    return [{
      // Keep the persisted key byte-for-byte compatible with the pre-plan
      // pipeline.  New protocol keys remain readable for forward/backward
      // compatibility, but writes must continue to hit the legacy cache.
      cacheKey: legacyCacheKey(unit.descriptor.sourceHash, unit.provider, unit.model, unit.descriptor.kind),
      translated,
      provider: unit.provider,
      model: unit.model
    }]
  }

  private async unitResultsExist(state: PlanState, unit: UnitState): Promise<boolean> {
    return (await Promise.all(unit.blockResultPaths.map((path) => this.fileExists(this.resolvePlanPath(state, path))))).every(Boolean)
  }

  private async writeMetadata(state: PlanState): Promise<void> {
    const key = planKey(state.taskId, state.jobId)
    const previous = this.metadataWriteTails.get(key) ?? Promise.resolve()
    const next = previous.then(() => this.writeMetadataNow(state), () => this.writeMetadataNow(state))
    const tail = next.then(() => undefined, () => undefined)
    this.metadataWriteTails.set(key, tail)
    try {
      await next
    } finally {
      if (this.metadataWriteTails.get(key) === tail) {
        this.metadataWriteTails.delete(key)
      }
    }
  }

  /** Serialize replacement of one plan.json on Windows and other platforms. */
  private async writeMetadataNow(state: PlanState): Promise<void> {
    const metadata: PlanMetadata = {
      formatVersion: 1,
      planId: state.planId,
      taskId: state.taskId,
      jobId: state.jobId,
      attempt: state.binding.attempt,
      preferredProvider: state.binding.translationProvider,
      sourceHash: state.sourceHash,
      mappingHash: state.mappingHash,
      pipelineVersion: TRANSLATION_PIPELINE_VERSION,
      mappingAlgorithmVersion: MARKDOWN_MAPPING_ALGORITHM_VERSION,
      blockMappingVersion: this.blockMappingVersion,
      tableTranslationProtocol: TABLE_TRANSLATION_PROTOCOL,
      tableTranslationCacheVersion: TABLE_TRANSLATION_CACHE_VERSION,
      units: state.units.map((unit) => ({
        unitId: unit.descriptor.unitId,
        kind: unit.descriptor.kind,
        sourceHash: unit.descriptor.sourceHash,
        blockIds: [...unit.blockIds],
        requestPath: unit.descriptor.requestPath,
        responsePath: unit.descriptor.responsePath,
        resultPath: unit.descriptor.resultPath,
        resultBlockPaths: [...unit.blockResultPaths],
        sourceIndexes: [...unit.sourceIndexes],
        mappingIds: unit.mappingIds.map((ids) => [...ids]),
        status: unit.status
      }))
    }
    await this.atomicPlanWrite(state, `.translation/${state.jobId}/plan.json`, `${JSON.stringify(metadata, null, 2)}\n`)
  }

  private async readMetadata(path: string): Promise<PlanMetadata | null> {
    try {
      const parsed = parseJson(await readFile(path, 'utf8'))
      return isPlanMetadata(parsed) ? parsed : null
    } catch {
      return null
    }
  }

  private async readMappings(root: string): Promise<BlockMapping[]> {
    const parsed = parseJson(await this.readOutputFile(root, 'block_list.json'))
    const list = z.object({
      version: z.literal(this.blockMappingVersion),
      mappings: z.array(blockMappingSchema).max(100_000)
    }).strict().safeParse(parsed)
    if (!list.success) throw new Error('block_list.json 内容无效或版本不匹配')
    return list.data.mappings
  }

  private async readOutputFile(root: string, relativePath: string): Promise<string> {
    const path = this.resolveOutputPath(root, relativePath)
    const info = await lstat(path)
    if (!info.isFile()) throw new Error('翻译输入不是普通文件')
    return readFile(path, 'utf8')
  }

  private resolveOutputPath(root: string, relativePath: string): string {
    if (!relativePath || relativePath.includes('\0') || relativePath.includes('\\') || isAbsolutePath(relativePath) || relativePath.split('/').some((part) => part === '..' || part.length === 0)) {
      throw new Error('翻译路径无效')
    }
    return this.pathPolicy.resolveChild(root, relativePath)
  }

  private resolvePlanPath(state: PlanState, relativePath: string): string {
    const prefix = `.translation/${state.jobId}/`
    if (!relativePath.startsWith(prefix) || relativePath.includes('\\') || relativePath.split('/').some((part) => part === '..' || part.length === 0)) {
      throw new Error('计划路径无效')
    }
    return this.pathPolicy.resolveChild(state.root, relativePath)
  }

  private async removeExactJobPlan(root: string, jobId: string): Promise<void> {
    const jobRoot = this.pathPolicy.resolveChild(root, `.translation/${jobId}`)
    await rm(jobRoot, { recursive: true, force: true })
  }

  private async atomicPlanWrite(state: PlanState, relativePath: string, content: string): Promise<void> {
    await this.atomicWrite(this.resolvePlanPath(state, relativePath), content)
  }

  private async atomicOutputWrite(state: PlanState, relativePath: string, content: string): Promise<void> {
    await this.atomicWrite(this.resolveOutputPath(state.root, relativePath), content)
  }

  private async atomicWrite(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.partial-${randomUUID()}`
    try {
      await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' })
      const handle = await open(temporary, 'r+')
      try { await handle.sync() } finally { await handle.close() }
      await rename(temporary, path)
      await syncDirectory(dirname(path))
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }

  private async fileExists(path: string): Promise<boolean> {
    try {
      const info = await lstat(path)
      return info.isFile()
    } catch {
      return false
    }
  }

  private requireUnit(state: PlanState, unitId: string): UnitState {
    const unit = state.unitById.get(unitId)
    if (!unit) throw new Error('翻译单元不存在')
    return unit
  }

  private async assertBindingOutputDir(binding: TranslationJobBinding): Promise<void> {
    if (!this.outputRoot) return
    await mkdir(this.outputRoot, { recursive: true })
    const documentsRoot = this.pathPolicy.resolveChild(this.outputRoot, 'documents-v2')
    await mkdir(documentsRoot, { recursive: true })
    const expected = this.pathPolicy.resolveChild(documentsRoot, binding.taskId)
    const candidate = this.pathPolicy.resolveChild(this.outputRoot, binding.outputDir)
    if (candidate !== expected) throw new Error('翻译作业输出目录不在配置的文档根目录内')
  }
}

function isAutomaticUnit(unit: UnitState): boolean {
  return unit.request.protocol === 'copilotix-translation-plain-v1'
    ? unit.request.segments.length === 0
    : unit.tablePlan?.hasTranslatableText === false
}

function countsFor(state: PlanState): { total: number; completed: number; failed: number } {
  return {
    total: state.units.reduce((sum, unit) => sum + unit.blockIds.length, 0),
    completed: state.units.filter((unit) => unit.status === 'completed').reduce((sum, unit) => sum + unit.blockIds.length, 0),
    failed: state.units.filter((unit) => unit.status === 'failed').reduce((sum, unit) => sum + unit.blockIds.length, 0)
  }
}

function mutationFor(state: PlanState, unit: UnitState): TranslationPlanMutationResult {
  return translationPlanMutationResultSchema.parse({ ...countsFor(state), unitId: unit.descriptor.unitId, status: unit.status })
}

function checkpointFor(state: PlanState): { totalBlocks: number; completedBlocks: number; failedBlocks: number; failedBlockIds: string[] } {
  const counts = countsFor(state)
  return {
    totalBlocks: counts.total,
    completedBlocks: counts.completed,
    failedBlocks: counts.failed,
    failedBlockIds: state.units.filter((unit) => unit.status === 'failed').flatMap((unit) => unit.blockIds).slice(0, 64)
  }
}

function collectPlainSegments(tree: any, unitId: string): Array<{ id: string; source: string; node: { value: string } }> {
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

function shouldTranslate(value: unknown): boolean {
  if (typeof value !== 'string' || !/[A-Za-z\p{L}]/u.test(value)) return false
  const letters = value.match(/[A-Za-z]/g)?.length ?? 0
  const han = value.match(/[\p{Script=Han}]/gu)?.length ?? 0
  return letters > 0 || han === 0
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

function buildReferenceActions(sourceBlocks: Array<{ markdown: string; mappingIds: string[] }>, mappings: BlockMapping[]): Map<number, string> {
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

function translationBlockId(taskId: string, sourceIndex: number, mappingIds: string[]): string {
  return `translation-${sha256(`${TRANSLATION_PIPELINE_VERSION}|${taskId}|${sourceIndex}|${mappingIds.join('|')}`).slice(0, 20)}`
}

function stableUuid(value: string): string {
  const digest = createHash('sha256').update(value).digest()
  digest[6] = (digest[6]! & 0x0f) | 0x40
  digest[8] = (digest[8]! & 0x3f) | 0x80
  const hex = digest.subarray(0, 16).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function joinMarkdownBlocks(blocks: string[]): string {
  return blocks.length > 0 ? `${blocks.map((block) => block.trimEnd()).join('\n\n')}\n` : ''
}

function unitMarkdownMap(unit: UnitState, markdown: string): Map<string, string> {
  return new Map([[unit.blockIds[0]!, markdown]])
}

function legacyCacheKey(sourceHash: string, provider: string, model: string, kind: TranslationPlanUnitKind): string {
  return sha256(kind === 'table'
    ? `${TRANSLATION_PIPELINE_VERSION}|table|${TABLE_TRANSLATION_CACHE_VERSION}|${provider}|${model}|zh-CN|${sourceHash}`
    : `${TRANSLATION_PIPELINE_VERSION}|${provider}|${model}|zh-CN|${sourceHash}`)
}

function assertPersistableTranslationBatch(input: TranslationBatchCommit): void {
  for (const block of input.blocks) {
    assertTranslationField(block.sourceMarkdown, `翻译块 ${block.blockId} 的原文`)
    if (block.translatedMarkdown !== null) assertTranslationField(block.translatedMarkdown, `翻译块 ${block.blockId} 的译文`)
  }
  for (const entry of input.cacheEntries) assertTranslationField(entry.translated, `翻译缓存 ${entry.cacheKey}`)
}

function assertTranslationField(value: string, label: string): void {
  if (Buffer.byteLength(value, 'utf8') > MAX_TRANSLATION_FIELD_BYTES) {
    throw new Error(`${label}超过 262KiB 持久化字段限制，请保留正文文件并避免通过 RPC`)
  }
}

function translationBatchFits(input: TranslationBatchCommit): boolean {
  return input.blocks.length <= MAX_TRANSLATION_BATCH_ITEMS &&
    input.cacheEntries.length <= MAX_TRANSLATION_BATCH_ITEMS &&
    Buffer.byteLength(JSON.stringify(input), 'utf8') <= MAX_TRANSLATION_BATCH_BYTES
}

function assertTranslationBatchSize(input: TranslationBatchCommit): void {
  if (!translationBatchFits(input)) throw new Error('翻译批次 UTF-8 大小超过 768KiB')
}

function planKey(taskId: string, jobId: string): string {
  return `${taskId}\u0000${jobId}`
}

function normalizeCursor(value: number): number {
  if (!Number.isInteger(value) || value < 0) throw new Error('翻译计划 cursor 无效')
  return value
}

function normalizeLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 32) throw new Error('翻译计划 limit 必须在 1 到 32 之间')
  return value
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value) as unknown } catch { throw new Error('翻译计划 JSON 无效') }
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isPlanMetadata(value: unknown): value is PlanMetadata {
  if (!isRecord(value) || value.formatVersion !== 1 || typeof value.planId !== 'string' || typeof value.taskId !== 'string' || typeof value.jobId !== 'string' ||
    typeof value.attempt !== 'number' || !Number.isInteger(value.attempt) || value.attempt < 0 ||
    !isTranslationProviderId(value.preferredProvider) ||
    typeof value.sourceHash !== 'string' || typeof value.mappingHash !== 'string' || !Array.isArray(value.units)) return false
  return value.units.every((unit: unknown) => isRecord(unit) && typeof unit.unitId === 'string' && typeof unit.kind === 'string' &&
    typeof unit.sourceHash === 'string' && Array.isArray(unit.blockIds) && Array.isArray(unit.resultBlockPaths) &&
    Array.isArray(unit.sourceIndexes) && Array.isArray(unit.mappingIds) && typeof unit.requestPath === 'string' &&
    typeof unit.responsePath === 'string' && typeof unit.resultPath === 'string' && typeof unit.status === 'string')
}

function isTranslationProviderId(value: unknown): value is TranslationProviderId {
  return value === 'qwen' || value === 'deepseek' || value === 'bing' || value === 'transmart'
}

function arraysEqual(left: unknown, right: unknown): boolean {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => value === right[index])
}

function nestedArraysEqual(left: unknown, right: unknown): boolean {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => arraysEqual(value, right[index]))
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('\\\\')
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, 'r')
    try { await handle.sync() } finally { await handle.close() }
  } catch {
    // Windows does not support opening directories for fsync; the file fsync
    // and atomic rename above still provide the durable publication boundary.
  }
}

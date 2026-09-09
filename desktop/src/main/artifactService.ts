import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { access, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import archiver from 'archiver'
import type { BlockMapping, DocumentPayload, CopilotixTask, TranslatedMarkdownBlock } from '@shared/types'
import { TABLE_TRANSLATION_PROTOCOL, TRANSLATION_PIPELINE_VERSION } from '@shared/translationPlanProtocol'
import type { ArtifactKind } from '@core/types'
import type { PathPolicyPort, TaskComputePort } from '@core/ports'
import { BLOCK_MAPPING_VERSION } from '@core/blockMapping'
import { MARKDOWN_MAPPING_ALGORITHM_VERSION } from '@shared/markdownBlocks'
import type { TaskRepositoryCompat } from './taskRepositoryCompat'

/** Filesystem-facing document/artifact operations kept out of command and runner orchestration. */
export class ArtifactService {
  constructor(
    private readonly repository: TaskRepositoryCompat,
    private readonly compute: TaskComputePort,
    private readonly pathPolicy: PathPolicyPort
  ) {}

  async getDocument(taskId: string): Promise<DocumentPayload> {
    const task = await this.requireTask(taskId)
    const markdown = await this.readOptional(join(task.outputDir, 'full.md'))
    const translatedMarkdown = await this.readOptional(join(task.outputDir, 'full.zh-CN.md'))
    const translatedBlocks = await this.loadTranslatedBlocks(task)
    const layoutJson = await this.readOptional(join(task.outputDir, 'layout.json'), '{}')
    const mappings = await this.loadMappings(task)
    return {
      task,
      markdown,
      translatedMarkdown,
      translatedBlocks,
      layoutJson,
      mappings,
      pdfUrl: `copilotix-asset://${task.id}/original.pdf`,
      assetBaseUrl: `copilotix-asset://${task.id}/`
    }
  }

  async resolveAsset(taskId: string, assetPath: string): Promise<string> {
    const task = await this.requireTask(taskId)
    return this.pathPolicy.resolveChild(task.outputDir, decodeURIComponent(assetPath.replace(/^\/+/, '')))
  }

  async createResultZip(taskId: string, destination: string): Promise<void> {
    const task = await this.requireTask(taskId)
    await new Promise<void>((resolvePromise, reject) => {
      const output = createWriteStream(destination)
      const archive = archiver('zip', { zlib: { level: 9 } })
      output.on('close', () => resolvePromise())
      output.on('error', reject)
      archive.on('error', reject)
      archive.pipe(output)
      archive.directory(task.outputDir, false, (entry) => shouldIncludeResultZipEntry(entry.name) ? entry : false)
      void archive.finalize()
    })
  }

  async recordArtifact(task: CopilotixTask, kind: ArtifactKind, path: string, jobId?: string): Promise<void> {
    if (!this.repository.recordArtifactRevision) return
    await this.repository.recordArtifactRevision(task.id, kind, path, await this.compute.hashFile(path), {}, jobId)
  }

  async atomicWriteFile(path: string, content: string): Promise<void> {
    const partialPath = `${path}.partial-${randomUUID()}`
    try {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(partialPath, content, 'utf8')
      const handle = await open(partialPath, 'r+')
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(partialPath, path)
    } finally {
      await rm(partialPath, { force: true }).catch(() => undefined)
    }
  }

  async atomicWriteJson(path: string, value: unknown): Promise<void> {
    await this.atomicWriteFile(path, JSON.stringify(value, null, 2))
  }

  async loadMappings(task: CopilotixTask): Promise<BlockMapping[]> {
    const blockPath = join(task.outputDir, 'block_list.json')
    try {
      const value = JSON.parse(await readFile(blockPath, 'utf8')) as { version?: number; mappings?: BlockMapping[] }
      if (value.version === BLOCK_MAPPING_VERSION && Array.isArray(value.mappings)) return value.mappings
      await this.compute.rebuildMappings(task.id, task.outputDir)
      return readMappings(blockPath)
    } catch {
      try {
        await this.compute.rebuildMappings(task.id, task.outputDir)
        return readMappings(blockPath)
      } catch {
        return []
      }
    }
  }

  async loadTranslatedBlocks(task: CopilotixTask): Promise<TranslatedMarkdownBlock[] | null> {
    try {
      const manifest = JSON.parse(await readFile(join(task.outputDir, 'translation.manifest.json'), 'utf8')) as unknown
      if (!isRecord(manifest) || manifest.version !== 2 || manifest.taskId !== task.id ||
        manifest.translationPipelineVersion !== TRANSLATION_PIPELINE_VERSION ||
        manifest.tableTranslationProtocol !== TABLE_TRANSLATION_PROTOCOL ||
        !Array.isArray(manifest.blocks)) return null
      const blocks = manifest.blocks.map((block) => {
        if (!isRecord(block) || !Number.isInteger(block.sourceIndex) || (block.sourceIndex as number) < 0 || typeof block.markdown !== 'string') return null
        const mappingIds = Array.isArray(block.mappingIds) && block.mappingIds.every((id) => typeof id === 'string')
          ? [...block.mappingIds] as string[]
          : null
        return { sourceIndex: block.sourceIndex as number, markdown: block.markdown, mappingIds }
      })
      if (blocks.some((block) => block === null)) return null
      const validBlocks = blocks as Array<{ sourceIndex: number; markdown: string; mappingIds: string[] | null }>
      const sourceIndexes = validBlocks.map((block) => block.sourceIndex)
      const validSourceOrder = new Set(sourceIndexes).size === sourceIndexes.length &&
        [...sourceIndexes].sort((left, right) => left - right).every((sourceIndex, index) => sourceIndex === index)
      const ordered = validSourceOrder
        ? [...validBlocks].sort((left, right) => left.sourceIndex - right.sourceIndex)
        : validBlocks
      const trustMappings = validSourceOrder && manifest.mappingAlgorithmVersion === MARKDOWN_MAPPING_ALGORITHM_VERSION &&
        manifest.blockMappingVersion === BLOCK_MAPPING_VERSION &&
        ordered.every((block) => Array.isArray(block.mappingIds))
      return ordered.map(({ sourceIndex, markdown, mappingIds }) => ({
        sourceIndex,
        markdown,
        mappingIds: trustMappings ? mappingIds ?? [] : []
      }))
    } catch {
      return null
    }
  }

  async readOptional(path: string, fallback = ''): Promise<string> {
    try {
      await access(path)
      return await readFile(path, 'utf8')
    } catch {
      return fallback
    }
  }

  private async requireTask(taskId: string): Promise<CopilotixTask> {
    const task = await this.repository.getTask(taskId)
    if (!task) throw new Error('任务不存在')
    return task
  }
}

function readMappings(path: string): Promise<BlockMapping[]> {
  return readFile(path, 'utf8').then((value) => {
    const parsed = JSON.parse(value) as { mappings?: unknown }
    return Array.isArray(parsed.mappings) ? parsed.mappings as BlockMapping[] : []
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

/** Keep durable plan request/response internals out of user-exported archives. */
export function shouldIncludeResultZipEntry(name: string): boolean {
  const normalized = name.replace(/\\/g, '/').replace(/^\/+/, '')
  return normalized !== '.translation' && !normalized.startsWith('.translation/')
}

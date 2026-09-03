import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { JobRunner, JobRunnerInput, JobRunnerResult } from '@core/jobs'
import { JobRunnerError } from '@core/jobs'
import type { TaskComputePort } from '@core/ports'
import { createTranslationProviders } from './translation/providers'
import { translateMarkdown } from './translation/markdownPipeline'
import type { CredentialVault } from './credentialVault'
import type { SettingsService } from './settingsService'
import type { TaskRepositoryCompat } from './taskRepositoryCompat'
import type { TaskLogger } from './logger'
import { ArtifactService } from './artifactService'
import { ProgressReporter } from './progressReporter'

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface TranslationJobRunnerOptions {
  repository: TaskRepositoryCompat
  settingsService: SettingsService
  vault: CredentialVault
  fetcher: Fetcher
  compute: TaskComputePort
  pathPolicy: import('@core/ports').PathPolicyPort
  logger?: TaskLogger
  artifacts?: ArtifactService
}

/** Executes one durable translate job; job state is changed only by Scheduler. */
export class TranslationJobRunner implements JobRunner {
  private readonly artifacts: ArtifactService
  private readonly logger: TaskLogger

  constructor(private readonly options: TranslationJobRunnerOptions) {
    this.artifacts = options.artifacts ?? new ArtifactService(options.repository, options.compute, options.pathPolicy)
    this.logger = options.logger ?? { info: () => undefined, error: () => undefined }
  }

  async run(input: JobRunnerInput): Promise<JobRunnerResult> {
    const task = await this.options.repository.getTask(input.job.documentId)
    if (!task) throw new JobRunnerError('文档不存在', 'DOCUMENT_NOT_FOUND', false)
    const settings = await this.options.settingsService.get()
    const markdown = await this.artifacts.readOptional(join(task.outputDir, 'full.md'))
    if (!markdown.trim()) throw new JobRunnerError('解析产物尚未生成', 'PARSED_ARTIFACT_MISSING', false)
    const mappings = await this.artifacts.loadMappings(task)
    const providers = createTranslationProviders(settings, this.options.vault, this.options.fetcher)
    const checkpointBase = { ...input.job.checkpoint, stage: 'translating' }
    const reporter = new ProgressReporter(input.updateProgress, {
      onEmit: () => undefined
    })

    this.logger.info('translation.start', { taskId: task.id, jobId: input.job.id, preferredProvider: task.translationProvider })
    const result = await translateMarkdown({
      task,
      jobId: input.job.id,
      markdown,
      mappings,
      providers,
      repository: this.options.repository,
      onProgress: async (completed, total, failed) => {
        if (input.signal.aborted) throw abortError()
        await reporter.report(
          total === 0 ? 100 : 45 + Math.round(((completed + failed) / total) * 55),
          { ...checkpointBase, totalBlocks: total, completedBlocks: completed, failedBlocks: failed }
        )
      }
    })
    if (input.signal.aborted) throw abortError()

    await writeFile(join(task.outputDir, 'full.zh-CN.md'), result.markdown, 'utf8')
    await this.artifacts.recordArtifact(task, 'translated_markdown', join(task.outputDir, 'full.zh-CN.md'), input.job.id)
    const completed = result.blocks.filter((block) => block.status === 'completed').length
    const checkpoint = {
      ...checkpointBase,
      stage: 'completed',
      totalBlocks: result.blocks.length,
      completedBlocks: completed,
      failedBlockIds: result.failedBlockIds,
      updatedAt: new Date().toISOString()
    }
    await writeFile(join(task.outputDir, 'translation.checkpoint.json'), JSON.stringify({ taskId: task.id, ...checkpoint }, null, 2), 'utf8')
    await this.artifacts.writeManifest(task, result, input.job.id)
    this.logger.info('translation.completed', { taskId: task.id, jobId: input.job.id, failedBlocks: result.failedBlockIds.length })
    return {
      status: result.failedBlockIds.length > 0 ? 'partial' : 'succeeded',
      progress: 100,
      checkpoint,
      detail: { failedBlockCount: result.failedBlockIds.length }
    }
  }
}

function abortError(): Error {
  return new Error('Job runner aborted')
}

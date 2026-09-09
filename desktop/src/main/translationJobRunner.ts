import type { JobRunner, JobRunnerInput, JobRunnerResult } from '@core/jobs'
import { JobRunnerError } from '@core/jobs'
import type { TaskComputePort } from '@core/ports'
import { createTranslationProviders } from './translation/providers'
import { runTranslationPlan } from './translation/translationPlanOrchestrator'
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
    if (settings.credentials.parser.state !== 'valid') {
      const stateMessage = settings.credentials.parser.state === 'missing'
        ? '未配置 Parser API Token'
        : 'Parser API Token 尚未验证或已经失效'
      throw new JobRunnerError(`${stateMessage}，请在设置中验证后重试`, 'TRANSLATION_CREDENTIALS_REQUIRED', false)
    }
    const providers = createTranslationProviders(settings, this.options.vault, this.options.fetcher)
    // Provider selection is resolved at execution time so a manual retry can
    // use the corrected setting instead of an old task snapshot.
    const effectiveTask = { ...task, translationProvider: settings.translationProvider }
    const checkpointBase = {
      ...input.job.checkpoint,
      stage: 'translating',
      failedBlockIds: Array.isArray(input.job.checkpoint.failedBlockIds)
        ? input.job.checkpoint.failedBlockIds.filter((id): id is string => typeof id === 'string').slice(0, 64)
        : []
    }
    const reporter = new ProgressReporter(input.updateProgress, {
      onEmit: () => undefined
    })

    this.logger.info('translation.start', { taskId: task.id, jobId: input.job.id, preferredProvider: effectiveTask.translationProvider })
    const result = await runTranslationPlan({
      task: effectiveTask,
      jobId: input.job.id,
      providers,
      compute: this.options.compute,
      artifacts: this.artifacts,
      pathPolicy: this.options.pathPolicy,
      signal: input.signal,
      onCredentialFailure: async (name) => {
        await this.options.settingsService.invalidateCredential(name).catch(() => undefined)
      },
      onProgress: async ({ counts, failedBlockIds }) => {
        if (input.signal.aborted) throw abortError()
        const { completed, total, failed } = counts
        await reporter.report(
          total === 0 ? 100 : 45 + Math.round(((completed + failed) / total) * 55),
          {
            ...checkpointBase,
            totalBlocks: total,
            completedBlocks: completed,
            failedBlocks: failed,
            failedBlockIds: [...failedBlockIds].slice(0, 64)
          }
        )
      }
    })
    if (input.signal.aborted) throw abortError()

    const checkpoint = {
      ...checkpointBase,
      stage: 'completed',
      totalBlocks: result.total,
      completedBlocks: result.completed,
      failedBlocks: result.failed,
      failedBlockIds: result.failedBlockIdsSample.slice(0, 64),
      updatedAt: new Date().toISOString()
    }
    await reporter.report(100, checkpoint, true)
    this.logger.info('translation.completed', { taskId: task.id, jobId: input.job.id, failedBlocks: result.failed })
    return {
      status: result.status,
      progress: 100,
      checkpoint,
      detail: {
        failedBlockCount: result.failed,
        translatedRelativePath: result.translatedRelativePath,
        manifestRelativePath: result.manifestRelativePath,
        checkpointRelativePath: result.checkpointRelativePath
      }
    }
  }
}

function abortError(): Error {
  return new Error('Job runner aborted')
}

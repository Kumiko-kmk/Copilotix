import { rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import extract from 'extract-zip'
import PQueue from 'p-queue'
import type {
  BatchJobRunner,
  Job,
  JobBatchResult,
  JobCheckpoint,
  JobRunnerError,
  JobRunnerResult
} from '@core/jobs'
import { JobRunnerError as RunnerError } from '@core/jobs'
import type { PathPolicyPort, TaskComputePort } from '@core/ports'
import type { AppSettings, CopilotixTask } from '@shared/types'
import type { CredentialVault } from './credentialVault'
import type { TaskLogger } from './logger'
import { ParserApiError, type ParserClient, type BatchResult, type BatchSubmission } from './parserClient'
import type { SettingsService } from './settingsService'
import type { TaskRepositoryCompat } from './taskRepositoryCompat'
import type { JobRepositoryPort } from '@core/jobs'
import { ProgressReporter } from './progressReporter'
import type { UsageAnalyticsRecorder } from './usageAnalyticsService'

const DEFAULT_PARSE_PIPELINE_CONCURRENCY = Object.freeze({
  upload: 3,
  download: 2,
  extract: 2,
  normalize: 2
})

export interface ParsePipelineConcurrency {
  upload: number
  download: number
  extract: number
  normalize: number
}

export interface ParseJobRunnerOptions {
  repository: TaskRepositoryCompat
  jobRepository: JobRepositoryPort
  settingsService: SettingsService
  vault: CredentialVault
  parserClient: ParserClient
  compute: TaskComputePort
  pathPolicy: PathPolicyPort
  logger?: TaskLogger
  usageAnalytics?: UsageAnalyticsRecorder
  concurrency?: Partial<ParsePipelineConcurrency>
}

interface LoadedJob {
  job: Job
  task: CopilotixTask
}

/** Scheduler-owned parse runner with remote IDs/checkpoints as the resume source of truth. */
export class ParseJobRunner implements BatchJobRunner {
  private readonly logger: TaskLogger
  private readonly remoteSnapshots = new Map<string, string>()
  private readonly uploadQueue: PQueue
  private readonly downloadQueue: PQueue
  private readonly extractQueue: PQueue
  private readonly normalizeQueue: PQueue

  constructor(private readonly options: ParseJobRunnerOptions) {
    this.logger = options.logger ?? { info: () => undefined, error: () => undefined }
    this.uploadQueue = new PQueue({ concurrency: positiveConcurrency(options.concurrency?.upload, DEFAULT_PARSE_PIPELINE_CONCURRENCY.upload) })
    this.downloadQueue = new PQueue({ concurrency: positiveConcurrency(options.concurrency?.download, DEFAULT_PARSE_PIPELINE_CONCURRENCY.download) })
    this.extractQueue = new PQueue({ concurrency: positiveConcurrency(options.concurrency?.extract, DEFAULT_PARSE_PIPELINE_CONCURRENCY.extract) })
    this.normalizeQueue = new PQueue({ concurrency: positiveConcurrency(options.concurrency?.normalize, DEFAULT_PARSE_PIPELINE_CONCURRENCY.normalize) })
  }

  async run(input: { job: Job; signal: AbortSignal; updateProgress: (progress: number, checkpoint: JobCheckpoint) => Promise<Job> }): Promise<JobRunnerResult> {
    const results = await this.runBatch({
      jobs: [input.job],
      signal: input.signal,
      updateProgress: async (jobId, progress, checkpoint) => {
        if (jobId !== input.job.id) throw new Error('Parse runner received an unknown job')
        return input.updateProgress(progress, checkpoint)
      }
    })
    const result = results[0]
    if (!result) throw new RunnerError('解析作业没有结果', 'PARSER_EMPTY_RESULT', false)
    if (result.error !== undefined) throw result.error
    if (!result.result) throw new RunnerError('解析作业没有完成状态', 'PARSER_EMPTY_RESULT', false)
    return result.result
  }

  async runBatch(input: {
    jobs: Job[]
    signal: AbortSignal
    updateProgress: (jobId: string, progress: number, checkpoint: JobCheckpoint) => Promise<Job>
  }): Promise<readonly JobBatchResult[]> {
    if (input.jobs.length === 0) return []
    const loaded = await Promise.all(input.jobs.map(async (job): Promise<LoadedJob | JobBatchResult> => {
      const task = await this.options.repository.getTask(job.documentId)
      return task ? { job, task } : failure(job, new RunnerError('文档不存在', 'DOCUMENT_NOT_FOUND', false))
    }))
    const valid = loaded.filter((item): item is LoadedJob => 'task' in item)
    const results: JobBatchResult[] = loaded.filter((item): item is JobBatchResult => !('task' in item))
    if (valid.length === 0) return results

    const settings = await this.options.settingsService.get()
    const token = await this.options.vault.get('parser-token')
    if (!token) {
      return results.concat(valid.map(({ job }) => failure(job, new RunnerError('未配置 Parser API Token', 'PARSER_AUTH_REQUIRED', false))))
    }

    const resumable = valid.filter(({ job }) => hasRemoteCheckpoint(job))
    const fresh = valid.filter(({ job }) => !hasRemoteCheckpoint(job))
    if (fresh.length > 0) results.push(...await this.processFresh(fresh, settings, token, input))
    if (resumable.length > 0) {
      const resumed = await Promise.all(resumable.map((loadedJob) => this.resumeOne(loadedJob, settings, token, input)))
      results.push(...resumed)
    }
    return results
  }

  private async processFresh(
    loaded: LoadedJob[],
    settings: AppSettings,
    token: string,
    input: { signal: AbortSignal; updateProgress: (jobId: string, progress: number, checkpoint: JobCheckpoint) => Promise<Job> }
  ): Promise<JobBatchResult[]> {
    let submission: BatchSubmission
    try {
      submission = await this.options.parserClient.createUploadBatch(loaded.map(({ task }) => task), settings, token, input.signal)
    } catch (error) {
      await this.invalidateParserCredential(error)
      return loaded.map(({ job }) => failure(job, toRunnerError(error, 'PARSER_SUBMIT_FAILED', [token])))
    }

    const byTaskId = new Map(loaded.map((item) => [item.task.id, item]))
    const reporters = new Map(loaded.map(({ job }) => [job.id, new ProgressReporter((progress, checkpoint) => input.updateProgress(job.id, progress, checkpoint))]))
    const progressTails = new Map<string, Promise<void>>()
    const uploaded = new Set<string>()
    const uploadErrors = new Map<string, unknown>()
    const uploadTargets = new Map(submission.uploads.map((upload) => [upload.taskId, upload]))

    for (const { job, task } of loaded) {
      const upload = uploadTargets.get(task.id)
      if (!upload) {
        uploadErrors.set(task.id, new RunnerError('Copilotix 返回的上传链接缺少文档', 'PARSER_PROTOCOL_ERROR', false))
        continue
      }
      await reporters.get(job.id)!.report(1, checkpointFor(job, 'uploading', {
        remoteBatchId: submission.batchId,
        remoteDataId: upload.dataId,
        remoteResultUrl: null
      }), true)
    }

    await Promise.all([...uploadTargets.values()].map((upload) => this.uploadQueue.add(async () => {
      const loadedJob = byTaskId.get(upload.taskId)
      if (!loadedJob || input.signal.aborted || uploadErrors.has(upload.taskId)) return
      const { job, task } = loadedJob
      let lastProgress = -1
      try {
        this.logger.info('upload.start', { taskId: task.id, jobId: job.id, batchId: submission!.batchId, bytes: (await stat(task.sourcePath)).size })
        await this.options.parserClient.uploadFile(task.sourcePath, upload.uploadUrl, (sent, total) => {
          const progress = Math.min(8, Math.max(1, total > 0 ? Math.round((sent / total) * 8) : 1))
          if (progress === lastProgress) return
          lastProgress = progress
          const previous = progressTails.get(job.id) ?? Promise.resolve()
          const next = previous.then(async () => {
            await reporters.get(job.id)!.report(progress, checkpointFor(job, 'uploading', {
              remoteBatchId: submission!.batchId,
              remoteDataId: upload.dataId,
              remoteResultUrl: null
            }))
          })
          progressTails.set(job.id, next.catch(() => undefined))
        }, input.signal)
        await progressTails.get(job.id)
        uploaded.add(task.id)
        await reporters.get(job.id)!.report(10, checkpointFor(job, 'polling', {
          remoteBatchId: submission!.batchId,
          remoteDataId: upload.dataId,
          remoteResultUrl: null
        }), true)
        this.logger.info('upload.completed', { taskId: task.id, jobId: job.id, batchId: submission!.batchId })
      } catch (error) {
        uploadErrors.set(task.id, toRunnerError(error, 'PARSER_UPLOAD_FAILED', [token]))
      }
    }, { signal: input.signal })))

    if (input.signal.aborted) return loaded.map(({ job, task }) => failure(job, uploadErrors.get(task.id) ?? new Error('Job runner aborted')))
    if (uploaded.size === 0) return loaded.map(({ job, task }) => failure(job, uploadErrors.get(task.id) ?? new RunnerError('没有成功上传的 PDF', 'PARSER_UPLOAD_FAILED', false)))

    const progressByTask = new Map(loaded.map(({ task }) => [task.id, { job: byTaskId.get(task.id)!.job, reporter: reporters.get(byTaskId.get(task.id)!.job.id)! }]))
    let finalResult: BatchResult
    try {
      finalResult = await this.options.parserClient.waitForBatch(
        submission.batchId,
        token,
        uploaded,
        (result) => this.applyRemoteProgress(result, submission!.batchId, progressByTask, progressTails),
        input.signal
      )
      await Promise.all([...progressTails.values()])
    } catch (error) {
      await this.invalidateParserCredential(error)
      const runnerError = toRunnerError(error, 'PARSER_POLL_FAILED', [token])
      return loaded.map(({ job, task }) => uploaded.has(task.id) ? failure(job, runnerError) : failure(job, uploadErrors.get(task.id) ?? runnerError))
    }

    const entries = new Map(finalResult.entries.filter((entry) => entry.dataId).map((entry) => [entry.dataId!, entry]))
    return Promise.all(loaded.map(async ({ job, task }) => {
      if (uploadErrors.has(task.id)) return failure(job, uploadErrors.get(task.id)!)
      if (!uploaded.has(task.id)) return failure(job, new RunnerError('PDF 上传失败', 'PARSER_UPLOAD_FAILED', false))
      const entry = entries.get(task.id)
      if (!entry) return failure(job, new RunnerError('Copilotix 批次结果缺少对应 data_id', 'PARSER_PROTOCOL_ERROR', false))
      if (entry.state === 'failed') return failure(job, new RunnerError(redactSecrets(entry.error || 'Copilotix 解析失败', [token]), 'PARSER_REMOTE_FAILED', false))
      if (entry.state !== 'done' || !entry.fullZipUrl) return failure(job, new RunnerError(`Copilotix 返回未完成状态：${entry.state}`, 'PARSER_PROTOCOL_ERROR', false))
      try {
        const result = await this.processParsedArtifact(job, task, entry.fullZipUrl, settings, input, submission.batchId, entry.dataId ?? undefined)
        return { jobId: job.id, result }
      } catch (error) {
        return failure(job, toRunnerError(error, 'PARSER_RESULT_FAILED', [token]))
      }
    }))
  }

  private async resumeOne(
    loaded: LoadedJob,
    settings: AppSettings,
    token: string,
    input: { signal: AbortSignal; updateProgress: (jobId: string, progress: number, checkpoint: JobCheckpoint) => Promise<Job> }
  ): Promise<JobBatchResult> {
    const { job, task } = loaded
    const remoteBatchId = stringValue(job.checkpoint.remoteBatchId)
    const remoteDataId = stringValue(job.checkpoint.remoteDataId)
    if (!remoteBatchId || !remoteDataId) return failure(job, new RunnerError('远程 checkpoint 无效', 'PARSER_CHECKPOINT_INVALID', false))
    try {
      const initial = await this.options.parserClient.getBatchResult(remoteBatchId, token, input.signal)
      const entry = initial.entries.find((item) => item.dataId === remoteDataId)
      if (entry?.state === 'failed' || entry?.state === 'waiting-file') {
        const cleared = checkpointFor(job, 'uploading', { remoteBatchId: null, remoteDataId: null, remoteResultUrl: null })
        await input.updateProgress(job.id, 0, cleared)
        const fresh = await this.processFresh([loaded], settings, token, input)
        return fresh[0] ?? failure(job, new RunnerError('重新上传失败', 'PARSER_UPLOAD_FAILED', false))
      }
      if (entry?.state === 'done' && entry.fullZipUrl) {
        return { jobId: job.id, result: await this.processParsedArtifact(job, task, entry.fullZipUrl, settings, input, remoteBatchId, remoteDataId) }
      }
      const reporter = new ProgressReporter((progress, checkpoint) => input.updateProgress(job.id, progress, checkpoint))
      const tails = new Map<string, Promise<void>>()
      const progressByTask = new Map([[task.id, { job, reporter }]])
      const finalResult = await this.options.parserClient.waitForBatch(
        remoteBatchId,
        token,
        new Set([remoteDataId]),
        (result) => this.applyRemoteProgress(result, remoteBatchId, progressByTask, tails),
        input.signal
      )
      await Promise.all(tails.values())
      const finalEntry = finalResult.entries.find((item) => item.dataId === remoteDataId)
      if (!finalEntry || finalEntry.state !== 'done' || !finalEntry.fullZipUrl) {
        return failure(job, new RunnerError(redactSecrets(finalEntry?.error || 'Copilotix 解析结果无效', [token]), 'PARSER_REMOTE_FAILED', false))
      }
      return { jobId: job.id, result: await this.processParsedArtifact(job, task, finalEntry.fullZipUrl, settings, input, remoteBatchId, remoteDataId) }
    } catch (error) {
      await this.invalidateParserCredential(error)
      return failure(job, toRunnerError(error, 'PARSER_RESUME_FAILED', [token]))
    }
  }

  private async invalidateParserCredential(error: unknown): Promise<void> {
    if (!(error instanceof ParserApiError)) return
    const code = String(error.code)
    if (code !== 'A0202' && code !== 'A0211' && code !== 'HTTP_401' && code !== 'HTTP_403') return
    await this.options.settingsService.invalidateCredential(
      'parser',
      code === 'A0211' ? 'PARSER_TOKEN_EXPIRED' : 'PARSER_TOKEN_INVALID',
      code === 'A0211' ? 'Parser API Token 已过期，请重新验证' : 'Parser API Token 无效，请重新验证'
    ).catch(() => undefined)
  }

  private async processParsedArtifact(
    job: Job,
    originalTask: CopilotixTask,
    resultUrl: string,
    settings: AppSettings,
    input: { signal: AbortSignal; updateProgress: (jobId: string, progress: number, checkpoint: JobCheckpoint) => Promise<Job> },
    remoteBatchId?: string,
    remoteDataId?: string
  ): Promise<JobRunnerResult> {
    const checkpoint = checkpointFor(job, 'downloading', {
      remoteBatchId: remoteBatchId ?? stringValue(job.checkpoint.remoteBatchId),
      remoteDataId: remoteDataId ?? stringValue(job.checkpoint.remoteDataId),
      remoteResultUrl: resultUrl
    })
    await input.updateProgress(job.id, 42, checkpoint)
    const zipPath = join(originalTask.outputDir, '.copilotix-result.zip')
    const partialZipPath = `${zipPath}.partial-${job.id}`
    const extractedDir = join(originalTask.outputDir, `.parsed.partial-${job.id}`)
    try {
      await this.downloadQueue.add(async () => {
        await this.options.parserClient.downloadResult(resultUrl, partialZipPath, input.signal)
        if (input.signal.aborted) throw new Error('Job runner aborted')
        await rm(zipPath, { force: true })
        await rename(partialZipPath, zipPath)
      }, { signal: input.signal })
      await this.extractQueue.add(async () => {
        await rm(extractedDir, { recursive: true, force: true })
        await extract(zipPath, { dir: extractedDir })
      }, { signal: input.signal })
      const normalized = await this.normalizeQueue.add(
        () => this.options.compute.normalizeParserOutput(originalTask, extractedDir, job.id),
        { signal: input.signal }
      )
      if (!normalized) throw new Error('Parser normalization queue returned no result')
      if (normalized.displayTitle && originalTask.title === null && this.options.repository.updateDocumentMetadata) {
        await this.options.repository.updateDocumentMetadata(originalTask.id, { displayTitle: normalized.displayTitle })
      }
      await this.options.usageAnalytics?.recordDocumentPages(originalTask.id, originalTask.createdAt, normalized.pageCount)
      this.logger.info('result.normalized', { taskId: originalTask.id, jobId: job.id })
    } finally {
      await rm(zipPath, { force: true }).catch(() => undefined)
      await rm(partialZipPath, { force: true }).catch(() => undefined)
      await rm(extractedDir, { recursive: true, force: true }).catch(() => undefined)
    }

    const translate = await this.ensureTranslateJob(job, originalTask, settings)
    const finalCheckpoint = {
      ...checkpoint,
      stage: 'parsed',
      remoteBatchId: remoteBatchId ?? stringValue(job.checkpoint.remoteBatchId),
      remoteDataId: remoteDataId ?? stringValue(job.checkpoint.remoteDataId),
      remoteResultUrl: resultUrl,
      translateJobId: translate.id
    }
    return { status: 'succeeded', progress: 100, checkpoint: finalCheckpoint, detail: { translateJobId: translate.id } }
  }

  private async ensureTranslateJob(parseJob: Job, task: CopilotixTask, _settings: AppSettings): Promise<Job> {
    const jobs = await this.options.jobRepository.list({ documentId: task.id, kind: 'translate' })
    const existing = jobs.find((job) => job.dependsOnJobId === parseJob.id)
    if (existing) return existing
    return this.options.jobRepository.enqueue({
      documentId: task.id,
      kind: 'translate',
      dependsOnJobId: parseJob.id,
      checkpoint: { stage: 'queued' },
      now: new Date().toISOString()
    })
  }

  private applyRemoteProgress(
    result: BatchResult,
    batchId: string,
    progressByTask: Map<string, { job: Job; reporter: ProgressReporter }>,
    tails: Map<string, Promise<void>>
  ): void {
    for (const entry of result.entries) {
      if (!entry.dataId) continue
      const state = `${entry.state}|${entry.progress?.extractedPages ?? ''}|${entry.progress?.totalPages ?? ''}`
      const current = progressByTask.get(entry.dataId)
      if (!current || this.remoteSnapshots.get(current.job.id) === state) continue
      this.remoteSnapshots.set(current.job.id, state)
      const ratio = entry.progress && entry.progress.totalPages > 0 ? entry.progress.extractedPages / entry.progress.totalPages : 0
      const progress = entry.state === 'waiting-file' ? 9 : entry.state === 'done' ? 42 : entry.state === 'converting' ? 40 : entry.state === 'running' ? 12 + Math.round(ratio * 28) : 10
      const previous = tails.get(current.job.id) ?? Promise.resolve()
      const next = previous.then(() => current.reporter.report(progress, checkpointFor(current.job, entry.state === 'done' ? 'result-ready' : 'polling', {
        remoteBatchId: batchId,
        remoteDataId: entry.dataId,
        remoteResultUrl: entry.fullZipUrl
      })))
      tails.set(current.job.id, next.then(() => undefined).catch(() => undefined))
    }
  }
}

function positiveConcurrency(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value! > 0 ? value! : fallback
}

function checkpointFor(job: Job, stage: string, patch: Record<string, unknown> = {}): JobCheckpoint {
  return { ...job.checkpoint, stage, ...patch }
}

function hasRemoteCheckpoint(job: Job): boolean {
  return Boolean(stringValue(job.checkpoint.remoteBatchId) && stringValue(job.checkpoint.remoteDataId))
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function failure(job: Job, error: unknown): JobBatchResult {
  return { jobId: job.id, error }
}

function toRunnerError(error: unknown, fallbackCode: string, secrets: readonly string[] = []): JobRunnerError {
  if (error instanceof RunnerError) {
    const message = redactSecrets(error.message, secrets)
    return message === error.message ? error : new RunnerError(message, error.code, error.retryable)
  }
  const apiCode = error instanceof ParserApiError ? String(error.code) : ''
  const status = error && typeof error === 'object' && typeof (error as { status?: unknown }).status === 'number'
    ? (error as { status: number }).status
    : undefined
  const retryable = /^HTTP_(?:408|429|5\d{2})$/u.test(apiCode) || status === 408 || status === 429 || (status !== undefined && status >= 500) || /(?:timeout|timed out|timedout|network|fetch failed|failed to fetch|econn|socket|temporar|HTTP\s*(?:408|429|5\d{2}))/iu.test(error instanceof Error ? error.message : '')
  const message = error instanceof ParserApiError
    ? `Parser API 请求失败（code=${apiCode || 'unknown'}${error.traceId ? `，trace_id=${error.traceId}` : ''}）`
    : redactSecrets(error instanceof Error ? error.message : '解析作业失败', secrets)
  return new RunnerError(message, fallbackCode, retryable)
}

function redactSecrets(message: string, secrets: readonly string[]): string {
  return secrets.filter((secret) => secret.length > 0).reduce((current, secret) => current.split(secret).join('[REDACTED]'), message)
}

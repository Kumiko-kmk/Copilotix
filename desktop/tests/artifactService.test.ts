import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BLOCK_MAPPING_VERSION } from '@core/blockMapping'
import type { TaskComputePort } from '@core/ports'
import { PathPolicy } from '../src/main/pathPolicy'
import { ArtifactService, shouldIncludeResultZipEntry } from '../src/main/artifactService'
import type { TaskRepositoryCompat } from '../src/main/taskRepositoryCompat'
import { MARKDOWN_MAPPING_ALGORITHM_VERSION } from '../src/shared/markdownBlocks'
import { TABLE_TRANSLATION_PROTOCOL, TRANSLATION_PIPELINE_VERSION } from '../src/shared/translationPlanProtocol'
import type { CopilotixTask } from '../src/shared/types'

describe('result archive filtering', () => {
  it('excludes only the root .translation tree, including dotfiles', () => {
    expect(shouldIncludeResultZipEntry('.translation')).toBe(false)
    expect(shouldIncludeResultZipEntry('.translation/plan.json')).toBe(false)
    expect(shouldIncludeResultZipEntry('.translation/job/responses/.hidden.json')).toBe(false)
    expect(shouldIncludeResultZipEntry('.translationary/notes.md')).toBe(true)
    expect(shouldIncludeResultZipEntry('nested/.translation/notes.md')).toBe(true)
    expect(shouldIncludeResultZipEntry('.gitignore')).toBe(true)
  })
})

describe('reader translation artifact recovery', () => {
  it('rebuilds Chinese Markdown from the task-bound manifest when the summary file is missing or stale', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'copilotix-reader-translation-'))
    const task = {
      id: '11111111-1111-4111-8111-111111111111',
      originalName: 'paper.pdf',
      title: null,
      name: 'paper.pdf',
      sourcePath: join(outputDir, 'original.pdf'),
      sourceHash: 'source-hash',
      outputDir,
      status: 'completed',
      progress: 100,
      translationProvider: 'qwen',
      remoteBatchId: 'batch',
      remoteDataId: 'remote',
      remoteResultUrl: null,
      error: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    } satisfies CopilotixTask
    const repository = { getTask: async (id: string) => id === task.id ? task : null } as unknown as TaskRepositoryCompat
    const compute = { rebuildMappings: async () => { throw new Error('not needed') } } as unknown as TaskComputePort
    const service = new ArtifactService(repository, compute, new PathPolicy())
    try {
      await writeFile(join(outputDir, 'translation.manifest.json'), JSON.stringify({
        version: 2,
        taskId: task.id,
        translationPipelineVersion: TRANSLATION_PIPELINE_VERSION,
        tableTranslationProtocol: TABLE_TRANSLATION_PROTOCOL,
        mappingAlgorithmVersion: MARKDOWN_MAPPING_ALGORITHM_VERSION,
        blockMappingVersion: BLOCK_MAPPING_VERSION,
        blocks: [
          { sourceIndex: 0, markdown: '# 正确标题', mappingIds: [] },
          { sourceIndex: 1, markdown: '正确正文', mappingIds: [] }
        ]
      }), 'utf8')

      await expect(service.getDocument(task.id)).resolves.toMatchObject({
        translatedMarkdown: '# 正确标题\n\n正确正文\n'
      })
      await writeFile(join(outputDir, 'full.zh-CN.md'), '# 其他论文的陈旧内容\n', 'utf8')
      await expect(service.getDocument(task.id)).resolves.toMatchObject({
        translatedMarkdown: '# 正确标题\n\n正确正文\n'
      })
    } finally {
      await rm(outputDir, { recursive: true, force: true })
    }
  })
})

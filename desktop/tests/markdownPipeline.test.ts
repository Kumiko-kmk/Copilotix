import { describe, expect, it } from 'vitest'
import { translateMarkdown } from '@main/translation/markdownPipeline'
import type { TaskRepository } from '@main/database'
import type { MinerUTask, TranslationBlockRecord } from '@shared/types'
import type { TranslationProvider } from '@main/translation/providers'

function task(provider: MinerUTask['translationProvider'] = 'qwen'): MinerUTask {
  return {
    id: 'task-1', name: 'paper.pdf', sourcePath: 'paper.pdf', sourceHash: 'hash', outputDir: '.',
    status: 'translating', progress: 0, parserModel: 'pipeline', translationProvider: provider,
    remoteTaskId: null, remoteStatusUrl: null, remoteResultUrl: null, error: null,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z'
  }
}

function repository(): TaskRepository {
  const blocks: TranslationBlockRecord[] = []
  const cache = new Map<string, string>()
  return {
    listTranslationBlocks: () => blocks,
    upsertTranslationBlock: (block: TranslationBlockRecord) => blocks.push(block),
    getCache: (key: string) => cache.get(key) ?? null,
    putCache: (key: string, value: string) => { cache.set(key, value) }
  } as unknown as TaskRepository
}

function provider(id: 'qwen' | 'deepseek', available: boolean, calls: string[]): TranslationProvider {
  return {
    id,
    model: `${id}-model`,
    isAvailable: async () => available,
    translate: async (text) => { calls.push(text); return `译:${text}` }
  }
}

describe('markdown translation pipeline', () => {
  it('translates visible text while preserving URLs, math and code', async () => {
    const calls: string[] = []
    const result = await translateMarkdown({
      task: task(),
      markdown: '# Title\n\nA **strong** paragraph with [link](https://example.com).\n\n$E=mc^2$\n\n```ts\nconst value = 1\n```\n',
      mappings: [],
      providers: new Map([['qwen', provider('qwen', true, calls)]]),
      repository: repository(),
      onProgress: () => undefined
    })
    expect(result.failedBlockIds).toEqual([])
    expect(result.markdown).toContain('https://example.com')
    expect(result.markdown).toContain('$E=mc^2$')
    expect(result.markdown).toContain('const value = 1')
    expect(calls.join(' ')).not.toContain('const value')
    expect(calls.join(' ')).not.toContain('E=mc')
  })

  it('falls back when the preferred provider has no credential', async () => {
    const calls: string[] = []
    const result = await translateMarkdown({
      task: task('qwen'),
      markdown: 'Academic paper.\n',
      mappings: [],
      providers: new Map([
        ['qwen', provider('qwen', false, calls)],
        ['deepseek', provider('deepseek', true, calls)]
      ]),
      repository: repository(),
      onProgress: () => undefined
    })
    expect(result.markdown).toContain('译:Academic paper.')
    expect(calls).toEqual(['Academic paper.'])
  })
})

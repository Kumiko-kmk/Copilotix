import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { translateMarkdown } from '@main/translation/markdownPipeline'
import { TranslationHttpError } from '@main/translation/providers'
import { buildBlockMappings } from '@main/blockMapping'
import { alignMarkdownBlocks, splitMarkdownBlocks } from '@shared/markdownBlocks'
import type { TaskRepository } from '@main/database'
import type { BlockMapping, MinerUTask, TranslationBlockRecord } from '@shared/types'
import type { TranslationProvider } from '@main/translation/providers'

const markdownParser = unified().use(remarkParse).use(remarkGfm).use(remarkMath)

function task(provider: MinerUTask['translationProvider'] = 'qwen'): MinerUTask {
  return {
    id: 'task-1', name: 'paper.pdf', sourcePath: 'paper.pdf', sourceHash: 'hash', outputDir: '.',
    status: 'translating', progress: 0, parserModel: 'pipeline', translationProvider: provider,
    remoteBatchId: null, remoteDataId: null, remoteResultUrl: null, error: null,
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

function mapping(id: string, order: number, sourceText: string, blockPosition = `0-${order}`): BlockMapping {
  return {
    id,
    order,
    type: 'text',
    sourceText,
    boxes: [{ pageIndex: 0, pageSize: [612, 792], bbox: [10, 10 + order * 40, 500, 40 + order * 40], blockPosition }]
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

  it('preserves academic HTML tags for the renderer', async () => {
    const calls: string[] = []
    const result = await translateMarkdown({
      task: task(),
      markdown: 'Water is H<sub>2</sub>O<sup>12</sup>.\n\n<table><tbody><tr><td>Value</td></tr></tbody></table>\n',
      mappings: [],
      providers: new Map([['qwen', provider('qwen', true, calls)]]),
      repository: repository(),
      onProgress: () => undefined
    })
    expect(result.failedBlockIds).toEqual([])
    expect(result.markdown).toContain('<sub>2</sub>')
    expect(result.markdown).toContain('<sup>12</sup>')
    expect(result.markdown).toContain('<table><tbody><tr><td>Value</td></tr></tbody></table>')
    expect(calls.join(' ')).not.toContain('<sub>')
    expect(calls.join(' ')).not.toContain('<table>')
  })

  it('keeps authors, abstract and body as ordered logical blocks with exact mappings', async () => {
    const calls: string[] = []
    const markdown = [
      '# Paper title',
      '<sub>George</sub> and Ada',
      'Abstract | Scientific summary.',
      'Main body.'
    ].join('\n\n')
    const mappings = [
      mapping('title', 0, 'Paper title'),
      mapping('authors', 1, '<sub>George</sub> and Ada'),
      mapping('abstract', 2, 'Abstract | Scientific summary.'),
      mapping('body', 3, 'Main body.')
    ]
    const noisyProvider: TranslationProvider = {
      id: 'qwen',
      model: 'noisy-model',
      isAvailable: async () => true,
      translate: async (text) => {
        calls.push(text)
        return `译:${text}\n\n额外换行`
      }
    }
    const result = await translateMarkdown({
      task: task(),
      markdown,
      mappings,
      providers: new Map([['qwen', noisyProvider]]),
      repository: repository(),
      onProgress: () => undefined
    })

    expect(result.blocks).toHaveLength(4)
    expect(result.blocks.map((block) => block.mappingIds)).toEqual([['title'], ['authors'], ['abstract'], ['body']])
    expect(splitMarkdownBlocks(result.markdown)).toHaveLength(4)
    expect(result.blocks[1]?.markdown).not.toContain('Abstract')
    expect(result.blocks[2]?.markdown).not.toContain('Main body')
    expect(result.blocks.every((block) => !block.markdown.includes('\n\n额外换行'))).toBe(true)
    expect(calls.some((call) => call.includes('George'))).toBe(true)
    expect(calls.some((call) => call.includes('Abstract'))).toBe(true)
  })

  it('translates one cross-page logical block once and retains every physical mapping id', async () => {
    const calls: string[] = []
    const result = await translateMarkdown({
      task: task(),
      markdown: 'First reference\nSecond reference\n',
      mappings: [
        mapping('source-box', 0, 'First reference', '0-7'),
        mapping('continuation-box', 1, 'Second reference', '1-0')
      ],
      providers: new Map([['qwen', provider('qwen', true, calls)]]),
      repository: repository(),
      onProgress: () => undefined
    })

    expect(result.blocks).toHaveLength(1)
    expect(result.blocks[0]?.mappingIds).toEqual(['source-box', 'continuation-box'])
    expect(calls).toHaveLength(1)
  })

  it('preserves the Markdown AST skeleton while translating visible text', async () => {
    const markdown = [
      '## Heading',
      '- A **strong** item with [link](https://example.com)',
      '- Water H<sub>2</sub>O and $E=mc^2$',
      '![Figure](images/figure.png)',
      '```ts\nconst value = 1\n```'
    ].join('\n\n')
    const result = await translateMarkdown({
      task: task(),
      markdown,
      mappings: [],
      providers: new Map([['qwen', provider('qwen', true, [])]]),
      repository: repository(),
      onProgress: () => undefined
    })

    expect(astSkeleton(result.markdown)).toEqual(astSkeleton(markdown))
    expect(result.markdown).toContain('https://example.com')
    expect(result.markdown).toContain('images/figure.png')
    expect(result.markdown).toContain('$E=mc^2$')
    expect(result.markdown).toContain('const value = 1')
  })

  it('keeps source order across out-of-order completion, failures and cache reuse', async () => {
    const calls: string[] = []
    const memory = repository()
    const delayedProvider: TranslationProvider = {
      id: 'qwen',
      model: 'delayed-model',
      isAvailable: async () => true,
      translate: async (text) => {
        calls.push(text)
        if (text.includes('Fail')) throw new TranslationHttpError('fixture failure', 500, 0)
        if (text.includes('Slow')) await new Promise((resolve) => setTimeout(resolve, 25))
        return `译:${text}`
      }
    }
    const options = {
      task: task(),
      markdown: 'Slow first.\n\nFail middle.\n\nFast last.\n',
      mappings: [
        mapping('slow', 0, 'Slow first.'),
        mapping('failed', 1, 'Fail middle.'),
        mapping('fast', 2, 'Fast last.')
      ],
      providers: new Map([['qwen' as const, delayedProvider]]),
      repository: memory,
      onProgress: () => undefined
    }
    const first = await translateMarkdown(options)

    expect(first.blocks.map((block) => block.mappingIds[0])).toEqual(['slow', 'failed', 'fast'])
    expect(first.blocks.map((block) => block.status)).toEqual(['completed', 'failed', 'completed'])
    expect(first.blocks[1]?.markdown).toBe('Fail middle.')
    expect(splitMarkdownBlocks(first.markdown)).toHaveLength(3)
    const callsAfterFirstRun = calls.length

    const second = await translateMarkdown(options)
    expect(second.blocks.map((block) => block.mappingIds[0])).toEqual(['slow', 'failed', 'fast'])
    expect(calls.length).toBe(callsAfterFirstRun + 3)
  })

  const acceptanceRoot = process.env.MINERU_TRANSLATION_ACCEPTANCE_DIR
  it.skipIf(!acceptanceRoot)('retains every logical mapping in the local 19-page MinerU task without live translation', async () => {
    const markdown = await readFile(join(acceptanceRoot!, 'full.md'), 'utf8')
    const layout = JSON.parse(await readFile(join(acceptanceRoot!, 'layout.json'), 'utf8'))
    const mappings = buildBlockMappings(task().id, layout)
    const sourceBlocks = alignMarkdownBlocks(markdown, mappings)
    const result = await translateMarkdown({
      task: task(),
      markdown,
      mappings,
      providers: new Map([['qwen', provider('qwen', true, [])]]),
      repository: repository(),
      onProgress: () => undefined
    })

    expect(result.blocks).toHaveLength(sourceBlocks.length)
    expect(result.blocks.map((block) => block.mappingIds)).toEqual(sourceBlocks.map((block) => block.mappingIds))
    expect(result.blocks.every((block, index) => block.sourceMarkdown === sourceBlocks[index]?.markdown)).toBe(true)
  })
})

function astSkeleton(markdown: string): unknown {
  const project = (node: any): unknown => ({
    type: node.type,
    children: Array.isArray(node.children) ? node.children.map(project) : undefined
  })
  return project(markdownParser.parse(markdown))
}

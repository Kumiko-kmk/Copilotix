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
import { flattenSegments } from '@main/translation/tableTranslation'
import type { TaskRepository } from '../src/utility/core/persistence/database'
import type { BlockMapping, MinerUTask, TranslationBlockRecord } from '@shared/types'
import type { TranslationProvider } from '@main/translation/providers'
import type { TableTranslationRequest, TableTranslationResponse } from '@main/translation/tableTranslation'

const markdownParser = unified().use(remarkParse).use(remarkGfm).use(remarkMath)

function task(provider: MinerUTask['translationProvider'] = 'qwen'): MinerUTask {
  return {
    id: 'task-1', originalName: 'paper.pdf', title: null, name: 'paper.pdf', sourcePath: 'paper.pdf', sourceHash: 'hash', outputDir: '.',
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
    translate: async (text) => { calls.push(text); return `译:${text}` },
    translateTable: async (request) => tableTranslation(request)
  }
}

function tableTranslation(request: TableTranslationRequest): TableTranslationResponse {
  return {
    protocol: request.protocol,
    translations: flattenSegments(request).map((segment) => ({ id: segment.id, text: `译:${segment.text}` }))
  }
}

function mapping(
  id: string,
  order: number,
  sourceText: string,
  blockPosition = `0-${order}`,
  type = 'text'
): BlockMapping {
  return {
    id,
    order,
    type,
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
    expect(result.markdown).toContain('<table><tbody><tr><td>译:Value</td></tr></tbody></table>')
    expect(calls.join(' ')).not.toContain('<sub>')
    expect(calls.join(' ')).not.toContain('<table>')
  })

  it('sends the table, caption and footnote in one structured request and restores every block', async () => {
    const tableRequests: string[] = []
    const tableProvider: TranslationProvider = {
      id: 'qwen',
      model: 'table-model',
      isAvailable: async () => true,
      translate: async (text) => `译:${text}`,
      translateTable: async (request) => {
        tableRequests.push(JSON.stringify(request))
        return tableTranslation(request)
      }
    }
    const markdown = [
      'Table 1. Results',
      '<table><thead><tr><th rowspan="2">Group</th><th colspan="2">Value</th></tr></thead><tbody><tr><td>Alpha</td><td></td></tr></tbody></table>',
      'Note. Values are normalized.'
    ].join('\n\n')
    const result = await translateMarkdown({
      task: task(),
      markdown,
      mappings: [
        mapping('caption', 0, 'Table 1. Results', '0-0', 'table_caption'),
        mapping('table', 1, '<table><thead><tr><th rowspan="2">Group</th><th colspan="2">Value</th></tr></thead><tbody><tr><td>Alpha</td><td></td></tr></tbody></table>', '0-1', 'table'),
        mapping('footnote', 2, 'Note. Values are normalized.', '0-2', 'table_footnote')
      ],
      providers: new Map([['qwen', tableProvider]]),
      repository: repository(),
      onProgress: () => undefined
    })

    expect(tableRequests).toHaveLength(1)
    expect(tableRequests[0]).toContain('Table 1. Results')
    expect(tableRequests[0]).toContain('Group')
    expect(tableRequests[0]).toContain('Alpha')
    expect(tableRequests[0]).toContain('Note. Values are normalized.')
    expect(result.blocks.map((block) => block.mappingIds)).toEqual([['caption'], ['table'], ['footnote']])
    expect(result.markdown).toContain('译:Table 1. Results')
    expect(result.markdown).toContain('<th rowspan="2">译:Group</th>')
    expect(result.markdown).toContain('<td>译:Alpha</td>')
    expect(result.markdown).toContain('译:Note. Values are normalized.')
  })

  it('falls back between providers with the complete table and keeps the original table on invalid responses', async () => {
    const requests: Array<{ provider: string; payload: string }> = []
    const markdown = ['Table 1. Results', '<table><tbody><tr><td>Accuracy</td><td>Recall</td></tr></tbody></table>', 'Note. Values are normalized.'].join('\n\n')
    const mappings = [
      mapping('caption', 0, 'Table 1. Results', '0-0', 'table_caption'),
      mapping('table', 1, '<table><tbody><tr><td>Accuracy</td><td>Recall</td></tr></tbody></table>', '0-1', 'table'),
      mapping('footnote', 2, 'Note. Values are normalized.', '0-2', 'table_footnote')
    ]
    const invalidProvider: TranslationProvider = {
      id: 'qwen',
      model: 'invalid-model',
      isAvailable: async () => true,
      translate: async () => 'plain fallback must not be used',
      translateTable: async (request) => {
        requests.push({ provider: 'qwen', payload: JSON.stringify(request) })
        return { protocol: request.protocol, translations: [] }
      }
    }
    const fallbackProvider: TranslationProvider = {
      id: 'deepseek',
      model: 'fallback-model',
      isAvailable: async () => true,
      translate: async () => 'plain fallback must not be used',
      translateTable: async (request) => {
        requests.push({ provider: 'deepseek', payload: JSON.stringify(request) })
        return tableTranslation(request)
      }
    }
    const result = await translateMarkdown({
      task: task(),
      markdown,
      mappings,
      providers: new Map([
        ['qwen', invalidProvider],
        ['deepseek', fallbackProvider]
      ]),
      repository: repository(),
      onProgress: () => undefined
    })

    expect(requests.map((request) => request.provider)).toEqual(['qwen', 'deepseek'])
    expect(requests.every((request) => request.payload.includes('Accuracy') && request.payload.includes('Recall'))).toBe(true)
    expect(result.blocks.every((block) => block.status === 'completed')).toBe(true)
    expect(result.markdown).toContain('译:Accuracy')
    expect(result.markdown).toContain('译:Note. Values are normalized.')

    const failingProvider: TranslationProvider = {
      ...invalidProvider,
      translateTable: async (request) => ({ protocol: request.protocol, translations: [] })
    }
    const failed = await translateMarkdown({
      task: { ...task(), id: 'failed-task' },
      markdown,
      mappings,
      providers: new Map([['qwen', failingProvider]]),
      repository: repository(),
      onProgress: () => undefined
    })
    expect(failed.failedBlockIds).toHaveLength(3)
    expect(failed.blocks.every((block) => block.status === 'failed')).toBe(true)
    expect(failed.markdown).toContain('<td>Accuracy</td>')
    expect(failed.markdown).toContain('Table 1. Results')
  })

  it('reuses a complete-table cache for another task without issuing cell requests', async () => {
    const requests: string[] = []
    const markdown = '<table><tbody><tr><td>Accuracy</td><td>Recall</td></tr></tbody></table>\n'
    const mappings = [mapping('table', 0, '<table><tbody><tr><td>Accuracy</td><td>Recall</td></tr></tbody></table>', '0-0', 'table')]
    const tableProvider: TranslationProvider = {
      id: 'qwen',
      model: 'cache-model',
      isAvailable: async () => true,
      translate: async () => 'plain translation must not be used',
      translateTable: async (request) => {
        requests.push(JSON.stringify(request))
        return tableTranslation(request)
      }
    }
    const memory = repository()
    const first = await translateMarkdown({
      task: task(), markdown, mappings, providers: new Map([['qwen', tableProvider]]), repository: memory, onProgress: () => undefined
    })
    const second = await translateMarkdown({
      task: { ...task(), id: 'other-task' }, markdown, mappings, providers: new Map([['qwen', tableProvider]]), repository: memory, onProgress: () => undefined
    })

    expect(first.markdown).toContain('译:Accuracy')
    expect(second.markdown).toBe(first.markdown)
    expect(requests).toHaveLength(1)
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
      },
      translateTable: async (request) => tableTranslation(request)
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

  it('normalizes the references heading, preserves bibliography entries and resumes translation for an appendix', async () => {
    const calls: string[] = []
    const firstReference = 'Attwell, D. and Laughlin, S. (2001). An energy budget for signaling. Journal Name, 21(10), 1133–1145.'
    const secondReference = 'Bengio, Y. (2009). Learning deep architectures for AI. Now Publishers. https://example.test/book'
    const markdown = [
      '## REFERENCES',
      firstReference,
      secondReference,
      '## A APPENDIX',
      'Appendix body should still be translated.'
    ].join('\n\n')
    const result = await translateMarkdown({
      task: task(),
      markdown,
      mappings: [
        mapping('references-heading', 0, 'REFERENCES'),
        mapping('reference-1', 1, firstReference, '0-1', 'ref_text'),
        mapping('reference-2', 2, secondReference, '1-0', 'ref_text'),
        mapping('appendix-heading', 3, 'A APPENDIX'),
        mapping('appendix-body', 4, 'Appendix body should still be translated.')
      ],
      providers: new Map([['qwen', provider('qwen', true, calls)]]),
      repository: repository(),
      onProgress: () => undefined
    })

    expect(result.markdown).toContain('## 参考文献')
    expect(result.blocks[1]?.markdown).toBe(result.blocks[1]?.sourceMarkdown)
    expect(result.blocks[2]?.markdown).toBe(result.blocks[2]?.sourceMarkdown)
    expect(result.blocks[1]?.markdown).toContain(firstReference)
    expect(result.blocks[2]?.markdown).toContain('Bengio, Y. (2009). Learning deep architectures for AI.')
    expect(calls.some((call) => call.includes('REFERENCES'))).toBe(false)
    expect(calls.some((call) => call.includes('Attwell'))).toBe(false)
    expect(calls.some((call) => call.includes('Bengio'))).toBe(false)
    expect(calls.some((call) => call.includes('A APPENDIX'))).toBe(true)
    expect(calls.some((call) => call.includes('Appendix body'))).toBe(true)
  })

  it('protects contiguous reference paragraphs without mappings until the next heading', async () => {
    const calls: string[] = []
    const reference = 'Doe, J. (2024). Paper title. Journal, 1(2), 3–4.'
    const result = await translateMarkdown({
      task: task(),
      markdown: `### Bibliography\n\n${reference}\n\n### Supplement\n\nSupplement body.\n`,
      mappings: [],
      providers: new Map([['qwen', provider('qwen', true, calls)]]),
      repository: repository(),
      onProgress: () => undefined
    })

    expect(result.markdown).toContain('### 参考文献')
    expect(result.markdown).toContain(reference)
    expect(calls.some((call) => call.includes('Doe, J.'))).toBe(false)
    expect(calls.some((call) => call.includes('Supplement'))).toBe(true)
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
      },
      translateTable: async (request) => tableTranslation(request)
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
    expect(result.failedBlockIds).toEqual([])
    const mappingById = new Map(mappings.map((item) => [item.id, item]))
    const references = result.blocks.filter((block) => block.mappingIds.some((id) => mappingById.get(id)?.type === 'ref_text'))
    expect(references.length).toBeGreaterThan(0)
    expect(references.every((block) => block.markdown === block.sourceMarkdown && block.provider === null)).toBe(true)
    expect(result.blocks.find((block) => /^##\s+References\s*$/i.test(block.sourceMarkdown))?.markdown).toBe('## 参考文献')
    expect(result.blocks.some((block) => block.sourceMarkdown.includes('<table>') && block.markdown.includes('译:'))).toBe(true)
  })
})

function astSkeleton(markdown: string): unknown {
  const project = (node: any): unknown => ({
    type: node.type,
    children: Array.isArray(node.children) ? node.children.map(project) : undefined
  })
  return project(markdownParser.parse(markdown))
}

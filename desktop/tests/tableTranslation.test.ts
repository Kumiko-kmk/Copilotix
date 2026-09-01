import { describe, expect, it } from 'vitest'
import {
  applyTableTranslation,
  buildTableTranslationPlan,
  buildTableTranslationUnits,
  flattenSegments,
  parseTableTranslationResponse,
  validateTableTranslationResponse,
  type TableTranslationRequest,
  type TableTranslationResponse
} from '@main/translation/tableTranslation'
import type { BlockMapping } from '@shared/types'

function block(sourceIndex: number, markdown: string, mappingIds: string[] = []) {
  return { sourceIndex, markdown, mappingIds }
}

function mapping(id: string, order: number, type: string, sourceText: string): BlockMapping {
  return {
    id,
    order,
    type,
    sourceText,
    boxes: [{ pageIndex: 0, pageSize: [612, 792], bbox: [0, 0, 10, 10], blockPosition: `0-${order}` }]
  }
}

function responseFor(request: TableTranslationRequest, prefix = '译:'): TableTranslationResponse {
  return {
    protocol: request.protocol,
    translations: flattenSegments(request).map((segment) => ({ id: segment.id, text: `${prefix}${segment.text}` }))
  }
}

describe('table translation protocol', () => {
  it('extracts cells, empty cells, headers and row/column spans while preserving the HTML tree', () => {
    const plan = buildTableTranslationPlan([
      block(1, [
        '<table data-source="mineru"><thead><tr><th rowspan="2">Group</th><th colspan="2">Value</th></tr></thead>',
        '<tbody><tr><td><strong>Alpha</strong> $x$</td><td></td></tr></tbody></table>'
      ].join(''))
    ], 0)

    expect(plan).not.toBeNull()
    const request = plan!.request
    expect(request.tables).toHaveLength(1)
    expect(request.tables[0]!.rows[0]!.map((cell) => [cell.tag, cell.rowspan, cell.colspan])).toEqual([
      ['th', 2, 1],
      ['th', 1, 2]
    ])
    expect(request.tables[0]!.rows[1]!.map((cell) => [cell.column, cell.segments.map((segment) => segment.text)])).toEqual([
      [1, ['Alpha']],
      [2, []]
    ])

    applyTableTranslation(plan!, responseFor(request))
    const rendered = plan!.blocks[0]!.render()
    expect(rendered).toContain('data-source="mineru"')
    expect(rendered).toContain('<strong>译:Alpha</strong>')
    expect(rendered).toContain('$x$')
    expect(rendered).toContain('rowspan="2"')
    expect(rendered).toContain('colspan="2"')
  })

  it('puts adjacent captions and footnotes into one complete-table request', () => {
    const sourceBlocks = [
      block(0, 'Table 1. Results', ['caption']),
      block(1, '<table><tbody><tr><td>Accuracy</td></tr></tbody></table>', ['table']),
      block(2, 'Note. Values are normalized.', ['footnote']),
      block(3, 'A paragraph after the table.', ['paragraph'])
    ]
    const units = buildTableTranslationUnits(sourceBlocks, [
      mapping('caption', 0, 'table_caption', 'Table 1. Results'),
      mapping('table', 1, 'table', '<table><tbody><tr><td>Accuracy</td></tr></tbody></table>'),
      mapping('footnote', 2, 'table_footnote', 'Note. Values are normalized.'),
      mapping('paragraph', 3, 'text', 'A paragraph after the table.')
    ])

    expect(units).toHaveLength(1)
    expect(units[0]!.blocks.map((item) => item.sourceIndex)).toEqual([0, 1, 2])
    const table = units[0]!.plan.request.tables[0]!
    expect(table.captions).toHaveLength(1)
    expect(table.footnotes).toHaveLength(1)
    expect(flattenSegments(units[0]!.plan.request).map((segment) => segment.text)).toEqual([
      'Table 1. Results',
      'Accuracy',
      'Note. Values are normalized.'
    ])
  })

  it('parses ordered JSON and rejects missing, duplicate, unknown or empty segments', () => {
    const plan = buildTableTranslationPlan([
      block(0, '<table><tr><td>Header</td><td>Body</td></tr></table>')
    ], 2)!
    const valid = responseFor(plan.request)

    expect(parseTableTranslationResponse(`\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``, plan.request).translations)
      .toEqual(valid.translations)
    expect(() => validateTableTranslationResponse({ protocol: plan.request.protocol, translations: [{ id: 'extra', text: 'bad' }] }, plan.request))
      .toThrow(/未知 segment/)
    expect(() => validateTableTranslationResponse({
      protocol: plan.request.protocol,
      translations: [valid.translations[0], valid.translations[0], valid.translations[1]]
    }, plan.request)).toThrow(/重复 segment/)
    expect(() => validateTableTranslationResponse({ protocol: plan.request.protocol, translations: [] }, plan.request))
      .toThrow(/缺少 segment/)
    const emptyResponse = responseFor(plan.request)
    emptyResponse.translations[0]!.text = '   '
    expect(() => validateTableTranslationResponse(emptyResponse, plan.request)).toThrow(/无有效译文/)
    expect(() => parseTableTranslationResponse('{"protocol":', plan.request)).toThrow(/不是有效 JSON/)
  })

  it('does not create translation segments for image-only tables', () => {
    const plan = buildTableTranslationPlan([
      block(0, '<table><tr><td><img src="images/table.png" /></td></tr></table>')
    ])!

    expect(plan.hasTranslatableText).toBe(false)
    expect(flattenSegments(plan.request)).toEqual([])
  })

  it('regresses the reported benchmark tables while preserving formulas and numeric cells', () => {
    const plan = buildTableTranslationPlan([
      block(0, 'Table 1: Benchmarks on Navier Stokes (fixing resolution $64 \\times 64$ for both training and testing)'),
      block(1, [
        '<table data-source="mineru"><tr><td>Config</td><td>Parameters</td><td>Time per epoch</td>',
        '<td>$\\nu = 1\\mathrm{e}-3$ T=50 N=1000</td></tr>',
        '<tr><td colspan="4">With unsupervised pre-training</td></tr>',
        '<tr><td>FNO-2D</td><td>414,517</td><td>127.80s</td><td>0.0128</td></tr></table>'
      ].join(''))
    ], 0)!
    const translations = flattenSegments(plan.request).map((segment) => ({
      id: segment.id,
      text: new Map([
        ['Table 1: Benchmarks on Navier Stokes (fixing resolution ', '表1：Navier-Stokes 基准测试（固定分辨率 '],
        [' for both training and testing)', ' 用于训练和测试）'],
        ['Config', '配置'],
        ['Parameters', '参数量'],
        ['Time per epoch', '每轮时间'],
        ['With unsupervised pre-training', '使用无监督预训练']
      ]).get(segment.text) ?? segment.text
    }))

    applyTableTranslation(plan, { protocol: plan.request.protocol, translations })
    const caption = plan.blocks[0]!.render()
    const table = plan.blocks[1]!.render()
    expect(caption).toContain('表1：Navier-Stokes 基准测试')
    expect(caption).toContain('$64 \\times 64$')
    expect(table).toContain('<td>配置</td><td>参数量</td><td>每轮时间</td>')
    expect(table).toContain('<td colspan="4">使用无监督预训练</td>')
    expect(table).toContain('$\\nu = 1\\mathrm{e}-3$')
    expect(table).toContain('<td>414,517</td><td>127.80s</td><td>0.0128</td>')
    expect(table).toContain('data-source="mineru"')
  })
})

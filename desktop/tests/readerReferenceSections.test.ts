import { describe, expect, it } from 'vitest'
import { readerReferenceSections } from '../src/renderer/readerReferenceSections'
import type { ReaderBlock } from '../src/shared/readerDocument'
const block = (markdown: string): ReaderBlock => ({ role: 'content', markdown, mappingIds: [], order: 0 })

describe('reference section typography', () => {
  it('follows numbered reference headings through page boundaries and stops at an appendix', () => {
    const blocks: ReaderBlock[] = [block('## Discussion'), block('Normal text.'), block('## 7. References'),
      block('[1] First reference.'), { role: 'page-divider', markdown: '', mappingIds: [], order: 0 },
      block('### Online sources'), block('[2] Second reference.'), block('## Appendix'), block('Appendix text.')]
    expect([...readerReferenceSections(blocks)]).toEqual([2, 3, 5, 6])
  })
  it('recognizes Chinese headings without shrinking ordinary mentions of references', () => {
    expect([...readerReferenceSections([block('References are discussed here.'), block('## 參考文獻'), block('文献条目。')])]).toEqual([1, 2])
  })
})

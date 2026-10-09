import { describe, expect, it } from 'vitest'
import { extractPaperProfile } from '../src/renderer/paperArchive/paperProfile'

const ORIGINAL = [
  'Provided proper attribution is provided, the tables may be reproduced.',
  '# Attention Is All You Need',
  'Ashish Vaswani∗ Google Brain [avaswani@google.com](mailto:avaswani@google.com)',
  'Noam Shazeer<sup>†</sup> Google Brain <noam@google.com>',
  '## Abstract',
  'The dominant sequence transduction models are based on complex recurrent networks.',
  'We propose a new simple network architecture, the **Transformer**.',
  'Keywords: attention, sequence modeling; machine translation',
  '## 1 Introduction',
  'Recurrent neural networks ![fig](images/a.png)',
  '## 3 Model Architecture',
  '## 3.1 Encoder and Decoder Stacks',
  '$$\nQ K^T\n$$',
  '<table><tr><td>BLEU</td></tr></table>',
  '| a | b |\n| --- | --- |\n| 1 | 2 |',
  '## Acknowledgements',
  'Thanks.',
  '## References',
  '[1] Jimmy Lei Ba. Layer normalization.\n[2] Dzmitry Bahdanau. Neural machine translation.',
  '[3] Denny Britz. Massive exploration.'
].join('\n\n')

const TRANSLATED = [
  '# 注意力就是一切',
  '阿希什·瓦斯瓦尼∗ 谷歌大脑',
  '## 摘要',
  '主流的序列转换模型基于复杂的循环网络。',
  '## 1 引言',
  '## 3 模型架构',
  '## 3.1 编码器与解码器堆栈',
  '## 参考文献'
].join('\n\n')

describe('paper profile', () => {
  it('preserves abstract link destinations in autolink, Markdown and HTML forms', () => {
    const url = 'https://github.com/hojonathanho/diffusion'
    for (const link of [`<${url}>`, `[代码](${url})`, `<a href="${url}">代码</a>`, `<${url}/some_code_here>`]) {
      const translated = `# 扩散模型\n\n## 摘要\n\n我们展示了图像合成结果，实现可见 ${link}。\n\n## 引言`
      expect(extractPaperProfile('', translated).translatedAbstract).toContain(link.includes('some_code_here') ? `${url}/some_code_here` : url)
    }
  })
  it('reads title, authors, abstracts, keywords and top-level sections', () => {
    const profile = extractPaperProfile(ORIGINAL, TRANSLATED)
    expect(profile.title).toBe('Attention Is All You Need')
    expect(profile.translatedTitle).toBe('注意力就是一切')
    expect(profile.authors).toBe('Ashish Vaswani Google Brain；Noam Shazeer Google Brain')
    expect(profile.abstract).toBe('The dominant sequence transduction models are based on complex recurrent networks. We propose a new simple network architecture, the Transformer.')
    expect(profile.translatedAbstract).toBe('主流的序列转换模型基于复杂的循环网络。')
    expect(profile.keywords).toEqual(['attention', 'sequence modeling', 'machine translation'])
    expect(profile.sections).toEqual(['1 引言', '3 模型架构'])
  })

  it('counts figures, tables, equations and references from the source', () => {
    expect(extractPaperProfile(ORIGINAL).counts).toEqual({ figures: 1, tables: 2, equations: 1, references: 3 })
  })

  it('accepts an inline abstract paragraph and missing translations', () => {
    const profile = extractPaperProfile('# Title\n\nA. Author\n\nAbstract—We study a sufficiently long problem statement here.\n\n# I. Introduction')
    expect(profile.abstract).toBe('We study a sufficiently long problem statement here.')
    expect(profile.authors).toBe('A. Author')
    expect(profile.translatedTitle).toBeNull()
    expect(profile.sections).toEqual(['I. Introduction'])
  })

  it('returns empty facts for an empty document', () => {
    expect(extractPaperProfile('')).toEqual({
      title: null, translatedTitle: null, authors: null, abstract: null, translatedAbstract: null,
      keywords: [], sections: [], counts: { figures: 0, tables: 0, equations: 0, references: 0 }
    })
  })
})

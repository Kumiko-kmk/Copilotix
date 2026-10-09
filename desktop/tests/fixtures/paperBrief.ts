import type { PaperBriefContent } from '../../src/shared/paperBrief/schema'

export const briefContent: PaperBriefContent = {
  paperType: 'method', field: { discipline: '信息科学', area: '论文阅读' },
  tldr: '通过结构化提取组织论文，帮助快速了解研究。',
  context: { background: '论文内容分散。', gap: '缺少统一的阅读入口。', question: '如何提高论文阅读效率？' },
  approach: { summary: '通过结构化提取组织内容', keyIdeas: ['按研究问题组织内容'], basis: '原文摘录', evaluation: '摘录未提供完整评测。' },
  findings: [{ claim: '方便快速浏览', evidence: '效率提升 99.7%。', strength: 'limited', scope: '摘录范围内', anchors: ['E1'] }],
  contributions: [{ kind: 'method', text: '统一研究问题与方法' }],
  limitations: [{ text: '只依据摘录', source: 'inferred' }], assumptions: [], openQuestions: [],
  terms: [{ term: '档案卡', definition: '结构化阅读概览。' }],
  reading: { audience: '科研读者', prerequisites: [], focus: [{ section: 'Method', reason: '了解方法' }] },
  keywords: ['论文阅读'], coverage: { basis: 'partial', missing: ['完整评测'] }
}

import type { PaperBriefContent } from '../../src/features/insight/core/paperBrief/schema'

/** A brief within every length range of BRIEF_LENGTHS, so one provider answer is accepted as is. */
export const briefContent: PaperBriefContent = {
  paperType: 'method',
  field: { discipline: '信息科学', area: '论文阅读与知识组织' },
  tldr: '本文提出按研究问题、方法与发现组织论文内容的结构化提取方法，使读者在两分钟内判断论文是否值得精读。',
  context: {
    background: '科研人员每周需要浏览大量论文，现有阅读工具大多按原文顺序展示全文，或只给出一段笼统的摘要。读者往往要通读引言、方法与实验三个部分，才能判断一篇论文解决什么问题、证据是否可靠，以及与自己的工作是否相关，这一过程费时且容易遗漏关键条件。',
    gap: '已有的自动摘要多为一段连续文字，没有区分研究问题、方法、证据和局限，也不标注结论对应的原文位置，读者难以核对，更难在多篇论文之间横向比较。',
    question: '如何提高论文阅读效率？能否用统一的结构组织任意学科的论文，并让每条结论都能追溯到原文？'
  },
  approach: {
    summary: '方法以解析后的论文为输入：先按章节角色识别摘要、引言、方法、结果与结论，删除参考文献与附录；再在固定预算内挑选信息量最高的段落，保证每类内容至少有一段；最后让模型按固定字段填写档案卡，每条发现必须引用摘录编号。生成后由程序核对编号是否存在、证据中的数字是否出现在原文，未通过的条目保留但标为需核对，局限则区分作者自述与推断。',
    keyIdeas: [
      '按研究问题、方法、证据与局限组织内容，而不是按原文章节顺序',
      '在固定字节预算内按章节角色配额挑选段落，避免实验结果挤占篇幅',
      '每条发现引用摘录编号，生成后由程序核对编号与数字'
    ],
    basis: '十四篇已解析论文的原文与译文摘录',
    evaluation: '核对摘录覆盖率与数字一致性，摘录未提供完整评测'
  },
  findings: [
    { claim: '结构化档案卡便于快速浏览论文要点', evidence: '摘录称阅读效率提升 99.7%，但没有给出对照组、样本量与测量方式，无法判断这一数字的来源。', strength: 'limited', scope: '仅限摘录所述场景', anchors: ['E1'] },
    { claim: '按章节角色配额选段能覆盖方法与结论', evidence: '摘录说明选段会优先保留摘要、方法与结论各至少一段，并删除参考文献与附录部分。', strength: 'moderate', scope: '', anchors: ['E1'] },
    { claim: '引用摘录编号使结论可以回到原文核对', evidence: '摘录描述每条发现都附带摘录编号，读者可以展开查看对应原文段落，判断结论是否成立。', strength: 'moderate', scope: '依赖摘录本身准确', anchors: ['E1'] }
  ],
  contributions: [
    { kind: 'method', text: '提出跨学科通用的论文档案卡结构，统一研究问题、方法与证据' },
    { kind: 'tool', text: '实现带编号核对与数字核对的生成流程，未通过的条目标为需核对' }
  ],
  limitations: [
    { text: '只依据挑选出的摘录生成，未读到的章节可能遗漏重要条件', source: 'inferred' },
    { text: '效率提升的数字缺少对照实验，摘录未说明测量方法', source: 'inferred' }
  ],
  assumptions: ['解析后的论文章节标题足以识别摘要、方法与结论等角色'],
  openQuestions: ['在人文与社科论文上，同一结构是否同样适用？'],
  terms: [
    { term: '档案卡', definition: '按固定字段整理的论文结构化概览，便于快速浏览与比较' },
    { term: '摘录编号', definition: '发送给模型的每段原文的编号，结论通过它回到原文核对' },
    { term: '需核对', definition: '编号不存在或证据中的数字未在原文出现时给出的提示' }
  ],
  reading: {
    audience: '需要快速筛选大量论文的研究生与科研人员',
    prerequisites: ['论文基本结构', '大语言模型基本用法'],
    focus: [{ section: 'Method', reason: '了解段落挑选与核对的具体规则' }]
  },
  keywords: ['论文阅读', '结构化摘要', '信息提取', '可追溯性'],
  coverage: { basis: 'partial', missing: ['完整评测结果'] }
}

/** Provider response for the four-section contract; legacy fixture above remains unchanged. */
export const briefGeneration = {
  metadata: { title: null, authors: null, year: null, venue: null, doi: null },
  paperType: briefContent.paperType, field: briefContent.field, tldr: briefContent.tldr,
  keywords: briefContent.keywords, coverage: briefContent.coverage,
  analysis: {
    abstract: briefContent.context.background.repeat(3).slice(0, 250),
    background: ['领域背景', '已有方法', '研究切入'].map(title => `${title}：${briefContent.context.background}`).join('\n\n'),
    conclusions: briefContent.findings.map(item => ({ title: item.claim,
      text: (item.evidence + briefContent.context.background.repeat(2)).slice(0, 130), anchors: item.anchors })),
    discussion: { contribution: briefContent.context.background.repeat(2).slice(0, 120),
      progress: briefContent.context.gap.repeat(4).slice(0, 120),
      limitations: briefContent.context.question.repeat(4).slice(0, 120) }
  }
}

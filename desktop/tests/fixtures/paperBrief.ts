import type { PaperBriefContent } from '../../src/features/insight/core/paperBrief/schema'

/** A brief within every length range of BRIEF_LENGTHS, so one provider answer is accepted as is. */
export const briefContent: PaperBriefContent = {
  paperType: 'method',
  field: { discipline: '資訊科學', area: '論文閱讀與知識組織' },
  tldr: '本文提出按研究問題、方法與發現組織論文內容的結構化提取方法，使讀者在兩分鐘內判斷論文是否值得精讀。',
  context: {
    background: '科研人員每週需要瀏覽大量論文，現有閱讀工具大多按原文順序展示全文，或只給出一段籠統的摘要。讀者往往要通讀引言、方法與實驗三個部分，才能判斷一篇論文解決什麼問題、證據是否可靠，以及與自己的工作是否相關，這一過程費時且容易遺漏關鍵條件。',
    gap: '已有的自動摘要多為一段連續文字，沒有區分研究問題、方法、證據和侷限，也不標註結論對應的原文位置，讀者難以核對，更難在多篇論文之間橫向比較。',
    question: '如何提高論文閱讀效率？能否用統一的結構組織任意學科的論文，並讓每條結論都能追溯到原文？'
  },
  approach: {
    summary: '方法以解析後的論文為輸入：先按章節角色識別摘要、引言、方法、結果與結論，刪除參考文獻與附錄；再在固定預算內挑選資訊量最高的段落，保證每類內容至少有一段；最後讓模型按固定欄位填寫檔案卡，每條發現必須引用摘錄編號。生成後由程式核對編號是否存在、證據中的數字是否出現在原文，未透過的條目保留但標為需核對，侷限則區分作者自述與推斷。',
    keyIdeas: [
      '按研究問題、方法、證據與侷限組織內容，而不是按原文章節順序',
      '在固定位元組預算內按章節角色配額挑選段落，避免實驗結果擠佔篇幅',
      '每條發現引用摘錄編號，生成後由程式核對編號與數字'
    ],
    basis: '十四篇已解析論文的原文與譯文摘錄',
    evaluation: '核對摘錄覆蓋率與數字一致性，摘錄未提供完整評測'
  },
  findings: [
    { claim: '結構化檔案卡便於快速瀏覽論文要點', evidence: '摘錄稱閱讀效率提升 99.7%，但沒有給出對照組、樣本量與測量方式，無法判斷這一數字的來源。', strength: 'limited', scope: '僅限摘錄所述場景', anchors: ['E1'] },
    { claim: '按章節角色配額選段能覆蓋方法與結論', evidence: '摘錄說明選段會優先保留摘要、方法與結論各至少一段，並刪除參考文獻與附錄部分。', strength: 'moderate', scope: '', anchors: ['E1'] },
    { claim: '引用摘錄編號使結論可以回到原文核對', evidence: '摘錄描述每條發現都附帶摘錄編號，讀者可以展開檢視對應原文段落，判斷結論是否成立。', strength: 'moderate', scope: '依賴摘錄本身準確', anchors: ['E1'] }
  ],
  contributions: [
    { kind: 'method', text: '提出跨學科通用的論文件案卡結構，統一研究問題、方法與證據' },
    { kind: 'tool', text: '實現帶編號核對與數字核對的生成流程，未透過的條目標為需核對' }
  ],
  limitations: [
    { text: '只依據挑選出的摘錄生成，未讀到的章節可能遺漏重要條件', source: 'inferred' },
    { text: '效率提升的數字缺少對照實驗，摘錄未說明測量方法', source: 'inferred' }
  ],
  assumptions: ['解析後的論文章節標題足以識別摘要、方法與結論等角色'],
  openQuestions: ['在人文與社科論文上，同一結構是否同樣適用？'],
  terms: [
    { term: '檔案卡', definition: '按固定欄位整理的論文結構化概覽，便於快速瀏覽與比較' },
    { term: '摘錄編號', definition: '傳送給模型的每段原文的編號，結論透過它回到原文核對' },
    { term: '需核對', definition: '編號不存在或證據中的數字未在原文出現時給出的提示' }
  ],
  reading: {
    audience: '需要快速篩選大量論文的研究生與科研人員',
    prerequisites: ['論文基本結構', '大語言模型基本用法'],
    focus: [{ section: 'Method', reason: '瞭解段落挑選與核對的具體規則' }]
  },
  keywords: ['論文閱讀', '結構化摘要', '資訊提取', '可追溯性'],
  coverage: { basis: 'partial', missing: ['完整評測結果'] }
}

/** Provider response for the four-section contract; legacy fixture above remains unchanged. */
export const briefGeneration = {
  metadata: { title: null, authors: null, year: null, venue: null, doi: null },
  paperType: briefContent.paperType, field: briefContent.field, tldr: briefContent.tldr,
  keywords: briefContent.keywords, coverage: briefContent.coverage,
  analysis: {
    abstract: briefContent.context.background.repeat(3).slice(0, 250),
    background: ['領域背景', '已有方法', '研究切入'].map(title => `${title}：${briefContent.context.background}`).join('\n\n'),
    conclusions: briefContent.findings.map(item => ({ title: item.claim,
      text: (item.evidence + briefContent.context.background.repeat(2)).slice(0, 130), anchors: item.anchors })),
    discussion: { contribution: briefContent.context.background.repeat(2).slice(0, 120),
      progress: briefContent.context.gap.repeat(4).slice(0, 120),
      limitations: briefContent.context.question.repeat(4).slice(0, 120) }
  }
}

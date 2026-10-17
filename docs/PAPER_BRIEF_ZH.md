# Paper Brief v2 維護契約

授權、取消、併發與保存見 [AI 檔案卡](PAPER_INSIGHT_ZH.md)。欄位以 `shared/paperBrief/schema.ts` 為準，四部分字數以 `lengths.ts` 的 `ARCHIVE_LENGTHS` 為唯一來源，提示詞與新輸出校驗共用。

## 四部分分析

- 詳情依序「摘要 → 背景 → 結論 → 討論」。摘要忠實壓縮研究目的、方法、結果與意義；背景從本文引言／相關工作總結；結論以條目說明核心工作、方法及結果，附可展開的全文分塊證據；討論包含領域貢獻、本文呈現的研究進展、局限與展望。
- 研究進展限於論文寫作時及全文涵蓋的範圍，不代表截至今日的最新進展。作者自述與 AI 推斷在措辭上區分，不能憑模型記憶增加後續文獻。
- 新模型輸出包含分類、總結、關鍵詞、`analysis` 四部分、覆蓋資訊及缺失的首頁 `metadata`；資訊兜底及證據驗證契約見 [首頁事實提取](PAPER_INSIGHT_ZH.md#首頁事實提取)。程序投影舊 v2 必要欄位以維持消費端兼容，不再要求模型生成隱藏的術語／閱讀路線。新檔案隱藏舊證據基礎／檢驗方式欄，避免重複與空值。
- 漢字／全形標點計 1，其餘非空白字元計 0.5。原生解碼另限制摘要不超過 300 個原始字符、引導結論寫向範圍中部；不改舊檔保存契約。四部分單項與合計均校驗；一次修復後仍超範圍則生成失敗，原檔保留。「原文未說明」允許短於下限，不為字數補造內容。
- 四部分正文段落首行縮排兩字；頁底不顯示生成依據／覆蓋與研究進展範圍的說明文字，底層覆蓋與來源資訊仍保存。
- 新內容的數學變量／公式使用 LaTeX；顯示仍經 `ArchiveText.tsx`、閱讀器 `prepareReaderMarkdown` 和 KaTeX。舊數學兼容只作用於顯示，不改源文或已存檔案。
- `grounded` 僅表示證據編號存在，`numbersVerified` 僅表示數字匹配，不驗證推論、單位、條件或論文可靠性；未通過條目保留並標示需核對。

## 全文與請求

- 档案生成改用 `buildFullBriefContext`，完整發送已解析原文；原文缺少／空白才回退譯文。只做可還原的順序分塊及 E1…編號，不選段、不丟參考文獻／附錄、不清理長公式或壓縮表格。圖片保留 Markdown 鏈接，不表示已發送圖片像素或完成視覺分析。
- Utility 通過 `insight:brief-source` 返回已校驗文獻的路徑、雜湊與 revision 小描述符；Main 讀全文，檢查普通文件／大小／SHA-256，讀後重新確認 revision。全文不經 Renderer 或 1 MiB Core RPC 信封，Core RPC 全局上限不變。取消與源文更新不接受半截輸入。
- 原始文本安全上限 16 MiB，序列化模型請求上限 20 MiB；這些是傳輸限制，不是模型 token 上限。超限明示失敗，不截斷、不降回摘錄；所選模型仍須能容納全文及輸出。
- Qwen／DeepSeek 沿用 temperature 0.2、max_tokens 6000 與 JSON 格式；Codex 檔案使用結構化輸出與 medium 檔位，任務最多 10 分鐘。修復只追加一次先前回答與具體問題，仍保留全文並檢查請求上限及授權。
- `buildBriefContext` 的舊選段預算僅保留供其他摘要／分類流程使用，不再是檔案生成入口。

## 兼容與恢復

- 仍保存 `insight/brief.v2.json`，schemaVersion 2。`analysis` 在存儲契約中可選，舊 v2 可讀，按四頁重新歸類並提示缺失的研究進展；舊摘要仍取譯文。無 v2 時保留 v1／結構回退。
- 新生成必須符合四部分輸出契約；舊保存結果不套新字數、不自動重生成、不刪 v1、不改 SQLite migration／備份 manifest。`PAPER_BRIEF_PROMPT_VERSION` 更新後只提示可重新生成。
- 原子保存、源文 revision、取消／刪文獻／維護鎖契約保持原有語義；校驗或生成失敗保留此前檔案。

驗證入口：`paperBrief.test.ts`、`paperInsight.test.ts`、`codexRuntime.test.ts`、`ipcContracts.test.ts`；界面與數學入口 `ArchiveDetail.test.tsx`、`ArchiveText.test.tsx`、`e2e/paper-insight.spec.ts`、`e2e/archive-math.spec.ts`。真實全文生成、字數和 max 檔位記錄及四頁截圖見 `../investigation/paper-four-parts-20261015/`，一次樣本不代表全學科人工品質驗收。

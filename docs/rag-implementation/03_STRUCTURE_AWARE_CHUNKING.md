# 03 — 結構切塊與來源譜系（已完成）

## 維護契約

- Utility 複用 remark／GFM／math AST 與 block alignment，依 heading、paragraph、list、code、formula、table、caption、other 切塊；heading anchor／sectionPath 表達父子關係，不另建重複 Markdown 解析器或 parentChunkId 欄。
- 只拆超過 700 個估算 token 的葉子；優先句子／詞邊界，必要時按 Unicode code point 拆，不截斷代理對。offset 為 UTF-16，overlap 默認 0；token／chunker fingerprint 版本化，不依賴 provider tokenizer。策略改動需更新身份版本。
- 寬表、長行與長單元格拆分都帶最小表頭；派生文本引用整表 source span、confidence=range，不偽裝成精確定位。
- chunk 保存穩定 ID／hash／ordinal、章節、mapping IDs、頁碼、offset、token 與 confidence。無 mapping 可切塊，但頁碼空且 confidence=none；bbox 只通過 mapping 引用，不能複製成兩份坐標。
- `compute:rag-content-index` 只跨進程傳 documentId／contentRevisionId；Utility 只讀已登記且屬於該文檔的 parsed Markdown／mapping artifact，檢查 PathPolicy、普通文件與 hash。未登記／越界／內容不一致不可重試，臨時 I/O 可重試。
- 全量 chunk 校驗後單事務發布／切換 active revision。新 revision 失敗或取消保留舊 ready／100% 進度；首次取消回 queued。切塊零網絡，不等同已接入 FTS／embedding／混合檢索。
- 翻譯 plan 同 taskId／jobId 的原子替換經有界串行寫隊列；完成後刪 tail，避免 EPERM 競爭及 Map 增長。

實作入口：`utility/core/compute/structureAwareChunker.ts`、`utilityOperations.ts`、`main/ragContentIndexJobRunner.ts`、`rpcRagContentIndexer.ts`。回歸入口：`structureAwareChunker.test.ts`、`ragContentIndexJobRunner.test.ts`、`markdownBlocks.test.ts`、`blockMapping.test.ts`、`taskService.test.ts`。

保留穩定重跑、全文／表頭完整、UTF-16 回切、mapping／頁碼、超長中英文／emoji、缺 mapping、取消／失敗保舊及重試檢查。下一步為 [本地 FTS](04_LOCAL_FTS_BACKEND.md)。

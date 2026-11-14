# Markdown、編輯層與匯出契約

## 閱讀器與匯出分離

內部 rich 格式 markdown-html-math-v1 保留 HTML 合併表格、sub/sup、LaTeX，經消毒與 KaTeX；prepareReaderMarkdown 只做非結構準備／圖片路徑修正。normalizeMarkdown 僅生成匯出投影，不回寫原文。KaTeX 及 rehype-katex 的 renderer／Vitest 解析與字型 CSS 必須去重一致，不能讓短公式斷成多行。

## 匯出格式

UTF-8／LF、CommonMark＋GFM＋$／$$ 數學；HTML 表格展平為 GFM，合併格資訊可能不可逆（舊 v5 已丟失者無法恢復）。保護 code literal、轉義表格 pipe，數學竪線用 \vert／\Vert。僅在重新驗證成功時修壞的 left/right，不猜公式；非法控制字元顯示 U+FFFD。文件級 reference definition 在分塊前展開。

另存時把實際引用圖片複製至唯一相鄰目錄，改相對連結，全部成功後才原子發布 Markdown；缺圖／越界／非法目標清暫存並保留舊匯出，拒絕寫入任務資料目錄。傳遞須含圖片目錄。ZIP 同樣規範兩份 Markdown、攜帶圖片，排除 .translation／憑據／DB／日誌，臨時 ZIP 完成才替換目標。

## 閱讀器內編輯與整段刪除（使用者編輯層）

- `edits/markdown-edits.v1.json` 是獨立使用者層；Utility 每文獻序列化、樂觀 revision、fsync／rename。損壞保留，閱讀可回退並報錯，匯出須失敗避免默默丟編輯。
- `content:N` 結合 mapping／base hash 定位：原位置的 mapping 或 hash 相同 → 唯一 mapping → 唯一 hash；都不能確認則保留 orphan、不套錯塊。supplementalDeleted 按 mapping ID；不改 annotationKey 或原偏移。
- 閱讀、翻譯、問答與匯出都套編輯／刪除／順序；解析、文字修復、翻譯不能覆蓋它。Brief 與圖片解讀仍讀解析原文。
- 正文只在雙擊時原地編輯，單擊只保留選段／定位。合併段落即使對應多個 PDF 框也整塊處理；快速連刪等 mutation 同一序列。已移除整段邊框及上移／下移選單；拖曳與恢復原始順序保留。`boxMarks` 僅讀取歷史資料，編輯 IPC／RPC 不再接受 `box`／`unbox`；其他編輯不刪除歷史記錄。PDF 右鍵或無框時相鄰塊仍可恢復已刪除段落。
- 只對請求重翻譯且變更的塊用 retranslateAt 加鹽快取，保留其他完成／失敗狀態；generatedAt 標 fulfilled。sourceChanged／fallbackProvider 僅展示或選單，不混入複製文字。
- 可選 order 含塊數、完整排列與 updatedAt，包含已刪除塊；塊數不符忽略但保留，重置移除欄位。拖曳整段／整圖組、不拆圖說；順序變動不作廢翻譯快取，不能盲排未對齊譯文。讀取／匯出／問答遵守順序。
- 新可選欄位可能被舊 strict schema 拒絕，不能聲稱可直接降版；須備份並重置新欄位或用相容版本。
- parsed blocks／ID／預處理結果保持穩定，編輯為輕量樂觀更新＋排隊儲存；失敗過載已儲存狀態並報錯，不每次編輯重取全文或顯示整頁 spinner。

## 解析亂碼行的文字層修復

僅修 PDF 文字層可核對的文字區：詞框重疊 ≥85%、長度比限1.5；候選至少6詞且單個小寫字母比例 ≥40%。疑似下標碎片需 ≥8 spans 幾何比對，真正上下標保留；補字有界（額外≤1/4），不猜公式、表格、圖片、旋轉或掃描頁。

跳過已編輯／刪除塊；編輯檔不可讀則整篇停止修復，orphan 不得保護錯塊。只對唯一 Markdown 匹配同步改 layout／Markdown 並正確轉義，必要時最多3輪。保留 mapping ID，標註按 quote 遷移。

每 layout session 舊文件自動修復一次，只在無活躍作業時背景執行。full／block／layout 原子發布後才事務提交 artifact revision；中斷可恢復。來源 hash 改變只標記譯文 sourceChanged，不自動重發付費翻譯；來源更新後文庫重掛載讀回有效版本。

## 翻譯計劃與整圖

正體中文翻譯採用 markdown-logical-block-v7-taiwan-traditional。v4／v5／v6 的計劃與快取不會用於新翻譯，合法的舊 manifest 仍可供閱讀、匯出及恢復遺失的投影檔。不強制重解析或重翻譯，舊平面表格不會自動復原。

整圖使用共用幾何、來源 revision／hash／邊界驗證；full.figures.md 只是匯出投影，不改來源。裁圖成功才隱藏對應解析圖片／圖內文字，缺圖或歧義保留來源，不能用區域性 PNG 掩蓋缺失。裁圖、圖片展示覆寫與來源段落共享的細節見 [reader README](../desktop/src/features/reader/README.md) 與 [圖片契約](FIGURE_INSIGHT_ZH.md)。

## 驗證

既有 reader／translation／export 回歸須涵蓋 rich 結構、公式／code 保護、使用者層、舊 manifest、圖片複製、路徑隔離、缺圖回滾與 ZIP；真實論文只在隔離副本核對，不提交全文。瀏覽器／CI 不替代 Notion Desktop 實際匯入驗收；歷史樣本不證明當前構建已透過。

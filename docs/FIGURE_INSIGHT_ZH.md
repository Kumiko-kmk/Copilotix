# 圖片 AI 解讀接口

本版提供整圖解析、返回與保存接口；文庫檔案封面已按 `displayWeight` 選圖（見下方「文庫封面」）。尚未添加獨立解析窗口或自動批次生成；讀取結果不會發送圖片。

## 返回契約

模型只返回嚴格 JSON：`{ displayWeight, overview, takeaway }`。

- `displayWeight`：0–100 整數，唯一綜合分數；同時考慮核心相關性、理解價值、信息／證據量、完整性、清晰度、封面代表性與視覺表達。不返回分項分數、封面適合度、理由或 supports。這是展示優先級，不是科学可靠性評分。
- `overview`：目標 100–160 字元，存儲硬上限 240 字元，概括整張 Figure 的對象、機制或比較。英文、空格與標點均計數，避免照抄過多英文標籤。
- `takeaway`：目標 50–90 字元，存儲硬上限 160 字元，指出核心理解與邊界。目標字數不強制補足；只有超過硬上限或 schema 錯誤才修復。
- 純公式／推導圖片：`displayWeight: 0` 且兩個文字字段為空。混合流程／架構圖仍解釋機制，不轉錄或推導其中公式。不可讀圖片零分，文字可簡述無法可靠解讀。

模型格式/schema 失敗最多修復一次；第二次仍不合法則失敗，不保存無效結果。字段與提示詞入口：`desktop/src/features/insight/contract/figureInsight.ts`、`core/figureInsightPrompt.ts`。改提示詞時更新 `FIGURE_INSIGHT_PROMPT_VERSION`。

## 圖片及上下文

- 原圖來源為文獻目錄 `figures.json` 的 `figureId` → `images/figures/figure-pN-<hash>.png`。Utility 以 `block_list.json`、`layout.json` 重新核對 complete geometry、來源版本、PNG 尺寸及 SHA-256；不掃描全部 JPG，不另傳已合併子圖，不自行用子圖代替缺失整圖。
- 每次請求一張完整圖，用 Base64 傳入 `image_url`；保留整個圖幅及像素尺寸，不切子圖、不公開圖片。≤2 MiB 沿用 PNG，較大 PNG 由 Main `nativeImage.toJPEG(98)` 做高品質有損傳輸編碼，僅在 JPEG 比 PNG 小時採用；不改寫文庫原始 PNG。單圖 ≤14 MiB，完整請求 ≤20 MiB；超限失敗，不暗中降採樣。模型服務端仍可能縮放細小字，提示詞要求不猜測。
- 文字使用原文 `full.md` 與映射中的原文，不用譯文代替。包括論文標題、完整圖說的有界文本（含已識別圖說續段／圖例）、圖說附近及正文引用該圖附近的段落、12 KiB 預算的論文角色摘要。圖說最多約 8 KiB、相關段落最多 12 條各約 3.5 KiB、概覽最多 24 條；這是圖片解讀上下文，尚非全文分析。
- `compute:figure-insight-descriptor` 在 Utility compute lane 建立 descriptor（只傳上下文、小元資料及 Main 使用的受控本地路徑，無 PNG bytes）；Main 核對圖片字節／雜湊後向供應商發送。PNG 與本地絕對路徑不經 Renderer；絕對路徑不進模型提示詞。

## 服務商與流程

沿用已啟用、已驗證的首選 Qwen／DeepSeek 服務與憑據。Qwen 選 `qwen3.8-max` 時保留；其他現有 Qwen 選項用 `qwen3.8-flash`。DeepSeek 統一用 `deepseek-flash`（Pro 不支持圖片）。實際使用的模型保存在結果 provenance，不更改用戶的文字問答／翻譯模型設定。

非思考模式、temperature 0.2、輸出最多 1400 tokens；共享 ChatProvider 的白名單 endpoint、串流、限流和用量記錄。視覺請求首包預算 120 秒，文字問答預設仍為 30 秒。最多 2 個活動 pipeline、100 個排隊圖片，單張最多 5 分鐘。每個 `(documentId, figureId)` 同時只有一個生成。取消、設定／憑據變更、刪文獻、文庫維護及退出時停止相關 pipeline；已開始的原子提交必須等待完成。

## 保存位置與 UI 對接

每張成功結果原子保存於：

`<文獻目錄>/insight/figures/<SHA256(figureId)>.v1.json`

根結構：`{ version: 1, documentId, figure, content, provenance }`。

- `content` 僅含三個模型字段。
- `figure` 由 Utility 寫入：`figureId`、相對 `imagePath`、整圖 `sourceRevision`、零起算 `pageIndex`、PDF 坐標 `cropBox`、`mappingIds`、`sourceAssets`、像素 `width/height`、`pngSha256`。
- `provenance`：上下文／圖片綜合 `sourceRevision`、`promptVersion`、實際 `{ provider, name }`、`generatedAt`。綜合 revision 包括 PDF／layout 整圖版本、PNG 雜湊、裁圖 geometry、原文及 mapping 雜湊。新增可選 `upload: { mimeType, byteLength, sha256, jpegQuality?: 98 }` 記錄實際傳送字節；既有無 upload 的 v1 結果仍可讀。`figure.pngSha256` 對應文庫源 PNG，不能拿 `upload.sha256` 校驗源 PNG。
- 單文件 ≤64 KiB；原子 rename 使用 Windows 有界重試。來源更新會拒絕保存晚到結果；讀舊結果返回 `stale: true`，不自動付費重新生成。壞文件／缺圖不改寫舊結果。
- 無 SQLite migration，不修改 `figures.json`、原文／譯文、`brief.v2.json` 或 `insight.v1.json`。備份／恢復沿用整個文獻目錄；文獻刪除會一併處理其結果。

Renderer 入口為 `window.copilotix.figureInsight`：

```ts
const request = { documentId, figureId } // 用現有整圖 geometry / figures.json 的 ID
const unsubscribe = window.copilotix.figureInsight.onChanged(event => {
  if (event.documentId === documentId && event.figureId === figureId) {
    // ready: event.state.record.content、record.figure；先判斷 stale
  }
})
await window.copilotix.figureInsight.generate(request) // 排隊後返回 void，結果經事件／get 返回
const state = await window.copilotix.figureInsight.get(request)
await window.copilotix.figureInsight.cancel(request)
unsubscribe()
```

狀態為 `missing / generating / ready / unavailable / failed`；ready 附 `record`、`stale`。事件訂閱應在 generate 前建立，並按雙 ID 過濾。重開窗口用 get 恢復磁盤結果。封面候選可依 `record.content.displayWeight` 排序；圖片使用相對 `record.figure.imagePath`，PDF 定位用 `pageIndex`、`cropBox`，不得讓模型生成路径或坐标。

Main／Preload IPC：`figureInsight:get / generate / cancel / changed`。Core RPC：`figureInsight:get / save` 及 `compute:figure-insight-descriptor`。流程入口：`features/insight/main/figureInsightService.ts`、`utility/figureInsightStore.ts`；IPC 在 `features/insight/{contract,main}/ipc.ts`，組裝與生命週期在 `app/main/bootstrap.ts`。

## 閱讀器整圖邊界

`readerFigureGroups.ts` 先按圖說與解析器結構建立候選，再以多源最短路分配子圖歸屬；邊權使用頁面歸一化中心距離，跨行／欄的連接容差同時參考頁面及子圖尺寸。相鄰獨立圖可按各自對齊的圖說分開，接近同分的歸屬保留歧義；跨欄圖說的續文共用歸屬。解析器父節點只是證據：不得越過正文、表格或其他圖說，也不得因部分子圖受阻就只接受最近一列；父節點錯連到圖說另一側、且被阻隔時，以清楚的幾何歸屬為準。沒有論文名稱、圖號或固定行列數特例。

圖體外包範圍完整保留，四周最多 4 pt 留白按相鄰內容的空隙中線收縮；真正侵入圖體、未知／損壞坐標、多重歸屬或跨頁映射仍保留來源圖，不用局部成功隱藏缺失。映射 ID、標註和來源文件不變；裁圖範圍／成員改變透過既有 geometry key 淘汰舊快取、按需生成。17 篇實際文庫幾何比對的完整圖組由 101 組增至 111 組，原有已支持圖片無丟失、無重複歸屬或越界裁切；此為幾何與資料驗證，不代表所有組圖均已人工辨識。證據在工作區 `../investigation/robust-figures-20261016/corpus.json`；回歸入口 `readerFigureGroups.test.ts` 包含多列、疏間距、三種縮放、輸入逆序、側／頂圖說、獨立鄰圖、錯誤父節點與正文穿插。

閱讀投影以實際圖片來源優先於解析器錯掛的錨點。上一圖說與下一圖首張圖片被解析成同一 Markdown 段落時，可共享來源段落而分別展示兩個完整圖；下一圖優先置於沒有外來圖說的成員段落，保留原有圖說順序。僅相應裁圖成功才隱藏它自己的來源圖片／已核對的圖內文字，另一圖待處理或失敗時保留其來源；不重寫 Markdown、mapping ID、annotation key 或文字偏移。共享無法確證時仍回退。`captionLabel` 是同版本 Main／Renderer 內部幾何提示，不改持久化 figure manifest；投影與顯示回歸在 `readerFigureGroups.test.ts`／`MarkdownPane.test.tsx`，包含單圖失敗與標註文字不變。

## 文庫封面

`features/library/renderer/archive/figureSpread.ts`：抽出檔案時，卡片顯示跨頁——左為論文首頁，右為同尺寸圖頁。Renderer 經 `copilotix-asset://<id>/figures.json` 讀清單（只接受 `images/figures/*.png`），逐圖 `figureInsight.get` 取 `displayWeight`；有分者按分數排前、0 分不展示，無分者按頁序（附錄靠後）、裁圖面積和長寬比兜底；首頁上的圖與極端長條不選。排版為等寬行（每行 1–3 張、行內等高撐滿），在前 1–6 張的所有分行中選版面利用率最高、最小短邊 ≥ 版心寬 24%、大小不過分懸殊者；圖多不扣分，同等利用率下展示更多高分圖。只解碼選中圖片，任一失敗或無可用圖則保留單頁封面。封面只補齊本地整圖，不觸發 AI 解讀。選中新導入論文後，在進入詳情前即與閱讀器共用 `ensureFigureArtifacts`：由解析映射與 layout 識別可靠整圖、從 PDF 裁取並經既有 revision 校驗與原子保存生成 `figures.json`／PNG，再選圖排版；不再依賴使用者先進入閱讀器。所需可靠整圖、排版封面與檔案內容就緒前不開放詳情；抽出後使用已準備的跨頁。切篇／關閉取消未完成裁圖，暫時失敗不快取為永久單頁封面，重新打開可重試。

## 驗證邊界

2026-10-11 經使用者明確授權，使用既存 DeepSeek Key 實測六篇論文全部已提取整圖，共 **39/39** 成功：Transformer 5、AlphaFold 5、DDPM 15、Neural Operators 3、Graph Networks 9、GAN 2；權重 62–96。全部三欄結果經 schema 校驗、原子保存並讀回確認非 stale。這是模型／持久化實測，未做完整人工科學內容驗收或已打包應用 UI 驗收。

證據在 workspace `../investigation/figure-insight-live-20261011/`：`preview.html` 可看完整原圖與三欄結果；`report.json` 有位置、caption、實際回覆、請求／用量及記錄路徑；`summary.json` 有逐篇排序和費用估算；`report-before-*.json` 保留排錯及續跑快照。大樣本矩陣原 PNG 約 6–8 MiB，完整 JPEG98 約 1.4–1.8 MiB（像素尺寸保持）；本次批次工具用 Windows 圖像編碼產生 JPEG，正式 Main 使用 Electron nativeImage，後者未在已打包應用單独驗收。三張因 SSE 中斷／逾時而失敗的圖最後改用完整 JSON 回覆補齊；正式 Main 仍採串流，不宣稱網路失敗已完全消除。

批次入口 `desktop/scripts/figure-insight-live.ts`：預設只讀預檢，`--execute` 才發送，續跑跳過已保存且未過期的結果；`--non-stream` 僅為批次實測的 JSON 回覆適配。腳本只讀 SQLite／原始憑據，授權設定為本次程序內設定，不更改使用者持久設定；測試用量在上述證據中，不寫入桌面用量頁。大圖 JPEG 測試副本在證據目錄 `uploads/`，不進文獻原圖目錄。

含排錯的已返回用量為輸入 **174,428**、輸出 **5,644** tokens。按 [DeepSeek 當日官方價格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)（週末閒時，輸入全按未命中 1 元／百萬、輸出 4 元／百萬）估 **0.197004 元人民幣**；續跑快照已去重，未返回 usage 的中斷請求不計入，未讀取帳單，不能當作實際扣款。

使用者要求停止額外驗證前，圖片解析／保存、ChatProvider、Core RPC 四組 **47 項**針對性測試通過。後續維護了 RPC 名稱一致性、圖片首包預算及 JPEG 傳輸身份的回歸用例，依使用者要求未再執行；未跑 smoke、E2E、應用重建或打包。最近一次 typecheck 尚有既有 `features/library/renderer/archive/ArchiveDetail.tsx:120` 的 TS7030，不宣稱全倉型別檢查通過。

Codex 可作為已啟用的首選服務：使用服務連接中選定的 Codex 問答模型；不讀取 API Key。圖片還需模型支持 image，否則明確失敗。結果仍經既有 schema／grounding 校驗與原子保存。運行時與資料庫 provider 擴展見 [架構](ARCHITECTURE_ZH.md#codex-provider本机-app-server)，設定步驟見 [服務配置](wiki/Service-Setup.md)。

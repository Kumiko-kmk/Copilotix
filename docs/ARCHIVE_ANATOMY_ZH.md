# 檔案拆解視圖（360° 查看器）

文庫抽出檔案後的拆解視圖，移植自 RhineLabUI `src/model-viewer.ts`、`src/viewer-camera.ts`（MIT，LBEILC）。檔案按論文的篇章結構拆開，不按圖片拆。目前章節頁是 demo，下面列出接入真實內容所需的數據。

## 入口與操作

- 詳情完全展開後：點擊卡片，或點詳情底部「拆解档案」進入；`Enter`／「打开阅读」仍進閱讀器。抽出、解密中點擊無效。
- 查看器內：拖動旋轉、滾輪或 `+`／`−` 縮放、方向鍵平移、`Home`／「复位视角」復位、「拆解档案／一键重组」切換，`Esc`／「返回档案」淡出回詳情。打開後約 0.42 秒自動拆開一次；reduced-motion 直接到位。
- 查看器開啟時文庫頁鍵盤處理讓位（`inspectingRef`），詳情收回或換篇時自動關閉。

## 結構

| 文件 | 內容 |
| --- | --- |
| `paperArchive/archiveViewer.ts` | `ArchiveViewer`：獨立 WebGLRenderer、34° 鏡頭 `(7.2, 3.8, 12)`、OrbitControls（原參數）、霧隨物距、部件組沿 Z 位移 `depth × spread`，`damp(…, 5.5)`；`viewerParts()` 生成部件順序與深度 |
| `paperArchive/viewerCamera.ts` | 原 `ViewerCameraMotion`：球面插值、對數縮放、0.56 秒復位 |
| `paperArchive/anatomySheets.ts` | `drawSectionSheet()`：每節一張 1280×906 畫布（與卡片窗口同比例），目前正文為佔位塊並標 DEMO |
| `paperArchive/ArchiveAnatomy.tsx` | 全頁覆層：頭部、360°、右側「ASSEMBLY / 篇章结构」列表、底部操作與狀態；經 `['document', id]` 查詢取章節 |

部件由前到後：紧固件（2.75）、透明盖板（1.85）、各章節（1.05 到 −1.25 均分）、背板与框架（−2.05）。組裝時章節頁在卡內相距 0.012 疊放避免 Z-fighting。章節取自 `extractPaperProfile().sections`；未識別時用「摘要／引言／方法／实验／结论」示例，超過 8 節則第 8 頁合併「其余 N 节」。點列表中的章節：該頁上浮 0.22、其餘降至 0.18 不透明度，右側顯示示例說明；外殼部件不可選。

蓋板用半透明玻璃（opacity 0.16，非 transmission），保證後方章節清晰；原版的清晰／磨砂切換未移植。

## 接入真實內容需要的數據

每個章節頁（以及右側說明）需要：

1. `sectionId`、序號、原文標題與譯文標題；與 `blockMappings` 的起止 mappingId，用於「在閱讀器中定位本節」。
2. 章節摘要：60–120 字中文，一段。
3. 要點：1–3 條，每條 ≤40 字；可標註「方法／結果／局限」類型。
4. 本節相關圖片：`figureId` 列表（來自 `figures.json`，按 `displayWeight` 排序），以及圖片解讀的 `overview`／`takeaway`（已由 [圖片 AI 解讀](FIGURE_INSIGHT_ZH.md) 提供）。
5. 篇章層級：子節（1.1、1.2…）是否展開為子層，或只在說明欄列出。
6. 生成來源與版本：與 Paper Brief 一樣附 `sourceRevision`、模型與時間，原文更新時標 stale，不自動重生成。

建議由 Utility 生成每篇一份 `insight/structure.v1.json`（或併入 Paper Brief v3），Renderer 只讀；生成授權、取消與存儲沿用 [AI 檔案卡](PAPER_INSIGHT_ZH.md) 的流程。

## 未完成

- 章節頁正文、要點、相關圖片與「定位到閱讀器」均為 demo／未接入。
- 未做音效、清晰／磨砂切換、觸控與手柄專門提示、查看器畫質預設。
- 只做了截圖驗收（真實論文副本），未跑單元測試、E2E 或真人互動驗收。

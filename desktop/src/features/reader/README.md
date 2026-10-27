# reader

閱讀器：四視圖工作台（PDF、原文、中文、問答）、Markdown 與 PDF 視圖、捲動同步、選區工具列（高亮、下劃線、筆記、加入問答）、正文引用、圖片分組與裁圖、閱讀器內編輯／刪除／排序，以及閱讀文件與導出。契約見 下方「契約」、[Markdown 格式](../../../../docs/MARKDOWN_FORMAT_ZH.md)、[介面偏好](../../../../docs/UI_PREFERENCES_ZH.md)。

## 公開 API

- `contract/`：`ipc.ts`（`reader-figure-display:*`、`reader-notes:*`、`reader-annotations:*`、`documents:edit-markdown`、`documents:cache-figure`，`createReaderApi`）、`rpc.ts`（`readerOperations`：`notes:*`、`markdown-edits:apply`、`annotations:*`）、`markdownEdits`（編輯層 schema 與解析）、`readerNotes`、`figureDisplay`、`readerSchemas`／`readerTypes`（標註、圖片快取的 schema 與型別）。
- `core/index.ts`：`readerContentMappings`、`buildReaderFigureGeometries`、`paperSelectionText`、標註重定位；翻譯、問答與文庫用它們讀取閱讀內容與圖片幾何。
- `runtime/index.ts`：`readMarkdownEditsFile`（翻譯計劃讀取編輯層）。
- `main/index.ts`：`ArtifactService`（閱讀文件、Markdown／ZIP 導出、裁圖）、`FigureDisplayStore`、`registerReaderIpc`。
- `utility/index.ts`：`createReaderOperations`、`MarkdownEditStore`（問答上下文也讀編輯層）、`ReaderNoteStore`。
- `renderer/index.ts`：`loadReaderPage`／`loadedReaderPage`（`ReaderPage` 只經此懶載入，保留分包）、`loadFigureArtifacts`（同理）、`SafeMarkdown`、`ReaderAnnotationToolbar`、`useReaderNoteLayer`、選區與標註工具。

## 資料（文獻目錄，均無 migration）

- `edits/markdown-edits.v1.json`：使用者編輯層（含可選 `order`）；解析、修復與翻譯不得改寫。
- `notes/notes.v1.json`、`reader/figure-display.v1.json`、`figures.json` 與裁圖 PNG。
- 標註在 SQLite（經 library 的倉庫）；localStorage `copilotix.reader.layout.v1`（工作台佈局）。

## 測試

`tests/features/reader/`（`pnpm desktop:test --module reader`）；E2E `e2e/reader.spec.ts`、`reader-figures.spec.ts`、`qa-fixes.spec.ts`。

## 圖像資源與記憶體

- PDF 保持共用 worker、可見頁前後預渲染和原有並發；圖區仍保留 64 MiB 熱快取，原文／中文共享相同尺寸裁圖。淘汰圖區在最後一個使用者完成複製後釋放畫布像素，已卸載 PDF 頁在渲染取消完成後釋放，失敗／取消解碼一律關閉 ImageBitmap，不改解析度與預熱策略。
- `figures.json` 的會話元資料最多保留最近使用的 128 篇；淘汰不刪磁碟產物，重新註冊時從原檔讀回。沒有 schema、IPC 或持久化變更；圖片生命週期、可見頁／預熱等既有回歸已執行。記憶體需區分 renderer、GPU、主進程與 Utility 的工作集，不能將單進程數值當作整個應用；隔離三篇成熟論文對照未觀察到反覆開收的線性增長，不承諾固定總占用降幅。

renderer 與測試統一解析直接依賴的 KaTeX：rehype-katex 及所匯入的字體／CSS 不能各用不同 DOM 版本。renderer.resolve.dedupe 與 Vitest 去重一致，測試另內聯 rehype-katex，避免外部化繞過解析；實測單個短公式、分式、根式、矩陣，短公式不拆行。原公式字串與保存資料不變。

## 例外（超過 600 行）

`renderer/components/MarkdownPane.tsx`（701 行）：一個視圖元件，漸進掛載、圖片就緒、捲動同步、選區與編輯共用約二十個 ref 與同一組 layout effect；塊視圖、圖片狀態、重排單元、狀態面板與 DOM 工具已拆至 `MarkdownBlockView.tsx`、`useMarkdownFigures.ts`、`MarkdownPaneParts.tsx`、`markdownPaneDom.ts`。再拆需改變 effect 次序，留待功能分支並配合真實文庫驗收。

## 契約（2026-10-26 自 AGENTS.md 遷入）

### 閱讀器契約（原 AGENTS §7）

- PDF 貼合完整 clientWidth，無外圍 padding／邊框／陰影、原生捲動條、頁間或末頁 gap；浮動捲動條支援拖曳／鍵盤且不佔位。透明欄分隔器覆蓋右欄。寬度／縮放／延遲尺寸改變時，layout effect 按頁號與頁內比例恢復，停用 overflow anchoring 並取消舊 frame；人工翻頁與引用定位正常更新頁碼。
- 只提供 PDF、原文、中文、問答四視圖，JSON 僅保留底層產物與 ZIP。`readerLayout.ts` 為 split／group 純函式樹，每視圖僅出現一次、最後一個不可關閉；localStorage `copilotix.reader.layout.v1` 校驗修復後載入，缺省「PDF｜原文·中文·問答」，首次沿用舊 sessionStorage 欄寬。
- 工作台分組最小 240×140；拆分、移動、關閉／重開、拖曳（5px 起拖、Esc 取消；邊緣四分之一拆分，中間合併）不得破壞唯一視圖。拖曳預覽走獨立 DragContext；分隔器拖動僅本地更新、放開提交。最大化純 CSS、其他分組保持掛載、不持久化；split pane 不设 position，分隔線用 ::after。
- Markdown 僅選中時掛載並恢復 `initialScrollTop`；PDF／問答首次顯示後保持掛載。工具列 portal 到所在分組；PdfPane 的 `toolbarHost`、`initialViewState`／`onViewStateChange` 保持移動／重開錨點。頂欄不再提供複製；另存作用於聚焦分組。
- 圖片分組（`readerFigureGroups.ts`）：MinerU 常把子圖拆成獨立圖塊、把 `(a) …` 子圖說誤標為 table_caption 或掛在別的圖下；子圖說按幾何視為圖內文字，不作屏障；`Figure N |`（Nature 式）視為圖說；這類圖說緊貼其上方一行子圖時，按該行寬度展開成分隔，只認上方子圖（右側列不再串到下一張圖，解析器跨圖說的錯誤父子關係忽略；npj Fig. 5–7，21 篇真實文庫逐篇對比僅這三張改變）。仍無法確認 PDF 裁圖（無圖說／歧義／裁圖失敗）且子圖左右並排時，`ReaderFigureMosaic` 用解析出的子圖按 PDF 相對位置拼排並隱藏逐段原圖，不再逐行堆疊。改動須用真實文庫逐篇核對並排子圖歸屬。圖組預設顯示 PDF 裁圖（有圖說的 complete／ambiguous；無圖說 unsupported 保留解析圖）；圖組下方不放按鈕，右鍵選單可「以解析子图显示／以 PDF 原图显示」、加入問答、在 PDF 中查看、刪除此圖（連同圖說各段），按圖（geometry ID）存文獻目錄 `reader/figure-display.v1.json`（IPC `reader-figure-display:get/set`，無 migration，損壞視為自動），選回自動結果即清除；只覆寫顯示狀態，不改裁圖產物。
- 選區工具列：高亮、下劃線、羽毛筆「写笔记」、加入問答。筆記存文獻目錄 `notes/notes.v1.json`（Core RPC `notes:list/upsert/delete`，IPC `reader-notes:*`），錨點同標註以 quote／前後文重定位；虛線底紋＋頁邊羽毛筆，懸停顯示並可直接編輯（使用者明確要求的懸停例外之一，見介面偏好），點外部自動保存、Esc 放棄。問答選區發送後移入該輪並以 `userSelections` 告知模型，見問答入口文檔。
- 正文引用（第二個懸停例外）：`readerCitations.ts` 從論文自身的 References 區塊（標題範圍，或無標題時從 1 起、像參考文獻的編號段落；容許雙欄亂序、跨頁續行與合併段）建立「標記 → 條目」索引，識別方括號數字（含區間／列表、全形括號）、上標數字（僅在正文不用方括號引用時，作者行的單位上標排除）與作者年份（敘述式／括號式，中文「等人」、全形標點）；完全本地，對不上不標記。`ReaderCitations.tsx` 以 CSS Highlight 標色、caret 命中測試懸停顯示條目（另一視圖文字不同時並列），點擊經選區同步跳到條目並閃爍高亮。PDF 視圖未做（無鏈接注釋層）。邊界見介面偏好。
- 快捷鍵：Ctrl+1–4 顯示四視圖，Ctrl+反斜線右拆，Ctrl+Alt+←/→ 移組，Ctrl+W 關閉，Ctrl+Shift+T 重開，Ctrl+Shift+M／雙擊最大化，Esc 還原。
- `readerScrollSync.ts` 以 mappingId＋塊內比例對齊視口 35% 閱讀線；僅人工捲動領先，120ms 程式回聲不回報，每幀最多一次。參與者為分組選中且在 layout.synced 的視圖（預設原文＋中文、PDF 關閉、問答不參與）；PDF 用 `pdfSyncPosition`。引用無可見閱讀視圖時，`ensureReadingView` 在問答旁拆開／重開原文或中文／PDF，先還原最大化，不能取代問答。共用少量 mappingId 的合成夾具有歧義，同步／選段聯動須用真實解析資料驗收。

### 10. Markdown 公共格式與導出

- `docs/MARKDOWN_FORMAT_ZH.md` 定義格式、版本兼容、映射、原子導出與真實論文驗證；`standardMarkdown.ts` 共享規範為 CommonMark＋GFM＋明確數學擴展，不得將公式降級代碼。
- Markdown 導出攜帶相鄰圖片目錄及相對鏈接，圖片失敗不得覆蓋既有導出；原任務資料不可作導出目標。ZIP 同樣規範化兩份 Markdown。
- 對比交付只保留使用者要求的两份 Markdown；瀏覽器／CI 不替代 Notion Desktop 驗收。
- 閱讀器內編輯與整段刪除是獨立的使用者編輯層（`edits/markdown-edits.v1.json`），解析、修復與翻譯不得改寫或覆蓋它；閱讀、翻譯、問答與導出都須套用。段落／圖組長按拖曳排序存同檔可選 `order`（整份排列＋塊數，塊數不符即忽略；旧版遇此欄位視為不可讀，恢復原始順序即移除）。契約見上述格式文檔「阅读器内编辑与整段删除」。

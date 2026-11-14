# 閱讀器獨立驗收入口

直接引用當前 PDF、Markdown、工作臺、對映和圖片分組實現，不復制閱讀器邏輯，不修改業務資料結構。提供 PDF／原文／譯文（原文與譯文在右側標籤切換，也可拆分並排）；高亮僅在本次會話保留。與主應用使用獨立 userData，解析結果隨包只讀分發，執行時禁止外網請求，無憑據橋接。

`compile-parse.mjs` 編譯真實解析指令碼；`parse.generated.mjs <PDF> <結果目錄>` 只使用 Windows 憑據庫中的 parser-token 向 MinerU 官方服務提交指定檔案。首次上傳需使用者明確授權該第三方與檔案範圍。儲存批次檢查點，不儲存 Token 或簽名 URL；不確定的上傳結果不自動重發。輸出採用原有 full.md、layout.json、block_list.json 和 images，不覆蓋個人文庫，不帶入筆記或聊天。

`build.mjs [解析結果/paper]` 構建獨立入口；從 desktop 執行 `electron-builder --projectDir ../output/reader-acceptance-20261031/app --config scripts/reader-acceptance/package.cjs --win portable` 生成單檔案便攜 EXE（config 路徑建議使用絕對路徑）。專案目錄必須指向獨立 app，且排除 node_modules，避免打入主應用依賴。先確認完整解析結果，再打包。此包是閱讀器驗收版，不替代全應用釋出門禁。

效能透過獨立程序啟動、PDF 首次繪製完成、原文全部就緒分別記錄；系統檔案快取可能仍熱，不能稱磁碟冷啟動。便攜 EXE 的自解壓啟動成本須獨立報告。

`compile-parse.mjs translate` 編譯獨立翻譯指令碼；`translate.generated.mjs <驗收結果目錄>` 使用現有 Qwen 憑據、官方 qwen-mt-plus 和生產翻譯計劃，將 paper/ 中原文翻譯為 full.zh-CN.md、translation.manifest.json。必須獲得該論文的 Qwen 翻譯授權。只讀主應用設定，獨立 SQLite 儲存計劃和快取，HTTP 單併發限速；失敗後保留進度。打包不含指令碼、金鑰或資料庫。入口逐段驗證 sourceHash 並複用原有 sourceIndex／mappingId，切換標籤保留各自閱讀位置和會話高亮。所有定位均瞬間完成。

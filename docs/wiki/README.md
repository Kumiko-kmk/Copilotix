# 中文 Wiki 的版本化原始檔

本目錄與倉庫 README 一起維護，對應 [GitHub Wiki](https://github.com/Kumiko-kmk/Copilotix/wiki)。指南以 **1.2.0** 為基線；服務商當前模型許可權和價格以官方說明為準。

| 檔案 | 釋出頁面 |
| --- | --- |
| `Home.md` | 使用指南首頁 |
| `Installation-and-Upgrade.md` | 安裝、升級與解除安裝 |
| `Service-Setup.md` | 解析、翻譯與問答服務 |
| `First-Paper.md` | 處理第一篇論文 |
| `Reader-Workbench.md` | 閱讀工作台 |
| `Paper-AI-Chat.md` | 論文 AI 問答 |
| `Local-Data-and-Export.md` | 本地資料、匯出與文庫管理 |
| `FAQ.md` | 常見問題 |
| `_Sidebar.md`、`_Footer.md` | Wiki 導覽 |

維護時先核對當前程式碼和實際執行，再修改本目錄及 README；應用內截圖存於 `docs/images/screenshots/`，採集範圍見該目錄的說明。示意圖與實際截圖須分別標註，問答入口截圖不得作為付費模型回答質量的證據。

釋出順序：先讓主倉庫文件、圖片透過最新合併檢查並進入 `master`，再將本目錄除 `README.md` 外的 Markdown 檔案同步到獨立 Wiki 倉庫並提交。Wiki 圖片使用主倉庫的絕對地址，避免先發布頁面產生失效圖片。既有 `Home`、`First-Paper`、`Service-Setup`、`FAQ` 頁面名稱保持不變，外部連結繼續有效。

Wiki 是獨立 Git 倉庫，主倉庫提交不會自動更新 Wiki。兩處釋出後均需檢查頁面、導覽與圖片，並記錄實際釋出結果；未獲使用者授權時不推送任一倉庫。

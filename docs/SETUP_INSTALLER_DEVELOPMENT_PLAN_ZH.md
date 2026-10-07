# Windows Setup：Agent 維護交接

更新：2026-10-07。保留此協作入口；已精簡多次交付范本、過時容量和歷史驗收敘述。当前操作以 [發布文檔](DESKTOP_RELEASE_ZH.md)、[安裝指南](WINDOWS_INSTALLATION_ZH.md) 和根目錄 `AGENTS.md` 為準。

## 現行交付契約

- ZIP 根目錄交付 `setup.exe`、獨立 `uninstall.exe`、安裝說明與小型 advanced 校驗資料，完整 runtime 已嵌入 Setup。開發副本保留於 `release-artifacts/<build-id>/program/`，不在 ZIP 重複交付，不裁剪必需 DLL、PAK、keyring native binding 或教程資源。
- schema 5 的 bundle-manifest 不包含外部開發路徑或 ZIP 自身哈希；外層 release-manifest 在 ZIP 完成後記錄 transport.sha256。發布腳本原子切換成功產物；只清理已驗證的前次成功產物，失敗 staging 保留供排查。
- appId、四個 bundle、單實例與 userData 路徑維持兼容。Setup 目前使用者安裝，允許自訂位置，桌面捷徑選項默認勾選；自訂程序位置不等於遷移文庫。
- 正式 Setup、主程序及內嵌卸載器須受信任簽章。唯一一次 `desktop-v1.0.0` 未簽名 bootstrap 例外以 `DESKTOP_RELEASE_ZH.md` 的精確 tag／Actions variable 條件為準；其他 tag 保持門禁，本機自簽不替代正式簽章或自動加入系統信任。

## 退出、升級與資料保護

- 安裝／卸載發現應用仍運行時提示正常退出，不強殺背景任務。覆蓋升級及靜默卸載不觸發資料清理。
- 卸載默認保留 userData、系統憑據與獨立文库。只有明確勾選清理并經 Main 原生第二次確認，Utility 才唯讀盤點并按已登記 `documents-v2/<id>` 和固定 userData 邊界清理。保護原始導入來源、外部備份與共用文件；目錄 junction、路径漂移或确认 token 不匹配時拒絕。
- 新憑據、native 依賴、資源或儲存格式須同步核對打包／卸載驗證。文獻 `chat/` 位於現有已登記目錄內，無新外部清理位置；聊天在退出／文庫維護前等待取消并落盤，备份／迁移完整目录带上聊天记录。
- 資料庫 migration 的快照、校驗和與回滾兼容保持不變；不得把改安裝路徑當作文庫遷移。

## 驗證與待辦邊界

- 日常依 `AGENTS.md`：不預設跑本地測試，commit、push 後核對最新 SHA 的全套 Actions。CI 驗證 NSIS、體積、fuses、清單／SHA、packaged smoke、隔離安裝／升級／卸載／重裝、下載及解壓；不能套用舊提交的數量／綠燈。
- 人工安装验证必須使用 GUID 隔離目錄，核對中文／空格路徑、桌面捷徑、運行中保護與取消。不得覆蓋或卸載本機日常安裝。單元清理測試不能替代原生 wizard 验收。
- 自動更新、MSIX／Store、跨平台安裝器仍为後續範圍；受信任簽章状态以当前 policy 和实际发布证据為準。

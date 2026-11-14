# 許可與 Windows 簽章配置

自有程式碼為根 LICENSE.md 的 MIT；不覆蓋歷史上游／第三方許可。打包保留 resources/licenses 與 Electron 原宣告。正式簽章政策及逐版本例外只記於 [CODE_SIGNING_POLICY](CODE_SIGNING_POLICY.md)，發布門禁與資產版面配置只記於 [發布契約](DESKTOP_RELEASE_ZH.md)。

## 現有接入

檔案式 PFX／P12 使用 Actions secrets WIN_CSC_LINK（路徑或 Base64）、WIN_CSC_KEY_PASSWORD。CER 無私鑰，不能當 PFX。購買的 Token／Windows 憑證儲存、HSM、雲簽尚須適配預檢與簽章步驟，不是填入 secret 就已接通。

順序：build → fuses寫入讀回 → runtime簽章／時間戳／驗證 → 同一runtime封裝Setup與解除安裝程式簽章 → 全部驗簽 → 最終hash → 草稿回讀核驗 → 公開。簽後改圖示／fuses／資源必須重簽重算；Setup 不能替代 ASAR／原生依賴／smoke 檢查。

## 申請與測試界線

維護者選擇 SignPath Foundation 路線並接受基金會發行者名稱；2026-09-28 提交嘗試沒有確認回執，未確認核准或啟用，不宣稱贊助／可信簽章。後續接入前向供應商確認資格、身份、MFA 與批准角色；GitHub 暱稱不能代替 CA 要求的真實身份。

desktop/scripts/create-test-certificate.ps1 可建立本機自簽測試證書；私鑰不可匯出，不加入 Trusted Root／Publishers，CER 與樣本位於 %LOCALAPPDATA%/Copilotix/Signing，不提交倉庫。不要求普通使用者安裝測試根證書，不用它公開發布。

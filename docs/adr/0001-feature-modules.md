# ADR-0001：功能優先，程序層置於模組內

狀態：已接受（2026-10-25）。範圍：desktop/src。

原程序目錄讓同一功能散落各處、shared 混雜且中央 IPC 過大。現採：

- `app/`：main、preload、renderer、utility 入口與 contract 登錄檔，只組裝。
- `platform/<關注點>/<層>/`：跨功能基礎設施，不引用 features。
- `features/{document,library,parsing,translation,reader,chat,insight,zotero,settings}/`：各自擁有業務，按需設 contract、core、runtime、main、utility、renderer。

contract 為純資料 schema；core 為純邏輯，兩者不碰 Node／Electron。runtime 可用 Node，不碰 Electron；renderer 不碰 Node／main／utility，main 不直接引用 utility，preload 只依契約。跨功能只引用 contract 或各層 index.ts；禁止迴圈（含 type-only，懶載入不算初始化迴圈）。`pnpm desktop:deps` 以 error 強制，規則源為 desktop/.dependency-cruiser.cjs。

每個模組 README 僅列用途、公開入口、資料／恢復、測試與大檔例外；細節連至唯一專項契約。修改聚焦模組，跨模組能力先經公開入口暴露。舊搬檔對照由 Git 歷史保留。若功能持續需要繞過邊界，重新劃分責任，不放寬依賴規則。

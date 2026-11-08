# Agent 入口

只讀本入口及本次改動所屬模組 README；再按需讀專項契約，不預載全部 docs。文件只記現行約束、恢復語義與未決事項，不複製代碼、歷史日誌或驗收流水。

## 工作規則

- 動手與交付前查看 `git status --short --branch`；保留既有未提交修改，不清理其他工作區。push、上傳、發布須有使用者明確授權；只在要求時打包，其他 UI 交付用隔離資料的實際截圖。
- 不加 title／Tooltip／Popover；僅閱讀器筆記、論文本身參考文獻卡例外。
- schema、migration、IPC／RPC、jobs、Artifact／PathPolicy、發布變更須同步其唯一所屬契約，交代兼容、恢復及實際驗證邊界。不得為測試通過改產品門檻或刪安全回歸。

## 代碼與檢查

`desktop/src/app` 只組裝；`platform/<關注點>/<層>` 不依賴 features；`features/<模組>/<層>` 擁有業務。跨模組只引用 contract 或各層 index.ts；無循環、無進程越界。IPC 在模組 contract/ipc.ts 聲明；RPC 在 contract/rpc.ts 聲明並組入 app/contract/coreRpc.ts。規則見 [ADR](docs/adr/0001-feature-modules.md)。單檔 ≤600 行，例外及理由留模組 README。

使用 Node **24.19.0**、pnpm **11.19.0**；系統 Node 24.11.1 不可用。代碼修改跑 typecheck、lint、deps、受影響測試及 build；模組測試 `pnpm desktop:test --module <name>`。純文檔檢查連結與 diff。完整發布門禁及付費／真人驗證界線見下列入口。

## 按需入口

- [未決事項](docs/MILESTONE_1_3_ZH.md)：含封面完整圖組門檻回歸，未修復前勿視為合法單頁。
- [架構與平台契約](docs/ARCHITECTURE_ZH.md) · [開發／測試](docs/DESKTOP_DEVELOPMENT_ZH.md) · [發布](docs/DESKTOP_RELEASE_ZH.md)
- [專項契約與產品指南索引](docs/README.md)

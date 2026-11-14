# parsing

PDF 解析：調用 MinerU 解析 API、下載與發布解析產物、建立塊映射（PDF 版面 ↔ Markdown 段落），以及用 PDF 文字層修復破碎行。

## 公開 API

- `contract/blocks.ts`／`blockSchemas.ts`：塊幾何、映射與文字層修復結果的型別與 schema；`parserApi.ts`：解析服務來源 `PARSER_API_ORIGIN`。
- `contract/ipc.ts`：`documents:repair-text-layer`；`contract/rpc.ts`：`parsingOperations`（`compute:normalize-parser`、`compute:rebuild-mappings`、`compute:repair-text-layer`）。
- `core/index.ts`：塊映射 `buildBlockMappings`／`BLOCK_MAPPING_VERSION`，Markdown 分塊與對齊 `splitMarkdownBlocks`、`alignMarkdownBlocks`、`MARKDOWN_MAPPING_ALGORITHM_VERSION` 等；翻譯、閱讀、問答都以它切塊。
- `main/index.ts`：`OfficialParserClient`、`ElectronFileUploader`、`ParseJobRunner`（`parse` 作業）、`registerParsingIpc`。
- `utility/index.ts`：`createParsingOperations`，以及文庫導入共用的 `hashFile`、`isNotFound`。
- `renderer/index.ts`：`useTextLayerRepair`（閱讀器「修復文字層」）。

## 資料（文獻目錄）

`full.md`、`layout.json`、`content_list.json`、`images/`、`block_list.json`、`text-layer-repair.json`；發布經暫存＋校驗＋原子 rename，修復不改寫使用者編輯層。

## 測試

`tests/features/parsing/`（`pnpm desktop:test --module parsing`）；真實解析驗收用 `COPILOTIX_LAYOUT_ORACLE_DIR`／`COPILOTIX_LAYOUT_ACCEPTANCE_DIR`／`COPILOTIX_READER_REGRESSION_DIR`。

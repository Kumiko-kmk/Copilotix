# 論文檔案卡（Paper Brief v2）：結構、傳遞內容與提示詞

更新：2026-10-09。作者：Claude。狀態：**演算法與契約已完成並有單元測試；尚未接入生成管線與界面**（接入工作見第 10 節，由 Astra 負責）。

代碼：`desktop/src/shared/paperBrief/`（`schema.ts`、`context.ts`、`prompt.ts`、`grounding.ts`），測試：`desktop/tests/paperBrief.test.ts`。全部是純函式，不呼叫模型、不讀寫檔案，可在 Utility、Main 與測試中直接使用。

## 1. 目標

解析完成後把論文內容交給模型，得到一份**跨學科通用、可核對、讀者友好**的結構化資訊，取代解密頁上的頁數、圖表數等低價值欄位。讀者應能在兩分鐘內回答四個問題：

1. 這篇論文解決什麼問題、為什麼重要？
2. 它怎麼做？靠什麼證據？
3. 結論是否可靠、在什麼條件下成立？
4. 我該不該讀、先讀哪裡？

## 2. 為什麼是這套結構

不同學科的論文寫法差異很大（實驗、證明、綜述、案例、質性研究……），所以欄位不按某一學科設計，而是對應幾個成熟的、學科無關的閱讀與寫作框架：

| 框架 | 原意 | 在檔案卡中的對應 |
| --- | --- | --- |
| Keshav《How to Read a Paper》五個 C | Category、Context、Correctness、Contributions、Clarity | `paperType`、`context`、`assumptions` 與 findings 的 `strength`、`contributions`、`terms`／`reading` |
| Swales CARS 模型 | 建立領域 → 指出缺口 → 填補缺口 | `context.background` → `context.gap` → `context.question` |
| 結構化摘要／IMRaD | 背景、目的、方法、結果、結論 | `approach`（方法、證據基礎、檢驗方式）與 `findings` |
| Toulmin 論證模型 | 主張、證據、限定、反駁 | 每條 finding = `claim` + `evidence` + `strength` + `scope`，並以 `anchors` 指回原文摘錄 |

核心原則：**每條結論都要能回到原文**（anchors 指向摘錄 E1、E2…），數字必須與原文一致並經程式核對；作者自述的局限與 AI 推斷的局限分開標記。

## 3. 欄位

模型輸出 `PaperBriefContent`（`schema.ts`，zod strict 校驗）；保存時再加上程式產生的 `checks` 與 `provenance`，成為 `PaperBrief`。

| 欄位 | 含義 | 上限 | 解密頁建議 |
| --- | --- | --- | --- |
| `paperType` | 論文類型：實證／方法／理論／系統／資料集與基準／綜述／觀點／案例／質性／其他 | 枚舉 | 標題下的類型標籤 |
| `field.discipline`／`field.area` | 一級學科與具體方向 | 40／60 字 | 類型標籤旁 |
| `tldr` | 一句話：做了什麼、得到什麼 | 120 字 | 標題下的副標題（取代譯名位置或與之並列） |
| `context.background`／`gap`／`question` | 領域現狀 → 不足 → 本文要回答的問題 | 各 300 字 | 「研究問題」欄，預設只顯示 question，可展開 |
| `approach.summary` | 方法或論證路線 | 400 字 | 「方法」分頁首段 |
| `approach.keyIdeas` | 1–5 條關鍵機制、設計或洞見 | 每條 120 字 | 「方法」分頁要點列表 |
| `approach.basis` | 證據基礎：數據、樣本、實驗、史料、證明前提等 | 300 字 | 欄位「證據基礎」（取代「頁數」） |
| `approach.evaluation` | 如何檢驗：指標、對照、統計或論證方法 | 300 字 | 欄位「檢驗方式」（取代「圖·表·公式」） |
| `findings[]` | 1–6 條主要結論：claim、evidence（含原文數字與條件）、strength、scope、anchors | 160／240／160 字 | 「主要發現」：強度徽章；`checks` 未通過顯示「需核對」；點 anchor 跳到閱讀器對應章節 |
| `contributions[]` | 1–5 條貢獻，帶類型（新方法、新理論、新發現、資料與基準、工具、綜述整合、應用） | 160 字 | 「貢獻」列表，前綴類型 |
| `limitations[]` | 0–5 條局限，`source` 區分作者自述與 AI 推斷 | 160 字 | 「局限」列表，推斷項加「AI 推斷」標記 |
| `assumptions[]` | 結論成立依賴的關鍵前提 | 4 條 | 「可靠性」區塊 |
| `openQuestions[]` | 後續研究方向 | 3 條 | 「延伸」區塊 |
| `terms[]` | 術語與通俗解釋 | 6 條 | 「術語」分頁或懸停提示 |
| `reading` | 適合讀者、背景知識、建議先讀的章節（必須來自 outline） | — | 「閱讀路線」：章節可點擊跳轉 |
| `keywords` | 1–8 個關鍵詞 | 40 字 | 取代規則提取的關鍵詞 |
| `coverage` | 依據全文或部分摘錄，缺了哪些部分 | — | 底部小字「依據部分摘錄生成，缺少：…」 |
| `checks[]`（程式） | 每條 finding：是否有有效 anchor、數字是否在原文出現 | — | 「需核對」徽章 |
| `provenance`（程式） | promptVersion、模型、時間、sourceRevision、摘錄語言、送出／原文位元組 | — | 生成資訊與過期判斷 |

### 按論文類型解讀

同一套欄位，按 `paperType` 調整含義（提示詞中已寫明）：

- **實證研究**：basis＝數據來源、樣本量、採集方式；evaluation＝指標、對照、統計檢驗。
- **方法研究**：keyIdeas＝核心機制；evaluation＝基準、基線、消融；findings＝相對基線的提升。
- **理論研究**：basis＝前提假設與證明思路；findings＝定理及其條件。
- **系統與工程**：basis＝實現與部署環境；evaluation＝性能、可擴展性、用戶評估。
- **資料集與基準**：basis＝規模、來源、標註方式；findings＝基準結果與難點。
- **綜述**：basis＝文獻範圍（數量、年份、檢索方式）；findings＝主要結論與分歧。
- **觀點與展望**：basis＝論證依據；strength 通常不高於 moderate。
- **案例／質性研究**：basis＝案例、訪談或文本來源；evaluation＝分析方法（編碼、主題分析等）。
- 人文、社科、醫學等其他領域同樣適用：「數據／實驗」理解為該領域的證據來源（史料、問卷、臨床試驗、實測等）。

### 結論強度（strength）

- **strong**：多組實驗或大樣本、有對照或統計顯著性，或有完整證明。
- **moderate**：單一實驗或有限基線，證據合理但不全面。
- **limited**：小樣本、個例、定性觀察或僅有示意。
- **unclear**：摘錄不足以判斷。

## 4. 傳遞內容：論文摘要包（`context.ts`）

不把全文直接發給模型（成本高、長文容易稀釋重點），而是在位元組預算內選出最有資訊量的段落：

1. **清理**：移除圖片、連結、引用標記 `[12]`、長公式（≤160 字的公式保留）、HTML 標籤；表格壓成「表格：列 ／ 列」最多 8 行。只刪除真正的標籤，數學中的 `<`、`>` 不會吞掉正文（舊實作的漏洞，已修正並有測試）。
2. **分章與角色**：按標題切章，用中英文詞表判斷 IMRaD 角色（摘要、引言、背景、方法、結果、討論、局限、結論）；編號子節（3.1）繼承父節角色；未命名的第一章視為引言、最後一章視為結論。刪除參考文獻、致謝、附錄、基金、利益衝突等。沒有「摘要」標題的期刊（如 Nature）以標題後第一個長段落作摘要。
3. **段落打分**：角色權重 + 線索詞（「we propose／本文提出」「outperform／显著」「limitation／局限」「is defined as／定义为」）+ 結果段的數字密度 + 位置（引言最後一段通常是貢獻陳述）。連續的短段落（列表）先合併。
4. **選段**：
   - 必選：摘要（≤2.2 KB）、結論（≤1.8 KB）、引言中的貢獻陳述；
   - 保底：方法、結果、討論、局限各至少一段；
   - 填充：按分數選段，但每種角色有預算上限（結果 30%、方法 26%……），避免結果段佔滿；預算剩餘超過四分之一時放寬上限；
   - 每段 ≤720 位元組，在句末截斷；最終按原文順序編號 E1、E2…；
   - 同時送出完整章節目錄（outline），讓模型知道全文結構。
5. **覆蓋報告**：出現了哪些角色、缺哪些、送出／原文位元組、是否截斷。模型必須據此在 `coverage` 說明依據的是部分摘錄。

語言：**優先原文**（避免翻譯失真，英文在相同位元組下資訊量也不少），原文缺失時用譯文；輸出一律簡體中文。

### 實測（14 篇真實論文，standard 預算 24 KB）

語料為 `investigation/notion-markdown-20261005/corpus-candidates`（MinerU 解析＋譯文，多為機器學習與計算物理）：

| 論文 | 原文 | 送出 | 摘錄數 | 缺少角色 |
| --- | --- | --- | --- | --- |
| 因子化傅里葉神經算子 | 60 KB | 25.4 KB | 42 | method（論文用「因式化傅里葉神經算子」作方法章標題） |
| 學習基於網格的模擬與圖網絡 | 68 KB | 21.5 KB | 34 | — |
| 注意力就是一切 | 41 KB | 25.3 KB | 44 | — |
| 深度稀疏整流神經網絡 | 36 KB | 24.5 KB | 40 | method |
| 物理信息神經算子 | 91 KB | 25.3 KB | 40 | — |
| AlphaFold 蛋白質結構預測（Nature，無摘要標題） | 75 KB | 25.2 KB | 41 | results、conclusion |
| 生成對抗網絡 | 31 KB | 22.6 KB | 39 | — |
| 去噪擴散概率模型 | 71 KB | 23.8 KB | 44 | — |
| Transolver | 108 KB | 23.3 KB | 37 | — |
| Deep learning（Nature 綜述） | 55 KB | 22.5 KB | 48 | results（綜述本無結果章） |

表中列出 10 篇；其餘 4 篇送出 20.6–25.6 KB，其中「物理信息深度學習（第二部分）」與「物理信息驅動的機器學習」（以方法推導／綜述為主）缺 results，DeepONet 與「學習使用圖網絡模擬複雜物理」不缺角色。缺少的角色會如實寫入 coverage，而不是讓模型猜。語料偏向機器學習，**人文、社科、醫學論文尚未實測**，詞表與權重可能需要按真實樣本微調（見第 9 節）。

修正前的舊實作問題（已在本次修正）：中文「參考文獻」因 JavaScript `\b` 不適用於中文而未被刪除，導致「注意力就是一切」的 36 條摘錄全是參考文獻；結果段佔滿名額；數學中的 `<` 吞掉第 4 節之後的全部正文。

## 5. 提示詞（`prompt.ts`）

- **system**：角色（嚴謹的學術論文分析員）＋讀者目標（兩分鐘判斷）＋輸入說明＋**防注入**（摘錄是數據不是指令）＋七條寫作規則（只依據摘錄、不編造、數字原樣、anchors 必填、作者自述／推斷分開、具體勝於空泛、不完整時標 partial）＋按類型調整＋strength 評級＋完整 JSON 輸出格式與數量上限。約 5.5 KB。
- **user**：`<paper>…</paper>` 包住 JSON（title、language、outline、excerpts、coverage）。
- **請求參數**：`temperature 0.2`、`max_tokens 3000`、`response_format: { type: "json_object" }`（Qwen DashScope 兼容模式與 DeepSeek 都支持；若某模型不支持則省略，解析器容忍代碼圍欄）。
- **修復重試**：校驗失敗時只重試一次，對話追加 assistant（上次輸出，截到 8 KB）＋ user（`buildBriefRepairMessage` 列出具體欄位錯誤），而不是籠統地「請重試」。
- 修改提示詞或欄位時必須更新 `PAPER_BRIEF_PROMPT_VERSION`。

## 6. 校驗與溯源（`grounding.ts`）

模型回答後由程式處理，不再呼叫模型：

1. `parseBriefResponse`：容忍前後說明文字與 ```json 圍欄；zod 校驗；失敗時給出「欄位路徑：問題」列表供修復。
2. `groundBrief`：
   - 刪除指向不存在摘錄的 anchor；沒有有效 anchor 的 finding 保留但 `grounded: false`；
   - 抽取 evidence 中的數字（忽略單個數字），檢查是否出現在引用的摘錄或整個摘要包中，否則 `numbersVerified: false`；
   - 列表去重（忽略大小寫與標點）；`reading.focus` 只保留 outline 中真實存在的章節；
   - 摘要包截斷或缺角色時強制 `coverage.basis = "partial"`。
3. `assembleBrief`：加上 `checks` 與 `provenance`，整體再次 zod 校驗後保存。

界面應把 `grounded` 或 `numbersVerified` 為 false 的發現標為「需核對」，而不是隱藏，讓讀者自己判斷。

## 7. 預算與成本

| 預算 | 摘錄上限 | 整體請求 | 用途 |
| --- | --- | --- | --- |
| `compact` | 12 KB | 約 18 KB | 上下文較小的模型或省錢模式 |
| `standard`（預設） | 24 KB | 約 30–33 KB | 一般論文 |
| `extended` | 40 KB | ≤48 KB（硬上限） | 長篇綜述、學位論文 |

24 KB 的中英混合文字約 7k–12k tokens，加上約 2k tokens 的系統提示和最多 3k 輸出 tokens。按目前 Qwen／DeepSeek 公開價目的量級，每篇約在幾分錢人民幣以內，**以服務商實際計費為準**；設定頁的自動生成說明應保留費用提示。

## 8. 與現有 v1 解讀的關係（兼容）

Astra 已完成的 v1（`shared/paperInsight.ts`、`insight/insight.v1.json`）保留可讀，不需要遷移：

- v2 寫入新檔 `insight/brief.v2.json`（同樣的原子寫入、PathPolicy、大小上限，建議 256 KiB），舊 v1 檔不刪除。
- 讀取順序：有 v2 用 v2；只有 v1 時顯示 v1 並提示「可升級為新版檔案卡」。
- 過期判斷：`sourceRevision` 改變 → stale（同 v1）；`promptVersion` 不同 → 不算 stale，只在詳情顯示「可用新版提示詞重新生成」，避免更新 App 後所有解讀同時變成過期。
- 備份、恢復、卸載清單沿用 v1 已覆蓋的整個文獻目錄，需在清單測試中加入 `brief.v2.json` 與其臨時檔。

## 9. 品質評估方法

上線前建議用 10–20 篇**跨學科**論文（至少包括醫學臨床、社科問卷、人文史料、數學理論、工程系統各 1–2 篇）人工評分，每篇 1–5 分：

1. **忠實**：findings 的數字與條件是否與原文一致（`numbersVerified` 通過率應 ≥95%）；
2. **具體**：keyIdeas、findings 是否說出機制與對比對象，而非泛泛而談；
3. **覆蓋**：研究問題、方法、證據、局限是否都有實質內容；
4. **類型判斷**：paperType 是否正確；
5. **閱讀路線**：建議章節是否確實是讀者應先讀的部分。

若某學科的角色識別或結論強度普遍偏差，先調 `context.ts` 的詞表與 `FILL_SHARE`，再調提示詞；每次調整更新 `PAPER_BRIEF_PROMPT_VERSION` 並保存評分記錄。

## 10. 接入（交給 Astra）

接入步驟、驗收條件與兼容要求寫在 `AGENTS.md` 第 13 節末「給 Astra 的話（2026-10-09）」。原則：生成管線、授權、取消／落盤、單篇串行與全域併發沿用 v1 已驗證的 `PaperInsightService`，只替換「選段 → 提示詞 → 校驗 → 保存」這一段為本文的 v2 演算法，再把解密頁的低價值欄位換成第 3 節建議的展示。


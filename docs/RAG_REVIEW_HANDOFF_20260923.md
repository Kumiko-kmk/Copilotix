# RAG 审查与接续记录（2026-09-23）

## 当前工作位置

- 仓库：`F:\12479\文档\ChatGPT\paperAssistant\Copilotix`。
- 分支：`codex/rag-review-20260923`；起点 `4c96a29`，来自本地 master（当时领先 origin/master 16 个提交）。没有拉取远端、重置、stash、提交或推送。
- 本轮开始时工作树干净。后续代理须先读 AGENTS.md 和本文件，再检查 Git diff，保留本轮未提交修改。
- 这是一轮基础审查与修复，不代表论文问答、跨文档总结或完整 RAG 已实现。原编号计划 04 及之后仍未完成。

## 架构判断与实际完成度

目前没有整体重写的必要。现有 Renderer → Preload → Main → Utility 边界、凭证隔离、SQLite 事务、产物 hash、持久化任务及取消/恢复机制应保留。后续新增明确的检索与回答服务，比另起 Python 服务、引入额外向量数据库或更换整个前端更容易验证。

| 能力 | 源码证据 | 当前结论 |
| --- | --- | --- |
| PDF 导入、解析、翻译、阅读 | main 的 parse/translation runner 与 renderer Reader | 已有运行链路，本轮全量回归覆盖 |
| RAG 状态与检索/引用 DTO | shared/ragSchemas.ts | 有契约；存在本轮修复的 ID 格式不兼容 |
| 内容/向量元数据、任务、删除 | sqliteRagRepository.ts、ragDomainService.ts、v2TaskRepositoryCompat.ts | 有持久化基础；不是可运行的语义检索 |
| 结构化切块与自动任务 | structureAwareChunker.ts、ragContentIndexService.ts、main/index.ts | 已接入本地 runner；本轮修复标题、版本与启动恢复 |
| FTS/BM25/trigram | v2Database.ts 迁移仅至 v4；没有 FTS 实现 | 尚未实现；local ready 当前仅表示内容切块发布 |
| Embedding | 有 ensureEmbeddingJob 与 profile/vector 表；main 未注册 embedding runner | 尚无供应商调用、批次恢复与向量查询完整链路 |
| Hybrid / rerank | 有规划与 DTO | 未实现 |
| 问答与可信引用 | 有流式/引用 schema；无完整 chat 服务或 Renderer IPC | 未实现 |
| 选区问答 | MarkdownPane 的可选 onAddToChat 回调 | 只具备 UI 数据入口，不能当作问答功能 |
| 多文档总结与评测 | 设计计划 | 未实现 |

旧 ARCHITECTURE_ZH.md / RAG_DEVELOPMENT_PLAN_ZH.md 中“RAG 尚未实现”描述的是较早基线；03 的实现记录比总索引更接近当前源码。不能仅根据文档的 planned/completed 判断实际功能。

## 本轮已修复

1. **P1：持久化 ID 与公开 DTO 冲突。** 实际内容版本为 `rag-content-revision-<64位小写hex>`，向量索引为 `rag-vector-index-<64位小写hex>`；公开契约原先要求 UUID。新增各自专用 schema，同时兼容 UUID，应用于状态、搜索、引用定位、选区快照。文档/产物/请求 ID 和 scope 仍维持原校验，不放宽为任意字符串。旧数据库无需改写。
2. **P1：章节树跳级错误。** H1 → H3 → H3 时第二个 H3 被错误挂到第一个 H3 下。改用保留真实 heading depth 的栈。
3. **P1：长标题违反切块与落库限制。** 标题原来绕过 700 token 上限；完整标题还会超过 sectionPath 单项 512 字符限制。现在标题正文按 Unicode 安全边界分块且可按 UTF-16 offset 回切；仅用于展示/检索的章节标签限长并加省略号。完整正文不截断。
4. **P1：算法身份漂移。** 原来计划侧与执行侧各有一份版本常量，且 parser 元数据可以指定任意 chunkerFingerprint。现在版本来自 shared/ragVersion.ts，提升到 `structure-aware-v2:tokens-v1:utf16`，计划侧只使用已安装算法的身份。
5. **P1：旧文档缺少算法升级入口。** Utility 初始化时为没有当前算法 revision 的已解析文档补建本地任务。继续使用原事务发布规则，旧 ready 内容在新任务完成前可用；重复启动不重复排队，也不自动重试已存在的当前版本失败任务。不会启动云端 embedding 或调用付费 API。
6. **基线回归：设置页图标污染按钮名称。** “打开当前目录”的可访问名称变成了 `folder-open打开当前目录`。将装饰图标标为 aria-hidden，保持现有按钮测试断言。

兼容与恢复：未修改已有 migration、未变更数据库版本；新旧内容 revision 并存，旧引用身份保留。新版本重建是本地低优先级任务。若回退应用代码，需同时回退版本/计划/执行相关文件；不要人工改写现有 revision hash 或删除数据库来“修复”状态。

## 剩余问题与实施优先级

### 接下来先完成 04：本地检索后端

读取 `docs/rag-implementation/04_LOCAL_FTS_BACKEND.md`，不要直接从切块跳到 chat。

- 新增连续 migration，建立 word 与 trigram 通道；确保 chunk、FTS 和 active revision 在同一发布事务中一致。
- 先探测开发 Node 与打包 Electron 的 SQLite 实际 FTS5/tokenizer 能力，不能只根据开发机判断。
- scope 必须在 SQL 查询中约束；分页游标绑定 query、scope 和索引 generation。索引变化后显式拒绝旧游标或重开查询。
- 英文词法、中文 trigram、1–2 汉字/公式/缩写 fallback 必须有独立用例；禁止直接执行用户提供的 FTS 表达式。
- 译文后到时只更新 variant/lexical generation，不改 canonical chunk ID、不重做 embedding。
- 测试删除后零召回、旧版本切换、失败保旧、重复刷新与网络调用为零。
- 当前任务规划仍要求 parsed_markdown 与 block_mappings 成对存在；切块服务本身可处理无 mapping。应明确历史缺失 mapping 文档的降级策略，避免长期不入索引。

### 再完成 05–08：检索入口与语义能力

先实现能跳转原文的本地搜索 UI，再接明确的 embedding capability、凭证引用和文档范围授权。沿用现有 Main 网络/Vault、Utility 计算/SQLite 边界。

向量层还需要专项强化：`normalizeEmbedding` 目前仅校验字节长度；`upsertEmbedding` 没有在该方法内比较索引维度；`activateVectorIndex` 未在该方法内重验 semanticConsent。它们是代码审查发现，尚未在本轮构造攻击/并发重现，也未修改；必须在接入真实 embedding runner 前补齐维度、有限数值、完整覆盖与撤回授权的回归测试，不能依赖 UI 约束。

先做 exact Float32 作为可对照基线，再以实际库规模/时延决定是否需要 ANN。混合检索以 RRF 为可解释基线，不宣称它对所有语料最优；评测后再选参数或比较其他融合方法。

### 之后完成 10–12：问答与跨文档总结

- 区分术语搜索、单篇问答、选区解释和跨文档综合，避免把所有任务都简化为全库 top-k。
- 跨文档综合需按文档分配证据预算，报告哪些文档未找到证据，保留矛盾结果。
- citation 由检索器生成并绑定 artifact/revision/chunk/hash；模型只能引用已有 citationId，不能自造页码。
- 文档文本作为不可信内容；不足以回答时明确说明证据不足。流式断开、取消、provider 重试不得重复计费或重复写历史。
- 用固定中英文学术问题集评估召回、定位准确率、引用有效率、跨文档覆盖和拒答；没有评测证据不要堆叠 reranker、图检索或多个代理。

## 验证与证据

- 修改前 TypeScript 通过；全量基线 71 文件中 70 通过、1 失败，350 tests 通过、1 失败、3 跳过。失败是上述 SettingsPage 按钮可访问名称。
- 两个切块新增回归在修复前均失败；确定性 ID 契约回归在修复前失败。
- 修复后专项：5 文件、57 tests 通过；包含真实 SQLite 长标题落库、算法升级保旧与幂等用例。
- 全量 coverage：71 文件通过、357 tests 通过、3 跳过；statements/lines 87.85%、branches 77.64%、functions 87.43%，退出码 0。
- TypeScript 通过。最后一次标签控制字符处理改为 Unicode Cc 分类；需保留最终 lint/构建日志作为交付证据。
- 注意：现有 coverage 配置排除整个 Utility，因此全局百分比不能代表切块/SQLite/FTS 的覆盖程度。本轮没有扩大 exclude 或降低门槛；Utility 用例实际被执行，但后续应建立该层单独覆盖门禁。
- 日志位于 desktop/rag-review-baseline.log、rag-review-coverage.log、rag-review-lint.log、rag-review-release.log（生成文件，不作为源码提交）。
- 未调用真实论文解析、翻译、embedding 或 chat 云端 API；未宣称完成真实论文问答验收。

## 环境与恢复命令

当前宿主 Node 是 24.11.1，项目声明 Node 24 系列并记录较新的精确版本；最终须以生产打包 smoke 结果为准。依赖已存在，没有升级 lockfile。

Git 不在默认 PATH，且仓库所有者与命令账户不同；使用单次 safe.directory，不设置全局通配信任：

```powershell
& 'C:\Users\12479\AppData\Local\github-copilot-git-2.53.0-4\cmd\git.exe' -c safe.directory=F:/12479/文档/ChatGPT/paperAssistant/Copilotix status --short --branch
```

本轮沙箱命令启动出现 `setup refresh had errors`，因此 shell 通过明确授权执行。pnpm 11.19.0 已由 Corepack 提供；嵌套脚本需要入口目录加入当前进程 PATH：

```powershell
$env:PATH = 'C:\Users\12479\.cache\paperassistant-review-tools;' + $env:PATH
pnpm.cmd desktop:typecheck
pnpm.cmd desktop:lint
pnpm.cmd desktop:test:coverage
pnpm.cmd desktop:release
```

## 技术资料（审查时核对）

- [SQLite 官方 FTS5 文档](https://sqlite.org/fts5.html)：trigram 对少于三个 Unicode 字符的全文查询有限制，故需短词策略；tokenizer、查询 escaping 和 BM25 以该文档为准。
- [RRF 原始论文记录](https://research.google/pubs/reciprocal-rank-fusion-outperforms-condorcet-and-individual-rank-learning-methods/)：使用排名融合的基线依据。
- [融合方法对比研究](https://arxiv.org/abs/2210.11934)：RRF 对参数与语料有敏感性，应实测，不应把固定参数当作普遍最优。

## 本轮最终验证与可用产物

- 最终 typecheck 通过；lint 0 errors、49 warnings，未降低规则；git diff --check 通过。
- 全量 coverage 结果如上（357 passed / 3 skipped）；最终 Unicode 控制字符写法调整后，切块与真实落库相关 17 tests 再次通过。
- Main、Preload、Renderer、Utility 生产 bundle 构建通过；Utility bundle smoke 通过。
- Windows 完整目录、ZIP、ASAR/fuses/体积/解压检查、packaged smoke 已通过。脚本完成这些检查并生成 manifest 后，在替换 release 时失败，故不能把 desktop:release 写成发布成功。
- 失败原因：Windows EPERM，旧 release 内 Copilotix.exe 仍有多个进程运行（只读检查确认）。未终止这些进程，未删除旧发布目录。
- 新包位置：`.release-next-mudvgys1-30584-d6793a91/Copilotix-0.1.0-win-x64.zip`；已核对实际 ZIP hash 与 manifest、SHA256SUMS 一致。
- ZIP SHA-256：`02158F7116E2BE207FF64FD86F9B1213738C4375302974326886F8ADBD0F5D7D`。
- 同目录中的 `Copilotix-0.1.0-win-x64/` 是完整可运行包；不要只复制 EXE。退出旧应用后可按 AGENTS.md 的 from-built 命令再次发布（若期间改源码，必须重新 build）。
- 本轮只完成审查与基础修复，04 本地检索后端仍是下一实施单元；不要把这个测试包描述为已支持论文问答。

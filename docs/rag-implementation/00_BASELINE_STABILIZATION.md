# 00 — 恢复现有基线

> 状态：`completed`
>
> 前置计划：无
> 本计划禁止加入任何 RAG 代码。

## 用户结果

用户现有的导入、断点恢复和翻译行为保持可靠；后续 RAG 缺陷不会与已存在的回归混在一起。

## 已知基线

2026-09-16 实测：

- `pnpm desktop:typecheck` 通过；
- `pnpm desktop:test` 有 1 个失败：`desktop/tests/taskService.test.ts` 的 `resumes a remote checkpoint without resubmitting and runs one dependent translation`，预期 translation status 为 `succeeded`，实际为 `partial`。

## 代码修改任务

1. 在未修改代码前单独重跑失败用例，保存完整断言与日志。
2. 沿 `TaskService` → provider policy/order → dependent translation 的路径确认 `partial` 来源：是生产契约回归、测试 fixture 未随 provider 优先级更新，还是异步状态未等待完成。
3. 与 `shared/providerPolicy.ts`、Settings provider order、`translationJobRunner.ts` 的当前契约交叉核对。
4. 只做恢复预期行为所需的最小修复：
   - 若生产行为错误，修实现并增加回归断言；
   - 若 fixture 已不符合当前公开契约，修 fixture，并证明真实错误仍会返回 `partial`；
   - 禁止把期望直接改为 `partial` 来掩盖失败。
5. 检查工作树，不碰无关用户改动。

## 重点文件

- `desktop/tests/taskService.test.ts`
- `desktop/src/main/taskService.ts`
- `desktop/src/main/translationJobRunner.ts`
- `desktop/src/shared/providerPolicy.ts`
- 与实际根因直接相关的测试 fixture

## 自动测试

```powershell
pnpm --dir desktop test tests/taskService.test.ts
pnpm desktop:typecheck
pnpm desktop:lint
pnpm desktop:test
pnpm desktop:test:coverage
```

新增/调整断言必须覆盖：远端 checkpoint 不重复提交；只创建一个依赖翻译；有效 provider 成功时为 `succeeded`；部分 provider 失败时仍按现有契约返回 `partial`。

## 人工验收

使用现有 fake/integration 路径验证：恢复一个已有远端 checkpoint 后不会再次提交解析；最终只出现一次翻译；任务列表不会在成功后错误显示部分完成。不得调用真实付费 API。

## 退出门禁

- 上述五条命令 exit code 均为 0；coverage 阈值未降低。
- 失败根因和修复理由写入实施记录。
- 没有 RAG 文件、schema 或 UI 改动。
- 任一现有测试仍失败时，本计划为 `blocked`，01 不得开始。

## 实施记录（2026-09-16）

- 状态：`completed`
- 实际修改文件：仅本文件；未修改任何生产代码或测试代码。
- 失败根因与修复理由：统筹代理在创建分支/委派前曾复现一次 `partial`，但 Luna 接手后及管理侧复核均无法再次复现，因此现有证据只支持“瞬态或顺序相关失败”，不足以安全归因到某一生产实现。没有为了制造 diff 而猜测性修改代码。沿实际链路核对后，`SettingsService.validateCredential('qwen')` 为 fake qwen 凭证建立有效状态，`TranslationJobRunner` 通过 `executableProviderOrder` 将已验证 provider 传给 `TranslationPlanOrchestrator`，fake `/chat/completions` 响应被正常应用并由 Utility plan finalize 为 `succeeded`。已有负向回归仍证明全部 provider 失败时按契约返回 `partial`。
- 自动测试：
  - `pnpm --dir desktop test tests/taskService.test.ts`：exit code `0`；2 个测试通过。随后同命令重复 3 次，均 exit code `0`。
  - `pnpm desktop:typecheck`：exit code `0`。
  - `pnpm desktop:lint`：exit code `0`；0 errors、47 个既有 warnings，未新增 lint 错误。
  - `pnpm desktop:test`：exit code `0`；60 个 test files 通过，268 个测试通过、3 个跳过（共 271 个）。
  - `pnpm desktop:test:coverage`：exit code `0`；60 个 test files 通过，268 个测试通过、3 个跳过；All files：statements `86.13%`、branches `76.79%`、functions `86.03%`、lines `86.13%`，满足 `80/75/80/80` 门槛。
- 统筹代理独立复核：专项测试额外连续运行 5 次，全部为 2/2 通过；随后独立运行 typecheck、lint、全量 test 和 coverage，结果与上述计数、覆盖率一致。
- 人工验收：使用 `desktop/tests/taskService.test.ts` 的 `ResumeClient`、`MemoryVault`、`MarkdownTranslationPlanManager` 和 fake fetcher 路径验收；断点恢复不调用 `createUploadBatch`（`createCalls = 0`），解析只创建一个依赖 translate job，翻译只生成一个 `full.zh-CN.md`/manifest artifact，最终状态为 `succeeded`，且未调用真实 API。`desktop/tests/translationPlanOrchestrator.test.ts` 的全 provider 失败场景仍返回 `partial`，证明没有通过放宽失败契约取得绿色。
- 已知限制：首次失败只有命令输出而没有更细粒度诊断日志，连续通过后无法还原其具体瞬态条件；若后续 CI 再出现相同失败，应保存 provider 选择、unit mutation 和 finalize counts（仍不得记录密钥/正文）后重新打开 00。当前工作树仍包含其他用户未提交改动，本计划未触碰、未回滚、未清理。GUI E2E 不属于本计划，也未被宣称通过。
- 下一计划是否可开始：是；当前五条门禁均通过且没有 RAG 实现改动。下一步应由集成负责人按顺序启动 `01_RAG_CONTRACTS_AND_STATES.md`，开始前仍需重新检查工作树和基线。

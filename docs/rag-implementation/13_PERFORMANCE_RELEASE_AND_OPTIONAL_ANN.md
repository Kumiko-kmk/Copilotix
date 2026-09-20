# 13 — 性能、托盘后台与发布验收

> 状态：`planned`
>
> 前置计划：12

## 用户结果

大论文库索引时阅读仍流畅，后台作业状态可见可控；安装包升级、离线和删除行为可被发布证据证明。

## 代码修改任务

1. 对 10k/50k/100k chunk 测量：索引时间、exact query p50/p95、首结果、内存峰值、数据库/向量大小、取消延迟、应用启动和 Reader 交互延迟。
2. 校准 scheduler resource lanes：parse/translate 优先；rag-content 与 rag-embed 并发、批次和内存有界；Main/UI event loop 不执行重计算。
3. 托盘行为：窗口关闭而作业继续时显示索引数量/状态；提供暂停、恢复、取消；退出应用前按既有产品语义安全 checkpoint，不静默丢失。
4. 离线/代理/睡眠恢复/磁盘不足/数据库锁/Utility 重启的故障注入；旧 active index 始终可用或明确不可用，不能半发布。
5. 先用 exact scan 数据决定是否引入 ANN。只有 100k benchmark 超过冻结的 p95/内存预算，且真实个人库需要，才通过 `VectorStorePort` 加 `sqlite-vec` adapter。
6. 若引入 native extension，必须验证 Electron ABI、Windows x64/arm64（按项目支持矩阵）、ASAR 解包、hash/许可、安装/升级/卸载、fallback 和无 DLL 环境；`sqlite-vec` 不是事实来源，能从 embeddings 重建。
7. 完成 build、packaged CLI smoke、Electron E2E、安装包/便携版升级回滚和原子 release 验证；更新 ARCHITECTURE/README/安全与隐私说明，只将实际通过的能力标为 implemented。

## 性能预算冻结

实现前在目标 Windows 硬件记录 CPU/内存/磁盘基线并冻结预算。建议起始目标（可依据实测修订，但必须记录理由）：50k chunk exact query p95 ≤ 150 ms（不含远程 query embedding）、取消响应 ≤ 1 s、后台索引不让 Reader 连续交互 p95 退化超过 20%、峰值增量内存 ≤ 512 MiB。未实测不得写成已达到。

## 自动测试与命令

```powershell
pnpm desktop:rag-benchmark
pnpm desktop:typecheck
pnpm desktop:lint
pnpm desktop:test
pnpm desktop:test:coverage
pnpm desktop:build
pnpm --dir desktop test:e2e
```

若 `desktop:rag-benchmark` 尚不存在，本计划负责加入可固定 seed/规模并输出 JSON 的脚本。再运行仓库现有 packaged smoke/release verification 命令；执行者必须先从 `package.json` 和 release 脚本读取真实命令，不能猜测。若加入 ANN，再增加 adapter parity、缺 extension fallback、ABI/ASAR 和从事实表重建测试。

## 人工验收

在目标 Windows 安装包上：导入/使用预制大库 → 后台索引时阅读/搜索 → 最小化托盘 → 暂停/恢复/取消 → 断网/睡眠恢复 → 重启续跑 → 删除 → 升级旧数据库。记录版本、硬件、数据规模、时间、内存和截图/日志位置。

## 退出门禁

- 10k/50k/100k 结果可复现，性能预算有通过/失败结论。
- 若 exact scan 达标，不引入 ANN；若不达标，ANN 必须证明收益并通过发布矩阵。
- 全量 unit/coverage/build/E2E/packaged smoke 通过；不能运行的项目必须在目标 CI/机器补齐后才完成。
- 文档只声明已由代码、测试和打包证据支持的功能。
- 最终从 fresh install 和已有 v2 数据库升级都能完成端到端用户旅程。

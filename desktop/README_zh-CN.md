# MinerU 桌面翻译版

这是基于 MinerU 开源项目构建的非官方个人桌面客户端。它不包含本地解析模型，也不会启动仓库内的 Python `mineru-api`，而是连接 MinerU 官方 API v4，在解析完成后于本地生成简体中文 Markdown，并提供 PDF 版面区块联动阅读。

阅读器会以灰色还原 layout JSON 中的页眉、页脚与脚注，并在页面边界显示“第 N 页”。原文与中文译文视图都会隐藏容易被误认成图片的单独打印页码方块，只保留统一分页线。灰色补充元素不参与 PDF 跳转或滚动联动，但与正文、表格、代码和公式一样支持持久化荧光笔与下划线；图片和分页线不可标注。`<sub>`、`<sup>` 与链接仍按安全 Markdown 渲染。译文正文按可信 `sourceIndex` 重新使用当前原文映射，因此旧 version 2 任务也能安全恢复 PDF 联动。原文 Markdown、中文 Markdown 与 JSON 采用常驻视图和空闲预热，长文档切换时不会反复销毁并重建已渲染内容。

划选原文或译文文本后，选区上方会显示荧光笔、下划线和“添加到对话”三个操作。荧光笔默认黄色，悬停或右键图标可选择黄、绿、蓝、粉、紫五色；选色只改变当前笔色，点击荧光笔后才应用。再次划选已覆盖范围并执行相同样式可精确删除该范围。标注按任务及原文/译文分别保存在本地 SQLite，不写回 Markdown 或结果 ZIP；“添加到对话”当前只保留内部载荷接口。

完整的进程边界、任务状态机、API 契约、输出文件、翻译流水线和模块修改地图见 [`../ARCHITECTURE_ZH.md`](../ARCHITECTURE_ZH.md)。

## 开发环境

- Windows 10/11 x64
- Node.js 24.11.1
- pnpm 11.19.0
- MinerU 官方 API Token（在 [MinerU API 管理](https://mineru.net/apiManage) 获取）

```powershell
pnpm install
pnpm desktop:dev
```

首次安装依赖时，pnpm 可能要求批准 Electron、esbuild 和 electron-builder 的构建脚本。不要批准清单之外的未知脚本。

## 测试与构建

```powershell
pnpm desktop:typecheck
pnpm desktop:test
pnpm desktop:build
pnpm desktop:release
pnpm desktop:test:e2e
```

开发中间文件只位于 `desktop/out/`；每次 build 都会先安全清空该目录，避免旧哈希 bundle 混入新产物。正式发布文件统一位于仓库根目录 `release/`，每次执行 `desktop:release` 都会先精确清理再重建该目录（失败时不保留旧发布物）：

- `MinerU-<版本>-win-x64/`：唯一可运行目录，入口为其中的 `MinerU.exe`
- `MinerU-<版本>-win-x64.zip`：上述目录的传输副本，解压后运行
- `release-manifest.json`：版本、入口和 SHA-256 元数据
- `SHA256SUMS.txt`：ZIP 与主程序校验值

不再生成 setup 或单文件 portable。运行时必须保留整个目录，不能只复制 `MinerU.exe`；更新时关闭程序并整体替换目录即可。程序没有代码签名，Windows SmartScreen 可能显示未知发布者。自制版使用独立的 `%APPDATA%\MinerU-Translation` 数据目录，整体替换程序目录不会删除任务、设置或官方解析结果。

发布包仅保留 Electron 的简体中文语言资源，并在生成 manifest 前强制检查：`app.asar` 不超过 40 MiB、运行目录不超过 330 MiB、ZIP 不超过 140 MiB，且不得包含非浏览器端所需的 `@napi-rs/canvas`。任一检查失败都会中止发布。

## 配置

1. 在“设置 → 系统设置”填写必需的 MinerU 官方 API Token，然后点击“验证 Token”。API 地址固定为 `https://mineru.net`。
2. 设置结果保存目录。
3. 在“参数设置”选择解析模型和翻译源。千问、DeepSeek API Key 写入 Windows Credential Manager，不会保存到 SQLite 或前端。
4. Bing 与腾讯 TranSmart 使用非官方网页接口，可能限流、变化或失效；客户端会重试并按配置回退。表格在完整校验后才会整体回填：TranSmart 使用原生数组请求，Bing 兜底时使用多次短请求，避免长 marker 文本被改写或截断。

任务异常时可检查 `%APPDATA%\MinerU-Translation\mineru-desktop.log`。日志只记录任务阶段、远端状态和错误，Token、API Key 及预签名 URL 查询参数会被遮蔽。

## 隐私与安全

- PDF 会通过官方预签名上传地址发送到 MinerU 服务。
- 待翻译文本会发送到选定翻译服务；表格会连同 caption、footnote 作为一个逻辑整体处理，备用策略可能使同一文档使用多个服务。参考文献标题固定显示为“参考文献”，具体文献条目保持原文且不会发送到翻译服务。
- Token 只发送到固定的 `https://mineru.net/api/v4` 接口；预签名上传及结果下载请求不携带 Token。
- 日志、任务数据库和渲染进程不保存或返回 API Key。

本客户端为非官方个人改编，MinerU 名称、图标和解析引擎归其原项目所有。根仓库 `LICENSE.md` 使用附带额外条款的 MinerU Open Source License；`desktop/package.json` 当前声明 `AGPL-3.0-only`。正式分发前应由维护者确认并统一桌面客户端适用的许可证与署名要求。

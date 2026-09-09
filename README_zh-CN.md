# Copilotix

Copilotix 是面向 Windows 的论文处理与阅读桌面工作区，支持导入 PDF、持久化解析与翻译任务，以及 PDF/Markdown 联动阅读。

## 桌面应用

Electron 应用位于 `desktop/`，由四个隔离的 bundle 组成：

- React Renderer：任务、设置和阅读器界面；
- Preload：通过 `window.copilotix` 暴露经验证的领域 API；
- Main：权限、凭证、网络访问和流程编排；
- Utility：SQLite、artifact 文件操作和计算任务。

Renderer 启用 sandbox，不能直接访问 Node.js、文件系统、凭证或任意 IPC channel。

## 本地开发

环境要求为 Windows x64、Node.js 24 和 pnpm 11.19.0。

```powershell
pnpm install
pnpm desktop:typecheck
pnpm desktop:lint
pnpm desktop:test
pnpm desktop:build
```

使用 `pnpm desktop:release` 生成经过验证的目录版。发布流程会审计四个 bundle、ASAR、运行目录、哈希和 packaged CLI smoke，全部通过后才原子发布到 `release/Copilotix-<version>-win-x64/`。

## Python 包

Python 文档处理包名为 `copilotix`，命令入口包括 `copilotix`、`copilotix-api`、`copilotix-router` 和 `copilotix-gradio`。

## 文档入口

- [桌面开发说明](desktop/README_zh-CN.md)
- [架构基线](ARCHITECTURE_ZH.md)
- [RAG 开发计划](RAG_DEVELOPMENT_PLAN_ZH.md)
- [English README](README.md)

项目源码与问题跟踪：<https://github.com/Kumiko-kmk/Copilotix>

## 许可证

参见 [LICENSE.md](LICENSE.md)。为避免破坏兼容性或错误改写法律含义，仓库会保留必要的第三方依赖坐标和法定署名。

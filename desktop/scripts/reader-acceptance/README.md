# 阅读器独立验收入口

直接引用当前 PDF、Markdown、工作台、映射和图片分组实现，不复制阅读器逻辑，不修改业务数据结构。提供 PDF／原文／译文（原文与译文在右侧标签切换，也可拆分并排）；高亮仅在本次会话保留。与主应用使用独立 userData，解析结果随包只读分发，运行时禁止外网请求，无凭据桥接。

`compile-parse.mjs` 编译真实解析脚本；`parse.generated.mjs <PDF> <结果目录>` 只使用 Windows 凭据库中的 parser-token 向 MinerU 官方服务提交指定文件。首次上传需用户明确授权该第三方与文件范围。保存批次检查点，不保存 Token 或签名 URL；不确定的上传结果不自动重发。输出采用原有 full.md、layout.json、block_list.json 和 images，不覆盖个人文库，不带入笔记或聊天。

`build.mjs [解析结果/paper]` 构建独立入口；从 desktop 执行 `electron-builder --projectDir ../output/reader-acceptance-20261031/app --config scripts/reader-acceptance/package.cjs --win portable` 生成单文件便携 EXE（config 路径建议使用绝对路径）。项目目录必须指向独立 app，且排除 node_modules，避免打入主应用依赖。先确认完整解析结果，再打包。此包是阅读器验收版，不替代全应用发布门禁。

性能通过独立进程启动、PDF 首次绘制完成、原文全部就绪分别记录；系统文件缓存可能仍热，不能称磁盘冷启动。便携 EXE 的自解压启动成本须独立报告。

`compile-parse.mjs translate` 编译独立翻译脚本；`translate.generated.mjs <验收结果目录>` 使用现有 Qwen 凭据、官方 qwen-mt-plus 和生产翻译计划，将 paper/ 中原文翻译为 full.zh-CN.md、translation.manifest.json。必须获得该论文的 Qwen 翻译授权。只读主应用设置，独立 SQLite 保存计划和缓存，HTTP 单并发限速；失败后保留进度。打包不含脚本、密钥或数据库。入口逐段验证 sourceHash 并复用原有 sourceIndex／mappingId，切换标签保留各自阅读位置和会话高亮。所有定位均瞬间完成。

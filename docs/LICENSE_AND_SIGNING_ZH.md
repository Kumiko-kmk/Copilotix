# 许可证选择与 Windows 签名配置

许可证决定他人如何使用代码；代码签名证书用于验证软件发行者和文件完整性。它们是两件不同的事。本项目目前对正式发布设置了许可、签名门禁；这是项目的发布策略，不是“Windows 应用必须先购买软件许可证”的通用规定。

## 1. 许可证如何取得

对你有权授权的原创代码，可以选择标准许可证，复制完整文本并填写年份、权利人，不需要向 GitHub 申请或购买。

| 目标 | 可考虑的授权 |
| --- | --- |
| 允许别人使用、修改、商用及闭源分发，保留版权与许可声明 | MIT |
| 需要宽松授权，同时重视明确的专利授权条款 | Apache-2.0 |
| 暂不允许第三方再利用 | 保持未授权状态，或另行制定专有授权条款 |

标准文本和使用方法：[MIT](https://choosealicense.com/licenses/mit/)、[Apache-2.0](https://choosealicense.com/licenses/apache-2.0/)。

如果选择 MIT，项目内需要做的事情：
1. 确定授权范围与版权人。仓库来自 fork，不应直接把第三方保留文件也宣称为自有 MIT 代码。
2. 为桌面自有代码添加完整许可文件，例如 `desktop/LICENSE`，填入年份及实际权利人。
3. 将 `desktop/package.json` 的 `license` 改为 `MIT`，同步 README 中的范围说明，并把适用许可与第三方声明纳入分发包。
4. 保留第三方代码、依赖及图标适用的许可/署名；根目录已有 MinerU 文本应按实际文件来源解释，不能仅通过改 package 字段重新许可。
5. 运行许可门禁及打包检查，再决定是否发布。

**当前状态（2026-09-28）：维护者已选择 MIT，根 LICENSE.md 与 package 元数据已同步，版权署名沿用 Kumiko-kmk。上述步骤已完成。** 历史 MinerU 版本不因这次清理而重新许可。

## 2. 签名证书从哪里取得

新购公开受信任代码签名证书通常使用硬件 Token、HSM 或云签名保管私钥。不要按“购买后导出 PFX 上传 GitHub”的旧教程预设采购方式。参见 [DigiCert 私钥存储要求](https://knowledge.digicert.com/general-information/new-private-key-storage-requirement-for-standard-code-signing-certificates-november-2022)。

可选路线：

- **计划开源且符合条件**：评估 [SignPath Foundation](https://signpath.org/terms)。需要满足开源许可、维护、已有发行版本、项目声誉和审核等条件；申请不保证获批，签名发行者是基金会。MIT 满足许可类型要求，但其他申请条件仍需逐项满足。
- **个人开发者或企业购买服务**：向提供对应身份类型的 CA 申请代码签名产品，例如 [SSL.com 的 IV/OV 与 eSigner](https://www.ssl.com/products/software-integrity/code-signing/)。先确认所在地可受理、个人/企业身份要求、证书与签名服务的总费用、GitHub Actions 集成方式，再下单。一般流程为注册账户、提交身份材料、审核、开通云签名或硬件 Token、配置签名工具。
- **符合地区条件**：可使用 Microsoft [Artifact Signing](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart)。截至本次核验，Public Trust 的个人开发者仅支持美国、加拿大；组织另有支持地区清单。不要用 Private Trust 替代面向普通用户的 Public Trust。

签名不保证新软件立即免除 SmartScreen 提示；参见 [Microsoft 签名选项说明](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)。

## 3. 怎样接入这个项目

项目使用 electron-builder 26，配置应参照 [v26 文档](https://www.electron.build/v26/docs/features/code-signing/code-signing-win/)。以下是不同方案的接入范围，不表示已经配置完成。

### A. 现有 PFX 文件路径

当前代码只直接接好了文件式证书的生产预检查。仅在你确实拥有适用的文件式凭据时使用此路径；自签名 PFX 不会自动获得公众信任。

GitHub 仓库 → Settings → Secrets and variables → Actions → New repository secret：

| Secret | 值 |
| --- | --- |
| `WIN_CSC_LINK` | PFX/P12 的 Base64 内容；GitHub 托管 runner 不能读取你电脑上的 F: 路径 |
| `WIN_CSC_KEY_PASSWORD` | 该文件的密码 |

需要转成 Base64 时，可在本地复制到剪贴板，不打印或提交内容：

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes('C:\\private\\codesign.pfx')) | Set-Clipboard
```

上传 Secret 后清空剪贴板。密钥、密码、Token 只放受控的 Secret 存储，不提交到仓库。

确定授权后，tag 与桌面包版本严格一致，例如 `desktop-v0.1.0`。现有工作流会读取 Secret、启用 production、验证签名、上传 draft 并校验完整资产后公开。

### B. USB Token / Windows 证书存储

1. 在本地或自托管 Windows runner 上安装厂商驱动和签名工具，确认 Token 可用。
2. 用 `Get-ChildItem Cert:\\CurrentUser\\My -CodeSigningCert` 查询代码签名证书，按厂商流程确认可调用私钥。
3. 在 `build.win.signtoolOptions` 中按 v26 配置 `certificateSha1` 或 `certificateSubjectName`，以及时间戳设置。
4. 修改本项目的 `assertReleaseSigningConfiguration`，使所选且完整配置的证书存储方案可通过；当前只检查 WIN_CSC_LINK 的门禁会拒绝它。
5. 将生产签名 job 接到实际可访问 Token 的 runner。GitHub 托管 runner 无法直接使用插在你电脑上的 USB Token。

证书 SHA-1 指纹用于选择证书，不等于建议使用 SHA-1 文件签名。

### C. Azure 或 CA 云签名

Azure 的流程：创建 Artifact Signing account → 完成 Public Trust 身份验证 → 建立 certificate profile → 给构建身份授予 Certificate Profile Signer 角色。v26 使用 `build.win.azureSignOptions`，所需配置为 `publisherName`、`endpoint`、`certificateProfileName`、`codeSigningAccountName`。发行者名必须与证书 CN 一致。

若采用文档中的 service principal secret 方式，把 `AZURE_TENANT_ID`、`AZURE_CLIENT_ID`、`AZURE_CLIENT_SECRET` 放入 Actions Secrets 并映射到签名步骤；也可根据服务支持设计联合身份认证。

CA 云签名则按厂商 CLI/API 或 Windows KSP/CKA 集成，可使用 v26 的自定义签名钩子。

**这两类云方案都尚未接入当前工作流。** 需要同步修改签名预检查、构建配置和 CI 凭据映射，保留“签名有效才允许发布”的验证。不能仅添加几个 Azure 或 CA Secret 就认为当前项目已可签名。

## 4. 验收顺序

无论选择哪一种方案，保持顺序：

`构建 → 写入 fuses → 签名与时间戳 → 验证 EXE → 打 ZIP → 再验证 ZIP 内 EXE → 生成最终哈希 → 发布`

不要在签名后再替换图标、修改 fuses 或改写 EXE 资源，否则需要重新签名并重新生成 ZIP 和校验文件。本次图标更新已重新打包本地开发产物，但没有购买、申请或配置真实签名服务。
## 5. 已生成的本机测试证书

2026-09-28 已生成 RSA-3072 / SHA-256、有效期一年的代码签名测试证书。
主题为 CN=Copilotix Development (Self-Signed Test Only)。
私钥不可导出，保存在当前 Windows 用户的 Cert:\CurrentUser\My；未导入 Trusted Root 或 Trusted Publishers。
公开证书、指纹和签名样本位于本机 %LOCALAPPDATA%\Copilotix\Signing，不提交仓库。

可通过以下命令生成新的测试证书（每次运行创建新密钥，不会覆盖旧证书）：

~~~powershell
powershell -NoProfile -File desktop/scripts/create-test-certificate.ps1
~~~

签名样本包含生成证书，但 Windows 验证提示证书链根不受信任；这是自签证书的预期限制，不能声称签名受公众信任。
该证书不用于正式 Release，亦未改写现有 EXE。不要为消除提示而要求普通用户安装测试根证书。
正式签名需要确认申请人类型、国家或地区、真实发行者姓名／公司名称，再完成 CA 身份审核。
本脚本不导出 PFX，因此不能把生成的 CER 当作 WIN_CSC_LINK；CER 不含私钥。

## 6. 个人申请方案（2026-09-28 核验）

维护者希望以个人身份申请，优先台湾、其次中国大陆，展示 GitHub 账户名 Kumiko-kmk。申请地区必须对应实际可核验的身份及地址；不能为了通过审核随意切换。

- **SSL.com IV + 云签名**：官方明确证书展示经核验的个人姓名，并要求政府签发证件。GitHub 昵称不能直接替代真实姓名。官方页面未提供足以确认台湾和中国大陆个人申请均获受理的地区清单，付款前须向厂商确认身份文件、地区和云服务适用性。证书之外可能另收云签名订阅费或硬件费用。参考 [IV 产品说明](https://www.ssl.com/products/software-integrity/code-signing/iv/)。
- **SignPath Foundation**：面向符合条件的开源项目，发行者显示 SignPath Foundation，不显示个人 GitHub 昵称；需要已发布项目、可核验的项目声誉和其他审核要求，MIT 并不保证批准。参考 [申请](https://signpath.org/apply.html) 与 [条件](https://signpath.org/terms.html)。

目前未提交申请、购买服务或上传身份材料。待维护者选定路线后，再按真实审核结果接入生产签名；本地测试证书不代表申请已获批。

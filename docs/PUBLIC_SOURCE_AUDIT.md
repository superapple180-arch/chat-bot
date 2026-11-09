# 公开源码授权与凭证审查

本次目标是公开原创源码，不包含依赖目录、外部运行组件或安装包。原创源码维持 MIT，第三方组件、素材和在线服务不因此获得 MIT 授权。完整产品依赖的非商业限制不能改写原创源码的 MIT 权利。

## 依赖许可

`PUBLIC_SOURCE_AUDIT.json` 按根目录和桌面应用的锁文件登记全部 npm 包，按 `requirements-voice.txt` 登记全部固定版本 Python 包，保存实际发行物的许可证、NOTICE 文件摘要。缺失或版本不符的证据不会标为通过。跨平台可选包从 npm 官方仓库下载固定版本，并验证锁文件 SHA512；下载及证据只留在项目 `.cache/license-evidence`。

有些 npm 发行物没有随附许可证文件。此时另外核对 npm 记录的 `gitHead`，或将发行版本标签解析为提交并回查该提交的 package.json 版本，再收集该提交中的许可文本。报告将这类证据标为 `upstream-license-inspected`，与包内自带文本的 `distribution-inspected` 分开，保存来源地址、提交、内容摘要和对应包的完整性标识。上游默认分支上的最新许可不能直接充当旧版本的授权证明；构建脚本的 Apache 许可也不能替代其产出的 LGPL 二进制许可。

对于未随附许可文本的 MIT 或 WTFPL 包，源码审查核对发布者在发行包内的许可声明、同一版本的 npm 官方记录、锁文件 SHA512 和对应 SPDX 正文。只有这些证据一致，才标为 `publisher-declared-source-only`。该状态用于只引用依赖的源码快照。安装包门禁仍要求核对实际分发的许可、版权和 NOTICE 材料。 [npm 对许可声明的定义](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#license) [SPDX 许可目录](https://spdx.org/licenses/)

MIT、ISC、BSD、Apache 等依赖需要保留各自声明；多重许可不能随意省略 AND 分支。`parse-cache-control` 缺少清晰的 manifest 许可字段，但实际 LICENSE 为 BSD-3-Clause；`duck` 的 BSD 字段依据实际 LICENSE 识别为 BSD-2-Clause。JSZip 可以选择其 MIT 分支。Mozilla/MPL 和 LGPL 组件保留各自义务，不能统一标记为 MIT。

`ffmpeg-static` 的实际包声明 GPL-3.0-or-later，应用直接导入其 JavaScript 包，再运行 FFmpeg。原创代码的 MIT 条款与 GPLv3 兼容。此次源码快照包含原创实现和依赖引用，依赖包与 FFmpeg 二进制排除在外。分发包含该 GPL 依赖的组合产物时，须按 GPL 处理覆盖的组合作品、许可声明与对应源码。安装包门禁会继续阻止分发，直到这些义务完成核验。 [GNU 兼容许可说明](https://www.gnu.org/licenses/license-list.html#Expat) [GPLv3 条文](https://www.gnu.org/licenses/gpl-3.0.html)

Sharp 本体为 Apache-2.0，但实际预编译组件还涉及 LGPL-3.0-or-later。edge-tts 主体为 LGPLv3，其特定文件另为 MIT；其他 Python 包包括 Apache、BSD、MIT、PSF 和 certifi 的 MPL。依赖自己的许可文件与源码义务继续适用，本审查不代替安装包发行审查。

NapCatQQ v4.18.41 使用包含非商业限制的 [Limited Redistribution License](https://github.com/NapNeko/NapCatQQ/blob/v4.18.41/LICENSE)，不属于可统一重标为 MIT 的依赖。NapCat、QQ、Antigravity、用户登录状态及第三方运行组件均不纳入源码导出。现有外部 API 适配不能作为复制第三方源码的授权证明。

## 静态资源

| 资源 | 决定与证据 |
| --- | --- |
| `desktop-app/icon.png` | 纳入：与项目原创 SVG 生成器重新生成的 PNG 逐字节一致，适用项目 MIT |
| `test/fixtures/attachment.pdf` 与 `.docx` | 重新生成：仅合成文本，PDF 仅引用标准字体名称、不嵌入字体文件 |
| 本地 12 张 ChineseBQB 表情图 | 排除：来源索引不能证明原权利人逐张授予开源分发权；不删除本机原素材 |
| 图片库、音频库 | 公开快照的两个索引固定为空，不附带私人或第三方媒体 |
| 字体 | 当前 CSS 仅使用系统字体栈，无捆绑字体或远程字体导入 |
| 新增图片、音频、字体、视频及文档 | 无匹配的授权清单和内容摘要则阻止上传 |

## 凭证配置与迁移

使用 Node.js 24。`ONEBOT_ACCESS_TOKEN` 优先读取进程环境，其次读取 `config.local.json` 同目录的 `.env`，不回退读取 JSON 中的令牌。命令行使用项目配置目录，桌面应用使用其用户数据目录；本地 `.env` 中的其他变量不会被自动注入外部进程。

新部署复制 `.env.example` 为 `.env`，在本机填入令牌，再复制 JSON 示例并填写账号及普通设置。示例中的令牌为空，真实发送默认关闭。发布所需 `GITGUARDIAN_API_KEY`、`GH_TOKEN` 设置在发布进程环境或 GitHub Secrets，不需要发送到聊天。

旧部署先停止同账号桥接，再执行：

```sh
npm run build
node scripts/migrate-secrets.mjs config.local.json
```

迁移先写入并回读 `.env`，确认与旧令牌一致后清空 JSON 字段，已知配置备份同步脱敏。若环境已配置不同令牌或写入失败，保留原 JSON 并报错；不自动轮换 QQ 认证令牌。桌面应用启动执行相同迁移。网页设置保存令牌时仅更新 `.env`，配置及其备份不保存令牌；进程环境管理的令牌只能在进程环境中修改。

NapCat 原生认证文件是外部组件必需的本地数据，始终排除上传；管理密码仅保存加盐哈希。`.env`、密钥文件、聊天数据、日志、运行目录、依赖和私人历史均禁止进入公开快照。若发现真实凭证泄露，须先撤销或轮换，不能只删除文件或添加忽略规则。

## 执行与门禁

```sh
node scripts/audit-source-licenses.mjs
node scripts/export-release.mjs
# 使用导出命令输出的实际路径
node scripts/source-publication-gate.mjs .cache/PUBLIC_EXPORT_DIRECTORY
```

协议检查存在未决问题时明确停止上传。授权清单绑定锁文件、相关源码和资源摘要；内容变化后重新审查。公开候选库的 pre-push 按顺序检查协议与静态资源、本地隐私和完整历史、GitGuardian。GitGuardian 密钥缺失、扫描错误、命中或覆盖不完整均不放行。原始报告不写入公共日志。本地检查通过不能声称 GitGuardian 已通过，也不能声称已在真实 QQ 送达。

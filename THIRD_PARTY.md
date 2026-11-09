# 第三方组件

本项目原创源码采用 MIT 许可证。当前完整产品依赖 NapCat 等独立组件，首版限定免费非商业使用；原创代码的 MIT 许可不替代第三方许可与服务条款。

| 组件 | 用途与许可 |
| --- | --- |
| Electron、electron-builder、electron-updater | 桌面与安装更新 按上游 MIT 及随附第三方许可 |
| Node.js | 独立后端运行时 原许可随运行时提供 |
| React、Vite、Fastify、Motion、Lucide | 现有管理台与界面 保留依赖随附许可 |
| Sharp、Mammoth、PDF.js | 附件处理 分别为 Apache-2.0、BSD-2-Clause、Apache-2.0 |
| ffmpeg-static / FFmpeg | 独立进程转换媒体 GPL-3.0-or-later 保留具体发行版的许可、版本、构建及对应源码获取说明 |
| NapCatQQ | 官方来源独立下载 使用与分发受其 Limited Redistribution License 限制 禁止商业用途 |
| Antigravity CLI | 官方来源独立下载 用户自行登录并遵守服务条款 不随包携带登录状态 |
| uv / Astral Python builds | 官方上游下载 uv 为 MIT/Apache-2.0 Python及内含依赖分别保留许可 |
| edge-tts | 独立 Python 环境 LGPLv3 及部分 MIT 文件 不附带私人音频 |
| Tailscale | 可选独立安装 用户自行登录 不合并发行 |

所有 npm 生产依赖的 LICENSE、NOTICE 等随原始依赖保留。FFmpeg 的项目来源为 https://github.com/eugeneware/ffmpeg-static ，二进制发行与对应构建记录位于该项目指向的上游发布页；正式分发前必须核对具体二进制版本与对应源码材料，不能仅用项目首页替代 GPL 对应源码义务。

按固定版本的依赖与静态资源审查见 `docs/PUBLIC_SOURCE_AUDIT.json` 和 `docs/PUBLIC_SOURCE_AUDIT.md`。Sharp 的预编译组件包含 LGPL 义务。原创 MIT 源码与 GPLv3 兼容，公开快照通过依赖声明引用 `ffmpeg-static`。分发含该依赖的组合产物仍须核对 GPL 条款与对应源码，安装包门禁独立审核这些条件。 [GNU 兼容许可说明](https://www.gnu.org/licenses/license-list.html#Expat)

不附带现有本机的聊天、联系人、账号、缓存、录音或历史表情包素材。用户自行添加或下载的媒体需具备相应使用权。

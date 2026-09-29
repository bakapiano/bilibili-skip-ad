# BiliSkip — B站植入广告跳过插件

Chrome Manifest V3 扩展，使用 B站字幕和个人 DeepSeek API Key 识别赞助口播等商业植入，
在原生进度条标记广告区间，并按设置自动跳过。识别结果保存在本地 IndexedDB，也可以通过共享缓存复用。

当前版本：`0.1.4`。

- [官网与使用说明](https://biliskipad.bakapiano.com/)
- [下载 0.1.4 扩展 ZIP](https://biliskipad.bakapiano.com/downloads/biliskip-0.1.4.zip) · [SHA-256 校验值](https://biliskipad.bakapiano.com/downloads/biliskip-0.1.4.zip.sha256)
- [隐私与数据说明](https://biliskipad.bakapiano.com/privacy.html)
- [问题反馈](https://github.com/bakapiano/bilibili-skip-ad/issues)

## 功能

- 从当前 B站视频读取带时间戳的字幕，按中文 → 英文 → 其他语言回退，通过 DeepSeek Flash 识别商业植入；面板显示实际字幕语言。
- 原生进度条显示金色广告区间，开启自动跳过后，播放或主动定位到广告时跳至末尾。
- 提供边界试听、手动跳过和撤销功能。
- 操作面板位于 Chrome 工具栏图标弹窗，视频页保留原生进度条标记；关闭弹窗后继续处理分析与播放。
- 支持侧边推荐视频及分 P 切换，按新视频身份更新标记。
- 按视频、字幕指纹、模型和提示词版本保存本地缓存。
- 默认连接 `biliskipad.bakapiano.com` 的线上共享缓存，新分析结果保存本地后自动上传；设置页可关闭自动上传，弹窗保留手动上传入口。

## 安装与使用

1. 下载上面的 ZIP 并解压到固定目录；也可以克隆本仓库。
2. 在 Chrome 打开 `chrome://extensions`，开启开发者模式。
3. 点击「加载已解压的扩展程序」：ZIP 用户选择包含 `manifest.json` 的解压目录，源码用户选择仓库中的 `extension/`。
4. 需要自行识别时，在扩展设置页配置个人 DeepSeek Key，并确认字幕发送授权；已有共享结果可先直接读取。
5. 打开 B站视频，点击 Chrome 工具栏的 BiliSkip 图标。已有缓存会直接显示；需要新识别时点击「分析当前视频」，试听广告边界后按需开启自动跳过。

运行环境为 Chrome 120+。通过已解压目录加载扩展时，运行代码可直接使用；Node.js 用于开发、测试、打包和自部署后端。

更新时保留原扩展目录，在扩展管理页重新加载，再刷新 B站视频页。关闭弹窗后，已开始的分析、上传和自动跳过继续运行。

## 默认设置

| 设置         | 首次使用默认值 | 作用                                              |
| ------------ | -------------- | ------------------------------------------------- |
| 自动分析     | 关闭           | 开启后，对前台视频中尚无缓存的内容自动发起识别    |
| 自动跳过     | 关闭           | 开启后跳过符合阈值的广告，默认自评分阈值为 `0.90` |
| 查询共享缓存 | 开启           | 本地未命中时查询内置线上服务                      |
| 允许上传     | 开启           | 自动上传和手动上传的总开关                        |
| 自动上传     | 开启           | 新分析结果保存本地后自动提交一次                  |

关闭「分析完成后自动上传到共享缓存」后，仍可在弹窗手动上传。原有的上传总开关关闭设置会继续生效。

## 缓存和识别流程

1. 打开或切换视频时，重新核对 BV、分 P、CID 和字幕；字幕按中文、英文、其他语言的顺序回退。
2. 以视频标识、字幕指纹、模型和提示词版本查询本地缓存，未命中时再查询共享缓存。弹窗中的「读取线上缓存」可以主动刷新线上结果。
3. 新分析使用个人 Key 直接请求 `deepseek-flash`。模型返回广告起止句编号，插件结合原始字幕时间轴校验并生成跳过区间。
4. 有效结果先保存本地，再按当前设置自动上传。**0 段广告同样是有效缓存结果**。上传失败时保留本地标记，并提示手动重试。

新分析由 DeepSeek 按个人 API 账户用量计费；缓存命中时复用已有结果。「重新分析（再次计费）」会发起新的模型请求。
字幕覆盖率、字幕质量和模型判断会影响准确度；自评分适合配合试听与撤销核对。

## 项目结构

```text
extension/           Chrome 扩展运行代码、页面和样式
  lib/               字幕、模型、缓存、校验及消息模块
tests/               扩展、共享服务、官网构建与工具链回归测试
scripts/             项目检查和打包工具
server/              Node HTTP + SQLite 共享缓存后端
  site/              静态官网、隐私说明和公开截图
store/               商店文案、权限披露与审核材料
.tmp/                本机临时测试脚本和输出（Git 忽略）
dist/                打包产物（Git 忽略）
AGENTS.md            项目协作与代码格式规范
eslint.config.js     ESLint 环境和质量规则
.prettierrc.json     统一格式配置
```

## 开发

使用 Node.js 22.13+ 的 22.x 或 Node.js 24+。

```powershell
npm ci --ignore-scripts
npm run lint
npm run lint:fix
npm run format
npm run format:check
npm test
npm run verify
npm run pack
npm run pack:store
```

- `lint` 检查全部项目 JavaScript，包括扩展、正式测试、开发工具及配置文件。
- `lint:fix` 自动修复可处理的 ESLint 问题，`format` 统一 JS、JSON、HTML、CSS 和 Markdown 排版。
- `verify` 顺序执行 ESLint、格式检查、扩展资源/CSP/凭据检查和正式回归测试。
- `pack` / `pack:store` 先运行 `verify`，再把 `extension/` 打包到 `dist/`，生成 ZIP 与 SHA-256 文件。后端和官网独立部署。
- 依赖、临时脚本、本地数据和生成产物按配置隔离于正式检查范围。

临时接口探测和人工浏览器验证脚本统一放入 `.tmp/`；长期回归用例保留在 `tests/`。
完整约定见 [AGENTS.md](AGENTS.md)。

## 数据与隐私

个人 Key 保存在本机扩展存储中，模型请求将当前视频标题和字幕发送给 DeepSeek。
线上查询默认开启，发送视频标识、字幕指纹和模型版本；新分析结果默认自动上传视频信息、标记与有限证据，设置中可单独关闭自动上传。关闭「允许上传」总开关会同时关闭自动与手动上传。共享令牌按域名绑定，候选上传采用字段白名单。

每段上传最多包含 10 条证据句，每条最多 500 字符。DeepSeek Key、B站会话分别用于各自的认证链路。
共享服务记录来源 IP 与提交次数，计数保留最近 7 个 UTC 日期。完整说明见 [隐私页](https://biliskipad.bakapiano.com/privacy.html)。

## 自部署共享服务与官网

共享后端使用 Node 原生 HTTP 与 SQLite，运行时依赖 Node 标准库。执行：

```sh
npm run server
```

默认监听 `127.0.0.1:8787`，数据保存在 `data/shared-cache.sqlite`。提供 `GET /healthz`、`GET /v1/segments` 和 `POST /v1/candidates`。
同一来源 IP 两次提交放行至少间隔 1000ms；IPv6 按 `/64` 网段统计。

当前共享规则是结构校验合格的首条提交直接发布，同键相同内容幂等返回，差异内容返回 `409`；维护者可以撤销记录。
这套风控用于控制提交频率，标记准确性依赖识别结果与后续反馈。

官网位于 `server/site/`，使用静态 HTML/CSS，由 Nginx 托管；缓存 API 继续转发到 Node。
公开站点包含介绍页、隐私说明、真实视频截图，以及当前扩展 ZIP 和校验值。

```powershell
# 核验、打包扩展，并构建、部署官网和共享服务
npm run deploy:server

# 仅构建官网；传入已生成的扩展 ZIP
npm run build:site -- dist/<扩展上传包>.zip
```

`deploy:server` 的 SSH 目标与目录使用本项目的部署配置。部署到自己的机器前，按 [部署说明](server/DEPLOYMENT.md) 调整配置。
部署脚本会逐文件核对扩展 ZIP、校验部署包哈希，保留独立版本和失败回滚路径。
服务配置、IP 限流、管理命令见 [后端说明](server/README.md)。

## 验证状态

截至 2026-09-29，`npm run verify` 通过 **132 项测试（含子用例）**，覆盖字幕回退、缓存、自动上传、弹窗消息、播放器行为、服务端限流与官网构建。
真实 Chrome、线上接口与模拟测试的验收范围分别记录在以下文档中。

## 文档

- [扩展安装、架构和开发说明](EXTENSION.md)
- [0.1.4 工具栏弹窗与自动上传回归](POPUP_REGRESSION.md)
- [真实 Chrome E2E 验收记录](CHROME_E2E_REPORT.md)
- [验收状态与历史排查](E2E_STATUS.md)
- [共享缓存 API 协议](SHARED_CACHE_API.md)
- [后端与官网部署说明](server/DEPLOYMENT.md)
- [线上缓存验收](server/E2E_REPORT.md)
- [官网与下载验收](server/SITE_E2E_REPORT.md)
- [Chrome 商店打包与材料](CHROME_WEB_STORE.md)
- [原生 fetch 回归记录](BROWSER_FETCH_REGRESSION.md)
- [播放器与时间轴回归记录](BROWSER_PLAYER_REGRESSION.md)

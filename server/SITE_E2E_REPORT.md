# 官网部署验收

日期：2026-09-30。线上地址：`https://biliskipad.bakapiano.com/`。
当前部署版本：`20260930-163758-afa370c64ac5`；首次介绍页版本为 `20260929-191700-9c1bf9a7eb24`。

## 页面与安装包

- 静态页面源码：`server/site/`；构建入口：`scripts/build-site.js`。
- Nginx 静态根目录：`/srv/biliskipad/current/site/`。
- 官网和隐私页按 manifest 注入 `0.1.4`；CSS 与截图使用内容哈希参数。
- 当前官网采用白底工具文档排版，标题为「B站植入广告跳过插件」，截图为实际播放器原图裁切。
- 安装区将油猴脚本列为第一项并默认选中，可切换到 Chrome 扩展，分别显示对应安装入口和步骤。
- Chrome 扩展优先通过应用商店安装，ZIP / 源码步骤折叠保留。
- 当前扩展 ZIP：`dist/biliskip-0.1.4-20260929-222944.zip`。
- 公网 ZIP：`/downloads/biliskip-0.1.4.zip`，48,812 字节、25 个文件，包含 MIT `LICENSE`。
- 固定下载地址：`/downloads/biliskip.zip`，与版本包字节相同；校验值为 `/downloads/biliskip.zip.sha256`。固定地址使用 `Cache-Control: no-cache`，按当前版本重新验证。
- SHA-256：`3fae9d13d7d7c717156a26085bca5d006038c611bf67edad29dc132186353fbf`。

## 首次介绍页验证结果（历史）

| 项目                              | 结果                                                                 |
| --------------------------------- | -------------------------------------------------------------------- |
| 全项目验证                        | 132 项测试、ESLint、Prettier、扩展静态检查通过                       |
| 部署包                            | 明确文件白名单；扩展 ZIP 逐文件与当前源码比对；远端 SHA-256 核对成功 |
| 首页、隐私页、CSS、图标、两张截图 | 实际 HTTPS `200`，内容类型正确                                       |
| 下载完整性                        | 公网下载与本地 ZIP 字节级一致，公开 SHA-256 一致                     |
| 既有服务                          | 容器 `healthy`，`/healthz` 返回 `ok: true`                           |
| 既有数据                          | 原视频 `BV1pFUDBKE8X` 共享记录仍为 `published`，转转标记可读取       |
| 非公开路径                        | `/.env` 返回 `404`                                                   |
| 桌面布局                          | 实际 Chrome 检查，图片全部载入，页面保持预期布局                     |
| 窄屏布局                          | 实际 Chrome CSS 内容宽度 341px，页面横向滚动宽度同为 341px           |
| 导航与截图                        | 安装锚点生效、4 个安装步骤可见、广告前的截图可展开                   |
| 浏览器下载                        | 首次上线时点击下载触发实际 Chrome download 事件；当前公网包复验一致  |
| 隐私页                            | 标题、默认自动上传说明可见，窄屏布局正常                             |

使用 computer-use 验收真实线上页面；完成后恢复原浏览器视口。
前次截图：`dist/site-preview/desktop-simple.jpg`、`dist/site-preview/mobile-simple.jpg`。初版截图保留在同目录的 `desktop.jpg`、`mobile.jpg`。
只读公网验证脚本：`.tmp/verify-site-live.mjs`。

网站原有 API 协议与 IP 提交限流保持原实现。本轮网站验收为只读访问和扩展文件下载。

## 固定下载入口补充验收（历史）

- 133 项自动化测试通过，新增固定/版本化下载文件与校验值一致性回归。
- 从公网固定地址实际下载，ZIP 根目录包含 `manifest.json`，版本为 0.1.4，共 22 个文件，SHA-256 与已验证的商店包一致。
- 官网明确标注解压后通过 Chrome 开发者模式加载文件夹，安装步骤位于下载入口下方。
- 固定地址返回 `application/zip`、`200` 与 `Cache-Control: no-cache`，服务容器为 `healthy`。

## Chrome / 油猴安装方式切换验收（历史）

- 完整验证通过 153 项测试、ESLint、Prettier、扩展资源与凭据检查。新增原生单选状态／CSS 面板对应关系、安装链接及隐私说明回归。
- `fieldset`、单选控件和 CSS 实现安装方式切换，当前默认选择第一项油猴脚本。页面继续使用 `script-src 'none'` CSP。
- 本地预览与公网真实 Chrome 均确认：选择油猴后显示四个油猴安装步骤和 Greasy Fork 链接；选择 Chrome 后显示 ZIP、校验值及开发者模式加载步骤。
- 键盘左右方向键可切换选项，选中状态有边框和背景反馈，键盘焦点有可见轮廓。
- 窄屏实测页面 `clientWidth=341`、`scrollWidth=341`，两种安装步骤正常换行，完成后已恢复浏览器默认视口。
- 浏览器核对用户提供的 Greasy Fork 安装完成页，再进入「信息」页，确认脚本 ID `597956`、版本 `0.1.4.2`、MIT 和「安装此脚本」入口；官网与 README 使用正式信息页链接。
- 隐私页补充油猴 GM 存储、页面内存、默认运行环境及两个版本的控制入口。
- 公网首页、隐私页、CSS、两个 ZIP 下载及 SHA-256 均返回成功；下载文件与本地已验证的 48,812 字节 ZIP 一致。
- `/healthz` 返回 `{"ok":true,"schema_version":1}`，部署后容器为 `healthy`。
- 只读公网检查脚本：`.tmp/verify-install-site-live.mjs`；本地静态预览脚本：`.tmp/site-install-preview.mjs`。
- 随后按用户要求调整为油猴脚本第一项、默认选中。153 项测试再次通过，公网 HTML 已核对选项顺序和默认值，README 安装章节同步采用油猴优先。
- 两个选项加入内嵌 SVG 图标，桌面 32px、窄屏 24px。真实 Chrome 已确认图标和标题对齐，点击任一图标可切换对应安装步骤；窄屏页面宽度与横向滚动宽度均为 341px。图标使用装饰性无障碍标记，单选控件名称保持原有文字。

## Chrome 商店上架入口验收（2026-09-30）

- 用户提供正式上架条目，公开安装链接使用 `https://chromewebstore.google.com/detail/oebfplajlnbkabikbcadhhjhjdijahjk`，移除账号选择参数。
- 完整 `verify` 通过 154 项测试，新增 README、扩展文档、官网商店链接一致性与折叠 ZIP 回归。
- 真实 Chrome 默认仍选中第一项油猴脚本；点击 Chrome 标签显示商店按钮、三步安装说明和默认折叠的 ZIP / 源码入口。
- 展开 ZIP / 源码入口后下载地址、SHA-256 与开发者模式说明可见。
- 窄屏实测 `clientWidth=341`、`scrollWidth=341`，Chrome 商店按钮和步骤正常换行，完成后恢复原视口。
- 公网首页、隐私页、CSS、固定和版本 ZIP 及其 SHA-256 均通过；ZIP 保持 48,812 字节及原哈希，`/healthz` 返回 `ok: true`，容器为 `healthy`。
- 只读验收沿用 `.tmp/verify-install-site-live.mjs`，新版公开页面截图同时用于介绍视频，保存在 `.tmp/intro-video/frames-store/`。

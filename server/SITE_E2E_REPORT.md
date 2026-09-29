# 官网部署验收

日期：2026-09-29。线上地址：`https://biliskipad.bakapiano.com/`。
当前部署版本：`20260929-192442-40bfbf2cf9a6`；首次介绍页版本为 `20260929-191700-9c1bf9a7eb24`。

## 页面与安装包

- 静态页面源码：`server/site/`；构建入口：`scripts/build-site.js`。
- Nginx 静态根目录：`/srv/biliskipad/current/site/`。
- 官网和隐私页按 manifest 注入 `0.1.4`；CSS 与截图使用内容哈希参数。
- 当前官网采用白底工具文档排版，标题为「B站植入广告跳过插件」，截图为实际播放器原图裁切。
- 原始扩展 ZIP：`dist/biliskip-0.1.4-chrome-web-store-20260929-190955.zip`。
- 公网 ZIP：`/downloads/biliskip-0.1.4.zip`，47,143 字节、22 个扩展文件。
- SHA-256：`c42f72ac003df8af0657f6c02be2d34cf4806d3619e4df643f3b585c451ab55d`。

## 验证结果

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
当前截图：`dist/site-preview/desktop-simple.jpg`、`dist/site-preview/mobile-simple.jpg`。初版截图保留在同目录的 `desktop.jpg`、`mobile.jpg`。
只读公网验证脚本：`.tmp/verify-site-live.mjs`。

网站原有 API 协议与 IP 提交限流保持原实现。本轮网站验收为只读访问和扩展文件下载。

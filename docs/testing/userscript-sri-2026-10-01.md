# 油猴0.1.8.3：WASM/VAD资源拆分与SRI

日期：2026-10-01。Chrome版继续为0.1.8，保持原有独立WASM文件打包。

## 交付变化

- 油猴版本从0.1.8.2升级到0.1.8.3。
- `.user.js` 从17,359,186字节降到697,083字节，约减少96%。
- 业务逻辑、模型请求、校验、播放器和Worker JS保留在脚本中。
- WASM与VAD/词表声明为两个`@resource`，采用固定版本路径、哈希文件名和`#sha256=<hex>`。
- 新增`GM.getResourceUrl`授权。脚本只读取管理器返回的本地data/blob资源，按大小和SHA-256再次校验，成功后才交给ASR Worker。
- 资源下载发生于油猴安装/更新阶段，两个文件合计12,498,917字节；ASR开关保持默认关闭，239MB主模型仍按需下载。
- 主模型缓存、ASR字幕版本、提示词版本及共享协议保持原值。

## 固定资源

本站目录：`https://biliskipad.bakapiano.com/asr/sherpa-onnx-1.12.20/`。

| 资源      |   字节数 | SHA-256                                                            |
| --------- | -------: | ------------------------------------------------------------------ |
| WASM      | 11539169 | `2fc8dc389b23ad07f0d526b2e7c7c828543956d053db858d73cff192be7589e3` |
| VAD与词表 |   959748 | `aee057370c3af9b75689b0f1194428185d0bb0a63314711a73c7bb5f80aef2de` |

文件名分别为上述哈希加`.wasm`、`.bin`，内容与Chrome包中的二进制逐字节相同。
同目录同时提供来源清单和全部第三方许可。

## 校验与浏览器范围

- 最终`npm run verify`通过200项测试，失败0项；ESLint、Prettier、资源和凭据扫描通过。
- 构建时核对实际资源大小与哈希，检查产物小于2MiB。
- 固定测试覆盖data/blob读取、原生fetch接收者、资源缺失、HTTP URL拒绝、错误长度、错误哈希和SRI声明。
- Playwright中的真实Chrome从公网下载这两个文件，使用浏览器原生`fetch.integrity`验证SRI，并再次计算SHA-256。
- 正确SRI通过；相同资源使用错误SRI时请求拒绝。
- GMapi使用显式测试适配器，将经SRI验证的资源作为本地blob返回；239MB主模型传输使用相同固定字节的夹具。
- 当前验证覆盖真实浏览器SRI、完整资源字节和业务链路；Tampermonkey自身安装界面与Greasy Fork审核分别验收。
- 真实音轨 `BV1pFUDBKE8X`，518.455秒：2路VAD＋ASR 58.21秒，识别转转166.988–202.480秒，评分0.98。
- 实际DeepSeek请求、进度条标记和暂停时主动定位跳过通过；页面错误0条。

原始文件：`.tmp/userscript-sri/e2e.json`、`.tmp/userscript-sri-e2e.log`。
截图：`.tmp/userscript-sri/settings.png`、`.tmp/userscript-sri/completed.png`。

## 部署

部署脚本：`server/deploy-asr-resources.ps1` → `server/deploy/asr-resources.sh`。
2026-10-01 23:42部署，Nginx备份为
`/srv/biliskipad/backups/asr-resources-20261001-234255/nginx.conf`。
本次只增加持久化资源目录与静态路由，API容器、数据库、首页及公开扩展ZIP保持原状。
服务端完整文件哈希校验和API健康检查通过；日志 `.tmp/userscript-sri-deploy.log`。

## 规则依据

- Greasy Fork外部代码规则允许带Tampermonkey格式SRI的`@require`或`@resource`。
- Tampermonkey的`@resource`用于预加载资源，`GM.getResourceUrl`返回本地资源URL。
- WASM和二进制模型数据使用`@resource`声明；本次保留可读业务JS及全部许可。

规则来源：
https://greasyfork.org/zh-CN/help/external-scripts
https://www.tampermonkey.net/documentation.php?locale=en&q=sri
https://www.tampermonkey.net/documentation.php?locale=en#api:GM_getResourceURL

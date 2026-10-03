# 线上部署记录与操作说明

## 当前官网下载版本：0.1.9（2026-10-03）

当前release：`20261003-215743-016fbdab9cc5`。使用`server/deploy.ps1`发布经验证的扩展ZIP及官网，
固定下载`/downloads/biliskip.zip`、版本下载`/downloads/biliskip-0.1.9.zip`和各自SHA-256文件同步更新。
首页及隐私页版本说明均使用0.1.9。旧`/downloads/biliskip-0.1.6.zip`及校验文件保留。

- 本地包：`dist/biliskip-0.1.9-chrome-web-store-20261003-215705.zip`，51个扩展文件，3,932,596字节。
- SHA-256：`0aa49c3301162f2aedfeab9ff3fdbb425a7aaab0a184df0c070ce82976aec20f`。
- 部署前数据库备份：`/srv/biliskipad/data/backups/pre-site-zip-0.1.9-20261003-2200.sqlite`，728条广告记录、31条转写记录，完整性检查通过。
- 部署后逐条核对原广告和转写记录，变更／缺失均为0，容器为`healthy`。
- `npm run verify`通过321项测试；全量部署脚本新增历史版本ZIP保留，固定下载由本次发布替换。
- 日志：`.tmp/site-zip019-pack.log`、`.tmp/site-zip019-deploy.log`，公网下载核验记录见`.tmp/site-zip019-online.json`。

## 2026-10-02 转写接口与v6上线

该次release：`20261002-225017-691b2510389d`，通过`server/deploy-api.ps1`和`server/deploy/api.sh`上线。
新增`POST /v1/transcripts`（512KiB上限、哈希校验、幂等回执、独立待核验表），
广告提交与转写提交共用每IP每1000ms一次的限流。新增`ad-cues-v6-json`，保留v1–v5。
部署前备份`/srv/biliskipad/data/backups/pre-20261002-225017-691b2510389d.sqlite`，完整性检查通过，
原515条广告记录逐条核对保持原样。首页与公开ZIP保留原内容，隐私页增加独立转写上传开关和完整文本收集说明。

公网实测：航母视频的已归档真实ASR字幕213句，首次提交201、限流429、间隔后重复提交200并复用回执。
回执`39d45d9a-492a-4ec0-b204-d861fd0df634`；`GET /v1/transcripts`返回405，CORS预检204，健康检查200。
记录：`.tmp/transcript-api-2026-10-02.json`。随后发布两个真实v6广告标记作为MC／航母回归及免Key审核演示，
明细位于`.tmp/release019-demo-cache.json`。

## 目标机器

- 服务域名：`biliskipad.bakapiano.com`
- SSH：`root@175.178.13.169`，使用本机已信任的服务器主机密钥。
- DNS：该子域名由泛域名解析指向 `175.178.13.169`；根域名 `bakapiano.com` 的公网 A/AAAA 查询为空。
- 2026-09-29 只读检查：OpenCloudOS 9.4、x86_64、4 核、约 8GB 内存；可用内存约 1.7GB、磁盘余量约 29GB。
- 已有环境：Docker 29.3.1、Docker Compose 2.32.1、宿主机 Nginx 1.26.3、`/root/.acme.sh/acme.sh` 及其续期 cron。

本机代理 DNS 可能返回 `198.18.*` 映射地址，部署脚本使用已经核对并信任的服务器 IP 连接，保持严格 SSH 主机密钥检查。

## 部署结构

```text
Chrome 扩展
  → https://biliskipad.bakapiano.com
  → 宿主机 Nginx（TLS + X-Real-IP 覆盖）
  → Docker Compose / biliskipad / api
  → 127.0.0.1:8787（Node 原生 HTTP）
  → /srv/biliskipad/data/shared-cache.sqlite

官网访客
  → 同一 Nginx 虚拟主机
  → /srv/biliskipad/current/site/（静态介绍页、隐私页、截图与扩展下载）
```

- 镜像：Node 24.21.0 Debian bookworm-slim，Compose 固定镜像 SHA-256。
- 独立 Compose 项目名：`biliskipad`；服务名：`api`。
- Linux host 网络；应用只监听本机回环地址。
- 进程 UID/GID：`1000:1000`；只读根文件系统、256MiB 内存上限、0.5 CPU、64 PID 上限。
- 日志轮转：单文件 5MiB，最多 3 个文件；异常退出自动重启。
- 只信任本机 Nginx 的真实 IP 头，保持每个来源 IP 每 1000ms 最多一次提交。

## 路径

| 路径                                     | 内容                                |
| ---------------------------------------- | ----------------------------------- |
| `/srv/biliskipad/releases/<release-id>/` | 独立版本的运行代码                  |
| `/srv/biliskipad/current`                | 当前版本符号链接                    |
| `/srv/biliskipad/current/site/`          | 官网静态文件与扩展 ZIP 下载         |
| `/srv/biliskipad/compose.yaml`           | 当前 Compose 配置                   |
| `/srv/biliskipad/service.env`            | 可选共享服务令牌等私密运行配置      |
| `/srv/biliskipad/data/`                  | 持久化 SQLite 文件与 WAL            |
| `/srv/biliskipad/models/`                | 持久化语音模型与许可，Nginx直接读取 |
| `/srv/biliskipad/asr/`                   | 油猴SRI运行时资源、VAD/词表与许可   |
| `/srv/biliskipad/backups/<release-id>/`  | 升级前 Compose 和 Nginx 配置备份    |
| `/etc/nginx/conf.d/biliskipad.conf`      | 本服务的独立虚拟主机                |
| `/etc/biliskipad/tls/`                   | 本域名证书和私钥                    |
| `/var/lib/biliskipad/acme/`              | HTTP-01 验证目录                    |

配置备份与数据库备份分别管理。数据库备份采用 SQLite 一致性快照，并按业务留存策略保管；升级前涉及数据库结构变更时应先完成快照。

## 从 Windows 部署

### 官网与API单独部署

`powershell -NoProfile -File server/deploy-site.ps1` 会先运行完整检查，从当前线上release读取
已发布ZIP版本，使用 `build-site.js --site-only <version>` 构建站点，保留现有下载包。
部署覆盖范围固定为三个API模块、本站静态文件和Nginx模板；复制旧release后覆盖，
备份SQLite、逐条核对已有记录、原子切换并检查页面/API健康，失败时恢复上个release。
`server/deploy.ps1` 仍用于连同客户端ZIP的完整发布。

2026-10-02后续按用户要求撤回列表页及列表API。当前源码移除`results.html`、`results.js`、
`/v1/results`及分页查询逻辑，保留蓝白设计、导航图标、示例视频和原共享API。
`deploy/site.sh`在新release中将两份已退役页面文件移到本次备份目录，旧release完整保留，
并验证三个页面地址与列表接口均返回404；原有数据库与公开ZIP逐项核对后保留。

撤回于2026-10-02 09:42完成，release `20261002-094222-397c651d43df`。
原有215条记录逐条比对变更/缺失0条；快照
`/srv/biliskipad/data/backups/pre-site-20261002-094222-397c651d43df.sqlite`，
SHA-256 `9438d0d945cf4f86a2c236f92b1dc12cad602c2893586d4eb075b8ba9522effc`。
两份退役页面移动到 `/srv/biliskipad/backups/site-20261002-094222-397c651d43df/`，
旧release保留完整版本。首次部署遇到Nginx平滑重载的旧路由窗口而自动回滚，
增加有界等待后重试通过。203项测试通过，公开ZIP哈希保持原值。
部署与公网验证记录位于 `.tmp/results-retired-20261002/`。

2026-10-02 09:18首次上线release `20261002-091803-2c36455ba357`（列表功能后续撤回）：

- 官网浅蓝/白色主题、蓝色网站图标、五项导航图标；示例区增加原视频与167秒起点链接，展示真实转转区间166.988–202.480秒、评分0.98及理由。
- `/results.html`、`/results.js`、`GET /v1/results`上线；支持10/20/50条分页及50%保护筛选。
- 快照：`/srv/biliskipad/data/backups/pre-site-20261002-091803-2c36455ba357.sqlite`，214条记录，SHA-256 `cfc79e527c150a142073d088115d6b92221f634fa27acdaa73488dc2083053fd`，部署后原记录变更/缺失0条。
- 公开ZIP保留0.1.6及原SHA-256 `e906dc738cefc9ffc8a40f4af346532a1d616210ad1de9e08ad8df8d0b99ecda`；模型和WASM资源静态路由继续保留。
- 公网验收：214条有效结果、19条50%保护、70条含广告、144条零广告（验收快照）；逐页读取完整、记录ID无重复。
- 208项回归通过。Playwright检查公网桌面、390px和341px布局、安装切换、示例链接、结果翻页/筛选/展开/刷新恢复通过，页面错误0条。
- 原始证据：`.tmp/site-results/deploy.log`、`http-report.json`、`live-e2e.json`；截图与详细说明见 [本次验收](../docs/testing/site-results-2026-10-02.md)。

在项目根目录执行：

```powershell
npm run deploy:server
```

入口为 `server/deploy.ps1`：默认先执行完整检查并生成扩展 ZIP，再构建静态官网。
官网源码位于 `server/site/`，`scripts/build-site.js` 将版本号、CSS 与截图内容哈希、公开素材和扩展下载包整理到 `.tmp/site-build/site/`。
按明确文件白名单生成部署归档，通过 SSH/SCP 上传，再执行 `server/deploy/install.sh`。归档包含后端运行文件、部署模板和官网公开文件。

使用已打包的扩展时，可直接调用 PowerShell 入口：

```powershell
powershell -NoProfile -File server/deploy.ps1 -ExtensionArchive dist/biliskip-0.1.4-20260929-222944.zip
```

指定 ZIP 会先运行 `verify`，并逐文件比对 ZIP 与当前 `extension/` 源码的哈希；二者一致后才发布。

远程脚本核对 SHA-256、目录所有权标记和端口，创建独立版本，启动并验证容器及官网首页；
首次部署使用现有 acme.sh 申请该域名证书，安装后配置 Nginx 平滑重载。
证书续期沿用现有 acme.sh cron，部署注册的 reload 命令先执行 `nginx -t` 再重载。

部署失败时尝试恢复上一版本和此前的本服务虚拟主机；数据库目录保持原样。
每次部署保留旧版本目录，供明确选择回滚目标。

### 2026-10-01 后端单模块兼容升级

当前release为 `20261001-224000-5cd21d32ab06`。此次先核对线上与本地6个后端模块，
确认差异仅在 `server/validation.js`，随后复制原release并替换该文件。
复用当前Compose配置、官网、隐私页与下载包，通过原子切换`current`后重建`api`容器。
部署脚本持有同一`deploy.lock`，失败时恢复旧release；部署前备份SQLite并验证完整性。
该次限定目标的一次性脚本保存在 `.tmp/deploy-prompt-v5.sh`，执行记录为 `.tmp/prompt-v5-deploy.log`。
常规全量发布仍使用上面的 `server/deploy.ps1`。

### 语音模型静态部署

主模型存于 `/srv/biliskipad/models/sensevoice-small-int8/`，与release目录及SQLite独立。
模型URL为 `/models/sensevoice-small-int8/c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51.onnx`。
使用Nginx精确location直出239,233,841字节，支持单Range，缓存一年且immutable；
GET/HEAD公开读取，匿名CORS，模型SHA-256在客户端固定校验。
同目录公开 `LICENSE` 和 `NOTICE.md` 供核对上游来源与模型许可。

```powershell
powershell -NoProfile -File server/deploy-model.ps1 -ModelFile .tmp/model-release/model.onnx
```

脚本先验证本地文件大小与哈希、执行全量检查，再通过严格主机密钥校验的SCP上传。
远端 `server/deploy/model.sh` 再次核对哈希，持有`deploy.lock`，保留原Nginx备份，
执行`nginx -t`和平滑重载，核对200响应大小、Range与API健康；失败时恢复原配置。
该流程保留当前API容器、数据库、首页和下载包。
日常全量部署的Nginx模板包含相同模型路由，继续读取持久模型目录。

2026-10-01 22:57上线，Nginx备份位于
`/srv/biliskipad/backups/model-20261001-225702/nginx.conf`。
服务器本地与公网HEAD返回200，Content-Length为239233841，Range校验1024字节通过。
模型文件SHA-256为 `c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51`。
原始部署日志 `.tmp/model-deploy.log`。下载流量独立于广告候选提交的每IP每秒一次限流。

### 油猴SRI资源部署

油猴0.1.8.3使用的WASM和VAD/词表由Nginx目录 `/asr/sherpa-onnx-1.12.20/` 提供，
物理目录 `/srv/biliskipad/asr/sherpa-onnx-1.12.20/` 独立于release和SQLite。
固定哈希文件名配合`@resource #sha256`，管理器预加载，脚本运行时再次核验。
完整大小、哈希和验证范围见 [SRI验收记录](../docs/testing/userscript-sri-2026-10-01.md)。

```powershell
powershell -NoProfile -File server/deploy-asr-resources.ps1
```

脚本先执行`verify`，按白名单归档二进制与许可，SCP上传后核对归档和文件哈希；
远端持有部署锁，安装到固定目录，备份Nginx并平滑重载，失败时恢复配置。
GET/HEAD公开读取、CORS允许、缓存一年immutable、目录索引关闭、符号链接关闭。

2026-10-01 23:42上线，Nginx备份：
`/srv/biliskipad/backups/asr-resources-20261001-234255/nginx.conf`。
两份资源服务端和公网浏览器完整哈希均通过，API健康正常；
原始记录 `.tmp/userscript-sri-deploy.log`、`.tmp/userscript-sri/e2e.json`。

## 运维命令

```sh
cd /srv/biliskipad
docker compose -p biliskipad ps
docker compose -p biliskipad logs --tail=50 api
docker compose -p biliskipad exec -T api node server/index.js stats
docker compose -p biliskipad exec -T api node server/index.js recent
docker compose -p biliskipad exec -T api node server/index.js revoke <submission-id>
curl --fail https://biliskipad.bakapiano.com/healthz
```

回滚时先核对具体的旧版本目录，将 `current` 指向该目录，再针对 `api` 执行
`docker compose -p biliskipad up -d --force-recreate api`，并检查健康状态。
此步骤仅调整本服务的运行代码和容器，SQLite 持久数据继续保留。

## 插件接入

版本 `0.1.4` 内置该线上域名，默认启用共享查询和新分析结果自动上传，工具栏弹窗保留手动上传入口。
页面准备采用本地缓存优先，未命中时查线上；弹窗「读取线上缓存」按钮可主动请求服务器。
线上结果回填本机数据库，自动跳过仍经过本地字幕校验、评分和覆盖率保护。
上传提交视频信息、广告标记和有限证据。设置中的 `autoUpload` 可单独关闭自动上传；`sharedUpload` 总开关约束全部上传。

旧版本中从未配置共享域名的设置进行一次迁移；既有自定义域名和对应开关保持原值。
迁移版本单独记录，之后用户关闭的开关保持关闭。

## 官网路由

- `/`：产品介绍、功能、原图截图、Chrome / 油猴安装方式切换和对应使用说明。
- `/privacy.html`：公开的隐私与数据说明；`/privacy` 跳转到该页面。
- `/assets/`：本站图标与真实截图。
- `/downloads/biliskip.zip`：固定扩展下载地址，内容随当前部署版本更新，要求缓存重新验证。
- `/downloads/biliskip.zip.sha256`：固定下载地址的 SHA-256 校验值。
- `/downloads/biliskip-0.1.9.zip`：当前公开扩展ZIP，根目录包含`manifest.json`。
- `/downloads/biliskip-0.1.9.zip.sha256`：下载包校验值；历史版本路径保留供回溯。
- `/v1/` 与 `/healthz`：继续代理到原 Node 服务。
- `/v1/stats`：公开缓存汇总，首页使用 `/stats.js` 同源读取；统计输出不含 IP、凭据或逐条记录。

官网采用静态 HTML/CSS 与同域资源，Nginx 通过 CSP、内容类型校验头和框架嵌入限制保护页面。版本下载路径随扩展版本构建；CSS 查询参数按内容哈希更新。
2026-10-01 起仅首页增加同源 `stats.js`，CSP 的脚本和连接允许 `'self'`；安装选项继续由原生 CSS 单选控件切换。
安装方式切换使用原生单选控件与 CSS，油猴安装按钮链接到 Greasy Fork 的正式脚本页。
油猴脚本位于第一项并默认选中，Chrome 扩展位于第二项。
Chrome 面板优先链接到已上架的 Chrome 应用商店条目；ZIP / 源码步骤放在折叠说明中，保留下载和校验值。

## 验收记录

- 2026-09-29：部署版本 `20260929-173856-cc567b4ad66c` 上线，公网 HTTPS `/healthz` 返回 `200`。
- Let's Encrypt 证书签发成功，域名 SAN 为 `biliskipad.bakapiano.com`，到期时间 `2026-12-28 08:37:59 UTC`。
- 首轮 Nginx 连续重载后立即探测读到了旧站点证书，自动回滚生效。部署脚本增加保持证书验证的就绪轮询后，上线成功。
- 本地完整检查通过 107 项测试（含子用例）。真实公网 HTTPS 提交、查询、幂等、本地回填及伪造 IP 头限流验证通过，详情见 [E2E_REPORT.md](E2E_REPORT.md)。
- Chrome `0.1.3` 已完成两个真实视频的线上读取/上传，以及广告内定位跳过、重复跳过、撤销和刷新保留验证。
- 随后追加的多语言字幕回退已完成源码与自动化回归；在 Chrome 重新加载扩展后生效，真实英文视频验收待补充。
- 最后复查容器为 `healthy`，HTTPS `/healthz` 返回 `{"ok":true,"schema_version":1}`。
- 2026-09-29：官网部署版本 `20260929-191700-9c1bf9a7eb24` 上线；首页、隐私页、素材和下载均返回 `200`，既有广告缓存读取通过。
- 0.1.4 下载 ZIP 共 22 个扩展文件、47,143 字节，SHA-256 为 `c42f72ac003df8af0657f6c02be2d34cf4806d3619e4df643f3b585c451ab55d`。
- 官网相关变更后 132 项测试通过。实际 Chrome 桌面/窄屏布局、FAQ、导航、隐私页和 ZIP 下载事件验收通过，详见 [SITE_E2E_REPORT.md](SITE_E2E_REPORT.md)。
- 2026-09-29：按用户反馈改为白底工具文档排版，标题调整为「B站植入广告跳过插件」，移除宣传标语和装饰示意图，截图更换为播放器原图裁切。部署版本 `20260929-192442-40bfbf2cf9a6`；132 项测试、线上下载和原 API 复验通过。
- 2026-09-29：部署版本 `20260929-201750-7d6e14988226` 增加固定下载地址 `/downloads/biliskip.zip` 与校验值，首页在截图前展示安装步骤。133 项测试通过；公网 ZIP 验证为 0.1.4、22 个文件、根目录含 `manifest.json`，与版本包 SHA-256 一致。
- 2026-09-29：部署版本 `20260929-225529-0e64f410cdcb` 增加 Chrome / 油猴安装方式切换、Greasy Fork 入口与油猴数据说明。153 项测试及真实 Chrome 点击、键盘、窄屏检查通过。新版 ZIP 为 48,812 字节、25 个文件，随附 MIT `LICENSE`，公网哈希与本地一致，容器为 `healthy`。
- 2026-09-29：部署版本 `20260929-230248-7041bfc20da8` 将油猴脚本调整为第一项并默认选中，README 安装顺序同步更新。153 项测试通过，公网选项顺序、默认值及 `/healthz` 已复核。
- 2026-09-29：部署版本 `20260929-230740-a2eb76b405dc` 为油猴和 Chrome 选项加入内嵌 SVG 图标，并调整窄屏间距。153 项测试、真实 Chrome 桌面／窄屏显示及点击图标切换验证通过。
- 2026-09-30：部署版本 `20260930-163758-afa370c64ac5` 增加 Chrome 商店正式安装入口；首页状态、Chrome 面板和安装步骤同步更新，ZIP 折叠保留。154 项测试及公网首页／隐私页／CSS／下载校验通过，容器为 `healthy`。真实 Chrome 桌面选项切换、ZIP 展开和窄屏宽度 341px 验收通过。
- 2026-10-01 16:48：部署版本 `20261001-164830-d98dc8a379b6` 上线，兼容提示词 v1、v2-compact、v3-pipe，v3允许空证据列表，新旧缓存继续独立积累。保留每IP每秒最多一次提交。
- 部署前一致性备份：`/srv/biliskipad/data/backups/pre-016-2026-10-01T08-46-22.601Z-56159f34.sqlite`，71条记录，完整性检查通过。SHA-256：`e55a7cf2ae2faab5b06e070711bcfa692a062df802d2fdbd82d405163d95142d`。备份权限0600、父目录0700。
- 部署后逐条对比备份：原有71条记录保持原样；验收新增1条来自真实DeepSeek结果的v3广告缓存，总计72条。
- 首页统计与`/v1/stats`上线：缓存视频70个、去重分P70个、有效记录72条、广告25段、总广告时长1471.209秒（验收快照）。首页“累计节省时间”按该总时长展示，各分P取最新有效结果。
- 169项检查通过。新增标准ZIP条目写入脚本，保证 Windows PowerShell 中使用 `/` 路径；归档逐文件与源文件比对后部署。
- 最终 ZIP：`dist/biliskip-0.1.6-chrome-web-store-20261001-164830.zip`，50830字节，SHA-256 `e906dc738cefc9ffc8a40f4af346532a1d616210ad1de9e08ad8df8d0b99ecda`。固定地址与 `/downloads/biliskip-0.1.6.zip` 已同步。
- 新版公网上传201、查询200、重复上传200，旧版查询200；本地IndexedDB回填后模型调用0次。`.tmp/release-016-e2e-report.json`记录本次真实HTTPS与生产模块集成范围。
- Playwright验证首页统计、桌面和窄屏、选项切换、隐私页与浏览器下载；截图保存在 `dist/site-stats-0.1.6-desktop.png` 和 `dist/site-stats-0.1.6-mobile.png`。
- 2026-10-01 22:40（北京时间）：后端兼容升级 `20261001-224000-5cd21d32ab06` 上线。新增 `ad-cues-v4-topic`、`ad-cues-v5-obvious`，保留v1–v3；v3–v5允许空证据列表，版本间缓存独立。限流仍为每IP每1000ms最多一次。
- 校验模块SHA-256：`5cd21d32ab068e710a0e0dd98e26d040fe6d16667ce6f22f651a884465e93220`；其他运行模块、官网和下载字节保持原样。
- 部署前一致性备份：`/srv/biliskipad/data/backups/pre-20261001-224000-5cd21d32ab06.sqlite`，158条记录，完整性检查通过；SHA-256 `31634bf63f34592a18bae1f4cf986d2ac18a384057f79e47a1d9a3b1bc4fd590`。部署后逐条比对：原有记录变更/缺失0条。
- 使用 `BV1pFUDBKE8X` 的真实ASR/DeepSeek结果完成v5公网上传201、读取200、重复提交200；客户端共享回填、本地再次命中、新增模型调用0次。上传1条有效v5记录后总缓存159条。
- 原v1/v3样本公网页面返回200且响应SHA-256保持一致；v1–v5合法缓存未命中均返回404，未知提示词返回400。
- 官网、隐私页和固定ZIP前后哈希一致。公开ZIP保持 `0.1.6`、50830字节，SHA-256 `e906dc738cefc9ffc8a40f4af346532a1d616210ad1de9e08ad8df8d0b99ecda`；本地 `0.1.8` 试用包可直接接线上共享服务。
- 全量184项回归通过；真实HTTPS记录 `.tmp/prompt-v5-online.json`。验收时公开统计为155个视频、159条缓存、109段广告、5043.121秒累计广告时长，统计随新提交变化。

### README徽章与0.1.9后端复验

- 部署版本：`20261003-003914-fce32e9b89c9`，使用`server/deploy-api.ps1`执行API独立部署。前置全量检查321项通过。
- 新增`GET /v1/badges/videos`、`/v1/badges/segments`、`/v1/badges/saved-time`，提供固定的Shields Endpoint JSON汇总，公共缓存300秒；Nginx沿用`/v1/`路由。
- 两种部署归档均包含新增的`server/badges.js`；独立部署结束前通过HTTPS核验三个徽章入口。
- 部署前一致性备份：`/srv/biliskipad/data/backups/pre-20261003-003914-fce32e9b89c9.sqlite`，554条广告记录，完整性检查通过。部署后原有记录变更／缺失0条，转写字幕表保留2条记录。
- 容器最终为`healthy`，v1–v6兼容检查通过；首页、固定ZIP下载、模型与SRI资源沿用原有文件，公开ZIP仍为0.1.6。
- 公网统计复验快照（UTC `2026-10-02T16:41:51.469Z`）：534个视频、540个分P、555条有效记录、380段广告、16,788.633秒广告时长。部署后新增提交继续正常入库。
- 安装量徽章使用Greasy Fork公开累计安装次数；服务器统计继续使用既有缓存数据，客户端数据收集范围保持原样。
- 本机部署日志：`.tmp/badges-deploy.log`。油猴0.1.9.1产物为`dist/biliskip.user.js`，713,034字节，SHA-256为`2838389ecb9d84b690d4cd2fe5b0a6cddcaa058ce5c588bd2e7b4fca0f15fd77`。

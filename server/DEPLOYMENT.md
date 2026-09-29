# 线上部署记录与操作说明

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

| 路径                                     | 内容                             |
| ---------------------------------------- | -------------------------------- |
| `/srv/biliskipad/releases/<release-id>/` | 独立版本的运行代码               |
| `/srv/biliskipad/current`                | 当前版本符号链接                 |
| `/srv/biliskipad/current/site/`          | 官网静态文件与扩展 ZIP 下载      |
| `/srv/biliskipad/compose.yaml`           | 当前 Compose 配置                |
| `/srv/biliskipad/service.env`            | 可选共享服务令牌等私密运行配置   |
| `/srv/biliskipad/data/`                  | 持久化 SQLite 文件与 WAL         |
| `/srv/biliskipad/backups/<release-id>/`  | 升级前 Compose 和 Nginx 配置备份 |
| `/etc/nginx/conf.d/biliskipad.conf`      | 本服务的独立虚拟主机             |
| `/etc/biliskipad/tls/`                   | 本域名证书和私钥                 |
| `/var/lib/biliskipad/acme/`              | HTTP-01 验证目录                 |

配置备份与数据库备份分别管理。数据库备份采用 SQLite 一致性快照，并按业务留存策略保管；升级前涉及数据库结构变更时应先完成快照。

## 从 Windows 部署

在项目根目录执行：

```powershell
npm run deploy:server
```

入口为 `server/deploy.ps1`：默认先执行完整检查并生成扩展 ZIP，再构建静态官网。
官网源码位于 `server/site/`，`scripts/build-site.js` 将版本号、CSS 与截图内容哈希、公开素材和扩展下载包整理到 `.tmp/site-build/site/`。
按明确文件白名单生成部署归档，通过 SSH/SCP 上传，再执行 `server/deploy/install.sh`。归档包含后端运行文件、部署模板和官网公开文件。

使用已打包的扩展时，可直接调用 PowerShell 入口：

```powershell
powershell -NoProfile -File server/deploy.ps1 -ExtensionArchive dist/biliskip-0.1.4-chrome-web-store-20260929-190955.zip
```

指定 ZIP 会先运行 `verify`，并逐文件比对 ZIP 与当前 `extension/` 源码的哈希；二者一致后才发布。

远程脚本核对 SHA-256、目录所有权标记和端口，创建独立版本，启动并验证容器及官网首页；
首次部署使用现有 acme.sh 申请该域名证书，安装后配置 Nginx 平滑重载。
证书续期沿用现有 acme.sh cron，部署注册的 reload 命令先执行 `nginx -t` 再重载。

部署失败时尝试恢复上一版本和此前的本服务虚拟主机；数据库目录保持原样。
每次部署保留旧版本目录，供明确选择回滚目标。

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

- `/`：产品介绍、功能、原图截图、安装步骤和使用说明。
- `/privacy.html`：公开的隐私与数据说明；`/privacy` 跳转到该页面。
- `/assets/`：本站图标与真实截图。
- `/downloads/biliskip.zip`：固定扩展下载地址，内容随当前部署版本更新，要求缓存重新验证。
- `/downloads/biliskip.zip.sha256`：固定下载地址的 SHA-256 校验值。
- `/downloads/biliskip-0.1.4.zip`：与当前扩展源码一致的商店上传包。
- `/downloads/biliskip-0.1.4.zip.sha256`：下载包校验值。
- `/v1/` 与 `/healthz`：继续代理到原 Node 服务。

官网采用静态 HTML/CSS 与同域资源，Nginx 通过 CSP、内容类型校验头和框架嵌入限制保护页面。版本下载路径随扩展版本构建；CSS 查询参数按内容哈希更新。

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

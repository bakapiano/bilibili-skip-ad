# 语音模型自有域名与设置页预下载

日期：2026-10-01。版本继续为本地试用 `0.1.8` / `0.1.8.2`。

## 实现

- SenseVoiceSmall INT8原样镜像到 `biliskipad.bakapiano.com`，固定哈希命名。
- 主权重239,233,841字节；SHA-256为
  `c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51`。
- 后端Nginx直接提供文件，运行API与数据库保持原状；来源说明与许可一同提供。
- Chrome和油猴从相同模块读取/校验/保存模型；设置页新增下载、进度、取消和检查缓存。
- 下载独立于ASR开关、字幕授权和DeepSeek Key，ASR保持默认关闭。
- CacheStorage沿用 `biliskip-asr-model-v1`，新键为本站URL。旧Hugging Face键命中时先验证、再本地迁移。
- Chrome默认安装权限保留本站；第三方模型源使用可选域名权限。油猴声明本站、HF-Mirror、Hugging Face及已审查CDN的@connect。
- 下载源可选本站、HF-Mirror和Hugging Face；本站拒绝重定向，第三方源验证最终CDN目标，所有源使用匿名请求并校验相同模型SHA-256。
- Web Locks跨同源页面互斥模型准备；下载仅写磁盘缓存，转写时才创建CPU Worker。
- 设置页/面板关闭会取消进行中的预下载；重试从头开始。实际下载等待上限15分钟。

## 固定回归

`npm run verify`：新增可选源后196项测试通过，失败0项。覆盖自有域名与Nginx固定路径、域名权限、
首次下载/缓存复用、旧缓存迁移、哈希/体积/重定向拒绝、下载锁、取消、显式可信点击、
关闭设置页、ASR开关保持以及GM网络适配器。

首轮全量检查有一次本机回环HTTP测试连接失败；再次完整执行190项通过，补充界面及部署回归后193项通过。

## 真实网络与浏览器范围

模型已在服务器部署。服务端与公网HEAD 200，大小239233841字节，支持Range，
原始部署日志 `.tmp/model-deploy.log`，配置备份与复现命令见 [部署说明](../../server/DEPLOYMENT.md)。

Chrome设置页通过Playwright运行真实扩展并从公网站点下载完整模型，记录于
`.tmp/model-settings/extension.json`、`.tmp/model-settings-console.log`。
完整下载先检查SHA-256，随后复用缓存校验与第二个扩展页面的读取。
本轮完整下载与校验562.784秒；取消、刷新后缓存识别、二次校验零网络请求、第二个扩展页面复用均通过。
实际offscreen转写已读取这份预下载缓存，239MB权重请求增量为0，并完成真实ASR和DeepSeek；
记录在 `.tmp/model-settings/offscreen-e2e.json`。后续旧设置流程重跑遇到复用测试配置中的旧Service Worker，
最终源选项UI改用全新测试配置，并用已核验的相同字节准备缓存夹具，三源选择、保存、刷新与缓存校验均通过。

油猴使用实际打包单文件和显式GM适配测试环境。为节约重复下载带宽，模型传输使用相同固定字节的
分块夹具；设置页下载、缓存、CPU Worker、真实音轨ASR及DeepSeek调用分别验证。
该范围与真实Tampermonkey安装器分开记录，原始记录 `.tmp/model-userscript-e2e.log` 和 `.tmp/model-settings/userscript.json`。
油猴本轮通过：预下载时ASR仍关闭、Worker数量0，开启后复用已缓存模型；518.455秒真实音轨的
VAD＋ASR为62.33秒，识别转转广告166.988–202.480秒（0.98），进度条和主动定位跳过通过。

公网Range响应206，`Content-Range: bytes 0-1023/239233841`，前1024字节逐字节与原模型相同；
LICENSE与NOTICE.md均返回200。原始记录 `.tmp/model-settings/http.json`。

首次两路公网下载测试争用服务器带宽，已中止并改为单路完整公网下载。
服务器带宽和用户网络会影响首次准备时间；模型完成后保留浏览器磁盘缓存。

## 可选源

各源请求固定revision，目标权重大小和SHA-256保持同一组。
HF-Mirror此次最终下载域名也为 `us.aws.cdn.hf.co`；用户选择镜像时仍需考虑最终CDN连通性。
文件验证记录 `.tmp/model-settings/source-verification.json`。
各下载源命中同一份规范模型缓存；切换下载源后可以直接校验已有缓存，后续ASR读取同一模型。

2026-10-01最终文件核验：

| 源           | 完整字节数 | SHA-256核验                    |
| ------------ | ---------: | ------------------------------ |
| BiliSkip本站 |  239233841 | 通过，Chrome真实完整下载后校验 |
| HF-Mirror    |  239233841 | 通过，完整文件流式下载后计算   |
| Hugging Face |  239233841 | 通过，完整文件流式下载后计算   |

统一SHA-256：`c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51`。
第三方源测试使用本机当前网络（Mihomo TUN在运行）。两源首次下载到约112MB时命中测试脚本240秒期限，
随后使用HTTP Range续传完整文件后计算SHA-256；部分文件阶段明确记录为验证未完成。
原始记录 `.tmp/model-sources-check.log`、`.tmp/model-sources-resume.log`、`.tmp/model-settings/source-verification.json`。
UI回归记录 `.tmp/model-settings/sources-ui.json`，三次切源、保存、刷新后均复用缓存校验，网络请求增量为0。

# BiliSkip 油猴版

当前试用版本 `0.1.9.1`。使用Chrome 120+与Tampermonkey 5.4+，通过可选的个人DeepSeek API Key识别B站字幕中的植入广告；无字幕时可使用本地CPU转写。

Key为可选配置。缓存模式直接读取本地／共享广告及零广告结果，主按钮显示「查询共享缓存」。
已开启本地转写时，可手动「转写并查询共享缓存」，该查询仅发送指纹；独立的转写文本上传开关默认开启，可在ASR区块关闭。自行识别时再配置Key与DeepSeek字幕发送授权。

`0.1.9.0`与扩展`0.1.9`共用仅广告JSON v2提示词、标题和编号字幕输入、独立广告分段解析；视频身份与时间戳由客户端绑定。
提示词版本`ad-cues-v6-json`独立隔离缓存，原GM Key、设置和旧记录保留。结果继续转换为内部结构化记录用于跳过和共享。
线上共享后端已于2026-10-02接受v6及转写字幕提交；原有版本缓存继续独立提供。
ASR默认关闭，用户按需开启；CPU并发默认2，可选1/2/4/6/8；短视频豁免独立分区，默认关闭、预设3分钟，分钟数可调且支持小数。详见 [ASR试用说明](../docs/asr-trial.md)。
设置面板可提前下载约239MB语音模型，提供进度、取消和缓存校验。来源可选本站、HF-Mirror与Hugging Face，使用对应`@connect`白名单；各源核对相同SHA-256。下载期间保持面板打开。
脚本使用油猴默认运行环境，保留 GM 存储与网络权限。`0.1.4.2` 移除了 DOM 模式声明与启动检查。

## 安装

发布版入口：[Greasy Fork 上的 BiliSkip](https://greasyfork.org/zh-CN/scripts/597956-biliskip-ai-%E5%B9%BF%E5%91%8A%E8%B7%B3%E8%BF%87)。安装 Tampermonkey 后，在该页点击「安装此脚本」，按油猴确认页提示安装，然后从下面第 3 步开始使用。

源码构建安装：

1. 开发者在仓库根目录执行 `npm ci --ignore-scripts`、`npm run build:userscript`，生成 `dist/biliskip.user.js` 与 SHA-256 文件。
2. 在油猴管理面板选择「添加新脚本」，将生成文件的完整内容替换编辑器默认模板并保存。
3. 在 B站视频页刷新，打开油猴菜单中的「BiliSkip · 设置」。
4. 需要新识别时，通过「配置 DeepSeek Key」录入个人 Key，并勾选字幕发送授权、保存设置；共享缓存可直接读取。
5. 通过「BiliSkip · 打开面板」分析当前视频、查看费用、试听边界、手动跳过或撤销。
6. 按需开启自动跳过。自动分析首次默认关闭，开启后对前台、尚无缓存的视频发起付费识别。

Chrome 版与油猴版请选择一个运行。检测到 Chrome 版控制器时，油猴版让出播放器控制权，并在面板提示停用 Chrome 版后刷新。
本地构建产物位于 `dist/`；官网提供 Chrome ZIP 与 Greasy Fork 两种安装入口。

试用请导入重新构建的完整 `.user.js`，文件头包含 `@license MIT`，随后附有 [MIT许可全文](../LICENSE) 与ASR第三方许可。脚本约700KB，业务与Worker JS保持可读；准确大小以构建输出为准。

### WASM、VAD资源与SRI

`0.1.8.3` 将约11.54MB的WASM和约0.96MB的VAD/词表作为两个`@resource`，
分别引用本站 `/asr/sherpa-onnx-1.12.20/` 下的哈希文件名，并附`#sha256=<固定哈希>`。
Tampermonkey在安装/更新时获取和校验这些资源；需要完成约12.5MB资源准备。
运行时通过`GM.getResourceUrl`读取管理器的本地data/blob资源，再核对字节数和SHA-256后传给Worker。
`0.1.9.1` 在准备新转写或下载主模型前检查这两个资源，读取超时上限10秒。资源缺失、读取异常、长度或哈希校验失败时，在当前页面暂停新的ASR任务及主模型下载，设置里显示原因和「重新检查资源」。同一页面后续调用复用该故障状态；手动重试或刷新后重新检查。
保存的ASR开关、已有转写字幕、模型与广告缓存保留；字幕识别、DeepSeek调用、共享缓存、标记、跳过和撤销继续独立运行。转写上传开关保留可操作状态，便于随时调整偏好。成功重新校验后，恢复新转写与模型下载入口。
此降级覆盖已安装脚本的运行阶段；脚本安装及更新阶段的资源获取由油猴管理器处理。资源继续使用固定SRI和运行时SHA-256校验，运行时仅读取管理器的本地data/blob资源。ASR默认关闭，239MB主模型仍通过设置页按需下载。
Chrome版保留原来的独立WASM文件，缓存/提示词协议维持当前版本。
验证范围见 [SRI资源拆分记录](../docs/testing/userscript-sri-2026-10-01.md)。
本轮降级与组合故障验证见 [0.1.9.1验收记录](../docs/testing/userscript-fallback-0.1.9.1.md)。

## 首版功能

- 中文 → 英文 → 其他语言字幕回退，复用原有字幕地址解码与 Protobuf 适配。
- 同一套`deepseek-flash` JSON v2提示词、广告分段解析、字幕编号映射和严格校验。
- 原生进度条仅标记符合跳过条件的金色区间；播放中与主动定位到广告时自动跳过；暂停状态保持。
- 手动跳过、撤销、广告边界试听、侧边推荐视频与分 P 切换。
- 油猴本地缓存、线上共享查询、自动／手动上传，包括零广告结果。
- API 用量、参考费用、识别耗时与缓存来源显示。
- 面板按油猴菜单打开，关闭后继续处理当前标签页任务。
- 同源标签页共享 Web Locks：同视频任务去重，ASR、DeepSeek请求及上传分别互斥。ASR进行时，有字幕或转写缓存的其他视频可继续分析；同类资源忙碌时提示稍后重试。
- 从浏览器历史页面缓存恢复时重新挂载控制器，并复用已保存结果。

线上服务固定为 `biliskipad.bakapiano.com`。自部署到其他域名时，同步修改共享服务常量与构建脚本中的 `@connect` 白名单并重新构建。

## 代码复用

构建共用扩展字幕、提示词、ASR、校验和播放器模块，另打包CPU Worker。Chrome继续直接加载 `extension/`，油猴通过esbuild打包成单文件。

| 共享内容                                 | 源文件                                        | 两端的使用方式                        |
| ---------------------------------------- | --------------------------------------------- | ------------------------------------- |
| 提示词、模型、默认配置                   | `extension/lib/constants.js`                  | 保持模型与提示词版本一致              |
| 精简字幕输入与数据边界                   | `extension/lib/prompt.js`                     | 编号、正文、元数据显式投影            |
| 视频身份、字幕指纹、结果／设置校验、费用 | `extension/lib/core.js`                       | 相同缓存键与校验规则                  |
| 字幕获取和语言回退                       | `extension/lib/bilibili.js`                   | 注入各自网络适配器                    |
| DeepSeek 和共享缓存协议                  | `extension/lib/providers.js`                  | 相同请求、候选字段和回执处理          |
| 分析与缓存业务                           | `extension/lib/service.js`                    | 注入存储、设置与进度通知              |
| 公开设置投影                             | `extension/lib/messaging.js`                  | 只向视图提供开关和 Key 配置状态       |
| 时间格式、匹配、跳过条件                 | `extension/player-core.js`                    | 同一套播放器规则                      |
| 进度条标记                               | `extension/timeline.js`                       | 同一个 B站 DOM 适配                   |
| 播放器状态与操作                         | `extension/content-controller.js`             | 接收平台请求与订阅函数                |
| 操作面板视图                             | `extension/popup-view.js`                     | 接收 DOM 根、后台请求与播放器命令函数 |
| 面板布局和样式                           | `extension/popup.html`、`extension/popup.css` | Chrome 弹窗与油猴闭合 Shadow DOM 共用 |

本轮从原 `content.js`、`popup.js` 抽出了控制器和面板视图。两个原文件成为 Chrome 专用入口，保留消息来源检查。

平台单独维护的代码：

| 职责          | Chrome                       | 油猴                                              |
| ------------- | ---------------------------- | ------------------------------------------------- |
| 存储          | IndexedDB + `chrome.storage` | `userscript/storage.js` 的逐条 GM 存储            |
| 特权网络      | 扩展后台 `fetch`             | `userscript/network.js` 的 `GM.xmlHttpRequest`    |
| 调度与通信    | `background.js`、Chrome 消息 | `userscript/runtime.js`、私有函数调用与 Web Locks |
| UI 入口与设置 | 工具栏弹窗、扩展设置页       | `userscript/main.js` 菜单、`panel.js` 按需对话框  |
| 分发          | `extension/` ZIP             | `scripts/build-userscript.js` 生成 `.user.js`     |

## 存储与隐私

- Key 保存在油猴专属 GM 存储，录入使用浏览器原生输入对话框；面板显示配置状态。
- 模型请求只将 Key 发送给 DeepSeek；完整字幕与视频标题随识别请求发往 DeepSeek。
- B站会话仅供 B站 API 请求；字幕 CDN、模型及共享服务使用匿名请求模式。
- 共享结果上传沿用字段白名单，每段最多 10 条证据、每条最多 500 字符。
- 本地标记、ASR字幕、上传回执与最近200条事件逐条保存到GM；普通字幕上下文和运行任务保存在当前页内存。固定语音模型缓存在B站origin的CacheStorage，每次使用前核对SHA-256。
- 两个版本各有自己的本地设置与缓存；相同字幕、视频和版本可复用同一份线上标记。
- 默认开启共享读取、允许上传与自动上传。设置里可分别调整，授权文案位于相应开关旁。
- 页面刷新或关闭会终止本页等待；此前已提交的模型请求可能产生费用，重新识别前先读取缓存。

特权调用通过 GM API 执行，Key 保存在油猴专属存储；运行环境由油猴默认配置决定。
页面环境中的 JavaScript 对象可能受网站脚本影响，建议为模型调用设置专用额度。面板的闭合 Shadow DOM 用于封装样式和控件。
DOM 节点用于展示和检测双版本冲突，模型操作通过脚本内部函数调用。
网络适配器限制 HTTPS 域名、接口、方法和请求头，设置 `redirect: "error"`，核对最终 URL，桥接超时／中止。
GM使用ArrayBuffer接收响应后校验体积，普通API上限4MiB、音轨64MiB、固定模型239,233,841字节。语音模型通过专用匿名下载适配器访问内置源固定快照，下载进度阶段也检查体积；本站模型、API和音轨采用重定向拒绝策略，镜像和原站模型允许已审查CDN跳转并核对最终目标及完整文件SHA-256。

## 构建与验证

```powershell
npm run verify
npm run build:userscript
```

自动化使用模拟 GM、Web Locks、B站字幕、模型和共享接口；jsdom 执行完整单文件产物，验证界面、播放器和生命周期。
常规测试使用固定数据与模拟用量。2026-09-29 已在真实 Chrome 观察到字幕读取、线上与本地缓存、广告标记、自动跳过、侧边切换及模型结果；面板按钮与上传成功路径继续按实机清单核验。

测试入口：`tests/userscript/`。Chrome 原有播放器、弹窗、后台测试随完整 `verify` 一起运行。
详细状态见 [验证记录](VALIDATION.md)。

实现参考 Tampermonkey 官方文档：

- `https://www.tampermonkey.net/documentation.php?locale=en&q=meta:sandbox`
- `https://www.tampermonkey.net/documentation.php?locale=en&q=api:GM_xmlhttpRequest`
- `https://www.tampermonkey.net/documentation.php?locale=en&q=api:GM_info`

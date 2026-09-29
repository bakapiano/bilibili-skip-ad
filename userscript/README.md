# BiliSkip 油猴版

当前版本 `0.1.4.2`。使用 Chrome 120+ 与 Tampermonkey 5.4+，通过个人 DeepSeek API Key 识别 B站字幕中的植入广告。
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

发布到 Greasy Fork 时使用重新构建的完整 `.user.js`，文件头包含 `@license MIT`，随后附有 [MIT 许可全文](../LICENSE)。

## 首版功能

- 中文 → 英文 → 其他语言字幕回退，复用原有字幕地址解码与 Protobuf 适配。
- 同一套 `deepseek-flash` 提示词、JSON 输出、字幕编号映射和严格校验。
- 原生进度条金色区间；播放中与主动定位到广告时自动跳过；暂停状态保持。
- 手动跳过、撤销、广告边界试听、侧边推荐视频与分 P 切换。
- 油猴本地缓存、线上共享查询、自动／手动上传，包括零广告结果。
- API 用量、参考费用、识别耗时与缓存来源显示。
- 面板按油猴菜单打开，关闭后继续处理当前标签页任务。
- 同源标签页共享 Web Locks，分析任务互斥，上传任务互斥；忙碌时提示稍后读取缓存。
- 从浏览器历史页面缓存恢复时重新挂载控制器，并复用已保存结果。

线上服务固定为 `biliskipad.bakapiano.com`。自部署到其他域名时，同步修改共享服务常量与构建脚本中的 `@connect` 白名单并重新构建。

## 代码复用

构建实际引入 12 个现有扩展文件。Chrome 继续直接加载 `extension/`，油猴通过 esbuild 打包成单文件。

| 共享内容                                 | 源文件                                        | 两端的使用方式                        |
| ---------------------------------------- | --------------------------------------------- | ------------------------------------- |
| 提示词、模型、默认配置                   | `extension/lib/constants.js`                  | 保持模型与提示词版本一致              |
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
- 本地标记、上传回执与最近 200 条事件逐条保存到 GM；完整字幕上下文和运行任务保存在当前页内存。
- 两个版本各有自己的本地设置与缓存；相同字幕、视频和版本可复用同一份线上标记。
- 默认开启共享读取、允许上传与自动上传。设置里可分别调整，授权文案位于相应开关旁。
- 页面刷新或关闭会终止本页等待；此前已提交的模型请求可能产生费用，重新识别前先读取缓存。

特权调用通过 GM API 执行，Key 保存在油猴专属存储；运行环境由油猴默认配置决定。
页面环境中的 JavaScript 对象可能受网站脚本影响，建议为模型调用设置专用额度。面板的闭合 Shadow DOM 用于封装样式和控件。
DOM 节点用于展示和检测双版本冲突，模型操作通过脚本内部函数调用。
网络适配器限制 HTTPS 域名、接口、方法和请求头，设置 `redirect: "error"`，核对最终 URL，桥接超时／中止。
GM 使用 ArrayBuffer 接收响应后校验 4 MiB 大小上限，随后进入原有解析与校验流程；此上限作用于解析阶段。

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

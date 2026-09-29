# V1 验收状态

更新时间：2026-09-29（Asia/Shanghai）。验收状态：通过。0.1.2 已完成真实 Chrome 主流程验收，完整记录见 `CHROME_E2E_REPORT.md`；下方历史排查保留供追溯。

## 0.1.2 本轮新增范围

- [x] 原生主进度条、底部细进度条叠加广告色带，点击穿透。
- [x] 主动定位进广告时自动跳末尾，覆盖重复跳入与暂停状态。
- [x] 侧边推荐 SPA 校验改用 Chrome 当前标签页 URL，并对切换瞬间做有限只读重试。
- [x] 新媒体先就绪、路由稍后被轮询观察到的顺序回归。
- [x] 真实 Chrome + 合成媒体回归：定位、重复定位、撤销、播放边界、开关、路由与进度条重建。详见 `BROWSER_PLAYER_REGRESSION.md`。
- [x] 重载 0.1.2 后，真实 B站原生进度条、模型识别、缓存、播放动作及侧边切换逐项验收通过。

## 已完成

- [x] 纯 Chrome MV3 实现：设置、DeepSeek 直连、本地 IndexedDB、内容脚本、弹窗。
- [x] 字幕 Protobuf 与编码 URL 适配、空列表一次有限只读重试。
- [x] 广告编号/证据/指纹严格校验、缓存复用、并发去重、任务中断恢复。
- [x] 默认关闭的自部署 HTTPS 共享查询和候选上传接口。
- [x] 65 项 JavaScript 测试（其中 8 项原有油猴测试），40 项 Python 回归。
- [x] 原生 fetch 接收者错误在真实 Chrome Window/Worker 中复现；修复后 8 项浏览器 fixture 检查通过（包含两个负对照）。
- [x] 增补后台消息链路测试、分环节网络诊断、字幕失败时的公开 Key 状态回传。
- [x] 共享服务切换回执隔离：本地按 origin 和 payload 哈希保存，HTTP 幂等键保持稳定。
- [x] Manifest、JS 语法、模块/资源完整性、凭据字面量检查。
- [x] Windows 打包完成，zip 根目录 Manifest 与 17 个文件校验通过。
- [x] 真 B站字幕 + 真 DeepSeek API 联调，包含两次缓存命中且模型请求总数为 1。
- [x] Chrome 打开原视频，核对 519 秒媒体和视频标题。

## 真实接口证据

`runs/extension-live-2026-09-28T16-32-08-916Z/report.json`

- 245 句，字幕获取 300ms；模型调用 1,539ms。
- 转转广告 166.940–202.730 秒，字幕 82–105，自评分 0.97。
- 输入 7,039 / 输出 233 token；估算空闲 ¥0.007971 / 高峰 ¥0.015942。
- 模型请求 1 次，本地缓存命中 2 次，待上传 0 条。
- 执行环境明确为 Node + fake-indexeddb，`chromeE2E: false`。
- 在有限重试加入前，两次准备阶段曾返回空字幕；两次均在模型请求前结束。这些失败报告保留在相邻 `runs/extension-live-*` 目录。

## 用户首次加载交接

已验证发布包：`dist/biliskip-0.1.2-20260929-112832.zip`。

SHA-256：`bd00502a7406182c0be8a95766b6570f12e995ef6a1609d96859dd8598569a2b`。

当前浏览器工具明确阻止访问扩展管理页及本扩展的内部设置页。用户已完成首次安装，源码目录为：

```text
E:\bilibili-skip-ad\extension
```

Chrome → 扩展程序 → 管理扩展程序 → 开发者模式 → 加载已解压的扩展程序。

已为后续验收打开原视频，标签页属于「🧪 BiliSkip E2E」会话。完成状态由下面各项实证决定。

续轮检查：浏览器尚未出现 BiliSkip 设置页；再次打开指定视频，标题和 519 秒时长匹配，`biliskip-extension-root` 尚未出现。首次加载仍是当前真实 E2E 的交接点。

连续三轮遇到同一首次加载交接点，最新只读核验仍为原视频 519 秒、扩展面板缺席。已将 goal 标记 blocked，等待用户回复「已加载」后恢复真实 Chrome E2E；实现、自动化测试和接口联调证据全部保留。

### 09:37 后续实测（替代上述首次加载等待状态）

- 已在指定视频发现 `biliskip-extension-root`，媒体时长 519 秒；内容脚本与后台消息链路已运行。
- 发现已打开的「BiliSkip 设置」标签页。工具对该 `chrome-extension://…/options.html` 的访问明确阻止，Key/授权配置由用户在该页完成。
- 视频面板实际报「B站请求未完成，请检查网络和登录状态后重试」，后台错误根因仍待定位。
- 已修复错误掩盖问题：新源码分别标识元数据/旧字幕接口/Protobuf/CDN、网络/JSON/超时；字幕失败时仍回传已配置 Key 的公开状态。
- 新源码的 51 项 JS 测试与打包通过。普通视频页刷新仍显示旧诊断，用户需要在扩展管理页重载 BiliSkip 一次，再刷新视频以应用更新。
- 09:42 的独立 Node 字幕复查返回 `NO_SUBTITLE`：Protobuf 两次均为空列表，HTTP 均为 200，模型请求 0 次。报告为 `runs/extension-live-2026-09-29T01-42-28-763Z/report.json`。该结果与 Chrome 的笼统网络错误分别记录，暂不合并推断原因。

用户随后确认 Key 已配置。已通过视频页的自动跳过开关同步后台公开设置，面板按钮变为「分析当前视频」，证明后台已返回 `hasKey=true` 与 `consent=true`。已点击真实分析按钮，仍得到旧版 B站网络错误，当前阶段止于字幕加载。

验收视频目前暂停在约 52.79 秒，时长 519 秒。当前交接仅为：用户在扩展管理页重载 BiliSkip，随后继续通过视频面板的新诊断排查并完成真实分析/缓存/播放测试。

### 用户重载后的定位结果

- 新诊断已生效：视频面板显示 `BILI_NETWORK`，具体为「视频元数据接口连接失败（TypeError）」。Key/授权状态正确，按钮为「分析当前视频」。
- 同一 Chrome 直接访问该视频的 `/x/web-interface/view?bvid=BV1pFUDBKE8X` 也失败，导航返回 `net::ERR_BLOCKED_BY_CLIENT`。
- Chrome 错误页原文为「api.bilibili.com 已被屏蔽」「此页面已被 Chrome 屏蔽」，错误码 `ERR_BLOCKED_BY_CLIENT`。页面没有指明拦截扩展或策略的名称。
- 因此当前确认的阻塞层是 Chrome 客户端对 API 域名的拦截。字幕、模型、缓存和播放端到端验证须在该域名恢复可访问后继续。
- 浏览器安全/隐私或请求过滤设置的调整交由用户完成；本轮保持现有过滤配置，保留原视频验收标签页。

以上自动化观察随后得到新的反证，当前结论以下方更新为准。

### 用户手动访问与权限截图对照（修正拦截范围判断）

- 用户确认：在自己的 Chrome 手动访问相同元数据 API 可以正常打开。因此，自动化标签页的 `ERR_BLOCKED_BY_CLIENT` 不能直接归结为用户浏览器全局屏蔽该域名。
- 用户提供 BiliSkip 权限截图：「自动允许访问以下网站」总开关开启，列出 B站、B站 API、字幕 CDN 和 DeepSeek 域名；下方域名单独开关为灰色。
- 已读取 Chromium 官方 `host_permissions_toggle_list.ts` 与 `host_permissions_toggle_list.html.ts`。总开关对应 `HostAccess.ON_ALL_SITES`；域名单独开关的 `disabled` 绑定到 `allowedOnAllHosts_()`。因此子项灰色符合总开关开启后的正常 UI 联动，不能据此认定权限关闭。
- 已检查本项目 Manifest，所需 API/CDN/DeepSeek host permissions 均已声明。尚需区分扩展实际请求权限、扩展请求上下文和自动化环境的行为差异。
- 当前普通用户标签页列表中没有发现指定测试视频的对照页面。本轮保持原有浏览器权限和过滤规则，未继续更改扩展运行代码。

当前交接：在普通 Chrome 标签页手动打开 `BV1pFUDBKE8X`，观察右下角 BiliSkip 面板能否读取字幕，并提供面板状态。该步骤用于对照环境差异，暂不需要调整“放行”规则。

### 普通视频页对照与代码根因（最新结论）

用户截图确认普通视频页同样在扩展请求元数据时失败。随后对原生 fetch 的调用接收者做最小复现：三个客户端均将原生函数作为 `this.fetcher()` 调用，Chrome Window 和 WorkerGlobalScope 中都抛出 `Illegal invocation`。

已统一绑定 `fetcher.bind(globalThis)`，升级到 `0.1.1`。相同真实浏览器 fixture 中三个客户端在两个上下文均返回本地 HTTP 200，原始未绑定调用作为负对照仍按预期抛错。详见 `BROWSER_FETCH_REGRESSION.md`。

此前要求调整浏览器“放行”规则的推断已撤回。当前需要重载更新后的扩展，再验证 B站、DeepSeek 的实际请求和播放器动作。配置与 Key 沿用原有存储。

### 0.1.1 重载后的真实 B站结果

已在真实 Chrome 读取到 `data-build=0.1.1`、`data-state=ready`、`data-cache-source=local-cache`。原视频为 519 秒，面板显示 245 句字幕、转转 166.94–202.73 秒、自评分 0.97、模型耗时约 1.53 秒。该结果证明 fetch 修复后 B站准备链路与本地缓存已实际运行。

之后用户新增原生进度条标记、点入广告跳到末尾，并报告侧边推荐切换的身份校验错误。本轮合并为 0.1.2；当前交接为重载 0.1.2 后继续真实 B站验收。

0.1.2 打包完成后的现场检查：刷新真实视频页仍读到 `data-build=0.1.1`。已恢复指定原视频并暂停于约 12.80 秒，保留「🧪 BiliSkip E2E」标签页。重载后需要核对 `data-build=0.1.2`，再检查原生色带、暂停/重复定位跳过、缓存计数以及实际侧边推荐切换。

本轮核对的官方源码：

```text
https://raw.githubusercontent.com/chromium/chromium/main/chrome/browser/resources/extensions/host_permissions_toggle_list.ts
https://raw.githubusercontent.com/chromium/chromium/main/chrome/browser/resources/extensions/host_permissions_toggle_list.html.ts
```

## 真实 Chrome 主流程验收结果

- [x] 用户首次加载；已发现设置页标签、内容脚本和来自后台的响应。
- [x] Key 与字幕授权已由用户配置，并通过视频页与后台同步后的按钮状态确认。
- [x] 后台准备、模型请求、校验和入库在真实扩展中运行。
- [x] 刷新 `BV1pFUDBKE8X`；面板读到 245 句，真实分析显示对应转转区间。
- [x] 在视频面板读取当前视频请求计数；刷新缓存与整页重载均保持模型计数不变。
- [x] 试听广告前 2 秒，正常播放越过边界自动跳到 202.78 秒。
- [x] 点击及重复点击原生进度条广告段均跳到广告末尾。
- [x] 撤销返回跳过前进度，继续播放时保留该片段。
- [x] 同一缓存刷新后继续保持撤销状态。
- [x] 侧边合集切到另一个视频，旧广告清除，新标记正确加载；切回及相邻视频往返均通过。
- [x] 真实内容页面板及原生进度条完成视觉核对。

验收范围保留说明：设置页、弹窗的全量原生点击巡检及保存后密码框状态，受工具内部 URL 限制未自动化观察；安装与 Key/授权由用户实际完成。主流程以实际模型调用、IndexedDB 复用和播放行为验证配置成功，未将受限 UI 项冒充为观察结果。详见 `CHROME_E2E_REPORT.md`。

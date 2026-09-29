# 原生 fetch 调用上下文：真实 Chrome 回归

时间：2026-09-29，北京时间 10:23–10:24。

## 根因

三个请求客户端都曾将原生 `fetch` 保存为类成员，然后通过 `this.fetcher(...)` 调用。Chrome 的原生 API 会校验接收者；此时接收者变成客户端实例，导致 `TypeError: Illegal invocation`，请求在发送前终止。

这解释了普通 Chrome 可以访问 B站 API、而插件后台在元数据步骤立即得到 TypeError 的现象。此前自动化标签页单独打开 API 得到的 `ERR_BLOCKED_BY_CLIENT` 是另一条观察，不能直接作为插件自身错误或用户浏览器全局拦截的根因。

Node 的内置 fetch 与原先的箭头函数测试替身没有暴露接收者校验问题，因此原有 Node 测试全部通过仍然漏掉了这个浏览器缺陷。

## 最小复现

本地 fixture 仅监听 `127.0.0.1`，只提供明确允许的测试文件、项目模块和 `/probe` JSON。测试直接加载 `extension/lib/bilibili.js` 和 `extension/lib/providers.js`，在真实 Chrome 的 Window 和专用 WorkerGlobalScope 中执行各客户端的 `fetcher`。测试请求均发往本地 `/probe`。

| 用例                     | 修复前 Window / Worker    | 修复后 Window / Worker                    |
| ------------------------ | ------------------------- | ----------------------------------------- |
| 原始未绑定调用（负对照） | 均抛出 Illegal invocation | 均抛出 Illegal invocation，符合负对照预期 |
| BilibiliClient           | 均抛出 Illegal invocation | 均 HTTP 200                               |
| DeepSeekClient           | 均抛出 Illegal invocation | 均 HTTP 200                               |
| SharedClient             | 均抛出 Illegal invocation | 均 HTTP 200                               |

修复前 UI 报告时间：`2026-09-29T02:23:14.392Z`，状态 `failed`。

修复后 UI 报告时间：`2026-09-29T02:24:28.014Z`，状态 `passed`，8 项预期全部满足（包含两个负对照）。

真实 Chrome 错误原文分别包含：

```text
Failed to execute 'fetch' on 'Window': Illegal invocation
Failed to execute 'fetch' on 'WorkerGlobalScope': Illegal invocation
```

## 修复与防回归

三个客户端统一使用 `fetcher.bind(globalThis)`。补充 3 项 Node 回归，使用会校验接收者的普通函数替身分别执行 B站、DeepSeek 和共享请求链路。当前 Node JavaScript 测试共 54 项。

扩展版本更新为 `0.1.1`，视频面板 DOM 的 `data-build` 来自后台公开设置，可用于确认更新已加载。用户存储的 Key、设置与数据库沿用原扩展 ID。

本次人工验证使用的脚本已归入本机 `.tmp/`（Git 忽略）。保留该临时脚本的工作区可执行：

```powershell
node .tmp/browser-fixture-server.js
```

用 Chrome 打开命令输出的本地 URL，查看 8 项测试结果。浏览器实际广告识别、缓存和播放验收仍由 `E2E_STATUS.md` 单独记录；本回归仅证明原生请求绑定行为。

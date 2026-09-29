# 调研记录：B站植入广告的自动标记

调研日期：2026-09-28。目标是个人本地 PoC：字幕识别广告，现有 Codex CLI 承担 LLM 分类，播放器按标记跳转。

## 结论

技术路线可行，已经有字幕 + AI 自动跳广告的公开实现。本 PoC 的重点是把 LLM 接口替换为本机现有的 Codex 调用，并用原始字幕编号约束广告边界。

## 相关项目

| 项目 | 已核实的做法 | 可借鉴部分 |
| --- | --- | --- |
| `hanydd/BilibiliSponsorBlock` | 小电视空降助手；社区标注区间，浏览器读取并跳过；有公开 API 和数据下载入口 | 播放器交互、分类定义、人工标记评估集 |
| `qingmeng1/bilijump-ai` | 字幕优先；可用音频转录；调用模型标记；自动/手动跳过，支持缓存和纠错 | 已有完整 AI 跳过流程，适合后续集成 |
| `chemhunter/biliadskip` | 油猴脚本抓字幕、识别广告提示弹幕并调用 AI | 轻量级脚本形态和浏览器侧取数据 |
| `ccBilly-aipm/bilibili-ai-subtitle` | 查询旧版 JSON 及新版 Protobuf 字幕元数据，导出带时间轴字幕 | 新接口字段布局、字幕格式化和获取失败排查 |

核实方式：读取上述项目的 README，检查 `bilijump-ai` 的 `content.js` 字幕与模型调用路径，并针对给定视频请求实际接口。

源码链接：

- https://github.com/hanydd/BilibiliSponsorBlock
- https://github.com/hanydd/BilibiliSponsorBlock/wiki/API
- https://github.com/hanydd/BilibiliSponsorBlock/wiki/Sponsor
- https://github.com/qingmeng1/bilijump-ai
- https://github.com/qingmeng1/bilijump-ai/blob/main/BilibiliAiSkip/content.js
- https://github.com/chemhunter/biliadskip
- https://github.com/ccBilly-aipm/bilibili-ai-subtitle

本项目采用独立的轻量实现。若后续复用第三方源码或发布 fork，应对照相关仓库的许可证和署名要求逐项检查。

## 给定视频的接口实测

视频：`https://www.bilibili.com/video/BV1pFUDBKE8X`

元数据：

```text
GET https://api.bilibili.com/x/web-interface/view?bvid=BV1pFUDBKE8X
aid = 115608825956470
cid = 34253507696
duration = 519 s
```

旧版 `/x/player/wbi/v2` 和 `/x/player/v2` 匿名请求返回空字幕列表。浏览器字幕菜单展示中文轨道，实际播放器同时使用新版接口：

```text
GET https://api.bilibili.com/x/v2/subtitle/web/view
    ?oid=34253507696&pid=115608825956470&type=1
    &context_ext={"video_type":1}
    &cur_production_type=0&preferred_language=ai-zh
```

新版响应为 Protobuf。根字段 1 对应字幕信息，其重复字段 3 对应轨道；轨道内字段 3、4、5 分别为语言、显示名与字幕地址。

本轮接口返回 `subtitle.bilibili.com` 形式的编码地址。实际播放器会 URL 解码、按公开的格式常量做 XOR 字符变换，得到 `aisubtitle.hdslb.com` 的原始字幕路径，并保留短期签名参数。

在浏览器已加载资源清单中观察到真实字幕地址后，又核对了当时的公开播放器代码：

https://s1.hdslb.com/bfs/static/player/main/core.ba67b466.js

`poc.py` 实现了该地址格式兼容。使用新版接口与地址解析后，已直接从终端匿名取得 245 条中文字幕。程序将字幕和元信息保存到本地，短期签名 URL 保留在请求内存中。

这一结果说明“旧接口空列表”需要结合新接口和浏览器字幕状态判断。其他视频仍可能需要登录态或 ASR。

## Codex 接入

官方非交互模式文档：

- https://developers.openai.com/codex/non-interactive/
- https://learn.chatgpt.com/docs/non-interactive-mode

并交叉核对本机 `codex exec --help`（CLI 0.154.0）。使用的能力包括 stdin 提示词、`--output-schema`、`--output-last-message`、`--ephemeral`、`--sandbox read-only` 和 `--skip-git-repo-check`。

沿用本机现有模型 provider 配置，可完成实际分类。本地 CLI 负责启动和编排，推理由已配置的模型服务执行。应按该服务的认证、限额和数据处理要求使用。

Windows 下直接经 `.cmd` 传递嵌套 TOML 参数容易遇到转义问题，因此改为使用安装包自身的 Node 启动器。MCP 服务逐个设置 `enabled=false`，保留原传输定义以通过配置校验。

## 本次分类结果

本轮模型输入仅包含标题、完整字幕与编号，社区标记并未作为分类输入。

```text
品牌：转转
字幕 ID：81–105（含两端）
开始：163.940 s
结束：202.730 s
时长：38.790 s
模型自评分：0.98
首次实际 CLI 分类耗时：16.1 s
```

检查原字幕：第 81 句为广告引入，第 82 句明确致谢赞助商；第 105 句结束推广；第 106 句在 203.210 秒恢复正文。边界存在字幕自身的精度和语义选择空间，最终体验应通过试听验证。

第二轮从视频链接开始重跑完整获取与分类流程，输出区间仍为 163.940–202.730 秒；模型自评分 0.97，Codex 阶段耗时 16.473 秒。两次是同一视频的重复验证，泛化表现由后续独立样本测试评估。

## 后续设计建议

1. 先积累 30–50 条跨 UP 主、题材、广告长短的视频评估样本，尤其收集正常评测、正文提及品牌、整片商单等易混淆场景。
2. 将“误跳正文秒数”列为核心指标，再看广告区间召回率和边界误差。
3. 给通用浏览器前端接 localhost 服务：显式分析按钮、任务队列、鉴权、严格来源限制、超时和缓存。
4. 字幕获取失败时添加本地 ASR 输入适配；视觉检测用于静默贴片和二维码。
5. 长视频采用带重叠上下文的分窗检测，再做边界精修和去重；广告评分通过评估集校准后调整自动跳过策略。

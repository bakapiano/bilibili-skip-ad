# DeepSeek Flash 直连实测

日期：2026-09-28。复用原 Codex PoC 的同一份 B站 AI 字幕，通过官方 DeepSeek Chat Completions API 分类一次。

## 方法

- API：`POST https://api.deepseek.com/chat/completions`
- 请求模型：`deepseek-flash`；响应模型：`deepseek-flash`
- 官方价格页列出的模型版本：DeepSeek-V4.1-Flash
- `thinking.type = disabled`
- `response_format.type = json_object`
- `temperature = 0`；`max_tokens = 2048`；`stream = false`
- 输入为高优先级分类规则、输出结构说明和全片字幕；沿用 Codex 的分类规则与句编号。
- API Key 从 `DEEPSEEK_API_KEY` 读取。项目文件与生成的请求正文均采用环境变量引用或占位符。

本轮输入由 245 条字幕、标题、视频身份和字幕校验和组成；输入 token 还包括分类指令和 JSON 格式说明。

```text
视频：BV1pFUDBKE8X / P1 / CID 34253507696
视频长度：519 秒
字幕覆盖：0.520–517.559 秒
字幕 SHA-256：2de4709ddcf341c032c0d800e7b215ef2227db660c8456415fc54d6724b603a4
请求开始：2026-09-28T22:41:11.815593+08:00
请求结束：2026-09-28T22:41:14.389325+08:00
耗时：2.574 秒（包含 HTTP 网络耗时）
finish_reason：stop
实际模型请求数：1
```

## 识别结果

| 项目 | DeepSeek Flash | 前次 Codex 基线 |
| --- | --- | --- |
| 广告数量 | 1 | 1 |
| 品牌 | 转转 | 转转 |
| 首句 ID | 82 | 81 |
| 尾句 ID | 105 | 105 |
| 开始时间 | 166.940 秒 | 163.940 秒 |
| 结束时间 | 202.730 秒 | 202.730 秒 |
| 广告区间长度 | 35.790 秒 | 38.790 秒 |
| 单轮耗时 | 2.574 秒 | 16.1 秒 |

Flash 选在明确的赞助商致谢句起跳，保留了之前 3 秒的正文衔接句。两者均在“说回正题”之前结束标记。上述比较是单视频、不同调用方式的实测记录，泛化性能由后续评估集验证。

Flash 的自评分为 0.97。它是模型的排序信号，精度应由人工标注样本评估。

## 用量和费用

API 返回：

```json
{
  "prompt_tokens": 7179,
  "completion_tokens": 282,
  "total_tokens": 7461,
  "prompt_cache_hit_tokens": 0,
  "prompt_cache_miss_tokens": 7179
}
```

本次北京时间 22:41，按官方时段定义属于空闲时段。2026-09-28 核实的人民币价格：

| 每百万 token | 空闲时段 | 高峰时段 |
| --- | ---: | ---: |
| 输入缓存命中 | ¥0.02 | ¥0.04 |
| 输入缓存未命中 | ¥1 | ¥2 |
| 输出 | ¥4 | ¥8 |

```text
本次估算 = (0 × 0.02 + 7179 × 1 + 282 × 4) / 1,000,000
         = ¥0.008307
         = 0.8307 分钱

相同用量高峰估算 = ¥0.016614
```

按同等输入输出规模外推：

| 视频数 | 空闲时段 | 高峰时段 |
| --- | ---: | ---: |
| 1 | ¥0.008307 | ¥0.016614 |
| 1,000 | ¥8.307 | ¥16.614 |
| 10,000 | ¥83.07 | ¥166.14 |

这些是模型 API 费用估算。本轮使用现成字幕，费用外推基于相同 token 规模。字幕量、输出长度、思考模式、缓存、请求次数及有效价格都会改变费用；实际扣费以官方账单为准。

计费实现把输入分成命中和未命中两部分。`completion_tokens` 已包含思考模式产生的思考 token，计费使用总输出一次。程序始终提供两种时段价格；工作日白天的法定节假日归属留待用户确认。价格快照的日期随结果保存。

## 本地结果文件

- [结果和证据](runs/BV1pFUDBKE8X-p1-deepseek-flash/review.md)
- [广告区间 JSON](runs/BV1pFUDBKE8X-p1-deepseek-flash/segments.json)
- [原始 token 用量和费用估算](runs/BV1pFUDBKE8X-p1-deepseek-flash/api-usage.json)
- [实际请求正文](runs/BV1pFUDBKE8X-p1-deepseek-flash/api-request.json)
- [油猴脚本](runs/BV1pFUDBKE8X-p1-deepseek-flash/skip.user.js)

`runs/` 用于本地验证，已被 `.gitignore` 排除。再次运行会产生新的请求用量。

## 官方参考

本次直接读取官方页面并核对接口字段：

- 模型和人民币价格：https://api-docs.deepseek.com/zh-cn/quick_start/pricing
- Chat Completions：https://api-docs.deepseek.com/zh-cn/api/create-chat-completion
- JSON Output：https://api-docs.deepseek.com/zh-cn/guides/json_mode
- 思考模式：https://api-docs.deepseek.com/zh-cn/guides/thinking_mode

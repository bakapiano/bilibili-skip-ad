# 自部署共享缓存协议 V1

本文代码路径以仓库根目录为基准。更多文档见 [文档索引](README.md)。

浏览器扩展 `0.1.4` 默认查询 `https://biliskipad.bakapiano.com`，新分析结果保存本地后默认自动上传，可在设置中关闭；工具栏弹窗保留手动上传入口。最小服务端位于 `server/`，使用 Node HTTP + SQLite。启动与部署见 [后端说明](../server/README.md) 和 [线上部署记录](../server/DEPLOYMENT.md)。

## 启用条件

设置 `sharedBaseUrl` 为 HTTPS 域名根地址，例如 `https://cache.example.com`。用户在扩展设置页选择查询/上传功能后，为这个具体 origin 授予可选访问权限。可以配置独立 `sharedToken`。

所有请求使用 5 秒超时、禁止重定向和 `credentials: omit`，JSON 响应上限 256KiB。请求体采用字段白名单。DeepSeek Key 和 B站会话始终留在各自原有链路。

## 查询已发布标记

公开统计使用 `GET /v1/stats`，返回：

```json
{
  "schema_version": 1,
  "cached_videos": 70,
  "cached_parts": 70,
  "cached_records": 72,
  "ad_segments": 25,
  "saved_seconds": 1471.209,
  "basis": "latest-active-per-video-part-ad-duration",
  "updated_at": "2026-10-01T08:49:38.967Z"
}
```

数字为部署验收时快照。该接口公开、只返回聚合数据，采用 `Cache-Control: public, max-age=60`。
时长按每个 `(BV, 分 P)` 最新有效记录的广告时长汇总，视频数按 BV 去重。
私有标记接口继续执行下方身份、版本和可选令牌校验。

README徽章使用以下公开只读接口，统计口径与`/v1/stats`一致，HTTP缓存300秒：

- `GET /v1/badges/videos`：缓存视频数。
- `GET /v1/badges/segments`：广告片段数。
- `GET /v1/badges/saved-time`：广告时长按秒／分钟／小时展示。

例如`/v1/badges/segments`返回Shields Endpoint格式：

```json
{
  "schemaVersion": 1,
  "label": "广告片段",
  "message": "380 段",
  "color": "3b82f6",
  "cacheSeconds": 300
}
```

路径采用固定白名单；GET携带查询参数返回400，POST返回405，未知统计项返回404。徽章读取复用现有聚合缓存，提交限流计数保持原值。

```http
GET /v1/segments?bvid=BV1pFUDBKE8X&page=1&cid=34253507696&transcript_sha256=<sha256>&model=deepseek-flash&prompt_version=ad-cues-v6-json
Accept: application/json
Authorization: Bearer <独立共享服务令牌，可选>
```

无匹配返回 `404`。命中返回：

```json
{
  "schema_version": 1,
  "status": "published",
  "model": "deepseek-flash",
  "prompt_version": "ad-cues-v6-json",
  "labels": {
    "video_key": "BV1pFUDBKE8X:p1:34253507696",
    "transcript_sha256": "<完整64位sha256>",
    "summary": "识别总结",
    "segments": [
      {
        "start_id": 82,
        "end_id": 105,
        "brand": "转转",
        "confidence": 0.97,
        "reason": "赞助口播与下单引导",
        "evidence_ids": []
      }
    ]
  }
}
```

客户端重新核对完整视频/字幕绑定、模型/提示词版本、发布状态、句编号、证据与区间重叠。秒数来自当前字幕的重新映射。有效记录进入本机 IndexedDB；命中本地缓存后跳过共享查询。

`0.1.9`客户端使用`ad-cues-v6-json`，线上后端保留v1–v5并新增v6，缓存按版本独立。
模型采用仅广告JSON v2输出，共享API继续使用绑定完整身份的内部JSON标签。v3–v6允许空证据列表。
2026-10-02新增独立`transcripts`表用于转写准确度评估，广告记录保留原结构和查询行为。

## 上传候选

新分析结果按设置自动上传，或用户在工具栏弹窗点击「上传到线上缓存」时调用：

```http
POST /v1/candidates
Content-Type: application/json
Idempotency-Key: <请求体canonical JSON的sha256>
Authorization: Bearer <独立共享服务令牌，可选>
```

请求字段：

| 字段                      | 内容                                                                      |
| ------------------------- | ------------------------------------------------------------------------- |
| `schema_version`          | `1`                                                                       |
| `video`                   | 白名单 `bvid/page/cid/duration/title/part`                                |
| `transcript_sha256`       | 当前规范化上下文指纹                                                      |
| `model`, `prompt_version` | 检测版本                                                                  |
| `labels`                  | 与查询返回的 labels 相同字段集合                                          |
| `segments`                | `start_id/end_id/start/end/brand/confidence/reason/evidence_ids/evidence` |
| `evidence`                | 每段最多 10 句，每句仅 `id/from/to/content`，文本最多 500 字符            |

回执：

```json
{ "schema_version": 1, "status": "pending", "submission_id": "server-generated-id" }
```

`status` 可为 `pending` 或 `accepted`；两者均为候选提交回执，发布状态通过查询接口单独表达。相同 idempotency key 返回相同提交结果。扩展将失败候选留在 outbox，用户再次上传沿用同一 key；已成功提交的候选直接返回本机保存的回执。

本地 outbox 按「目标 origin + payload 哈希」区分回执。切换共享服务域名后，同一标记会向新服务独立提交；切回原服务时可复用原有回执。HTTP `Idempotency-Key` 始终为请求体哈希。

## 上传本地转写字幕

`POST /v1/transcripts`使用JSON和相同的可选共享令牌，请求上限512KiB。
`Idempotency-Key`为完整请求体canonical JSON的SHA-256。请求字段：

| 字段                | 内容                                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------- |
| `schema_version`    | `1`                                                                                                  |
| `video`             | `bvid/page/cid/duration/title/part`，视频时长最多3600秒                                              |
| `asr_version`       | `sensevoice-int8-1.12.20-vad-04-12-cues-v2`                                                          |
| `client_version`    | 如`0.1.9`                                                                                            |
| `transcript_sha256` | 下方算法定义的`{video,cues}`指纹                                                                     |
| `cues`              | 完整的`{id,from,to,content}`数组，ID从1连续递增，时间按毫秒规范化；最多10000句、序列化最多120000字符 |

服务端重新计算字幕指纹，按视频／ASR版本／字幕指纹去重；首次201、重复200，回执为
`{"schema_version":1,"status":"accepted","submission_id":"..."}`。
数据以`unreviewed`保存于独立表，供维护者后续评估。`GET /v1/transcripts`返回405，公开统计保持原来的广告汇总口径。
本接口与广告候选提交共用每IP每1000ms一次的限流；超出返回429和`Retry-After`。
客户端提交队列在上次响应后至少间隔1000ms，以兼容连续的转写／广告上传。失败保留本地结果与错误回执。
转写上传使用独立的`asrUpload`设置，默认开启，发送前再次核对开关和目标域名；普通字幕及缓存读取沿用既有流程。

## 指纹算法

使用 UTF-8 编码的 canonical JSON，递归按对象键名排序、数组保留顺序、数字使用 JavaScript `JSON.stringify` 的表示。散列输入为 `{video,cues}`。

`video` 是 `bvid/page/cid/duration/title/part`；`cues` 是按原始顺序生成的 `{id,from,to,content}`，ID 从 1 开始、时间四舍五入至毫秒、文本去两端空白。具体规范实现位于 `extension/lib/core.js`。

跨语言服务端需要对齐 JavaScript 数字序列化，例如 `1` 与 `1.0` 的差别会影响哈希。共享服务以本协议、扩展实现和测试向量为准。

## 当前最小服务端策略

1. `POST /v1/candidates` 按来源 IP 控制相邻放行请求至少间隔 1000ms，SQLite 原子记录计数。错误 JSON、认证失败和幂等重试都计入提交限流。
2. 超限返回 `429` 与 `Retry-After`；每日统计次数用于观察，保存最近 7 个 UTC 日期。
3. 请求上限 64KiB，校验字段白名单、canonical 请求体哈希、视频绑定、编号范围、时间区间和证据。
4. 按本版简化目标，首条校验通过的提交直接进入共享缓存，返回 `accepted`；查询状态为 `published`。这里的发布表示缓存准入，内容准确性需要后续反馈和复核。
5. 同一缓存身份的完全相同请求复用提交回执；不同内容返回 `409`，保留原记录。本机管理命令可撤销记录，查询随后返回 `404`，同键新提交返回 `410`。
6. 代理 IP 来源须显式配置。服务默认使用 TCP 连接来源；只有可信代理可通过被覆盖的 `X-Real-IP` 提供客户端地址。
7. 管理入口为服务器本机命令，包含 IP 计数查看、最近标记和记录撤销。

未来可增加用户反馈、独立模型复核和签名校验。当前插件按所配置域名提供的共享结果工作，并用本次完整字幕重新验证句编号和时间边界。

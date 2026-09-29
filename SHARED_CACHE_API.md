# 自部署共享缓存协议 V1（预留）

浏览器扩展已实现默认关闭的查询与候选上传适配器。服务端由后续独立任务部署在用户控制的公开 HTTPS 域名。这里定义接口边界和验收约束。

## 启用条件

设置 `sharedBaseUrl` 为 HTTPS 域名根地址，例如 `https://cache.example.com`。用户在扩展设置页选择查询/上传功能后，为这个具体 origin 授予可选访问权限。可以配置独立 `sharedToken`。

所有请求使用 5 秒超时、禁止重定向和 `credentials: omit`，JSON 响应上限 256KiB。请求体采用字段白名单。DeepSeek Key 和 B站会话始终留在各自原有链路。

## 查询已发布标记

```http
GET /v1/segments?bvid=BV1pFUDBKE8X&page=1&cid=34253507696&transcript_sha256=<sha256>&model=deepseek-flash&prompt_version=ad-cues-v1
Accept: application/json
Authorization: Bearer <独立共享服务令牌，可选>
```

无匹配返回 `404`。命中返回：

```json
{
  "schema_version": 1,
  "status": "published",
  "model": "deepseek-flash",
  "prompt_version": "ad-cues-v1",
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
        "evidence_ids": [82, 102]
      }
    ]
  }
}
```

客户端重新核对完整视频/字幕绑定、模型/提示词版本、发布状态、句编号、证据与区间重叠。秒数来自当前字幕的重新映射。有效记录进入本机 IndexedDB；命中本地缓存后跳过共享查询。

## 上传候选

用户在视频面板主动点击「上传此标记为候选」后调用：

```http
POST /v1/candidates
Content-Type: application/json
Idempotency-Key: <请求体canonical JSON的sha256>
Authorization: Bearer <独立共享服务令牌，可选>
```

请求字段：

| 字段 | 内容 |
| --- | --- |
| `schema_version` | `1` |
| `video` | 白名单 `bvid/page/cid/duration/title/part` |
| `transcript_sha256` | 当前规范化上下文指纹 |
| `model`, `prompt_version` | 检测版本 |
| `labels` | 与查询返回的 labels 相同字段集合 |
| `segments` | `start_id/end_id/start/end/brand/confidence/reason/evidence_ids/evidence` |
| `evidence` | 每段最多 10 句，每句仅 `id/from/to/content`，文本最多 500 字符 |

回执：

```json
{"schema_version":1,"status":"pending","submission_id":"server-generated-id"}
```

`status` 可为 `pending` 或 `accepted`；两者均为候选提交回执，发布状态通过查询接口单独表达。相同 idempotency key 返回相同提交结果。扩展将失败候选留在 outbox，用户再次上传沿用同一 key；已成功提交的候选直接返回本机保存的回执。

本地 outbox 按「目标 origin + payload 哈希」区分回执。切换共享服务域名后，同一标记会向新服务独立提交；切回原服务时可复用原有回执。HTTP `Idempotency-Key` 始终为请求体哈希。

## 指纹算法

使用 UTF-8 编码的 canonical JSON，递归按对象键名排序、数组保留顺序、数字使用 JavaScript `JSON.stringify` 的表示。散列输入为 `{video,cues}`。

`video` 是 `bvid/page/cid/duration/title/part`；`cues` 是按原始顺序生成的 `{id,from,to,content}`，ID 从 1 开始、时间四舍五入至毫秒、文本去两端空白。具体规范实现位于 `extension/lib/core.js`。

跨语言服务端需要对齐 JavaScript 数字序列化，例如 `1` 与 `1.0` 的差别会影响哈希。现有 Python PoC 使用自己的历史指纹；共享服务以本协议实现和测试向量为准。

## 服务端后续实现要求

1. 上传入口视所有客户端字段为不可信输入。验证 JSON schema、体积、时间/编号范围、视频身份与摘要。
2. 所有上传先进入候选队列。`published` 由服务端独立审查或复核流程产生。
3. 请求令牌、IP、视频维度设置速率/配额限制与异常检测，保存审计事件和撤销入口。
4. 合并多用户一致标记时考虑独立身份、历史质量和投毒风险；关键标记可重新获取字幕并用服务端模型复核。
5. 客户端声明的模型名和置信分仅作为候选信息，发布前结合证据判断。
6. 当前适配器将所配置 HTTPS 域名视为共享结果提供方，未来可增加版本化签名校验。服务端仍负责内容质量。

以上为未来服务端契约与设计要求，当前仓库交付范围是浏览器端适配器和协议测试。

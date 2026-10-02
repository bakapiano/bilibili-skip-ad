# 本地语音识别接入设计

日期：2026-10-01。本文保留接入前的设计与POC证据；`0.1.8` 已完成本地ASR试用集成，当前实现与边界以 [ASR试用说明](asr-trial.md) 为准。

追加 [6/8路及CPU占用实测](testing/asr-parallel-high-2026-10-01.md)：6/8路保留完全相同的转写及时间戳，独立WASM堆为3/4GiB。当前高负载环境中8路比6路少约14%转写等待，并行上限仍应结合实际可用内存。

现有CPU模型已完成 [1/2/4 Worker并行对照](testing/asr-parallel-2026-10-01.md)：全片107.74/64.88/39.45秒，保留相同词级时间戳和229条字幕；四路WASM堆合计2GiB，其他模型与音频缓冲另计。可作为后续集成的可配置加速方案。

后续 [SenseVoice RapidSpeech WebGPU 实测](testing/sensevoice-webgpu-2026-10-01.md) 已完成：65秒三轮为9.49/8.46/8.33秒，全片518.455秒为93.62秒（复用已有VAD边界）。GPU路径可运行，词级时间戳需另适配；正式默认方案和CPU回退暂沿用现有sherpa。

后续已完成 [Whisper-small WebGPU 对照实验](testing/whisper-webgpu-2026-10-01.md)。同一 65 秒片段，SenseVoice CPU 为 12.83 秒，Whisper GPU 为 42.16 / 46.37 秒；默认模型继续优先选择现有 SenseVoice CPU。

## 接入位置

语音识别提供带时间戳字幕，继续复用当前广告模型请求、编号校验、缓存、时间条和跳过控制器。

```text
确认 BV / P / CID 和视频元数据
  → 按当前顺序尝试中文、英文、其他语言字幕
  → 得到可用字幕：normalize
  → 字幕不可用且用户启用本地转写：
      本机 ASR 字幕缓存 → 命中后 normalize
      首次转写 → 音轨下载 → 浏览器解码为 16kHz 单声道
               → VAD + SenseVoice → token 时间戳切句 v2 → normalize
  → 按字幕哈希查询本地 / 线上广告缓存
  → 缓存缺失：现有 DeepSeek 分析，或后续接入 Qwen 的独立分段分析
  → 严格校验 → 本机保存 → 按设置上传广告标记 → 播放器标记与跳过
```

首版建议显式启用“无字幕时使用本地转写”，首次提示下载体积，提供下载、排队、音频处理、转写和广告分析进度。
字幕接口网络失败、权限失败和确实无轨道分别呈现，用户可重试字幕或选择本地转写。
首版完成全片转写、固定编号后再做广告分析，逐步产出的中间结果保留为任务进度。

## 已选模型与实测

沿用已经跑通的 **SenseVoiceSmall INT8 + Silero VAD**，sherpa-onnx 1.12.20 WASM SIMD、CPU 单线程。
模型固定到本机 `dist/asr-poc/model-assets.json` 所记文件及哈希；后续换模型独立评测。
Sherpa 官方提供 SenseVoice 的中、英、日、韩、粤语模型。当前 B站中文样本的质量和速度已实测。

| 资源                     |                                      大小 |
| ------------------------ | ----------------------------------------: |
| SenseVoice 主权重        |                          239,233,841 字节 |
| 模型数据包，含 VAD、词表 | 240,193,589 字节，约 240.2 MB / 229.1 MiB |
| WASM 运行时              |               11,539,169 字节，约 11.5 MB |
| 上述数据包和 WASM 合计   |             251,732,758 字节，约 251.7 MB |

建议发布时把 JS 和 WASM 随扩展打包；模型数据按需下载，版本和 SHA-256 固定在包内可信清单中。
POC 的 `.data` 内容来源及文件布局应在迁移时复核，只分发所需模型和词表数据。

### 首次模型下载估算

按 240.2 MB 模型数据和**实际下载吞吐**计算：

| 实际速度 | 纯下载估算 |
| -------- | ---------: |
| 1 MB/s   |     4 分钟 |
| 5 MB/s   |      48 秒 |
| 10 MB/s  |      24 秒 |
| 20 MB/s  |      12 秒 |

这是大小除以速度的估算；连接、服务器限速、校验、缓存写入和初始化另计。
建议由自有域名提供固定版本静态模型文件，部署前实测带宽与 Range / 断点续传。
已有本机缓存时读取和初始化：之前 Chrome 实测约 4.46 秒，此值来自本机服务提供资源。

### 识别速度

2026-09-30，Ryzen 5 3600 / 32GB RAM / Chrome 154，518.455 秒音轨：

- ASR：105.796 秒，RTF 0.204，约 4.90 倍实时。
- 含本机音频读取处理：106.211 秒。
- WASM 已分配线性内存：512 MiB；解码音频、JS 和缓存缓冲区另计。
- 89 个语音段均有 token 时间戳，切句 v2 生成 229 条字幕。
- 按该样本线性外推，10 分钟音频约 122 秒转写；其他 CPU 和音频复杂度需要实测。

原始报告：`dist/asr-poc/reports/2026-09-30T13-31-13-125Z-49757960.json`。
Qwen 与 ASR 独立选择：当前可先完成 CPU 本地转写，再用现有 DeepSeek 识别广告；本地 Qwen 路径另需 WebGPU 和自己的模型缓存。

## 多 Tab 复用

### 磁盘缓存

同一 Chrome 用户配置、同一扩展 ID 的页面共用扩展 origin 存储：

- 模型文件：扩展 origin 的 CacheStorage，一份固定版本模型供全部视频 Tab 复用。
- 下载任务：全局一份进行中的 Promise / 状态，多个 Tab 订阅同一进度。
- 转写字幕：IndexedDB；同一 BV/P/CID、音轨身份、模型哈希、VAD 和切句版本命中后直接读取。
- 广告标记：继续按现有视频身份、字幕哈希、模型和提示词版本匹配。
- Chrome、Edge、不同浏览器用户配置分别维护各自存储；隐身会话单独处理。

扩展后台及扩展页面持有缓存，内容脚本通过消息访问。官网 POC 和正式扩展各有自己的 origin 缓存。
提供缓存大小、删除模型、清理转写结果入口。评估 `unlimitedStorage` 权限或持久存储，并处理写入失败、磁盘不足及用户清理后的重新下载。

### 内存中的模型实例

建议新增扩展 **offscreen document + 一个 ASR Worker**：

```text
视频 Tab A ─┐
视频 Tab B ─┼→ 扩展后台任务调度 → 单个 offscreen 页面 → 单个 ASR Worker
视频 Tab C ─┘                      音频解码 / 缓存       模型实例 / 串行转写
```

这是代码架构保证的一份模型实例。仅共享 CacheStorage 时，各自创建的 Worker 仍各占一份运行内存。
相同视频任务去重、共享进度；不同视频串行排队。任务绑定视频身份和订阅 Tab，导航后只向仍匹配的页面发送结果。
空闲一段时间后结束 Worker，保留磁盘缓存，下次重新加载。

offscreen 页面使用包内静态 HTML；按实际用途声明 `WORKERS` 等理由。
扩展 API 调用集中在后台，offscreen 通过 runtime 消息交换任务元数据和进度，IndexedDB/CacheStorage 使用 Web API。
音频解码得到的大块 PCM 在 offscreen 与 Worker 间通过可转移 ArrayBuffer 传递。
扩展后台休眠、重启、浏览器崩溃均需任务恢复机制，任务 owner 与进度持久化。
Chrome 官方允许每扩展单个 offscreen 页面，split 隐身与常规配置分别计数。

## 现有源码需要调整的点

1. `extension/lib/bilibili.js`：拆开身份/元数据与字幕获取，增加有边界和来源校验的音轨适配。
2. 新增字幕来源协调器：优先当前轨道流程，按设置调用 ASR；输出统一 `normalize()` context。
3. `extension/lib/service.js`：现有 `load()` 直接调用 `bili.load()`；接入协调器，增加音频/转写阶段、取消和排队。
4. `extension/lib/db.js`：迁移式增加转写及下载任务存储，保留已有 records/settings。
5. 从 POC 提取 ASR Worker、token 时间戳切句 v2 和模型校验器；正式构建使用仓库可获取资源。
6. `manifest.json`：评估并增加 offscreen、音频 CDN/模型下载权限，CSP 加入 `wasm-unsafe-eval`。
7. 音轨优先走已有播放权限可访问的 DASH 音频；固定 HTTPS 域名白名单，校验 CID、时长、体积，避免日志保存签名 URL。
8. 原 POC 的 B站音轨预处理使用过本机 FFmpeg；正式纯浏览器要单独跑通完整 M4A/DASH 的读取、解码、重采样和失败处理。

长音频首版应设置时长和内存保护。完整音轨的 `decodeAudioData()` 可能持有较大的原采样率音频缓冲；后续按需评估 demux/WebCodecs 分块解码。
音频转写在本机执行；选择 DeepSeek 时，需要明确告知用户转写文字将发给 DeepSeek。共享上传继续遵循设置，明确标记里可能附带少量字幕证据。

## 字幕哈希与共享缓存边界

当前 `normalize()` 的指纹由 `{video,cues}` 计算，`source` 本身单独记录。来源标签不能独立承担版本隔离。
ASR 转写本地索引应包含模型、VAD、切句和音轨版本；广告标签继续严格绑定最终字幕哈希。
相同视频采用 B站字幕与 ASR 字幕时，文字和时间戳通常产生不同指纹。
ASR 结果先落盘，下次访问复用同一字幕和编号，提升命中率并节省转写时间。

现有共享查询要求 `transcript_sha256`，首次无字幕访问必须先取得转写 context 才能精确查缓存。
若未来要实现“首次无字幕也直接拿已有时间区间”，需另设计按视频身份发现候选并验证的服务协议，独立评估视频版本与安全绑定。
当前后端的模型白名单和缓存身份仍按正式 DeepSeek 路径配置；Qwen 正式共享要另做模型版本接入。

## 验收建议

- 有字幕视频继续走原流程；中英及其他语言回退、无字幕、登录和请求异常分别覆盖。
- 两个 Tab 同视频同时启动：一份模型下载、一份转写；切换视频、关闭其中一个 Tab 的结果路由正确。
- 不同视频排队、取消、后台重启恢复、内存释放后重新加载。
- 冷下载、缓存加载、断网命中、损坏文件、磁盘写入失败。
- 完整 B站音轨浏览器下载解码，时间偏移及广告边界与原字幕对照。
- ASR 字幕再次访问命中；模型/VAD/切句版本更新触发新转写索引。
- 正式常规回归使用固定模拟数据；真实转写和付费广告识别分别记录。

## 官方依据

2026-10-01 直接读取官方页面，返回 HTTP 200。检索工具本轮未返回可用摘录，以下页面通过本机 HTTPS 请求核验；摘要保存在 `.tmp/asr-poc/integration-source-check.json`。

- Chrome Offscreen API：`https://developer.chrome.com/docs/extensions/reference/api/offscreen?hl=en`
- Chrome 存储范围、配额与分区：`https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies?hl=en`
- Chrome 远端代码范围，含 JS/WASM 与数据区分：`https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code?hl=en`
- sherpa-onnx SenseVoice 文档：`https://k2-fsa.github.io/sherpa/onnx/sense-voice/index.html`

模型数据按需下载的发行方案建立在包内固定运行时和纯模型数据加载上；最终依赖打包结果与商店审核另行核验。

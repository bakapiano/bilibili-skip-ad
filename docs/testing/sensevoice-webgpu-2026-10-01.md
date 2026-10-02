# SenseVoice RapidSpeech WebGPU 实测

日期：2026-10-01。状态：独立浏览器 POC 完成，生产代码和线上缓存保持原状。

## 结果

SenseVoiceSmall Q8 经 RapidSpeech 的 WebGPU 路径完成 65 秒音频的三次转写及全片转写。
运行时明确加载 `WebGPU backend`，观测器记录实际 GPUQueue.submit；全部成功段均有 GPU 提交。

| 音频            | RapidSpeech Q8 WebGPU | 原 sherpa INT8 CPU 对照                                     |
| --------------- | --------------------- | ----------------------------------------------------------- |
| 同一 65 秒片段  | 9.49 / 8.46 / 8.33 秒 | 同日 Chrome 实测 12.83 秒（含 VAD），ASR 解码 12.12 秒      |
| 完整 518.455 秒 | 93.62 秒，89 段       | 9月30日 Chrome 实测 105.80 秒（含 VAD），ASR 解码 100.15 秒 |

GPU 本轮使用原 CPU 报告中的 Silero VAD 起止边界，输入仅为音频和时间边界；参考转写文字和广告标签未送入 GPU 模型。
短片段实际送入 ASR 的语音长度 57.564 秒，全片 463.328 秒。GPU 表中包含音频特征提取、模型和文本解码，VAD 与浏览器音频读取另外计时。
因此，两者是不同模型转换/量化和运行时的方案对照；纯 GPU 硬件加速比需要同一运行时 CPU 构建测试。

短片段后两轮平均 8.40 秒，约比旧 CPU 解码 12.12 秒减少 31% 时间。
全片 GPU 为约 5.54 倍音轨实时速度，较历史 CPU 解码时间减少约 6.5%。
全片实际接入还要增加 VAD 耗时和词级对齐成本，最终收益应以集成后实测为准。

三轮短片段全文逐字相同，文本 SHA-256 均为：
`0a8b4f54d5cc79df22a6eefad449943a753af2a60b3e0f0baa73f560ece3ef8d`。
单样例三次重复验证用于观察重复性，总体中文质量需要更多样例。

## 构建与来源

- 本机：Ryzen 5 3600、32GB RAM、RTX 3080 12GB，Chrome 154。
- 模型：RapidAI/RapidSpeech 的 `ASR/SenseVoice/sense-voice-small-q8_0.gguf`。
- 模型 revision：`4e19f044daba004f590efe6cc6129827f4849201`。
- 模型大小：292,012,352 字节，约 292 MB。
- 模型 SHA-256：`51e4a1eef8d2364fbf4380c20864e91c4d45552403207719eabe375b9ac446a7`，与上游 LFS 身份一致。
- 运行时：RapidAI/RapidSpeech-wasm Space 发布的 JS、WASM 与 bridge。
- 运行时 revision：`ab1acb125a407c5d17e5b733b1f1e0dd1b26e737`；内部版本字符串 `0.1.0`。
- WASM 大小 3,994,038 字节；JS 138,214 字节；完整来源清单在本机 `dist/sensevoice-webgpu/assets.json`。
- 实验文件准备合计 296,168,119 字节，本次约 28.79 秒；其中模型下载约 22.44 秒。

项目当前源码 `f3b08460c937a9a039f736565ed6e0812b1a6006` 用于接口理解；实际速度对应上方发布构建，二者分别记录。
发布构建原始字节保持原样，仅新增本机调用适配和 GPU 调用观测器。

## 加载与资源

缓存后的两次模型初始化合计分别为 1.257 秒与 1.249 秒，包含文件读取和哈希核验。
其中模型缓存读取及 SHA-256 约 0.63 / 0.59 秒。
GPU 着色器首次使用开销体现在首次推理中：第一个短段 2.07 秒，后续各段通常约 1.0–1.1 秒。

- 模型初始化和全片结束的 WASM 线性内存均为 415,956,992 字节，约 396.7 MiB。
- 额外音频、JS、CacheStorage 与显存另计。
- 整卡显存仅做点测：加载时 1700MiB、短片段完成后 1738MiB、全片过程中 1745MiB。这些是整卡采样点，含桌面与其他进程。
- 短片段每轮 2248 次 GPU 提交；全片 25009 次。
- 调度日志为 GPU+CPU 混合后端，部分操作可以在 CPU 执行。

计时来自浏览器 performance.now；运行时组件日志显示全片特征提取约 0.52 秒、编码器约 92.07 秒、文本解码约 0.95 秒。
编码器计时包含其执行路径开销；进一步细分 GPU 算子、同步与数据传输需要性能分析。

## 文字与时间戳

广告线索在本次结果中保留，包括“本期视频的赞助商转转”“二手回收平台”“一键下单”“闲置物品”，正文恢复句“ok那我们说回正题”单独落在 VAD 段中。
结果仍有语音识别常见错字，如“阿三克”“随脚随道”“通统”；原始标签和文字保留在 JSON 中。

关键接入限制是 **时间戳粒度**：

- 当前发布 bridge 的 `process()` 返回 `{status,text}`，可公开读取的是完整段文本。
- 本 POC 展示的 start/end 来自预先计算的 VAD 边界；每个词的时间位置还需另外获取。
- 全片广告引入所在 VAD 段为 **164.888–174.320 秒**，其中同时含正常正文和广告引入。
- 参考广告起点是 166.94 秒；仅凭这个段落范围无法直接还原该精细起点。
- 现有 sherpa CPU 结果提供模型 token 时间戳，当前字幕切句 v2 正在使用它们。

后续集成优先考虑：在 RapidSpeech 的 CTC 解码路径保留并导出 token/frame 对齐信息，继续复用现有切句器；或者对广告候选附近增加独立对齐阶段，并单独评估成本。

## 失败记录与修正

1. 首次初始化模型已成功，但实验内存统计读取了当前构建未导出的 `HEAPU8`。改用构建公开导出的 `HEAPF32.buffer.byteLength` 后加载和推理正常。这是 POC 适配错误，原始失败报告保留。
2. 尝试同运行时 Q8 CPU 对照时，在独立 Worker 中以能力测试替身让 `requestAdapter()` 返回 null。发布包进入 WebGPU 后端断言并终止，没有取得 CPU 计时。浏览器和系统 GPU 设置保持原状。
3. 已将页面中的该 CPU 探测选项标记并禁用。正式 CPU 回退可继续采用已验证的 sherpa 实现；同运行时性能对照需要另准备 CPU 构建。

## 本机产物

- [POC 运行说明](../../dist/sensevoice-webgpu/README.md)
- [结果汇总](../../dist/sensevoice-webgpu/evaluation.json)
- [全片页面截图](../../dist/sensevoice-webgpu/full-result.png)
- [短片段第一轮](../../dist/sensevoice-webgpu/reports/2026-10-01T13-12-38-015Z-c89f9d5f.json)
- [短片段第二轮](../../dist/sensevoice-webgpu/reports/2026-10-01T13-13-35-288Z-86be2fb5.json)
- [短片段第三轮](../../dist/sensevoice-webgpu/reports/2026-10-01T13-14-02-563Z-09c9e19a.json)
- [完整音轨结果](../../dist/sensevoice-webgpu/reports/2026-10-01T13-16-35-699Z-aecfeea4.json)
- [首次适配错误](../../dist/sensevoice-webgpu/reports/2026-10-01T13-11-27-430Z-3e9af530.json)
- [CPU 能力探测中止](../../dist/sensevoice-webgpu/reports/2026-10-01T13-14-24-367Z-88759502.json)

脚本位于 `.tmp/sensevoice-webgpu/`；浏览器入口 `http://127.0.0.1:43821/`。
资源身份、音轨哈希、VAD 边界、每段成功状态和 GPU 提交均由 evaluate.mjs 核验；专项 ESLint 与 Prettier 通过。
本机服务器限定回环与同源报告写入，浏览器 CSP 仅允许连接本机；音频、模型结果和日志均保留本机。
API Key、Cookie、付费模型调用、共享上传和部署均为 0。

## 官方项目来源

- 项目：`https://github.com/RapidAI/RapidSpeech.cpp`
- 发布 WASM：`https://huggingface.co/spaces/RapidAI/RapidSpeech-wasm`
- GGUF 模型：`https://huggingface.co/RapidAI/RapidSpeech`

运行时与模型权重各自许可需在正式集成时核对，发布包再整理许可证和归属说明。

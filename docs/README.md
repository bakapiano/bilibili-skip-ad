# 文档索引

项目安装与功能概览见 [根目录 README](../README.md)，代码协作规范见 [AGENTS.md](../AGENTS.md)。
文档中的命令、反引号标注的代码和产物路径，以仓库根目录为基准；Markdown 链接按当前文档位置解析。

## 使用与开发

- [宠物本地预览](pet-preview.md)：气泡动画、单次费用、分组台词、镜像贴边与图片上传裁剪。
- [宠物默认资源](../assets/pet/README.md)：默认角色与音效、校验清单及来源说明。
- [本地Prompt评测环境](../prompt/README.md)：`prompt/`下的614份有效字幕、三项指标、并发试跑及新旧Prompt回归对比。
- [Chrome 扩展安装、架构和开发说明](extension.md)
- [油猴安装、构建与代码共享](../userscript/README.md)
- [共享缓存 API 协议](shared-cache-api.md)
- [后端运行与管理](../server/README.md)
- [线上部署配置与操作记录](../server/DEPLOYMENT.md)
- [模型输入输出精简方案与决策](compact-prompt-plan.md)
- [本地语音识别接入设计](local-asr-integration.md)
- [本地ASR试用说明](asr-trial.md)
- [0.1.9更新日志](releases/0.1.9.md)
- [0.1.10更新日志](releases/0.1.10.md)
- [0.2.0更新日志](releases/0.2.0.md)
- [语音模型自有域名与提前下载验收](testing/model-download-2026-10-01.md)
- [油猴WASM/VAD资源与SRI瘦身](testing/userscript-sri-2026-10-01.md)

## 发布与介绍

- [Chrome 商店打包与材料](chrome-web-store.md)
- [商店素材文件说明](../store/README.md)
- [一分钟介绍视频稿](../store/intro-video-script.md)

## 验证记录

- [0.2.0打包验收](testing/release-0.2.0-2026-10-08.md)：版本一致性、正式扩展与油猴包、完整性校验和提交范围。
- [宠物验收](testing/pet-preview-2026-10-08.md)：默认资源、分组台词、自定义音频、启动就绪与首帧布局。

- [图标与自动保存UI预览](testing/ui-preview-2026-10-03.md)：保持版本号的本地预览，播放器右侧面板、自动保存、开关和全屏回归。

- [油猴0.1.9.1可选ASR降级](testing/userscript-fallback-0.1.9.1.md)：资源缺失、超时和校验失败隔离；字幕、缓存、跳过及共享服务组合故障。

- [0.1.9发布验收](testing/release-0.1.9-2026-10-02.md)：MC／航母真实页面与API、油猴产物、Edge免Key演示、转写上传和缓存分页。

- [1000视频随机抽样与8路字幕采集](testing/community-batch-1000-2026-10-02.md)：336个哈希桶、1000个不同BV、542份有效字幕；字幕阶段约65秒。
- [社区哈希桶抽样与模型对照](testing/community-intake-2026-10-02.md)：10个随机桶、30个候选视频、5份字幕与当前提示词实测，靶场扩充至93条。
- [Prompt Lab首轮现有prompt审计](testing/prompt-lab-audit-2026-10-02.md)：88条弱标注数据、71条原始字幕、社区差异与10例v5复测。
- [正文穿插广告的提示词实验](testing/interleaved-ad-prompt-2026-10-02.md)：三种五列提示词调整与显式正文复核对照，记录改进失败及剩余边界问题。

- [官网蓝白主题与历史列表验收](testing/site-results-2026-10-02.md)：真实示例和布局验收；列表页/API已于同日按要求撤回，保留原始记录。

- [0.1.8 ASR集成与浏览器验收](testing/asr-release-2026-10-01.md)：本地转写、实际DeepSeek、可调短视频豁免和进度条过滤。

- [ASR与字幕任务锁拆分](testing/asr-concurrency-fix-2026-10-02.md)：有字幕／缓存视频独立分析、跨标签页资源互斥及SPA回归。

- [空Key共享缓存模式](testing/keyless-cache-2026-10-02.md)：缓存模式入口、零广告结果、手动本地转写查询及Chrome弹窗回归。

- [明显无关商业植入提示词复测](testing/obvious-ad-prompt-2026-10-01.md)：原7段正文误标视频，新提示词10/10零广告，旧v3三次对照及原始请求归档。

- [SenseVoice CPU 6/8路与CPU占用](testing/asr-parallel-high-2026-10-01.md)：高负载下4/6/8路对照、浏览器与整机CPU采样、内存和加载开销。

- [SenseVoice CPU 多 Worker 对照](testing/asr-parallel-2026-10-01.md)：1/2/4路并行、同音轨精确一致性、全片耗时与内存代价。

- [SenseVoice WebGPU 实测](testing/sensevoice-webgpu-2026-10-01.md)：Q8 三轮短片段与全片结果、GPU 调度证据、VAD 时间戳粒度。

- [Whisper-small WebGPU 语音识别对照](testing/whisper-webgpu-2026-10-01.md)：GPU 短片段/全片转写、CPU 同片段重测、资源和失败记录。

回归与 E2E 报告保留对应版本、测试日期和观察范围。历史测试数量与功能开关按当时状态解读；当前自动化检查使用仓库根目录的 `npm run verify`。

| 记录                                                                | 范围                                   |
| ------------------------------------------------------------------- | -------------------------------------- |
| [Qwen3.5 非思考 POC 归档](testing/qwen35-nonthinking-2026-10-01.md) | 三条正样本、分段合并、格式与边界问题   |
| [主题优先提示词与兼容性](testing/topic-prompt-2026-10-01.md)        | `0.1.7` 提示词实测、缓存隔离与发布顺序 |
| [五列输出与标题输入验证](testing/pipe-protocol-2026-10-01.md)       | `0.1.6` 真实 API 对照与协议验收        |
| [精简字幕输入验证](testing/compact-prompt-2026-10-01.md)            | `0.1.5` 真实 API 用量、费用与 4K POC   |
| [油猴首版验证状态](../userscript/VALIDATION.md)                     | `0.1.4.2` 单文件模拟集成与实机验收清单 |
| [弹窗与自动上传回归](testing/popup-regression.md)                   | `0.1.4` 自动化回归                     |
| [官网与下载验收](../server/SITE_E2E_REPORT.md)                      | 站点、隐私页与 ZIP 下载                |
| [线上缓存验收](../server/E2E_REPORT.md)                             | `0.1.3` 服务端和真实浏览器链路         |
| [真实 Chrome E2E](testing/chrome-e2e.md)                            | `0.1.2` 字幕、模型、缓存与 B站播放     |
| [播放器与进度条回归](testing/browser-player-regression.md)          | `0.1.2` 真实 Chrome 合成媒体测试       |
| [原生 fetch 回归](testing/browser-fetch-regression.md)              | `0.1.1` Window / Worker 接收者问题     |
| [验收状态与历史排查](testing/e2e-status.md)                         | `0.1.2` 及之前的安装、网络与验收过程   |

共享服务、官网和油猴的模块文档保留在各自代码目录，统一从本索引访问。

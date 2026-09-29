# 本地 Qwen3-4B 实测

日期：2026-09-28。目标是在用户自己的 Windows 电脑上用开源小模型，替代云端 LLM 完成字幕中的广告区间标记。

## 选型与部署

- 模型：Qwen 官方 `Qwen3-4B-GGUF`，4.0B 参数，`Q4_K_M` 量化，Apache-2.0。
- 模型原生上下文 32,768 token；本 PoC 分配 16,384 token。
- 权重文件：`Qwen3-4B-Q4_K_M.gguf`，2,497,280,256 字节。
- 模型仓库固定 revision：`bc640142c66e1fdd12af0bd68f40445458f3869b`。
- SHA-256：`7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5`。
- 推理程序：官方 llama.cpp `b11146`，版本输出 `0.5.0-dev / commit 7fe450e19`。
- Windows x64 CUDA 12.4 便携运行包。运行包与 CUDA DLL 包均按官方发布页 SHA-256 校验。
- 模型、程序和安装包总大小约 4.31GB，保存于项目 `.models/`、`.runtime/`，已加入 `.gitignore`。

选择依据：使用发布者提供的量化文件，中文指令能力和 4B 规模适合本机先做小样本验证；16K 上下文足以容纳当前完整字幕及结构化输出。

## 本机配置

| 项目 | 实测 |
| --- | --- |
| GPU | NVIDIA GeForce RTX 3080，12,288MiB 显存 |
| NVIDIA 驱动 | 596.36 |
| CPU | AMD Ryzen 5 3600，6 核 / 12 线程 |
| 内存 | 约 32GB |
| GPU offload 参数 | `--n-gpu-layers 99` |
| Flash Attention | `on` |
| 上下文 / 并发槽位 | 16,384 / 1 |
| CPU 线程 | 6 |

服务首次启动至健康检查通过耗时 10.373 秒；完成停止和重启验证后，启动耗时 3.098 秒。模型加载计时与下面的请求计时分开记录。

一次启停对照：停止模型后整卡显存使用 1,198MiB，重启并推理后 6,152MiB，增量约 4.84GiB。该差值来自整卡快照，其他 GPU 应用也会影响，作为当前配置的粗略资源参考。

## 输入与输出策略

- 与 Flash 基线使用同一份完整字幕、同样的分类指令、句编号和 JSON 字段。
- `/v1/chat/completions` 通过 `127.0.0.1:8766` 调用本地服务。
- 非思考模式；`max_tokens=2048`。
- 使用 JSON Schema 约束输出，并把视频键与字幕哈希设为常量，以绑定输入身份。
- 广告起止仍由模型选择字幕句编号，之后由外层代码生成秒数并校验引用、排序和重叠。
- 采用模型卡的非思考采样参数：temperature 0.7、top_p 0.8、top_k 20、min_p 0、presence_penalty 1.5。
- seed=42；`cache_prompt=false`，两次视频请求返回的缓存计数均为 0。

模型的 tokenizer 不同，Qwen 的输入 token 数与 Flash 的计数分别记录。

## 真实视频结果

视频：`BV1pFUDBKE8X` / P1 / CID `34253507696`，长 519 秒，共 245 句字幕。

字幕 SHA-256：`2de4709ddcf341c032c0d800e7b215ef2227db660c8456415fc54d6724b603a4`。

| 指标 | 本地 Qwen 第 1 轮 | 本地 Qwen 重启后复测 | 前次 Flash |
| --- | ---: | ---: | ---: |
| 广告数量 | 1 | 1 | 1 |
| 起止句编号 | 82–105 | 82–105 | 82–105 |
| 开始秒数 | 166.940 | 166.940 | 166.940 |
| 结束秒数 | 202.730 | 202.730 | 202.730 |
| 请求耗时 | 5.534 秒 | 5.362 秒 | 2.574 秒 |
| 输入 token | 8,848 | 8,848 | 7,179 |
| 输出 token | 355 | 355 | 282 |
| 缓存 token | 0 | 0 | 0 |

三次均标记转转广告，`02:46.940–03:22.730`，长 35.790 秒。Qwen 自评分为 0.9，用作模型自身的排序信号。

首轮 Qwen 的服务端计时：

- 处理输入：2,111.196ms，约 4,191 token/s。
- 生成输出：3,279.399ms，约 108 token/s。
- HTTP 总耗时：5.534 秒。

输入中仅包含视频标题、字幕与输出要求。Flash/Codex 的广告标记作为事后比较数据保存。

## 品牌提及对照

对照输入为自编的相机科普素材，9 句、90 秒，包含佳能 M50、索尼 A6400、机身价格、二手设备及点赞关注提示。预期广告区间为 0；预期标签单独判断，输入标题采用中性的题材描述。

结果：`segments=[]`，耗时 1.804 秒，输入 1,125 token，输出 136 token。

这是一个简单合成对照。当前仅验证一个真实视频和一个合成输入，准确率与召回率需要更多独立样本评估。

## 费用与本地运行范围

这三次模型推理均在本机完成，模型 API 费用为 0；运行成本来自本机电力与硬件使用。GPU 的瞬时功率快照不足以推算整机电费，因此本报告将费用保留为成本构成说明。

已有字幕通过 `detect --provider local` 完成本地推理。从 B站 URL 启动的 `run --provider local` 会先联网获取 B站字幕，再在本机分类。模型加载使用已下载文件及运行器的 offline 模式。

安全与运行设置：

- 服务绑定 `127.0.0.1:8766`，启用项目内随机生成的访问令牌。
- 已验证携带空认证信息的 `/v1/models` 请求返回 HTTP 401。
- 客户端限制回环地址，关闭系统代理与重定向，防止本地访问令牌被转发到外部。
- 模型服务的网页界面、内置 Agent 工具和 MCP 代理已关闭。
- 启停管理核对 PID、可执行文件路径与进程创建时间，保护其他进程。
- 本地访问令牌保存在 `.runtime/local/api.key`，生成的请求正文与结果保持为无认证信息的数据文件。

## 使用与结果文件

```powershell
python local_model.py start
python poc.py run "BV1pFUDBKE8X" --provider local
python local_model.py status
python local_model.py stop
```

- [原视频结果](runs/BV1pFUDBKE8X-p1-local-qwen3-4b/review.md)
- [原视频请求用量](runs/BV1pFUDBKE8X-p1-local-qwen3-4b/local-usage.json)
- [原视频可安装脚本](runs/BV1pFUDBKE8X-p1-local-qwen3-4b/skip.user.js)
- [重启后复测结果](runs/local-qwen3-repeat/segments.json)
- [对照样本结果](runs/local-camera-control/labels.json)
- [合成对照原文](examples/camera-control.json)
- [固定版本与文件校验值](local-model.json)

本轮：40 项 Python 测试、8 项播放器测试通过；本地脚本通过 JavaScript 语法检查；本地模型启停与 API 认证经过实际验证。

## 一手来源

- 官方模型卡与量化文件：https://huggingface.co/Qwen/Qwen3-4B-GGUF
- 固定版本模型卡：https://huggingface.co/Qwen/Qwen3-4B-GGUF/blob/bc640142c66e1fdd12af0bd68f40445458f3869b/README.md
- 官方推理程序发布与文件摘要：https://github.com/ggml-org/llama.cpp/releases/tag/b11146
- 程序对应版本的 API 文档：https://github.com/ggml-org/llama.cpp/blob/b11146/tools/server/README.md

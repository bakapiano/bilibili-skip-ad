# BiliSkip：Chrome AI 广告跳过 + 多模型 PoC

## Chrome 扩展 V1

第一版纯 Chrome MV3 插件位于 `extension/`：用户配置 DeepSeek Key、直接分析 B站字幕、IndexedDB 本地缓存、自动跳过/试听/撤销，并预留默认关闭的自部署共享服务接口。

安装说明与开发命令见 [EXTENSION.md](EXTENSION.md)，真实接口联调和 Chrome 验收进度见 [E2E_STATUS.md](E2E_STATUS.md)，未来服务协议见 [SHARED_CACHE_API.md](SHARED_CACHE_API.md)。

`0.1.2` 已通过真实 Chrome 主流程验收：原生进度条广告色带、点入广告跳至末尾、重复跳入、试听/撤销、缓存复用及侧边视频切换。详见 [CHROME_E2E_REPORT.md](CHROME_E2E_REPORT.md)。

原有 Python、多模型与油猴 PoC 保留如下。

## 命令行 PoC

单条命令完成：B站视频链接 → 带时间戳字幕 → 本地 Qwen、DeepSeek API 或 Codex CLI → 广告区间 → 可安装的油猴脚本。

本地程序负责获取字幕、调用模型、校验结果和保存标记。`--provider local` 在本机 GPU 上运行 Qwen3-4B；`--provider deepseek` 使用官方 DeepSeek API；`--provider codex` 沿用现有 Codex 模型与认证配置。字幕文本会发送到所选的模型服务。Python 使用标准库。

## 本地小模型：Qwen3-4B

当前项目已部署 **Qwen3-4B 官方 Q4_K_M 量化版**，使用 **llama.cpp b11146 / CUDA 12.4**。模型权重约 2.50GB，连同便携运行程序与安装压缩包共约 4.31GB，位于本项目的 `.models/` 和 `.runtime/`。

在本机 RTX 3080 12GB 上实测：

- 同一条 8 分 39 秒视频，245 句字幕，连续两轮分别耗时 **5.534 秒 / 5.362 秒**。
- 两轮都识别 **转转，02:46.940–03:22.730**，与 Flash 的时间区间一致。
- 每轮输入 8,848 token、输出 355 token，缓存命中 0。模型的 tokenizer 与云端模型不同。
- 一个包含佳能、索尼、二手设备、价格和点赞关注的合成相机科普对照，返回 **0 个广告**，耗时 1.804 秒。
- 当前 16K 上下文配置下，整卡启停对照的显存增量约 **4–5GiB**。该值受其他 GPU 进程影响。

### 本地使用

```powershell
# 已部署环境：启动服务（已运行时会显示当前状态）
python local_model.py start

# 复用字幕进行本地识别
python poc.py detect runs/BV1pFUDBKE8X-p1/transcript.json --provider local

# 或从视频链接开始获取字幕并识别
python poc.py run "BV1pFUDBKE8X" --provider local

# 查看服务状态
python local_model.py status

# 停止服务，释放模型占用的显存
python local_model.py stop
```

全新环境可以先运行 `python local_model.py setup`，下载固定版本文件并核对 SHA-256。便携包用于 Windows x64 NVIDIA 环境。首次启动实测约 10.4 秒，系统缓存就绪后的重启约 3.1 秒；上述 5 秒级分类计时从模型已加载开始。

本地服务监听 `127.0.0.1:8766`，由脚本自动读取项目内生成的访问令牌。服务使用离线模型加载模式，关闭内置工具与网页界面。客户端固定使用回环地址，并跳过系统 HTTP 代理。已有字幕可在本机完成识别；从视频链接取字幕时会访问 B站。

本地后端使用非思考模式与 Schema 约束输出，运行成本来自本机电力与硬件使用。默认输出目录为 `runs/BV1pFUDBKE8X-p1-local-qwen3-4b/`，内含请求、用量、最终答案、时间区间和油猴脚本。

详细版本、硬件与测试记录见 [LOCAL_MODEL_BENCHMARK.md](LOCAL_MODEL_BENCHMARK.md)。目前是一个真实视频和一个合成对照的验证，更多题材和复杂植入需要独立评估。

## DeepSeek Flash：直接 API 调用

`--provider deepseek` 使用 `deepseek-flash`，默认关闭思考、开启 JSON Output，输出上限 2048 token。模型返回字幕句编号，原有校验器生成精确时间段和油猴脚本。

先在当前 PowerShell 进程中设置密钥。可以通过隐藏输入读取，随后执行：

```powershell
$dsSecret = Read-Host "DeepSeek API Key" -AsSecureString
try {
    $env:DEEPSEEK_API_KEY = [System.Net.NetworkCredential]::new("", $dsSecret).Password
    python poc.py run "BV1pFUDBKE8X" --provider deepseek
} finally {
    Remove-Item Env:DEEPSEEK_API_KEY -ErrorAction SilentlyContinue
    $dsSecret.Dispose()
}
```

环境变量已设置时，可直接复用已获取的字幕：

```powershell
python poc.py detect runs/BV1pFUDBKE8X-p1/transcript.json --provider deepseek
```

该后端的默认输出目录为 `runs/BV1pFUDBKE8X-p1-deepseek-flash/`，独立于 Codex 基线。除公共输出文件外，还会生成：

- `api-request.json`：实际请求正文，包括分类指令、Schema 和字幕。
- `api-usage.json`：响应 ID、模型、耗时、原始 token 用量、缓存分项及费用估算。

API Key 通过进程环境读取，认证信息仅放在发往官方 HTTPS 地址的请求头中。程序采用单次请求策略；若输出被截断或 JSON 校验失败，已返回的 API 用量仍保留供费用核对。

### Flash 本次实测：2026-09-28

同一份 245 条字幕，调用时间为北京时间 22:41，属于空闲时段，真实调用 1 次。

| 指标 | 结果 |
| --- | --- |
| 视频长度 | 8 分 39 秒 |
| 输入 token | 7,179；缓存命中 0，未命中 7,179 |
| 输出 token | 282 |
| API 耗时 | 2.574 秒 |
| 广告 | 转转，02:46.940–03:22.730，字幕 82–105 |
| 空闲价估算 | ¥0.008307，约 0.83 分钱 |
| 相同用量的高峰价估算 | ¥0.016614，约 1.66 分钱 |

本轮以当前官方价格快照计算：空闲时段每百万 token 输入缓存命中 ¥0.02、未命中 ¥1、输出 ¥4；高峰分别为 ¥0.04、¥2、¥8。见 [deepseek-pricing.json](deepseek-pricing.json)。

按同等输入输出规模，1,000 条视频的模型调用费约为空闲 ¥8.31 / 高峰 ¥16.61。该数字用于本样本规模的外推，实际费用随字幕量、输出长度、缓存、调用次数和有效价格变化。最终金额以官方账单为准。

Flash 起点在明确的赞助商致谢句，保留了前一条过渡句；Codex 起点包含该过渡句，两者广告终点相同。单视频结果用于验证流程，泛化精度由后续样本集评估。

完整记录见 [DEEPSEEK_BENCHMARK.md](DEEPSEEK_BENCHMARK.md)。

## Codex 对照实测

2026-09-28，视频 `BV1pFUDBKE8X`，第 1 P，CID `34253507696`，时长 519 秒。

- 直接获取 245 条 B站 AI 中文字幕，覆盖 `00:00.520` 至 `08:37.559`。
- 第一轮真实 Codex CLI 分类耗时 **16.1 秒**（包括进程启动），识别 **1 段转转推广**。
- 起止字幕 ID：**81–105**，时间 **02:43.940 → 03:22.730**，约 **38.79 秒**。
- 字幕 82 明确致谢赞助商；105 为最后的推广句；106 为“说回正题”。81 是广告专属引入，预览时建议重点试听这里。
- `0.98` 是该轮模型自评分。它用于优先级与跳过门槛，准确率需要独立样本评估。
- 第二轮从链接开始的一键流程也已通过，Codex 阶段耗时 16.473 秒，返回相同时间边界，自评分为 0.97。

真实结果位于 `runs/BV1pFUDBKE8X-p1/`。该目录和下载的字幕已加入 `.gitignore`，用于个人本地验证。

## Codex 运行方式

公共环境为 Python 3.11+；选择 Codex 后端时还需可用的 Codex CLI。Windows npm 安装的 Codex 会通过 Node 启动器调用，以保持参数转义正确。

```powershell
python poc.py run "https://www.bilibili.com/video/BV1pFUDBKE8X" --provider codex
```

输出：

| 文件 | 用途 |
| --- | --- |
| `transcript.json` | 视频信息、字幕编号、时间戳与 SHA-256 |
| `prompt.txt` | 可复查或交给当前 Codex 会话的完整分类输入 |
| `labels.json` | 模型返回的原始句编号标记 |
| `segments.json` | 校验后的视频广告区间、证据、调用耗时 |
| `review.md` | 便于人工核对的时间段和证据 |
| `skip.user.js` | 内嵌该视频标记的独立油猴脚本 |

分 P 和模型参数：

```powershell
python poc.py run "BV1pFUDBKE8X" --page 1 --timeout 180
# 显式选模型时添加 --model <本机可用的模型名>
```

分步执行便于排查和复用字幕：

```powershell
python poc.py fetch "BV1pFUDBKE8X"
python poc.py detect runs/BV1pFUDBKE8X-p1/transcript.json
```

### 在浏览器里试用

1. 在油猴脚本管理器中新建脚本，将生成的 `skip.user.js` 内容粘贴进去并保存。
2. 刷新对应 B站视频页面，右下角出现 BiliSkip 面板，完成 CID 验证后即可操作。
3. 展开标记，点“试听边界”，核对广告引入和回到正文的位置。
4. 点击“开启自动跳过”；评分至少 0.9、总标记覆盖小于半个视频的区间会自动跳过。
5. “撤销跳过”回到跳过前的位置，并在本轮播放中保留该片段。重新开启自动模式会开始新一轮。

脚本默认处于预览模式。每次生成的脚本绑定一个 BV / 分 P / CID，并检查视频时长。标注内嵌在脚本中，播放时仅需一次公开视频身份校验请求。

真实浏览器安装后的验收步骤：从约 `02:42` 播放，确认开启自动模式后进入标记区间会跳到约 `03:22.78`，再用撤销返回。当前自动化覆盖的是模拟 DOM/播放器状态；浏览器安装由使用者操作。

### 将标记工作交给当前 Codex 会话

```powershell
python poc.py prepare runs/BV1pFUDBKE8X-p1/transcript.json
```

把生成的 `prompt.txt` 和根目录 `labels.schema.json` 交给当前会话，请其将结构化结果保存为 `my-labels.json`，再执行：

```powershell
python poc.py render runs/BV1pFUDBKE8X-p1/transcript.json my-labels.json
```

这条路径也可用于人工修改边界。输入视频键和字幕校验和须保持一致。

## 字幕获取

按顺序尝试旧版 JSON 字幕接口和新版 Protobuf 接口，并解析当前播放器的字幕地址编码格式。本示例已验证匿名获取可行。

其他视频若需要登录态，可由使用者在当前终端设置 `BILIBILI_SESSDATA`。程序只向 `api.bilibili.com` 发送这个 Cookie，凭据保留在进程环境中。也可以直接导入原始 B站字幕 JSON：

```powershell
python poc.py run "BV1pFUDBKE8X" --subtitle-json data/BV1pFUDBKE8X.subtitle.json
```

导入格式为 `{"body":[{"from":0.5,"to":2.5,"content":"台词"}]}` 或对应数组。ASR 的结果也可以转换为这个格式。自动语音转写是后续扩展点。

## 识别与安全策略

- 模型选择原始字幕句编号，程序负责生成秒数，边界精度受原字幕时间轴影响。
- 提供全片上下文、分类原则和证据编号。语义范围是独立商业推广段落，产品讨论、频道介绍及三连提示按正文处理。
- 对 BV、CID、分 P、字幕哈希、ID 范围、证据范围、排序、重叠和有限数值进行校验。
- Codex 在临时工作目录中执行，采用只读模式；命令行关闭 shell、联网搜索、子代理及当前配置中的 MCP 服务。
- 字幕中的链接与命令均作为台词数据；模型结果仅进入 JSON 校验和页面文本节点。
- 所有生成结果留在本地。社区提交与共享数据集可作为后续独立功能设计。
- 输入上限为 8 MiB，单次提示词上限 12 万字符。长视频可扩展为重叠分窗及区间合并。

画面贴片、静默二维码等场景需要视觉检测；ASR 可以补充字幕覆盖，视觉检测可以补充静默广告覆盖。

## 测试

```powershell
python -X utf8 -m unittest discover -s tests -v
node --test tests/player.test.cjs
```

测试覆盖字幕解析和地址解码、错误边界、错误视频、空广告结果、证据校验、MCP 配置覆盖，以及播放器的预览、自动跳过、撤销、暂停、拖动和页面切换。

本轮验证：40 项 Python 测试、8 项播放器状态测试全部通过；生成脚本通过 Node 语法检查。测试额外覆盖 DeepSeek 缓存计费、思考 token 计数、错误输出用量保留，以及本地回环限制、代理隔离、进程身份核对和压缩包路径校验。

目前完成了单条真实视频的字幕获取、Codex/DeepSeek/本地 Qwen 分类与脚本生成验证。泛化评估建议选 30–50 条独立视频，记录误跳正文秒数、区间准确率/召回率、边界偏差、耗时和运行成本。

## 下一步

优先把现有脚本升级为通用前端：点击“分析本视频” → 带认证的 localhost 服务 → Qwen / DeepSeek / Codex → 本地缓存。这样每条视频生成一次标记，播放器自动读取结果。缓存键建议包含 BV、CID、字幕哈希、模型及提示词版本。

开源项目比较和接口调研见 [RESEARCH.md](RESEARCH.md)。

# 项目协作规范

## 项目边界

BiliSkip 是原生 JavaScript Chrome Manifest V3 扩展，使用 DeepSeek 分析 B站字幕，
通过 IndexedDB 保存标记并控制视频跳过。项目同时提供可选的自部署共享缓存后端。
保持浏览器直接加载 `extension/` 的工作方式，发布包仅包含该目录。
油猴版通过 esbuild 打包共享模块，平台适配代码位于 `userscript/`。

## 目录约定

- `extension/`：扩展页面、播放器行为和运行时代码。
- `extension/lib/`：字幕、模型、存储、校验和消息模块。
- `userscript/`：Tampermonkey 网络、GM 存储、菜单与入口；业务逻辑复用 `extension/`，产物位于 `dist/biliskip.user.js`。
- `tests/userscript/`：油猴适配、构建和端到端模拟回归。
- `server/`：Node 原生 HTTP + SQLite 共享缓存服务，独立于扩展运行和打包。
- `server/site/`：官网静态页面与公开截图；`scripts/build-site.js` 构建到 `.tmp/site-build/`，由部署脚本与扩展下载包一起发布。
- `tests/extension/`：可重复执行的扩展单元测试、回归测试与固定测试数据。
- `tests/`：工具链等正式回归测试。
- `scripts/`：需要提交的项目检查、构建和打包工具。
- `prompt/`：本机Prompt评测服务、数据整理、采集、指标、界面和`tests/`回归测试。有效字幕数据置`prompt/data/`，运行记录置`prompt/runs/`，二者Git忽略；与线上服务及扩展打包独立。
- `docs/`：跨模块使用说明、架构与协议文档，入口为 `docs/README.md`。
- `docs/testing/`：扩展回归、E2E 与历史排查记录，按验收版本和日期保留原始结论。
- `store/`：商店介绍、隐私说明草稿及宣传图的可重建文案；截图和交付素材保存在 `dist/`。
- `.tmp/`：临时调试、一次性接口探测、浏览器人工验证脚本及其输出，已加入 Git 忽略。
- `data/`、`runs/`、`.models/`、`.runtime/`、`dist/`：本地数据、历史运行结果、模型、运行时和产物，保持 Git 忽略。

新增一次性测试脚本首先放入 `.tmp/`。具备长期回归价值后，将用例整理到 `tests/`，
使用固定数据和模拟服务，随对应功能一起提交。正式 npm 命令只引用仓库内可获取的文件。
根目录 Markdown 保留 `README.md` 和 `AGENTS.md`；新增文档放入 `docs/` 或所属模块目录。
移动文档时同步更新 Markdown 链接、正文路径引用和文档索引。

## JavaScript 和文件格式

- 开发运行时使用 Node.js 22.13+ 的 22.x 或 Node.js 24+，依赖通过 `npm ci --ignore-scripts` 安装。
- 默认使用 ESM；Chrome 内容脚本保持普通脚本；确需 CommonJS 的文件使用 `.cjs`。
- ESLint 使用 `eslint.config.js` flat config，覆盖项目的 `.js`、`.cjs`、`.mjs` 源文件。
- 浏览器页面、扩展 Worker 和 Node 使用各自的全局变量配置。新增运行环境时更新精确文件匹配。
- Prettier 是排版规则的唯一来源；配置位于 `.prettierrc.json`。
- UTF-8、LF、文件末尾换行；JavaScript、JSON、HTML、CSS 使用两个空格缩进。
- PowerShell 使用四个空格缩进。
- JavaScript 使用双引号、分号、尾逗号；目标行宽为 100。
- 每条语句单独成行，每条变量声明只声明一个变量；控制流始终使用花括号。
- 函数体、控制流和多个赋值按逻辑展开，保持可读性；较长样式使用多行 CSS。
- 优先 `const`，需要重新赋值时使用 `let`；比较使用严格相等。
- 函数和变量使用 camelCase，类使用 PascalCase，模块常量使用 UPPER_SNAKE_CASE。
- 文件名沿用 kebab-case；正式回归测试使用 `*.test.js`。
- 注释说明原因、约束和边界；测试替身必须显式标明用途。

## 验证命令

```powershell
npm run lint
npm run lint:fix
npm run format
npm run format:check
npm run verify
npm run pack
```

`lint:fix` 修复可自动处理的代码问题，`format` 统一排版；提交前运行 `verify`。
新增源文件、脚本和测试时同步确认检查覆盖范围。
格式调整保持业务行为和字幕提示词语义；修复现有问题时添加对应回归。
真实模型调用、浏览器 E2E 与模拟测试分别记录验证范围和结果。

## 安全与行为约束

- API Key、Cookie、会话令牌通过用户设置或环境变量提供，凭据保留在本机。
- 调试记录使用脱敏信息；临时脚本遵循与正式代码相同的凭据隔离要求。
- 字幕、视频标题、模型结果和共享缓存均按外部数据处理，进入现有校验流程。
- 维护视频身份、字幕哈希、编号、区间边界、消息来源和授权校验。
- 原生 `fetch` 作为客户端成员保存时，保留 `fetcher.bind(globalThis)`。
- 模型与提示词的语义变化同步评估版本号、缓存身份和回归用例。
- 真实付费 API 测试独立执行；常规回归使用模拟请求。
- 两个平台共用字幕、提示词、缓存协议、播放器控制器和面板视图；平台凭据、权限与生命周期分别适配。
- 油猴采用默认运行环境，Key 保存在 GM 专属存储，保持请求域名白名单、重定向拒绝和跨标签页任务锁。
- 保留用户已有的本地数据和工作区改动；清理临时文件时核对具体路径。
- 提交前检查暂存区和凭据扫描结果，按用户请求执行提交与推送。
- 项目采用 MIT；保持根目录和 `extension/LICENSE` 内容一致，油猴产物附 `@license MIT` 与许可全文，发布包保留许可文件。

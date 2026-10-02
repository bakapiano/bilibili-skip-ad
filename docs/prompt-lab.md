# 本地 Prompt 评测环境

代码、测试、数据整理和完整使用说明现集中在 [`prompt/`](../prompt/README.md)。

- 启动：`npm run prompt`，`npm run lab`保留为相同入口。
- 本机地址：`http://127.0.0.1:43820/`。
- 当前数据：614份有完整字幕的独立输入，包含社区542份和历史回归73份，两集合共享1份输入。
- 数据位置：`prompt/data/`；运行记录：`prompt/runs/`。两者均Git忽略。
- 三项指标：平均IoU、正文误跳率、广告遗漏率；采用≥0.90和播放器50%保护的实际自动跳过区间。
- 对比：选择基线与候选批次，检查完整配对、输入/参考/模型身份和逐视频回归。
- 回归：`npm run prompt:test`，并纳入根目录`npm run verify`。

原始`data/prompt-lab/`与`runs/prompt-lab/`保留，旧快照和历史结论按原验收版本解释。

历史记录：[首轮Prompt审计](testing/prompt-lab-audit-2026-10-02.md)、
[社区试采](testing/community-intake-2026-10-02.md)、
[1000视频并发采集](testing/community-batch-1000-2026-10-02.md)。

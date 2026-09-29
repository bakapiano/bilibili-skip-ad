# 文档索引

项目安装与功能概览见 [根目录 README](../README.md)，代码协作规范见 [AGENTS.md](../AGENTS.md)。
文档中的命令、反引号标注的代码和产物路径，以仓库根目录为基准；Markdown 链接按当前文档位置解析。

## 使用与开发

- [Chrome 扩展安装、架构和开发说明](extension.md)
- [油猴安装、构建与代码共享](../userscript/README.md)
- [共享缓存 API 协议](shared-cache-api.md)
- [后端运行与管理](../server/README.md)
- [线上部署配置与操作记录](../server/DEPLOYMENT.md)

## 发布与介绍

- [Chrome 商店打包与材料](chrome-web-store.md)
- [商店素材文件说明](../store/README.md)
- [一分钟介绍视频稿](../store/intro-video-script.md)

## 验证记录

回归与 E2E 报告保留对应版本、测试日期和观察范围。历史测试数量与功能开关按当时状态解读；当前自动化检查使用仓库根目录的 `npm run verify`。

| 记录                                                       | 范围                                   |
| ---------------------------------------------------------- | -------------------------------------- |
| [油猴首版验证状态](../userscript/VALIDATION.md)            | `0.1.4.2` 单文件模拟集成与实机验收清单 |
| [弹窗与自动上传回归](testing/popup-regression.md)          | `0.1.4` 自动化回归                     |
| [官网与下载验收](../server/SITE_E2E_REPORT.md)             | 站点、隐私页与 ZIP 下载                |
| [线上缓存验收](../server/E2E_REPORT.md)                    | `0.1.3` 服务端和真实浏览器链路         |
| [真实 Chrome E2E](testing/chrome-e2e.md)                   | `0.1.2` 字幕、模型、缓存与 B站播放     |
| [播放器与进度条回归](testing/browser-player-regression.md) | `0.1.2` 真实 Chrome 合成媒体测试       |
| [原生 fetch 回归](testing/browser-fetch-regression.md)     | `0.1.1` Window / Worker 接收者问题     |
| [验收状态与历史排查](testing/e2e-status.md)                | `0.1.2` 及之前的安装、网络与验收过程   |

共享服务、官网和油猴的模块文档保留在各自代码目录，统一从本索引访问。

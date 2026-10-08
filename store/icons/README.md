# BiliSkip 图标

## 蓝色电视与禁止广告金币

源文件：[biliskip-tv-coin.svg](biliskip-tv-coin.svg)。该方案已获确认，并接入扩展0.2.0与油猴0.2.0.1；线上发布沿用独立流程。

- 蓝色双天线电视，白色播放键；右下角金色硬币叠加蓝色禁止圆环与斜杠。
- `viewBox="0 0 256 256"`，透明背景，使用SVG几何路径；金币符号也使用路径绘制。
- 主蓝色`#079ed1`，屏幕描边`#92ddf3`，金币`#f6a817`，金币内圈`#ffcf68`。
- 电视与金币之间使用透明镂空间隔，适配浅色和深色背景。
- 本机预览：`dist/biliskip-tv-coin-preview.png`；透明PNG：`dist/biliskip-tv-coin-512.png`。
- `npm run icons`使用固定版本的开发依赖`@resvg/resvg-js`生成16／32／48／128px PNG，并同步`extension/icons/icon.svg`与官网SVG。渲染依赖仅用于开发构建。
- 播放器单色入口：[player-icon.svg](../../extension/icons/player-icon.svg)，采用`currentColor`。可访问名称由按钮提供。
- 设置分区使用本项目绘制的七枚24px线性SVG（`extension/icons/section-*.svg`），在导航和分区标题中复用；油猴经`build:ui`内联相同文件。
- 项目链接分别使用`extension/icons/link-home.svg`房子图标与`link-github.svg`的GitHub标志；GitHub标志取自Primer Octicons，MIT许可原文保留在SVG中，两端复用同一资源。
- `npm run build:ui`从共享弹窗HTML、CSS和图标生成`extension/player-assets.js`，供普通内容脚本与油猴共用；该文件提交到仓库以便直接加载`extension/`。

电视外形改编自[Lucide的tv图标](https://github.com/lucide-icons/lucide/blob/main/icons/tv.svg)，
该图标继承Feather来源。遵循[Lucide仓库许可](https://github.com/lucide-icons/lucide/blob/main/LICENSE)中的ISC及Feather MIT条款，完整版权和许可已保留在SVG注释内。
电视比例、配色、屏幕、金币及禁止标志组合为本项目设计修改。

# 小宠物预览验收 · 2026-10-08

实现范围：共用图片角色组件、按压回弹、拖动、6 秒气泡、字幕 / 模型 / 本地转写状态、
参考费用、缓存本次 ¥0、打开视频面板、全屏收起与生命周期清理。

默认发布资源保持关闭，预览构建将指定本地图启用并内嵌。当前应用版本、Prompt、缓存协议保持原值。
预览路径与素材声明见 [使用说明](../pet-preview.md)。用户指定原图 SHA-256：
`dcc456613dbb1102a4b7ef636a8b622371e33b763489d6249c434fb54248ba5c`。

## 实际浏览器

Playwright 启动带预览扩展的有界面 Chromium，使用新的未登录配置。

- 静态预览页加载原图（610×610），真实鼠标按下得到 `matrix(1.05, 0, 0, 0.88, 0, 0)`。
- 松手采样获得 Y 轴 `0.98574 → 1.01087 → 1.00527 → 1`，验证过冲回弹。
- 模拟识别 → 完成费用、6 秒自动关闭、点击重显、拖到左侧后气泡完整显示、面板入口、全屏收起、关闭与刷新恢复通过。
- 真实 B站 `BV1Lmd2BAEad`：原生扩展读取中文 AI 字幕并命中真实共享缓存。
- 真实气泡：「找到共享结果啦 / 本次模型费用 ¥0 · 已复用广告标记」。
- 点击气泡内「打开视频面板」成功打开现有侧栏，小宠物实例为 1 个。
- 本轮 DeepSeek 网络请求为 0，凭据保持空白；有费用的界面演示使用标注清楚的模拟数据。

截图和原始报告保存在 `dist/biliskip-pet-preview/screenshots/`、`e2e-report.json`。
一次性浏览器脚本保存在 `.tmp/pet-e2e-20261008.mjs`。
初次动画断言遇到安装后设置页抢焦点，改为先关闭该测试配置的初始设置页并等待动画状态；
气泡收起断言改为等待实际隐藏，以适应后台页计时调度，随后全部浏览器检查通过。

## 固定回归

最终 `npm run verify` 通过：ESLint、Prettier、扩展检查与 359 项测试全部成功。
Chrome 预览 ZIP 已核对根目录 manifest 与宠物脚本，SHA-256：
`4fb1e11177a680be3740ed0f853de2d5d1faeed3e6dfd95730d8052636198ab6`。

- `tests/extension/pet.test.js`：预设生成、实时任务归属、历史缓存费用隔离、路线变化、异常和未知用量、按压 / 拖动 / 全屏 / 销毁。
- `tests/extension/player-panel.test.js`：完整内容脚本 + 模拟 API 的实际费用通知、再次读取缓存转为 ¥0、BFCache 重新挂载。
- `tests/userscript/bundle.test.js`：预览构建实际注入资源、完整模拟识别链路、刷新缓存与 Chrome 扩展冲突清理。

后续扩展范围：持久位置、设置页开关 / 换肤、独立累计费用账本。

## 气泡样式收尾验收 · 2026-10-08

按用户参考图完成深蓝描边、白底椭圆和两颗思考小泡泡，保留居中的识别状态、
本次参考费用和面板入口。左侧拖动时镜像装饰，360px 窄视口下气泡保持完整。

补充了拖动与自动收起的固定回归：拖动期间暂停收起计时，松手后完整展示 6 秒。
新增用例先复现了“拖动中识别完成，完成通知提前收起”的问题，修复后宠物专项 9 项通过。
取消指针和后续 capture 清理事件也覆盖在用例中。

- 本轮 Chromium 无头浏览器检查通过：按压回弹、模拟识别费用、自动收起、点击重显、
  拖动、360px 窄屏、全屏、关闭和刷新恢复。
- 真实 B站 `BV1Lmd2BAEad` 本轮返回 `NO_SUBTITLE`；异常气泡、打开视频面板和单实例检查通过。
  本轮共享缓存命中范围记为待复现，前文保留初版有界面浏览器的共享缓存验证记录。
- 本轮 DeepSeek 请求为 0。浏览器交互通道返回认证缺失，自动验收使用已有的项目脚本。
- 首轮全量回归与浏览器测试并行时为 362/363，随后独立完整重跑 `npm run verify` 为 363/363，
  ESLint、Prettier、扩展资源和凭据检查同时通过。
- 日志：`.tmp/pet-bubble-handoff-verify-20261008.log`；浏览器报告：
  `dist/biliskip-pet-preview/e2e-report.json`。
- 参考图与验收截图先生成缩小压缩副本再查看；交付效果图：
  `dist/biliskip-pet-preview/screenshots/pet-detail.jpg`。

独立预览页、Chrome 预览目录、油猴预览脚本和 Chrome ZIP 已同步。
ZIP 根目录 `manifest.json`、`pet.js`、`pet-assets.js` 和 `icons/pet-bubble.svg`
与预览源文件逐项一致。更新后的 ZIP SHA-256：
`17bd30682efe2c572b37fb82cf1cc4c4c230e41d351b81f28269b03959dd62bb`。

## 自动跳过对白 · 2026-10-08

扩展与油猴共用控制器的自动跳过事件：每次成功跳过生成递增编号，并提供本次跨过的广告秒数。
宠物显示「帮你跳过恰饭啦 / 已跳过 N 秒，继续看吧～」，沿用 6 秒收起和拖动暂停计时。
同一事件的状态轮询保持原计时；重复跳入广告生成新提示。撤销、手动跳转、刷新、
视频切换和新任务分别按当前状态展示。秒数按广告剩余部分计算，播放器越过末端的 0.05 秒安全余量单独处理。

- 固定回归覆盖事件来源、编号、快照副本、秒数、完成费用到跳过对白的转换、去重、
  收起、撤销、重复跳过、刷新和路线隔离，以及缓存应用期间仍在收尾的任务状态。
- Chrome 完整内容脚本与油猴实际构建产物的模拟链路均验证到自动跳过对白。
- 有界面 Chromium 在真实 `BV1Lmd2BAEad` 命中共享缓存，从 140 秒跳到 175.75 秒，
  气泡显示跳过 35.7 秒；6 秒收起、撤销及重复跳过通过。DeepSeek 请求为 0。
- 一次性脚本：`.tmp/pet-skip-e2e-20261008.mjs`；报告：
  `dist/biliskip-pet-preview/auto-skip-e2e-report.json`；缩小压缩效果图：
  `dist/biliskip-pet-preview/screenshots/auto-skip-detail.jpg`。
- `npm run verify` 全量 369 项通过，日志见 `.tmp/pet-skip-verify-20261008.log`。

Chrome 预览目录、油猴脚本、独立预览按钮和 ZIP 均已更新。
本轮 ZIP SHA-256：`4cacb54cc55d45ece588233552f3d70c63a8d9accb63c48f0499208793d81145`。

## 宠物设置与点击音效收尾 · 2026-10-08

接续未完成的设置开发，扩展和油猴共用宠物设置视图。新增显示开关、镜像并默认放到左下角、
点击音效开关与音量、14 个场景的标题 / 说明编辑、面板按钮文字和侧栏图标、
PNG / JPEG / WebP 本机上传裁剪。裁剪输出 512×512 PNG，原图最大 10 MiB。
费用与秒数占位符按场景校验，文案通过 `textContent` 显示。

- 本地预览接入上游默认小黄鸭 `Ya1.mp3` / `Ya2.mp3`；完成单击后播放并触发摸头回弹。
  拖动专用于移动角色；按下、拖动、取消指针、全屏、隐藏和销毁会清理音效及动画状态。
  常规构建使用自有图标及合成轻提示音，预览素材留在忽略的本机产物中。
- 修复保存失败后被无关成功覆盖、旧失败覆盖新值、旧裁剪保存完成关闭新上传的竞态；
  重试保留各字段最新值。裁剪事件同步捕获指针并正确释放图片对象 URL。
- 长文案的气泡最大高度为 420px，并受视口高度约束，内容溢出时可滚动。
  360×640 浏览器窗口的极端多行文案检查通过。
- 补充 `tests/extension/pet-settings.test.js`；扩展后台、宠物状态 / 音效、设置页清理、
  分区导航和油猴真实构建产物均补齐回归。修正旧测试替身仅保留一个 `pagehide` 监听的问题。
- 独立完整 `npm run verify` 为 **383/383**，ESLint、Prettier、扩展资源、CSP 和凭据扫描通过。
  日志：`.tmp/pet-settings-takeover-final-verify.log`。

### Chromium 实际浏览器

使用新的隔离配置和空凭据，加载更新的预览扩展。验证设置持久化、原生键盘切换场景、
图片上传 / 缩放 / 拖动 / 保存、512×512 解码尺寸、真实 Web Audio 解码与两段播放调度、
拖动保持原状且音效静默、自动跳过示例、6 秒收起和点击重显。

真实 B站 `BV1Lmd2BAEad` 本轮返回 `NO_SUBTITLE`：确认已保存的镜像和图片加载成功，
修改台词实时广播到视频页，新图标打开实际面板，显示开关切换后保持单实例。
本轮真实页面验证覆盖异常状态下的交互；广告跳过对白由固定模拟链路覆盖。
本轮 DeepSeek 请求数为 **0**。

初轮脚本使用 `selectOption` 触发合成事件，被可信事件校验过滤；改为原生键盘操作。
窄屏切换及页面初始设置加载的断言改为等待实际渲染状态。随后全部浏览器检查通过。

- 脚本：`.tmp/pet-settings-e2e-20261008.mjs`。
- 报告：`dist/biliskip-pet-preview/pet-settings-e2e-report.json`。
- 图片均先缩小压缩再读取；交付预览：`screenshots/pet-settings-preview.jpg`、
  `screenshots/pet-settings-live-preview.jpg`、`screenshots/pet-settings-detail.jpg`。
- 独立页面、预览扩展目录和油猴预览脚本均已同步；Chrome ZIP 同目录重建。
  ZIP 共 78 个文件，逐项 SHA-256 与预览扩展目录一致，根目录包含 `manifest.json`。
  ZIP SHA-256：`912b981b5b24a039c13684b68b1870286401e26d4adf8394157c67b2abe20e18`。

预览音效 SHA-256：

- `Ya1.mp3`：`0ad8f934ae5fa3cbd42745e086a56aa6532766618c6a620b860a795bdc7689f9`。
- `Ya2.mp3`：`1a8998077e5e306c3088bb442ce36617261dd58200754f457469a520801c565b`。

## 镜像贴边与单标题台词 · 2026-10-08

- 镜像时关闭按钮移到左上角并保持完整可点击；左侧默认 `left: 0`，两个朝向均默认贴底。
  拖动可以贴齐左右边缘及底边；拖到底部后按底边停靠，窗口增高或缩小继续贴底。
- 按压与识别动画以底部为基点，识别中的呼吸效果改为轻微纵向缩放；图片按底部对齐。
- 气泡正文合并为一个标题，保留面板入口。默认标题集中展示费用、缓存零费用或跳过秒数。
  设置页和油猴共用一个 160 字、可换行的标题台词框。
- 新增本机 `petDialogueVersion: 2`。旧版自定义标题和说明合并，保留自定义文字、
  空文本和占位符；等同旧默认值的覆盖项回归新默认。重复迁移保持幂等。
  Chrome Worker 启动写回迁移，油猴读取时迁移并在下一次保存设置时写回 GM。
  应用、Prompt、共享缓存和 ASR 协议版本保持原值。

验证结果：

- `npm run verify` **389/389**；ESLint、Prettier、扩展资源与凭据检查通过。
  日志：`.tmp/pet-title-final-verify-20261008.log`。
- Chromium 两种朝向共 14 组状态，逐帧采样图片底边；按压、拖到边缘、视口变化和关闭按钮检查通过。
  脚本：`.tmp/pet-edge-e2e-20261008.mjs`；报告：`dist/biliskip-pet-preview/pet-edge-e2e-report.json`。
- Chromium 在隔离配置中保存旧版测试设置，正常重启后确认 Worker 自动迁移写回，
  验证单标题编辑、示例数值替换、再次加载、缓存 / 跳过 / 用量标题及面板操作。
  热重载脚本最初受侧载扩展生命周期影响，改为正常重启隔离测试浏览器后全部通过。
  脚本：`.tmp/pet-title-e2e-20261008.mjs`；报告：`dist/biliskip-pet-preview/pet-title-e2e-report.json`。
- 本轮浏览器使用本机固定数据，DeepSeek 请求为 0。图片先缩小压缩再查看，
  预览位于 `screenshots/pet-title-skip-preview.jpg`、`pet-title-cost-preview.jpg`、
  `pet-title-settings-preview.jpg` 和 `pet-edge-mirror-preview.jpg`。
- 扩展预览目录、油猴预览脚本、独立页面及 Chrome ZIP 同步更新。
  ZIP SHA-256：`236359f8ad28efcbdb66239a8de034449a343290d905c46c79b95064a88ddc98`。

## 用户默认台词、单价档费用与右向气泡 · 2026-10-08

已读取用户测试配置中的宠物文案，并按明确要求设为默认。字幕读取 / 广告识别 / 本地转写共用
「恰饭片段寻找中...！」，本地 / 共享缓存共用「缓存命中！吃白饭啦」，全部异常共用
「搞不定啦！打开面板自己看一下~」。其余默认文案见[宠物说明](../pet-preview.md)。
14 个触发场景归为 8 组，修改 / 恢复一组同步作用于组内场景。
版本 3 迁移保留其他不同的自定义文案；用量待确认 / 短视频豁免留空并静默显示角色。
Chrome 导航、分区标题及油猴分区统一为「宠物」。

### 费用

核对参考项目 `lib/index.js` 与 DeepSeek 官方价格页面。按收到用量时的北京时间固定高峰或空闲
价档和一个 8 位小数参考金额，保存时段与时间依据，随后跨时段查看保持原值。
峰谷边界、周末、调休工作的周末、法定节假日、缺失未来节假日表、历史记录和有用量的异常均有固定回归。
推理 token 按已包含在输出总量中处理。旧金额占位符迁为 `{cost}`；面板同样显示单个参考金额。
这是本地 token 估算，实际账户扣费独立记录。

### 气泡与动画

角色两种朝向都优先右侧，右侧空间不足时转左；窗口狭窄时继续限位。
白色填充配柔和阴影，SVG 的 `stroke` 固定为 `none`。
入场参考上游 `dshwv-b2` / `dshwv-b1` / `dshwv-bshape` / 文字顺序：0 / 130 / 260 / 360ms。
状态轮询、拖动及窗口大小变化保持动画进度，关闭后重显重播；减少动态效果时直接显示。

### 验证

- `npm run verify` **402/402**，ESLint、Prettier、扩展资源与凭据扫描通过。
  日志：`.tmp/pet-final-all-20261008.log`。
- Chromium 隔离配置从用户批准的 v2 台词迁为 v3 默认，确认 8 组编辑器、分区改名、
  一组多场景保存 / 恢复、费用与秒数占位符、统一异常和单标题渲染。
  报告：`dist/biliskip-pet-preview/pet-defaults-e2e-report.json`。
- Chromium 验证两种镜像下 10 组位置，右侧刚好容纳与超出 1px 的边界；
  70 / 180 / 300 / 600ms 逐帧验证气泡依次出现，三个 SVG 部件的描边均为 `none`。
  重复状态 / 窗口变化保持同一动画，关闭后重新打开创建新动画，减少动态效果检查通过。
  报告：`dist/biliskip-pet-preview/pet-bubble-animation-e2e-report.json`。
- 以上浏览器验证使用隔离配置和本机固定数据，DeepSeek 请求为 0。
  参考图片与验收图片都先压缩再查看。预览：`screenshots/pet-bubble-borderless-preview.jpg`、
  `screenshots/pet-bubble-sequence-preview.jpg`。
- 扩展目录、独立预览、油猴预览脚本和 Chrome ZIP 一并更新。
  ZIP SHA-256：`09e76d0820c2caba76f362f58018e65d0373945a897dabf8efe3017d94a301ab`。

## 默认资源、自定义音频与气泡抬高 · 2026-10-08

- 用户指定的角色图与小黄鸭两段音效固定到 `assets/pet/`，带 SHA-256 清单、来源及独立素材授权声明。
  普通扩展、普通油猴和预览统一使用这组资源，恢复默认图片 / 音效也使用同一组资源。
  生成器校验源文件并内嵌，浏览器继续直接加载 `extension/`。
- 默认点击音量为 10%。新增本机音频上传，接受 MP3 / WAV / OGG / M4A，最大 1 MiB、10 秒，
  检查格式头和本机媒体时长后保存至扩展存储或 GM。自定义音频以单段替换默认音效对，
  重选、重置、页面销毁时取消旧读取；切换音源清理旧解码缓存和播放节点。
- 主气泡整体上移 40px；真实浏览器测得主气泡下沿与图片上沿间距约 16.93px。
- 默认台词更新为「恰饭片段寻找中...」及「大肥鱼吃了你 ¥{cost}」。

验证：

- `npm run verify` **411/411**，ESLint、Prettier、扩展资源 / 凭据检查通过。
  日志：`.tmp/pet-assets-audio-final-verify.log`。
- Chromium 使用普通 `extension/` 源目录和新配置验证：默认角色宽度 610px、默认音量 10%、
  默认小黄鸭音效，图片替换后恢复角色、真实 MP3 上传及重载保留、11 秒 WAV 拒绝且保留原音频、
  恢复默认音效。实际 Web Audio 验证自定义单段及默认两段解码播放，DeepSeek 请求为 0。
- 初轮内存文件上传触发合成事件，脚本改用真实本机 WAV 文件后通过可信事件边界。
  脚本：`.tmp/pet-audio-e2e-20261008.mjs`；报告：`dist/biliskip-pet-preview/pet-audio-e2e-report.json`。
- 图片先压缩再读取，预览位于 `screenshots/pet-audio-settings-preview.jpg` 和
  `screenshots/pet-raised-bubble-preview.jpg`。

公开分发素材前需核对其独立授权范围，详见 `assets/pet/NOTICE.md`。
该说明随扩展和油猴产物附带，项目 MIT 代码许可保持原文。

默认资源单独提交：`c11db27`（`assets/pet/` 的 6 个文件），其他暂存内容逐项比对保持原样。
预览 ZIP SHA-256：`5e8661e7938457803191683ff3e0b1554c763948b6c3136f1499947f8261bbbb`。

## 缓存静默与点击待机 · 2026-10-08

- 本地 / 共享缓存命中固定静默，宠物保留显示。设置中的缓存文案项移除，剩余 7 组、12 个可配置触发场景。
  文案版本提升至 4，读取旧配置时清理 `local` / `shared` 覆盖项，其他设置保留；旧设置页提交同类字段也会清理。
- 点击宠物显示当前待机台词，6 秒收起，沿用摸头动画和音效。手动展示与事件观察状态分开，
  重复轮询保持待机展示，之后发生新跳过、识别完成或异常时照常显示事件台词。
  点击发生在识别期间时，实时用量跟踪继续保留。
- `npm run verify` **415/415**，ESLint、Prettier、扩展资源及凭据检查通过。
  日志：`.tmp/pet-cache-idle-final-verify.log`。
- Chromium 隔离配置验证旧缓存文案迁移、7 组设置选项、缓存静默、点击自定义待机、
  同一状态去重、6 秒收起及新跳过恢复事件提示。使用本机固定数据。
  脚本：`.tmp/pet-cache-idle-e2e-20261008.mjs`；报告：`dist/biliskip-pet-preview/pet-cache-idle-e2e-report.json`。
  图片先压缩再查看，预览：`screenshots/pet-idle-on-click-preview.jpg`。

## 右侧拖动避让滚动条 · 2026-10-08

- 右侧边界采用文档 `clientWidth`，普通滚动条前保留 12px 动画 / 阴影安全区；
  浮动滚动条场景预留 24px。宠物、关闭按钮和气泡共用可用宽度，左侧 / 底部仍可贴边。
- 观察页面布局变化，滚动条出现、变宽或隐藏后自动重新限位；销毁时断开观察器。
  隐藏状态延后位置更新，恢复显示后按实际尺寸重新限位。
- `npm run verify` **417/417**，日志：`.tmp/pet-scrollbar-final-verify.log`。
- Chromium 实测 1000px 视口、18px 滚动条时宠物右边为 970px；36px 滚动条时为 952px，
  均在滚动条前留 12px。浮动滚动条路径为 976px，关闭滚动后为 1000px；重新启用滚动后正确回退。
  按压和气泡范围同时通过检查。脚本：`.tmp/pet-scrollbar-e2e-20261008.mjs`；
  报告：`dist/biliskip-pet-preview/pet-scrollbar-e2e-report.json`。
- 验收图先压缩再读取，预览：`screenshots/pet-scrollbar-safe-preview.jpg`。

## 蓝色气泡边框 · 2026-10-08

- 主气泡与两颗小圆点统一为 `#7298ca`、2px 蓝色描边，保留白底、柔和阴影和逐段入场动画。
  SVG 缩放时描边保持固定宽度，设置页台词预览同步使用同色边框。
- 宠物专项 **30/30**、`npm run verify` **417/417** 通过；全量日志：
  `.tmp/pet-blue-border-final-verify.log`。
- Chromium 检查两种镜像下共 10 组方向边界，三个 SVG 部件均计算为 `rgb(114, 152, 202)`。
  70 / 180 / 300 / 600ms 动画顺序、重复状态保持进度、关闭后重播及减少动态效果检查通过。
  报告：`dist/biliskip-pet-preview/pet-bubble-animation-e2e-report.json`。
- 验收截图先缩至 288×512 JPEG 再查看：`screenshots/pet-bubble-blue-preview.jpg`。
- 普通油猴、预览扩展、预览油猴和 Chrome ZIP 已同步；ZIP 根目录包含 `manifest.json`，
  全部 81 个文件的 SHA-256 与预览扩展目录一致。
  ZIP SHA-256：`ab0db70ae6c3e432633e08b2331915281a6855a6c4cdccac2eb271134aee216e`。

## 设置就绪后首显与面板 Logo · 2026-10-08

- 共用控制器通过 `settingsReady` 区分启动占位设置与已加载设置；宠物在等待期间保持隐藏。
  节点先以隐藏状态挂载，应用图片、镜像、位置与台词后首次显示。页面恢复遵循同一流程。
  设置读取失败时继续等待，收到有效设置广播后恢复显示；视频切换保留已经加载的设置。
- 气泡的面板入口改为直接内嵌 `extension/icons/icon.svg`，与插件共用彩色 Logo 源文件，
  尺寸为 16px。装饰图标对辅助技术隐藏，按钮继续使用配置的文字作为可访问名称。
- 新增回归先复现启动闪现，再验证修复。定向测试 **81/81**，`npm run verify` **423/423**。
  覆盖预览预设、延迟设置、关闭设置、读取失败与广播恢复、BFCache 恢复、油猴 GM 延迟及 Logo 来源。
  全量日志：`.tmp/pet-startup-final-verify.log`。
- Chromium 本机完整内容脚本检查：延迟设置 900ms 期间可见帧为 0；镜像、普通、关闭后启用、
  读取失败后恢复四组场景各采样至少 8 个可见帧。镜像首帧 `left: 0`、底部 720px；
  普通首帧 `left: 816px`。BFCache 恢复后首帧继续贴左贴底，Logo 与面板入口点击通过。
  测试使用模拟传输，模型请求为 0。脚本：`.tmp/pet-startup-e2e-20261008.mjs`；
  报告：`dist/biliskip-pet-preview/pet-startup-e2e-report.json`。
- 图片先压缩至 272×352 JPEG 再查看：`screenshots/pet-startup-logo-preview.jpg`。
  保留用户配置重开真实 B站试用窗口，初始 12 个可见帧均为镜像开启、`left: 0`，保持贴底。
- 普通油猴、独立预览、预览扩展与 ZIP 已更新。ZIP SHA-256：
  `795b354cb47c14776b34f8863e9e79410913ad5ee52f2c39ea5d252fc13d6e3a`。

## 面板入口居中对齐 · 2026-10-08

- Logo 与文字作为完整一行相对标题居中，图标固定 16px，文字使用相同的 16px 行高并垂直居中。
  长文字保留换行能力，图标保持原尺寸。
- 本机 Chromium 与真实 B站试用页测得横向中心差约 0.008px、纵向中心差 0px；
  Logo 与单行文字高度均为 16px。设置等待与镜像首帧检查继续通过。
- `npm run verify` **424/424**，日志：`.tmp/pet-alignment-final-verify.log`。
  用户参考图与验收图均先压缩再查看；效果图：`screenshots/pet-aligned-logo-preview.jpg`。
- 试用窗口、普通油猴和全部预览产物已同步。ZIP SHA-256：
  `e3de7337613e199860327178bf660fff5ef76ab132128ee0b663a066246f6d07`。

# Chrome Web Store 上传包

## 生成与上传

```powershell
npm ci --ignore-scripts
npm run pack:store
```

命令先运行完整验证，然后生成
`dist/biliskip-0.1.4-chrome-web-store-<时间戳>.zip` 和对应 `.sha256` 文件。
ZIP 只包含 `extension/` 下的运行代码和图标，`manifest.json` 位于 ZIP 根目录。
在 Chrome Web Store 开发者后台创建条目时上传此 ZIP。

当前包版本为 `0.1.4`。后续向同一条目上传更新包时，先同步提高
`extension/manifest.json`、`extension/lib/constants.js`、`package.json` 和展示文案中的版本。

官网：`https://biliskipad.bakapiano.com/`；公开隐私说明：`https://biliskipad.bakapiano.com/privacy.html`。
官网提供与本地验证包一致的 `/downloads/biliskip-0.1.4.zip` 和 `.zip.sha256`。

## 图标

- 扩展包含 16、32、48、128 像素 PNG 图标。
- 128 像素商店图标使用 96 像素主体和透明留白。
- 工具栏图标已写入 `action.default_icon`。
- 图标通过项目内几何绘图脚本生成，需要重建时运行 `npm run icons`。

## 商店页面待填写的材料

素材源文件位于 `store/`。历史 `0.1.2` 实拍素材位于 `dist/chrome-web-store-assets-0.1.2/`；`0.1.4` 将操作面板移至工具栏弹窗并增加自动上传开关，上架截图需按新版本复核。
准备完真实截图后，可以重建宣传图、整理文案并生成整体素材包：

```powershell
powershell -NoProfile -File scripts/package-store-assets.ps1 -ExtensionArchive dist/<程序上传包>.zip
```

整体素材 ZIP 用于整理和传递，程序上传使用其中 `extension/` 内的扩展 ZIP。
发布前请核对 `store/privacy-disclosures.md` 中的本机凭据保护事项，确认隐私政策并部署公开页面。

上传包和填写商店条目是两个步骤。提交审核前准备：

- 名称、说明、分类和语言。
- 至少一张真实扩展截图，尺寸为 1280×800 或 640×400。
- 一张 440×280 小型宣传图。
- 可公开访问的隐私政策页面，说明本机存储、字幕向 DeepSeek 的传输及可选共享服务。
- 隐私披露、权限用途及审核测试步骤。数据披露按实际行为填写。

这些材料在开发者后台单独提交。当前 ZIP 交付仅表示扩展文件和本地验证已完成。

## 单一用途和权限用途草稿

单一用途：根据 B站视频字幕识别商业植入，在播放器时间轴标记广告区间并按用户设置跳过。

- `storage`：保存个人模型 Key、用户设置及运行状态；广告缓存由 IndexedDB 保存。
- `www.bilibili.com`：在视频页运行播放器控制器、标记时间轴及响应工具栏弹窗的播放操作。
- `api.bilibili.com`：读取视频信息、字幕元数据并核对当前视频身份。
- `*.hdslb.com`：下载 B站字幕 CDN 的字幕文件。
- `api.deepseek.com`：用户授权后使用其个人 API Key，提交视频标题和字幕进行广告识别。
- `biliskipad.bakapiano.com`：默认查询视频标识和字幕指纹对应的线上标记；新分析结果默认自动上传视频信息、广告标记和有限证据，可在设置中关闭，并保留手动上传入口。服务按来源 IP 限流，计数逻辑保留 7 个 UTC 日期。
- 可选 `https://*/*`：用于用户自行配置的 HTTPS 共享服务，启用时仅向用户填写的服务域名申请主机权限。该功能默认关闭。

全部 JavaScript 随包提供，模型返回值作为 JSON 数据校验后使用。
付费服务说明应写明：用户配置自己的 DeepSeek Key，模型调用费用由 DeepSeek 按使用量收取。
审核说明可使用项目已验证的视频 `BV1pFUDBKE8X`；涉及付费模型的测试访问方式由发布者在审核说明中单独安排。

## 官方资料

- [准备扩展及 ZIP](https://developer.chrome.com/docs/webstore/prepare)
- [商店图标和图片要求](https://developer.chrome.com/docs/webstore/images)
- [隐私与权限说明](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)

# 宠物默认资源

按用户指定，将当前使用的角色图和小黄鸭音效固定为扩展与油猴共同的默认资源。

- `character.png`：角色图片，来源文件 `DSniang1.png`，610×610。
- `press.mp3` / `release.mp3`：小黄鸭点击音效，来源文件 `Ya1.mp3` / `Ya2.mp3`。
- `manifest.json`：来源版本、原始路径、大小和 SHA-256。

运行 `node scripts/build-pet-assets.js` 会校验固定资源并内嵌到 `extension/pet-assets.js`。
浏览器直接加载 `extension/`，油猴打包复用同一个生成文件；「恢复默认图片」使用这张角色图。
用户已上传的自定义图片与音量、开关设置继续保留。
普通构建与预览共用小黄鸭音效，点击音量默认 10%，设置页可另行上传本机点击音频。

来源和授权范围见 [素材声明](NOTICE.md)。公开分发前需确认素材授权。

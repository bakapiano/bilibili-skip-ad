# 扩展权限说明（中文）

适用扩展版本：0.1.9。以下三段分别粘贴到对应权限理由字段，每段少于1000字符。

## offscreen

用于在用户开启本地语音转写后，创建隐藏的扩展文档，完成当前视频音轨的解码、音频处理及基于 WebAssembly 和 Worker 的本地语音识别，生成带时间戳的字幕。该文档提供音频解码和语音识别所需的运行环境，并让已启动的转写任务在扩展弹窗关闭后继续执行。

## unlimitedStorage

用于在本机保存语音识别模型（约239MB）、转写字幕及广告识别结果等缓存。模型通过 CacheStorage 保存，转写字幕和识别结果通过 IndexedDB 保存。此权限提供大型模型与持续积累的缓存所需的存储空间，便于复用已下载的模型和已生成的识别结果，减少重复下载与重复分析。

## declarativeNetRequestWithHostAccess

用于为扩展自身发往 bilivideo.com、bilivideo.cn 及其子域名的音轨请求设置 B站来源的 Referer 请求头，以满足音频 CDN 的来源校验，让本地语音转写能够获取当前视频的音轨。规则采用会话规则，按扩展来源、目标域名和 XHR/fetch 请求类型限定作用范围，用于用户开启的本地语音转写流程。

## 代码依据

- `extension/lib/offscreen-asr.js`：按需创建WORKERS/BLOBS离屏文档；会话规则1801限定扩展发起方和音频域名。
- `extension/lib/asr-model.js`：239,233,841字节模型的CacheStorage读取、校验和保存。
- `extension/lib/db.js`：转写字幕、广告标记和任务记录的IndexedDB存储。

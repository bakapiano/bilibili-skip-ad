# BiliSkip 商店发布素材

## 文件对应关系

| 文件或目录                               | 使用位置                 |
| ---------------------------------------- | ------------------------ |
| `extension/*.zip`                        | 商店后台上传扩展程序 ZIP |
| `images/icon-128.png`                    | 商店图标                 |
| `images/promo-small-440x280.png`         | 小型宣传图               |
| `images/promo-marquee-1400x560.png`      | 可选横幅                 |
| `screenshots/01-ad-markers-1280x800.png` | 第 1 张功能截图          |
| `screenshots/02-auto-skip-1280x800.png`  | 第 2 张功能截图          |
| `documents/store-listing.zh-CN.md`       | 名称、简介和详细介绍     |
| `documents/privacy-policy.html`          | 部署后用于隐私政策 URL   |
| `documents/privacy-disclosures.md`       | 权限与数据披露核对       |
| `documents/reviewer-notes.md`            | 审核测试说明             |
| `documents/screenshot-notes.md`          | 图片来源与使用说明       |
| `SHA256SUMS.txt`                         | 素材完整性校验           |

整体素材 ZIP 用于下载和整理。上传扩展条目时，选择解压后 `extension/` 中的程序 ZIP；图片和文案填写到对应字段。

## 发布前最后核对

1. 在公开 HTTPS 地址部署隐私政策草稿，核对维护者和联系渠道，确认内容后移除草稿提示。商店后台填写实际可访问的 URL。
2. 按 `privacy-disclosures.md` 核对凭据本机存储的静态加密要求。当前代码采用扩展专属本机存储，完成审查和必要调整后提交相应版本。
3. 核对截图中第三方视频画面的使用权限，必要时替换成已授权视频的实拍截图。
4. 安排审核者可使用的模型测试方式和额度，通过适当的私密渠道提供测试凭据。
5. 确认隐私披露与实际运营后，在商店后台提交审核。

本素材包准备了文件和填写草稿，公开部署、账户设置和提交审核由发布者确认执行。

# 表情包（qq-sticker）

源码可信原生包。入口 `index.js`，清单镜像 `manifest.json`。

- 收藏、偷图、按标签/情绪检索、发送、联网查含义。
- 自动收藏由 `auto.js` 执行，读取 `collectProbability`、`collectCooldownSec`、`maxPerMessage`、`excludeKeywords`。
- 图片在 `data/dsh-onebot-bridge/stickers/`，索引只存元数据。
- 管理页：夜航控制台 → 插件 → 表情包。
- API：`stickerAdmin`、`configureNativePackage`、`GET /api/sticker-image`。

修改后必须跑 `npm test`、`npm run check:manifests`。

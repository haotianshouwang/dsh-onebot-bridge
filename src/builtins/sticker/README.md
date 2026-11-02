# 表情包（qq-sticker）

源码可信原生包。入口 `index.js`，清单镜像 `manifest.json`。

- 收藏、偷图、按标签/情绪检索、发送、联网查含义。
- 自动收藏由 `auto.js` 执行，读取 `collectProbability`、`collectCooldownSec`、`maxPerMessage`、`excludeKeywords`。
- 指定群内的自动收集不要求发图者是主人；私聊仍按插件的用户名单。此行为不授予群友工具权限。
- `intelligence.js` 在收藏后用真实图片分类，记录名称、情绪、标签、用途及是否适合当表情。串行识别，重复图不重复排队；失败时保留原图与真实错误状态，不编造分类。
- `model.js` 复用 DSH 当前模型、附件与流接口；当前模型必须支持图片才能自动分类。
- 开启 `autoSend` 后，正常聊天回复有机会从已分类表情中选一张，附在最后一段文字中，通过同一个 `Actions.request` 发送和回读。不连续重复同一张；没有合适表情或选图失败则正常发文字。戳一戳、管理指令、工具已经发过消息的轮次不追加表情。
- 新配置：`autoClassify`（默认开）、`autoSend`（默认关）、`sendProbability`（默认 25%）、`sendCooldownSec`（默认 60 秒，可设 0）。旧开关和数据路径保持兼容，不自动删除或替换收藏。
- 自主表达可选普通 QQ `face`、图片表情或给当前收到的消息贴表情回应，一轮只选一种。原生 QQ 表情不下载入图片库；接收时保留具体编号，常用编号补名称。QQ 超级表情特效、会员表情的呈现由 QQ/NapCat 决定。
- 看图回复不从图片库配图，防止刚收到、刚收藏的图片被立即原样发回；仍可使用原生小表情或消息回应。显式工具发送图片不受此自动配图规则影响。
- 贴表情复用 NapCat `set_msg_emoji_like`，只允许当前聊天已观察到的真实消息；网关 ACK 记作 submitted，不冒充客户端可见已验证。失败保留文字，不重试。`qq.message.react` 是另行授权的显式工具，自主贴表情由已开启的 `autoSend` 与插件作用范围管理。
- 已授权的 `plugin.qq-sticker.send` 兼容新编号 `face:13`（原生呲牙）和 `reaction:13`（贴呲牙回应）；后者可传 `messageId`，默认当前消息，仍由宿主核验消息归属。原图库编号和接口保持兼容，不需要额外给群友工具权限。
- 行为参考 [MaiBot 官方表情配置](https://docs.maibot.chat/manual/configuration/bot-config#收集表情包)：收集、理解用途、按语境选图；这里按现有 Node 插件生命周期独立实现。
- 图片在 `data/dsh-onebot-bridge/stickers/`，索引只存元数据。
- 管理页：夜航控制台 → 插件 → 表情包。
- API：`stickerAdmin`、`configureNativePackage`、`GET /api/sticker-image`。

修改后必须跑 `npm test`、`npm run check:manifests`。

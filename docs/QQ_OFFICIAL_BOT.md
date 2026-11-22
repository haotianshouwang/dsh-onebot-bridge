# QQ 官方机器人

`qq-official-bot` 是独立于 NapCat / OneBot 的官方开放平台通道，默认停用。它用 QQ 开放平台的 AppID 和 AppSecret 换取短期访问令牌，通过 Gateway WebSocket 接收事件，通过官方 OpenAPI 回复。启用这个插件不需要开启 OneBot 连接。

官方资料：[QQ 开放平台](https://q.qq.com/) · [机器人 API 文档](https://bot.q.qq.com/wiki/develop/api-v2/) · [官方 Node.js 示例](https://github.com/tencent-connect/qqbot-nodejs)

## 手动配置

1. 在 QQ 开放平台创建机器人，取得 AppID 和 AppSecret。
2. 用 DSH 主人身份打开「设置 → QQ 框架 → 模块巡检 → QQ 官方机器人」，或在「插件」中打开同名设置。
3. 勾选「启用此插件」并保存设置。如果要先检查配置而不连接网关，同时关闭「启用后自动连接」。
4. 在「官方机器人连接」填入 AppID 和 AppSecret，点击「保存凭据」。已开启自动连接时保存后会尝试连接；关闭自动连接时可点击「连接网关」。只有运行数据报告「已连接」才表示 Gateway 已就绪。

密钥只通过 DSH 主人设置提交。不要把密钥发到聊天、填进插件配置、放入 URL 或写入日志。旧的聊天动作 `plugin.qq-official-bot.set-credentials` 和 `qr-login-*` 只提示去 DSH 设置，不再接收密钥或返回二维码。独立夜航网页可查看官方机器人状态及编辑普通插件配置，不能提交凭据或发起扫码。

### API 环境与订阅范围

- 正式环境：`https://api.sgroup.qq.com`。
- 沙箱环境：开启「使用沙箱 API」后强制使用 `https://sandbox.api.sgroup.qq.com`。API 地址只允许这两个官方 HTTPS 根地址，不跟随 HTTP 重定向。升级时如曾使用自定义 API 地址，请在插件设置中改为受支持的地址后保存并重新启用。
- 默认 intents 同时订阅 `1 << 25`（群聊和 C2C）及 `1 << 30`（频道公域 @）。
- 启用 AI 回复时，`allowedUsers` 匹配私聊用户 OpenID；`allowedGroups` 匹配群 OpenID 或 `guild_id-channel_id` 频道键。留空表示相应类型不增加本地白名单。官方 OpenID 不等同于 QQ 号，不能用 OneBot 的监听白名单代替。

### 存储与部署环境

新的手动或扫码凭据作为一对用 AES-256-GCM 加密保存在插件存储中。设备密钥 `DSH_QQ_OFFICIAL_DEVICE_KEY` 单独由 DSH credentials 管理。界面只显示凭据是否可用，不回显已保存值；访问令牌只留在进程内存。备份或迁移时应保存同一套插件数据和 DSH profile 凭据库，勿公开备份。

已保存的加密凭据优先。没有加密记录时，兼容 DSH credentials 解析出的旧 `DSH_QQ_OFFICIAL_APP_ID` / `DSH_QQ_OFFICIAL_CLIENT_SECRET`，以及部署启动环境中的同名变量（也兼容旧 `QQBOT_APP_ID` / `QQBOT_APP_SECRET`）。部署环境的值请通过服务管理器或密钥管理注入，不要提交到仓库。加密记录存在但无法解密时不会静默回退到另一个机器人。

「清除凭据」会断开连接并删除已保存的凭据（包括旧本地引用），不会清除服务的环境变量。若状态仍显示「已配置」，请检查启动环境；如要切换或停用部署凭据，需在服务环境中改动后重启。

## 腾讯二维码绑定（可选）

在运行 DSH 的环境单独安装 [`@tencent-connect/qqbot-connector@1.2.0`](https://www.npmjs.com/package/@tencent-connect/qqbot-connector)。该 SDK 要求 Node.js `>=18`，包元数据标记为 `UNLICENSED`；本仓库不分发其源码，项目自身的 Node.js 版本要求不变。

在同一 DSH 设置页展开「使用腾讯二维码绑定」，点击「开始扫码」，需要时点「刷新扫码状态」查看最新二维码。开始扫码会断开当前官方连接。扫码确认只表示 SDK 已返回凭据；程序保存加密凭据后继续等待真实 Gateway `READY`，收到后才显示「绑定成功，网关已就绪」。二维码仅在当前过程和主人管理页临时展示，不写入磁盘或聊天记录。

## 消息与回复

当前支持 `GROUP_AT_MESSAGE_CREATE`、`C2C_MESSAGE_CREATE` 和 `AT_MESSAGE_CREATE`。开启 AI 回复后，DSH 模型只接收当前消息文本（附件仅有文字提示），没有 OneBot 身份、主人权限、工具、会话历史或长期记忆。停用、断开或授权变化后，在发送前重新校验。监控只保留发送所需的结果元数据，不保存官方聊天正文；平台接受请求不等同于收件人已收到。

被动回复按 UTF-8 切分，每块不超过 3000 字节，最多回复 5 块；超限时拒绝该回复。主人专用 `send` 动作仍受 QQ 平台的主动消息规则约束。

## 验收边界

隔离 DSH 和夜航网页验收使用测试凭据，验证设置与权限，不连接腾讯。仓库测试通过替身覆盖 SDK 回调、令牌、Gateway 协议、事件解析、权限隔离和回发。真实手机 QQ 扫码、腾讯 Gateway 上线、生产消息收发和外部模型仍需使用实际账号另行验收。

# QQ 官方机器人

`qq-official-bot` 是独立于 NapCat/OneBot 的官方开放平台通道。它支持腾讯官方二维码绑定和手动 AppID/AppSecret 配置，使用凭据获取 `access_token`，通过 Gateway WebSocket 接收事件，再使用官方 OpenAPI 回发消息。

官方资料：

- [QQ 开放平台](https://q.qq.com/)
- [QQ 机器人 API 文档](https://bot.q.qq.com/wiki/develop/api-v2/)
- [腾讯官方 Node SDK 示例](https://github.com/tencent-connect/qqbot-nodejs)
- [二维码绑定 SDK](https://www.npmjs.com/package/@tencent-connect/qqbot-connector)

二维码绑定使用 `@tencent-connect/qqbot-connector@1.2.0` 的 `startQrConnect` 回调接口：`onQrDisplayed` 提供二维码 URL，`onSuccess` 返回 `QrConnectCredentials[]`，`onFailure` 报告失败或取消，`onQrExpired` 报告过期，函数返回 `stop()`。该包要求 Node.js `>=18`，npm 页面标注为 `UNLICENSED`，因此项目把它声明为可选 peer 依赖，不在默认公开分发包中强制打包。需要二维码绑定时，应在运行 DSH 的环境单独安装该包。

## 配置

在 QQ 开放平台创建机器人，准备 AppID 和 AppSecret。密钥不能写入 `state.json`、插件配置、日志或 URL。可以在已有 QQ 桥接会话中调用插件动作 `plugin.qq-official-bot.set-credentials` 保存，也可以在启动 DSH 前设置环境变量：

```powershell
$env:DSH_QQ_OFFICIAL_APP_ID = '你的 AppID'
$env:DSH_QQ_OFFICIAL_CLIENT_SECRET = '你的 AppSecret'
```

插件启用后默认自动连接。沙箱环境勾选 `sandbox`，正式环境使用 `https://api.sgroup.qq.com`。Gateway 的 intents 位掩码默认订阅群聊和 C2C 消息：

- `1 << 25`：群聊和 C2C 消息
- `1 << 30`：频道公域 @ 消息

`allowedUsers`、`allowedGroups` 留空表示不增加本地白名单；填写后只处理匹配的官方平台 OpenID。官方平台的 ID 不一定是传统 QQ 数字号，不能填入 OneBot 的 QQ 监听白名单来代替。

## 消息和限制

当前支持 `GROUP_AT_MESSAGE_CREATE`、`C2C_MESSAGE_CREATE` 和 `AT_MESSAGE_CREATE`。群聊与频道消息通常要求 @机器人，插件会去掉官方事件中的 @ 占位符后交给 DSH AI。

官方平台的被动回复有时间窗口和单条入站消息最多 5 个回复分块的限制；插件按 UTF-8 字节切分，每块不超过 3000 字节，并拒绝超过 5 块的被动回复，避免静默丢失尾部。`send` 动作用于显式发送，但平台可能限制主动消息，不能把它当作 OneBot 的无限制主动推送。

## 二维码绑定状态

设置页的“官方二维码绑定”调用三个受权限保护的插件动作：`qr-login-start`、`qr-login-status`、`qr-login-cancel`。二维码 URL 和生成的图片只保存在当前进程内存及当前管理页面显示所需的短期响应中，不写入 DSH credentials；扫码成功后只把 SDK 返回的 AppID/AppSecret 写入 DSH credentials，并复用现有客户端等待真实 Gateway `READY` 事件。

## 状态和凭据

设置页只显示凭据是否已配置、Gateway 状态、Bot 名称和最近错误，不回显 AppSecret 或 access token。access token 只保存在进程内存并在过期前刷新；停用插件会停止 WebSocket 和重连定时器。

## 验收边界

仓库测试使用模拟 SDK 回调、HTTP 和 WebSocket，覆盖二维码会话生命周期、重复启动、取消、过期、失败、token、Gateway identify/heartbeat、事件解析、分块回发和凭据脱敏。真实手机 QQ 扫码、真实 `READY`、重启恢复和正式消息收发需要用户自己的账号、已安装 SDK 和手机操作；本次代码测试没有冒充这些真实验收结果。

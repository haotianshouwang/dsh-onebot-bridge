# QQ 官方 Bot 二维码登录真实环境验收记录

验收日期：2026-11-06（Asia/Shanghai）

结论：**C. 不通过**。环境检查完成，但真实二维码登录、真实消息收发和重启恢复未执行，因为实际运行环境没有安装二维码 SDK，且该包许可证标注为 `UNLICENSED`，授权条件未被确认。没有在授权不明确时安装或绕过许可，也没有伪造扫码结果。

## 实际运行环境

- DSH 使用独立 profile 运行，未将开发目录假定为运行目录。
- Node.js：`v24.21.0`
- DSH、NapCat 和 OneBot 均在本机监听。
- 本次没有重启 DSH；运行进程可能尚未加载本轮插件文件修改。

## SDK 检查

检查结果：源码依赖目录、实际 DSH profile 依赖目录和 profile 根依赖目录均不存在该包。

从实际运行副本执行动态导入得到：

```text
ERR_MODULE_NOT_FOUND: Cannot find package '@tencent-connect/qqbot-connector'
```

只读 npm 元数据核对结果：

- 目标版本：`1.2.0`
- Node 要求：`>=18.0.0`
- license：`UNLICENSED`
- 当前 Node `v24.21.0` 满足版本要求

由于 `UNLICENSED` 的授权和公开分发范围未确认，本次未安装 SDK，未修改 lockfile，也未把 SDK 强制加入公开产物。当前插件的动态加载错误路径可工作，但真实 SDK 加载无法验证。

## 真实扫码链路结果

| 验收项 | 结果 | 证据 |
|---|---|---|
| 创建二维码会话 | 未执行 | SDK 未安装 |
| 前端收到真实二维码 | 未执行 | SDK 未安装 |
| 手机 QQ 扫码 | 未执行 | 无可用二维码 |
| `onSuccess` 回调 | 未执行 | SDK 未安装 |
| `QrConnectCredentials[]` | 未执行 | SDK 未安装 |
| AppID/AppSecret 校验 | 仅模拟测试通过 | 无真实回调 |
| DSH credentials 保存 | 未进行真实交接 | 无真实回调 |
| AccessToken | 未执行 | 无真实凭据 |
| Gateway WebSocket | 仅既有模拟测试通过 | 无真实账号 |
| `READY` | 未执行 | 无真实 Gateway |
| 页面显示在线 | 未执行 | 无真实连接 |

## 消息收发

未执行真实 QQ Bot 消息接收或发送，因此不能声称消息路由、回复去重或 Agent 行为通过真实验收。既有 540 项测试仍属于模拟 HTTP、WebSocket、SDK 回调和本地插件测试。

## 异常和重启测试

未执行真实 SDK 取消、二维码过期、SDK 网络异常、AccessToken 失败、Gateway 失败、READY 超时或 DSH 退出时 SDK `stop()` 测试。源码级模拟覆盖了会话取消、过期、失败、重复启动和 SDK 缺失错误。

未执行真实凭据重启恢复；当前不能把内存中的二维码会话或模拟凭据视为持久化登录。

## 工作区保护

验收期间未执行 `git reset`、`git clean`、强制覆盖、生产数据库修改或依赖安装。仓库 `main` 分支存在大量用户未提交修改，包含 QQ/微信相关未跟踪文件；这些修改均未被清理或覆盖。

## 后续前置条件

只有在确认 `@tencent-connect/qqbot-connector@1.2.0` 的使用授权后，才能在实际 DSH profile 环境安装该 SDK。之后还需要用户提供可用 QQ Bot 账号并主动使用手机 QQ 扫码，才能继续记录真实 `onSuccess`、凭据持久化、Gateway `READY`、消息收发和重启恢复证据。

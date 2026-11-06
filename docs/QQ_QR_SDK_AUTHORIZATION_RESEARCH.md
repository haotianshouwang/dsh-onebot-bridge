# QQ 官方 Bot 二维码登录 SDK 授权与替代方案调查

查询日期：2026-11-06（Asia/Shanghai）

结论：**方案 B：授权不明确，继续保留可选扩展，不进行安装。**

腾讯官方生态已经存在二维码绑定实现，腾讯维护的 `tencent-connect/dsh-qqbot` 官方 DSH 插件公开说明“手机 QQ 扫码连接”，并将 `@tencent-connect/qqbot-connector@1.2.0` 列为依赖。可是，二维码 connector 自身在 npm 元数据中标注为 `UNLICENSED`，没有独立公开 LICENSE、repository 或明确的分发授权说明。官方插件使用它，不能自动推导第三方插件可以复制、再分发或强制安装它。

## 1. 资料和证据

### 腾讯官方 QQ Bot 文档

- [启动接入](https://bot.q.qq.com/wiki/develop/api-v2/)
- [获取访问凭证](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html)
- [QQ 开放平台](https://q.qq.com/)

官方文档明确说明：创建机器人后获得 `AppID` 和 `AppSecret`；`access_token` 是机器人身份调用 API 的凭证，不需要终端用户授权；服务端通过 `appId`、`clientSecret` 获取 token，当前有效期约 7200 秒，调用 API 时使用 `Authorization: QQBot ACCESS_TOKEN`。官方文档还列出 Node.js SDK Demo，但提示 SDK 仅提供接入参考，具体能力以官方文档为准。

官方 API 文档没有找到一个面向第三方插件开发者、明确描述 `QrConnectCredentials[]`、`startQrConnect`、二维码绑定任务或 connector 分发许可的独立协议页面。官方文档中的“手机 QQ 扫码”出现在开放平台账号注册/社区入口语境，不能单独作为 connector 授权条款。

### 腾讯维护的官方 DSH 插件

- [tencent-connect/dsh-qqbot](https://github.com/tencent-connect/dsh-qqbot)
- [官方仓库 package.json](https://github.com/tencent-connect/dsh-qqbot/blob/main/package.json)
- [官方仓库 LICENSE](https://github.com/tencent-connect/dsh-qqbot/blob/main/LICENSE)

该仓库页面将自己描述为“让 QQ Bot 接入 DeepSeek Harness（dsh）的官方插件”，仓库许可证为 MIT。README 明确写出桌面设置页使用手机 QQ 扫码连接，扫码成功后凭据自动保存；CLI 模式也描述终端二维码、手机 QQ 扫码绑定和保存到 profile。官方 package.json 同时声明：

```json
"dependencies": {
  "@tencent-connect/qqbot-connector": "1.2.0"
},
"peerDependencies": {
  "@tencent-connect/qqbot-connector": "1.2.0"
}
```

这证明 connector 被腾讯维护的官方 DSH 插件作为运行依赖使用，是“官方生态支持该接入方式”的强证据；但该仓库的 MIT LICENSE 只覆盖 `dsh-qqbot` 仓库代码，不能扩展解释为 connector 本身获得 MIT 授权。

### connector npm 包元数据

- [npm package page](https://www.npmjs.com/package/@tencent-connect/qqbot-connector)
- [npm registry metadata](https://registry.npmjs.org/@tencent-connect%2fqqbot-connector)

对 `@tencent-connect/qqbot-connector@1.2.0` 的 npm 元数据进行只读核对：

- version：`1.2.0`
- engines：`node >=18.0.0`
- license：`UNLICENSED`
- author：空字符串
- npm maintainers：`uv-w`、`vnues`、`zuosh`、`joyqwang`、`tencentconnectqqbot`、`ryanlee-gemini`
- `publishConfig.access`：`public`
- 未发现 package metadata 中的 `repository`、`homepage` 或独立授权 URL

`publishConfig.access=public` 只能说明 npm 发布可见性，不能说明任何人可以自由复制、再分发或商业使用。`UNLICENSED` 也不能直接推断“禁止使用”或“允许个人使用”；它表示 npm 元数据没有授予可依赖的标准开源许可证。当前没有找到腾讯官方对该 connector 的个人使用、服务器部署、插件分发或商业使用授权文字。

## 2. 发布主体和维护主体

可以确认的事实：

1. npm 包的 scope 是 `@tencent-connect`。
2. 腾讯维护的 `tencent-connect/dsh-qqbot` 和 `tencent-connect/openclaw-qqbot` 都把该 connector 列为 `1.2.0` 依赖。
3. `tencent-connect/dsh-qqbot` 仓库是公开仓库，仓库页面标注官方 DSH 插件和 MIT LICENSE。
4. npm connector 的 maintainers 列表包含 `tencentconnectqqbot@gmail.com`，但 npm maintainer 名称和邮箱本身不是法律授权文件。

无法确认的事实：

1. npm 包的实际发布账号与腾讯公司的法律主体是否相同。
2. connector 源码的独立仓库地址和版权归属。
3. `UNLICENSED` 是临时漏填、内部发布策略，还是有意限制分发。
4. 是否允许第三方把 connector 作为普通 dependency 打包到插件压缩包、桌面安装包或公开 npm 包。
5. 是否允许商业服务器、托管服务、多租户环境或 SaaS 使用。
6. 是否允许用户自行安装后由第三方插件动态加载。

这些问题只能由腾讯 Connect/QQ Bot 维护团队或明确的书面许可确认，不能由 npm scope、官方仓库依赖关系或社区文章替代。

## 3. 官方支持的登录和接入方式

### AppID/AppSecret + Access Token + Gateway

这是腾讯 QQ Bot 官方文档明确描述的标准服务端接入流程：

```text
QQ 开放平台创建机器人
→ 获得 AppID/AppSecret
→ 服务端获取 access_token
→ Gateway WebSocket / API
→ 接收和发送消息
```

官方文档明确给出了 token URL、请求参数、有效期、刷新规则和 `QQBot` Authorization 头。该方案不需要在每次启动时进行用户 OAuth 授权。

### 手机 QQ 扫码绑定

腾讯维护的官方 DSH 插件 README 明确支持：

- DSH 设置页手机 QQ 扫码连接
- CLI 终端二维码扫码绑定
- 扫码成功后凭据自动保存
- 后续启动无需再次扫码
- 无端内页面时可使用浏览器扫码降级

因此，二维码绑定在腾讯官方 DSH 插件生态中确实存在成熟实现。当前没有找到 QQ Bot API 文档对 connector 的低层协议和授权条款说明；`startQrConnect` 和 `QrConnectCredentials[]` 仍属于 npm connector 的实现接口。

### OAuth 或授权码替代流程

官方“获取访问凭证”页面只列出机器人身份使用的 `access_token`，并明确该凭证“不需要用户授权”。本次没有找到一个可替代 connector、并且能返回机器人 `AppID/AppSecret` 的公开 OAuth 授权码流程。用户 OAuth 与机器人身份 token 不是同一种凭据，不能自行混用。

## 4. 方案比较

| 方案 | 官方支持程度 | 授权明确程度 | 技术可行性 | 维护成本 | 分发风险 | 用户操作 |
|---|---|---|---|---|---|---|
| A. 直接使用 `@tencent-connect/qqbot-connector@1.2.0` | 腾讯官方 DSH 插件正在使用，生态支持证据强 | **不明确**，npm 标注 `UNLICENSED`，无独立授权文本 | 高，现有 `qr-connector.js` 已适配 | 低到中，受 SDK 版本影响 | **高**，不能默认公开打包或再分发 | 扫码简单 |
| B. 保留可选 peer/运行时扩展，由用户自行安装 | 与 A 相同的官方生态支持 | **仍不明确**，但不把未授权包强制分发 | 高，现有动态 import 和缺失提示已支持 | 中，需记录安装和版本 | 低于 A，避免默认再分发 | 用户需自行安装 SDK |
| C. 手动 AppID/AppSecret | 官方文档明确支持 | 高，官方文档直接说明凭据和 token 流程 | 高，现有 `QQOfficialClient` 已实现 | 低 | 低 | 用户复制两项凭据 |
| D. 自行实现二维码协议或模拟官方认证 | 无官方公开协议依据 | 无法确认，存在绕过/违规风险 | 不应实施 | 高 | 高 | 表面简单，实际不可审计 |
| E. 迁移到腾讯官方 `dsh-qqbot` 插件 | 官方仓库、官方 DSH 插件和二维码流程证据最完整 | 插件本身 MIT；connector 仍需单独看待 | 高，但需要更换 DSH 插件架构 | 中到高 | 由官方插件维护，但会引入架构迁移 | 官方插件安装后扫码 |

## 5. 现有代码只读审计

### `src/builtins/qq-official/qr-connector.js`

- 使用动态 `import('@tencent-connect/qqbot-connector')`，SDK 缺失时会进入 `FAILED` 并返回可读错误。
- 只允许一个活动会话。
- 保存 SDK 返回的 `stop()`，支持取消、失败、过期和插件停用清理。
- 不把二维码 URL 或图片写入长期凭据；二维码展示状态只保留在进程和短期页面响应中。
- 成功回调交给 `index.js` 处理，不直接记录 AppSecret。

### `src/builtins/qq-official/index.js`

- SDK 通过 `qrSdkLoader`/动态 import 接入，缺失时不会伪造登录成功。
- `selectQrCredentials()` 遍历并验证 `appId`、`appSecret`。
- 成功后使用现有 DSH credentials API 保存，再复用 `QQOfficialClient`。
- 只有客户端收到真实 `READY` 后，状态才更新为在线。
- 手动 `set-credentials`、`connect`、`disconnect` 仍保留。
- 手动保存凭据会取消活动二维码会话，避免二维码结果覆盖手动配置。

### `src/builtins/qq-official/client.js`

- 使用 AppID/AppSecret 获取 AccessToken。
- AccessToken 只保存在进程内存并按有效期刷新。
- Gateway 使用 WebSocket、Identify、READY、Heartbeat、RESUME/重连。
- 错误信息会过滤 client secret 和 access token。
- 消息接收和发送逻辑与二维码适配器独立。

### `package.json`

当前声明为：

```json
"peerDependencies": {
  "@tencent-connect/qqbot-connector": "1.2.0"
},
"peerDependenciesMeta": {
  "@tencent-connect/qqbot-connector": {
    "optional": true
  }
}
```

这与“默认公开分发包不强制携带 `UNLICENSED` SDK”的策略一致。缺点是用户未自行安装 SDK 时二维码功能不可用，但手动 AppID/AppSecret 仍可工作。

### `docs/QQ_OFFICIAL_BOT.md`

已记录 SDK API、`UNLICENSED` 元数据、可选依赖策略、动态加载和真实验收边界；没有把模拟测试写成真实扫码通过。

## 6. 风险判断

### 凭据风险

现有实现没有把 AppSecret、AccessToken 或 QR URL 放进普通日志；二维码状态也没有作为长期凭据保存。手动配置和二维码配置最终都进入同一 DSH credentials 接口，认证适配器没有与微信或 OneBot 共用状态。

### 分发风险

如果把 connector 放入 `dependencies`、lockfile、压缩包或桌面安装器，可能构成对一个 `UNLICENSED` 包的再分发。官方 DSH 插件的做法证明腾讯自己的插件可以这样发布，但没有给出第三方项目的许可授权。因此本项目不应据此自行扩大分发权限。

### 协议风险

不应根据社区代码、反向接口或二维码 URL 自行实现同等协议。当前可审计路径只有：用户自行安装 connector，或使用腾讯官方 DSH 插件。

## 7. 最终推荐

当前推荐：**方案 B**。

保留现有二维码适配器和手动 AppID/AppSecret 作为两个独立入口，但不安装、不打包、不强制分发 `@tencent-connect/qqbot-connector`。在设置页明确提示：未安装 SDK 时二维码入口不可用，手动配置仍然可用。

若腾讯 Connect 团队书面确认以下事项，可以再评估方案 A：

1. 允许第三方插件在服务器端调用该 connector。
2. 允许用户自行安装后由插件动态加载。
3. 允许作为可选依赖出现在项目 package metadata 和安装说明中。
4. 是否允许插件分发 connector，或必须让用户从 npm 单独安装。
5. 是否存在品牌、商业、地区或账号权限限制。

如果授权无法确认，则继续采用方案 B；如果未来决定不支持任何 QR 依赖，则退回方案 D 的可行替代不是“自研协议”，而是方案 C，保留手动 AppID/AppSecret。

## 8. 本次未修改内容

本次没有安装 SDK，没有修改 `package.json`、lockfile、QQ/微信业务代码、消息路由、Agent 意图识别、生产 profile 或数据库，也没有重启 DSH。仅新增本调查报告。

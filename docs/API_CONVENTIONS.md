# API 约定

## 1. 管理站点

只监听 `127.0.0.1:3097`，请求必须是本机地址、Host/Origin 合法。除登录/初始化/会话查询外，POST 必须带会话 Cookie 和 `x-csrf-token`。

### 1.1 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 控制台 HTML |
| GET | `/assets/app.css`、`/assets/app.js` | 静态资源 |
| GET | `/api/session` | `{ok, configured, authenticated, csrf}` |
| POST | `/api/setup` | 首次设置管理密码 |
| POST | `/api/login` | 登录，成功设置 HttpOnly Cookie |
| POST | `/api/logout` | 退出并锁定该会话的秘密空间 |
| POST | `/api/password` | 修改管理密码，销毁其他会话 |
| POST | `/api/action` | 白名单动作分发 |
| GET | `/api/sticker-image?id=...` | 会话鉴权的表情原图 |
| GET | `/api/qzone-image?url=...` | 会话鉴权、QQ 图片域名白名单代理 |
| GET | `/api/qzone-avatar?id=...` | 会话鉴权的 QQ 好友头像代理 |

### 1.2 请求

```http
POST /api/action
Content-Type: application/json
x-csrf-token: <session.csrf>

{"action":"stickerAdmin","op":"list","query":{"offset":0,"limit":24}}
```

`action` 必须在 `src/web/admin-server.js` 的 `ALLOWED_ACTIONS` 中。`revision` 由前端自动附带；需要乐观锁的动作会校验。

### 1.3 响应

成功：

```json
{"ok": true, "value": { "...": "..." }}
```

失败：

```json
{"ok": false, "error": "面向用户的错误信息"}
```

HTTP 状态：

| 状态 | 场景 |
|---|---|
| 200 | 成功 |
| 400 | 参数/业务校验失败 |
| 401 | 未登录/会话过期/密码错误 |
| 403 | CSRF、Origin、Host、权限不足 |
| 404 | 资源不存在 |
| 405 | 方法不允许 |
| 413 | 请求体过大 |
| 415 | 非 JSON |
| 429 | 登录/解锁限速 |
| 500 | 未预期错误 |

错误信息必须截断、脱敏，不能包含堆栈、Cookie、Token、密码、秘密正文。

## 2. 动作命名

- 页面数据：`stickerAdmin`、`qzoneAdmin`、`memoryAdmin`、`autonomyAdmin`，用 `op` 区分。
- 秘密空间：`secretAdmin`，必须带 `op` 和页面级 `vaultSession`。
- 配置保存：`configureNativePackage`，参数 `{id,enabled,config,scope,preserveSecrets?}`。
- 插件安装/卸载：`prepareUninstall`、`confirmUninstall`、`restorePackage`。
- 旧动作名保持不变；新增动作必须加入白名单和文档。

### 2.1 分页

`offset` 从 0 开始，`limit` 有上限；响应：

```json
{"items":[],"total":0,"offset":0,"limit":20,"hasMore":false}
```

### 2.2 管理动作

| action/op | 读/写 | 主要参数 | 返回 |
|---|---|---|---|
| `stickerAdmin/overview` | 读 | — | 状态、配置、统计、分类 |
| `stickerAdmin/list` | 读 | `query` | 表情元数据（不含图片字节） |
| `stickerAdmin/remove` | 写 | `id` | 被删记录、overview |
| `stickerAdmin/annotate` | 写 | `id,name,emotion,tags,usage` | sticker、overview |
| `qzoneAdmin/overview` | 读 | — | 状态、配置、同步进度 |
| `qzoneAdmin/friends` | 读 | `query` | 好友列表、头像代理、每人动态数/错误 |
| `qzoneAdmin/refresh-friends` | 读/刷新 | — | 重新读取 `get_friend_list` |
| `qzoneAdmin/feed` | 读 | `offset,limit,friendId,query,order` | 已同步动态分页 |
| `qzoneAdmin/sync` | 写 | `friendIds?` | 后端批量同步好友动态 |
| `memoryAdmin/overview` | 读 | — | 统计、配置（无密钥） |
| `memoryAdmin/list` | 读 | `query` | 分页记忆 |
| `memoryAdmin/get` | 读 | `id` | 记忆、复习记录、下次复习 |
| `memoryAdmin/create/update/remove` | 写 | 字段/ID | 变更记录 |
| `memoryAdmin/graph` | 读 | `scope,limit` | 节点、推断边 |
| `memoryAdmin/reviewOverview` | 读 | `id?` | 待复习、曲线、真实记录 |
| `memoryAdmin/reviewComplete` | 写 | `id,note?` | 新复习记录 |
| `autonomyAdmin/overview` | 读 | — | 今日、最近、下次 |
| `autonomyAdmin/diaryList/get` | 读 | 筛选/ID | 日记 |
| `autonomyAdmin/diaryCreate/Update/Delete` | 写 | 字段/ID | 变更 |
| `autonomyAdmin/activityList/Create/Update/Delete` | 读写 | 字段/ID | 活动 |
| `autonomyAdmin/timeSummary` | 读 | `from,to` | 分类/按天汇总 |
| `secretAdmin/status` | 读 | — | 模式、决策、分享状态；不含密码 |
| `secretAdmin/decide` | 写 | `force?` | 请求角色通过受限 Agent 决策；已有空间不覆盖 |
| `secretAdmin/request-share` | 写 | — | 仅角色选择分享时解锁本次查看 |
| `secretAdmin/lock` | 写 | — | 立即锁定 |
| `secretAdmin/list/get/create/update/remove` | 读写 | ID/标题/正文 | 解锁后内容或元数据 |
| `secretAdmin/setup` | 兼容写 | `legacy:true,password` | 仅旧版迁移，不是新用户流程 |
| `secretAdmin/change-password/reset` | 写 | 当前/新密码、`RESET` | 旧版改密/清空 |

## 3. DSH 宿主 API

`src/host/index.js` 通过 `ctx.connection.fetch.register` 暴露 `/api/qq-bridge`，只接受 JSON。该入口由 DSH 的 owner 身份/Host/Origin 保护，不是公网 API。

`qqFramework` SDK 的调用关系：

```
PluginSDK.facade()
  ├─ registerTrustedPackage(manifest) → api
  ├─ api.action(name, def, handler)
  ├─ api.on(types, handler)
  ├─ api.invoke(capability, args, context, signal)
  ├─ api.putResource(bytes, context, opts)
  ├─ api.storage.get/set/update
  ├─ api.settings(def, provider)
  └─ api.registerContextProvider(fn)
```

动作能力 ID 为 `plugin.<pluginId>.<action>`；核心动作如 `qq.message.send`。

## 4. 权限

- 管理站点：本机会话 + CSRF；写操作仍需后台校验。
- DSH 宿主：owner 身份 + 同源校验。
- QQ 动作：`ownerOnly`、`mutating`、`publicSafe`、作用范围、额度、到期时间、拒绝优先。
- 秘密空间：独立密码 + 页面 nonce；不因管理登录而自动解锁。
- 前端隐藏按钮不是权限控制；后端必须再校验。

## 5. 日志查询

`snapshot.logs` 返回最近 100 条；页面只展示最后 60 条。日志字段：

```json
{"time":"ISO","level":"info|warn|error","message":"...","detail":{}}
```

`detail` 不能包含 Token、Cookie、密码、秘密正文。审计另存 `data/.../admin/audit.jsonl`，只记录登录/改密结果和 IP/UA 摘要。

## 6. 版本与兼容

- 管理 API 没有独立版本号，随插件版本发布；新增字段保持向后兼容。
- 删除字段/改变语义必须先在文档和迁移中说明。
- 旧页面/旧动作名至少保留一个版本周期。
- 新增 action 必须同步更新 `ALLOWED_ACTIONS`、前端调用、测试和本文档。

## 7. 执行结果协议（protocol 1）

实现：`src/core/result.js`（状态、转换、归一化）与 `src/core/contracts.js`（能力验证契约）。
`Actions.invoke()` 返回的对象保留原有字段（包括 `outcome`），并新增：

```json
{"state":"submitted","verified":false,"evidence":{"messageId":"123","retcode":0},"protocol":1,"finishedAt":"2026-11-01T03:00:00.000Z"}
```

### 7.1 状态

| state | 含义 | 允许转出 |
|---|---|---|
| `requested` | 已提出请求，尚未授权 | authorized / submitted / failed / cancelled |
| `authorized` | 权限、范围、额度通过 | submitted / accepted / failed / cancelled |
| `submitted` | 已提交给下游（WS 已写出、HTTP 2xx） | accepted / confirmed / failed / unknown |
| `accepted` | 下游明确受理，但无回读证据 | confirmed / unknown / failed |
| `confirmed` | 已按该能力契约拿到成功证据 | — |
| `failed` | 有明确失败证据 | — |
| `unknown` | 证据不足（超时、断线、读回不一致）；**不得自动重试** | confirmed / failed（仅在拿到新证据后） |
| `cancelled` | 取消、权限失效、插件停用 | — |

### 7.2 能力契约

| 能力 | 网关 ACK 后 | 确认条件 |
|---|---|---|
| `qq.message.send` 及 image/audio/video/file/forward | `submitted` | 仅证明已提交；`messageId` 进入 evidence |
| `qq.message.recall`、`qq.poke`、`qq.request.decide`、群资料修改 | `submitted` | 未回读，不声称已生效 |
| `qq.profile.nickname` | `submitted` | 回读 `get_login_info` 昵称一致才 `confirmed`，否则 `unknown` |
| `plugin.qq-qzone.comment` | `accepted` | HTTP 200 只代表受理 |
| `plugin.qq-qzone.publish` | `submitted` | `tid` 进入 evidence |
| `plugin.qq-sticker.send`、`plugin.qq-tts.speak`、`plugin.qq-web.image-send` | `submitted` | 未收到对端回执 |
| 本地落库（记忆、日记） | `confirmed` | 本地事务完成 |

### 7.3 兼容与扩展

- `outcome` 暂不改变，避免破坏旧调用方；所有新增代码和发送结果判断必须读 `state`。不得根据旧的 `outcome=confirmed` 生成“已送达/已完成”提示。
- 任何新的 `mutating` 核心动作必须在 `CAPABILITY_CONTRACTS` 声明契约，`tests/result-protocol.test.js` 会拒绝漏声明。
- 契约只能让状态更严格或更弱：`ack` 降级到 `submitted/accepted`，`verify:'readback'` 可升级到 `confirmed` 或降级为 `unknown`。
- 工具审计（`framework.audit`）新增 `state` 字段；`started` 记 `authorized`，完成/失败记实际状态。

### 7.4 追溯标识

每次执行身份（`permissions.issue`）都带 `traceId`，默认等于 `机器人:会话类型:对象:消息ID`：

- 同一条 QQ 消息触发的所有动作、审计行共享同一个 `traceId`；
- `permissions.audit` 行包含 `traceId/state/riskLevel/capability`；
- DSH 工具审计（`entry.audit`）包含 `traceId/state/verified/mutating`；
- 任务步骤保存 `traceId/state/verified/planIndex`，可回查该步对应的工具调用。

因此一次处理可以按 `traceId` 串起：入站消息 → 工具审计 → 任务步骤 → 最终回复。

### 7.5 任务步骤字段

`TaskStore.addStep` 新增并持久化：

| 字段 | 含义 |
|---|---|
| `planIndex` | 对应第几个计划步骤（从 1 开始），重试后仍指向同一计划步 |
| `state` | 本步工具结果的协议状态（空表示旧记录） |
| `verified` | 本步是否拿到验证证据 |
| `traceId` | 关联工具审计 |
| `idempotent` | `true` 只读可重试 / `false` 调用过写操作、禁止自动重放 / `null` 未判定 |

`steps` 验证按 `planIndex` 匹配，并要求对应步骤为 `state=confirmed` 且 `verified=true`；`submitted/accepted` 不能自动完成任务。旧任务只有明确的 `outcome=confirmed` 才兼容通过。`tool` 验证优先比较显式声明的 `state`，没有 `state` 时才退回 outcome 子串匹配。

执行器采用**执行前写意图**：先 `beginStep` 落盘 `running`，再调用外部能力，最后 `completeStep` 写回结果。进程在调用前/调用中崩溃，重启后该步骤被标为 `unknown`，任务进入 `failed` 并保留历史。普通 `failed -> planning` 不能确认未知结果；只有主人调用 `qq.task.recover` 并传入 `confirmed:true`，写入 `recovery.acknowledgedAt` 后才允许新一次尝试。`unknown` 结果与调用过写操作的失败步骤都不会自动重试。

### 7.6 错误分类与可观测性

实现：`src/core/errors.js`。分类只用于聚合与展示，不改变抛出的错误。

| 类别 | 典型来源 |
|---|---|
| `input` | 参数缺失、类型/范围校验失败 |
| `permission` | 仅主人、未授权、超出范围、额度/冷却 |
| `auth` | 登录凭据失效、认证/鉴权失败 |
| `network` | 未连接、DNS/连接失败 |
| `downstream` | OneBot retcode 失败、下游明确拒绝 |
| `timeout` | 明确超时且没有“结果未知”语义 |
| `unknown` | 超时/断线导致结果无法判定，禁止自动重试 |
| `cancelled` | 用户取消、插件停用、租约失效 |
| `persistence` | state.json/tasks.json 写入失败 |
| `plugin` | 插件回调异常、插件处理超时 |
| `internal` | 兜底 |

可关联字段：

- `framework.audit[]`：`traceId / state / errorClass / durationMs / capability / riskLevel`；
- DSH 工具审计（`entry.audit`）：`traceId / state / verified / mutating / errorClass / durationMs`；
- 消息任务（`inbox[].execution`）：本轮工具调用摘要 + `replyState`，即“最终回复对应的实际执行结果”；
- `snapshot.taskDetails`：最近 10 个任务的步骤、工具、状态、错误分类、是否验证、是否重试、`traceId` 与历史。

因此一次处理可以按 `traceId` 还原：入站消息 → 工具审计 → 任务步骤 → 最终回复。日志与审计中的 Token、Cookie、`access_token`、密码会被脱敏。

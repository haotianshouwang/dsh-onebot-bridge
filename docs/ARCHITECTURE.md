# 架构说明

> 适用版本：dsh-onebot-bridge 0.13.0（本次 UI/插件治理后的实现）。
> 修改代码前必须先阅读本文、`DEVELOPMENT.md`、`CODING_STANDARDS.md` 和 `PLUGIN_SYSTEM.md`。

## 1. 系统边界

```
DSH 0.2.1-rc.2
  └─ dsh-onebot-bridge（本仓库 plugins/dsh-onebot-bridge）
       ├─ src/host/index.js       DSH 插件入口，注册 qqFramework SDK
       ├─ src/onebot/             OneBot 11 正向/反向 WebSocket
       ├─ src/session/            会话、Agent、回复、媒体输入
       ├─ src/core/               权限、动作、事件、媒体、插件模型
       ├─ src/builtins/           源码内置包与可信原生包
       ├─ src/extensions/         声明式扩展加载器
       ├─ src/market/             市场索引、安装、升级、回滚
       ├─ src/sdk.js              可信原生插件 SDK（API 2）
       ├─ src/web/                独立管理站点（夜航控制台，127.0.0.1:3097）
       └─ src/admin/              四个功能包的只读/管理服务
```

外部进程：

- **NapCat**：QQ 协议网关，OneBot 11 正向 `ws://127.0.0.1:3001`。
- **DSH**：宿主，端口 3080；提供模型、会话、工具、文件、凭据等能力。
- **夜航控制台**：同一 Node 进程内的 HTTP 服务，只监听 `127.0.0.1:3097`。

## 2. 前端与后端

角色情绪与群聊见闻由独立源码插件 `src/builtins/emotion/` 提供，ID 为 `qq-emotion`。宿主仅提供已接收的范围内对话、零工具结构化观察和现有主动联系队列；插件用 SDK 存储心情、消息来源与分享状态。日常回复通过 SDK 上下文读取，自动选表情和自主活动读取同一份衰减后的状态。插件没有直接发送权限，来源失效、停用、账号或范围变化均撤销旧分享。详见该插件 README。

### 2.1 夜航控制台

| 文件 | 职责 |
|---|---|
| `src/web/admin-server.js` | HTTP 路由、静态资源、会话/CSRF、动作白名单、表情/空间图片代理 |
| `src/web/admin-auth.js` | scrypt 管理密码、内存会话、登录限速、审计 |
| `src/web/public/index.html` | 单页入口，严格 CSP，无内联脚本/样式 |
| `src/web/public/app.css` | 暖白主题、布局、表格、表单、弹窗、星图/曲线样式 |
| `src/web/public/app.js` | 原生 ES 模块；登录、导航、总览和四个插件页面 |
| `src/web/public/star-map.js` | Three.js/WebGL 记忆星云；独立销毁/缩放/旋转/搜索，含 WebGL 降级 |
| `src/session/proactive.js` | 主动联系决策、安静时段、频率、去重与回执 |
| `src/session/tasks.js` | 持久化任务状态机、步骤、验证与恢复 |

控制台没有构建步骤，也没有引入第二套 UI 库。页面通过 `fetch` 调用 `/api/action`，不直接访问 QQ 网关。

### 2.2 DSH 内的 QQ 框架页

`src/client/client.js` 是 DSH “设置 → QQ 框架”的客户端扩展，保留 DSH 自身主题；独立控制台是另一套入口。改独立站点时不要破坏 `src/client/client.js` 的注册。

## 3. 管理 API 数据流

以表情包收集概率为例：

```
管理员修改概率
  → app.js POST /api/action {action:'configureNativePackage', id:'qq-sticker', config:...}
  → admin-server 校验会话、CSRF、Host/Origin 和动作白名单
  → host action() 调用 checkConfig() 校验并写入 state.json
  → 插件下次自动收藏时读取 nativePackages['qq-sticker'].config.collectProbability
  → stickerAdmin.overview() 返回真实配置与统计数据
  → 页面重新渲染
```

同一条链路适用于 QQ 空间、长期记忆和自主时间。只改前端数字而不改插件读取逻辑，视为未完成。

### 3.1 只读与写入

- 页面数据读取：`stickerAdmin`、`qzoneAdmin`、`memoryAdmin`、`autonomyAdmin` 的 `overview/list/get/...`。
- 配置写入：统一走 `configureNativePackage`，由 `src/core/package-model.js` 的 `validateConfig` 校验。
- 表情图片：`GET /api/sticker-image?id=...`，要求有效管理会话，返回二进制，不把大图塞进 JSON。
- 秘密空间：`secretAdmin`，要求管理会话 + 页面级 `vaultSession`；解锁密钥只存在内存。
- 删除日记、记忆、表情等破坏性操作：前端二次确认，后端仍做存在性和权限校验。

## 4. 插件加载

### 4.1 源码内置包（builtin）

`src/builtins/index.js` 定义 `ai-chat`、`persona`、`welcome`、`poke`、`market`。它们不是独立 Node 包，由 `Builtins` 类在宿主内读写 `framework.builtins`。

### 4.2 源码可信原生包（native-source）

`src/host/index.js` 在启动时调用：

```js
activateSticker(sdk.facade(), {stickers, readResource});
activateQzone(sdk.facade(), qzoneBackend);
activateMemory(sdk.facade(), {store: memory, log});
activateAutonomy(sdk.facade(), {dir, native, persona, online, log});
```

每个 `activate*` 调用 `framework.registerTrustedPackage(manifest)`，注册动作、事件、上下文提供器或设置页数据提供器。运行状态在 `framework.nativePackages[id]`。

### 4.3 声明式扩展（extension）

`src/extensions/index.js` 从 `data/dsh-onebot-bridge/extensions/<id>/` 读取 `manifest.json` 与 `rules.json`，只执行固定规则，不加载 JavaScript。安装记录在 `state.extensions[id]`。

### 4.4 市场包

`market-dist/*.zip` 是分发产物，不是源码目录。构建脚本在 `src/builtins/market` / `scripts/build-market.mjs`，安装时解压到数据目录并登记扩展记录。源码插件与市场声明式包不是同一种运行时。

## 5. 数据存储

| 路径 | 内容 | 是否敏感 |
|---|---|---|
| `data/dsh-onebot-bridge/state.json` | 设置、插件配置、会话映射、日志 | 可能含配置，不含管理密码 |
| `data/dsh-onebot-bridge/admin/admin.json` | scrypt 管理密码哈希 + salt | 敏感，不能发布 |
| `data/dsh-onebot-bridge/stickers/` | 表情图片和 `index.json` | 用户数据 |
| `data/dsh-onebot-bridge/memory/memory.db` | 长期记忆 SQLite、复习记录 | 用户数据 |
| `data/dsh-onebot-bridge/autonomy/` | `state.json`、`diary.jsonl`、`activities.jsonl` | 用户数据 |
| `data/dsh-onebot-bridge/private/secret-vault.json` | AES-256-GCM 密文、salt、nonce、tag、设备密钥封装 | 高敏感，禁止外发 |
| `data/dsh-onebot-bridge/private/secret-decision.json` | 角色创建/分享决策与理由，不含密码 | 敏感 |
| `data/dsh-onebot-bridge/private/secret-audit.jsonl` | 创建/分享/解锁审计，不含密码或正文 | 敏感 |
| `data/dsh-onebot-bridge/qzone/admin-status.json` | 同步状态、好友数量、游标 | 低敏感 |
| `data/dsh-onebot-bridge/qzone/feed.json` | 已同步的好友动态、图片 URL、评论/点赞 | 高敏感，禁止发布 |
| `data/dsh-onebot-bridge/proactive/state.json` | 主动联系计数、结果、去重 hash | 敏感 |
| `data/dsh-onebot-bridge/tasks/tasks.json` | 任务目标、计划、步骤、验证 | 用户数据 |
| `data/dsh-onebot-bridge/media/` | 1 小时媒体资源池 | 临时数据 |

`state.json` 写入通过 `src/host/store.js` 串行化，并使用 `.bak`。记忆库使用 Node 内置 `node:sqlite`。秘密空间与普通日记完全分离。角色密码的设备密钥保存在 DSH credentials（`QQBOT_SECRET_DEVICE_KEY`），不写入 `private/`。

## 6. 启动顺序

1. `Store.open()` 读取/迁移 `state.json`。
2. 构造权限、事件、媒体、动作、内置包、SDK、扩展、市场、路由。
3. 打开表情库、QQ 空间后端、TTS、记忆库、自主时间。
4. 构造四个 admin 服务，打开 `qzone/admin-status.json`、`qzone/feed.json`、`private/secret-vault.json`。
5. 启动 `startAdminServer`（失败只记日志，不影响 QQ 桥接）。
6. 启动市场、媒体、扩展、原生包、OneBot 连接；启动 QQ 空间同步调度器、自主时间 tick 与主动联系 tick。
7. 注册每小时媒体清理、长期记忆清理、自主时间历史保留。
8. 首次启用且秘密空间未初始化时，QQ 在线后触发一次受限 Agent 决策。

停用时逆序释放：路由、OneBot、扩展、SDK、记忆库、管理站点、媒体；必要时提交状态。

## 7. 权限边界

- 管理站点：只有通过管理密码登录的本机会话能调用 `/api/action`；写操作还要 CSRF。
- QQ 动作：`Permissions` 在每次调用前检查主人、作用范围、动作开关、额度和到期时间。
- 插件动作：SDK `check()` 再次校验插件 active、作用范围和调用身份。
- 私密空间：角色自主决策 + 设备密钥封装 + 页面级 nonce；角色选择保密时管理密码也不能读取内容。
- 市场：只接受声明式包；原生插件属于可信宿主代码，必须经过人工审阅。

## 8. 已知边界

- QQ 空间好友列表来自 OneBot `get_friend_list`；动态解析会尽量读取正文、图片、评论、点赞，但字段是否出现取决于 QQ 实际响应，缺失时明确标注。
- QQ 空间自动同步已实现为后端串行分批任务；仍受本地 `readPerHour` 保护、QQ 接口配额、登录状态和空间隐私限制，不能突破它们。
- QQ 空间缓存会保存真实动态正文；`qzone/feed.json` 属于高敏感用户数据，不应发布。
- 业务次数策略：QQ 空间推荐值发布 3/天、评论 5/天；自主时间推荐 8 次/天；`custom` 使用自定义值；`unlimited` 只取消业务每日上限，不取消冷却、每小时读取保护、活动时段、每分钟调度或 QQ 接口配额。
- 长期记忆的复习计划只持久化真实复习记录并计算下次建议时间；**没有后台推送提醒**，需要打开页面查看。
- 聊天定时提醒独立于记忆复习与自主闲聊：主人通过 `qq.task.create` 的 `delaySeconds` 或 `remindAt` 创建持久化提醒，宿主每秒调度到期任务，只向创建时的当前聊天发送。离线或暂停时等待恢复；原账号、主人或监听范围变化则取消。发送意图先落盘，未知结果不重发；普通任务执行器不接管提醒。简单中文相对时间请求由路由直接创建，复杂日期由模型调用同一动作。
- 每轮回复从实际注册的动作与当前权限生成语音、提醒、表情能力状态，避免把没有授权误称为没有功能。自动表情仍由独立模型选择，图片在文字后单独发送，QQ 小表情保留在文字消息中，消息贴表情走反应接口；各自记录真实回执。
- 原生源码插件没有独立的“热更新代码”生命周期；启用/停用通过 `enabled` 与 SDK `api.active()` 检查生效，升级由 DSH 插件管理完成。
- 管理站点只使用 HTTP + 本机回环；远程访问需要自行加 HTTPS 反向代理。

## 9. 相关文档

- `DEVELOPMENT.md`：本地启动、测试、排错。
- `PLUGIN_SYSTEM.md`：三类插件、清单、生命周期、兼容。
- `PLUGIN_DEVELOPMENT.md`：新插件教程。
- `UI_GUIDELINES.md`：新页面必须遵循的视觉规范。
- `API_CONVENTIONS.md`：路由与响应格式。
- `REAL_ACCEPTANCE.md`：真实 QQ 验收清单、证据要求与记录工具。
- `PHASE4_DELIVERY.md`：第四阶段交付报告（审计、修改、测试、未决问题、建议）。
- `SECURITY.md`：密码、密钥、日志脱敏。
- `MIGRATION.md`：旧配置、旧目录和升级顺序。

# 真实 QQ 环境验收清单

> 本文件只记录真实 QQ 环境的验收；模拟网关、单元测试和模型自述都不能算真实验收。
> 任何一项标记 `real-pass` 之前，必须能指出证据文件/消息 ID/截图路径。

## 1. 状态定义

| 状态 | 含义 |
|---|---|
| `unit-pass` | 单元测试通过，未经过任何网关 |
| `mock-pass` | 本机模拟 OneBot 网关通过 |
| `real-pass` | 真实 QQ 账号/网关通过，且有证据 |
| `real-fail` | 真实环境执行失败，有错误/证据 |
| `untested` | 尚未在真实环境执行 |
| `blocked` | 当前环境无法执行（缺账号、缺设备、沙箱限制等） |

**禁止**：把 `mock-pass` 改写成 `real-pass`；把“消息已提交”改写成“对方已收到”；把模型回复当成执行证据。

## 2. 环境要求

- 专用测试 QQ 账号与测试群，不使用真实社群；
- NapCat 已登录，OneBot 正向 `ws://127.0.0.1:3001` 可连；
- 机器人主人 QQ 已配置；测试群已加入监听；
- 测试前备份 `data/dsh-onebot-bridge/state.json` 与 `data/dsh-onebot-bridge/tasks/`；
- 所有写操作只发给测试账号/测试群，并记录 `message_id`。

## 3. 验收矩阵

| # | 能力 | 检查项 ID | 当前状态 | 证据 |
|---|---|---|---|---|
| 1 | WebSocket 连接与账号绑定 | `ws-connect` | `mock-pass` | OneBot 正向/反向单测 |
| 2 | 断线与重连恢复 | `ws-reconnect` | `mock-pass` | `tests/reconnect.test.js` |
| 3 | 私聊文本收发 | `private-text` | `untested` | — |
| 4 | 群聊文本收发（@、分条） | `group-text` | `untested` | — |
| 5 | 图片接收（视觉/OCR） | `image-recv` | `untested` | — |
| 6 | 图片发送 | `image-send` | `mock-pass` | 曾真实提交一次 `message_id=1991601745`，未确认对端显示 |
| 7 | 语音接收（转写） | `voice-recv` | `untested` | — |
| 8 | 本地语音生成与发送 | `voice-send` | `blocked` | 本机受限环境无法初始化 SAPI，见 TEST_REPORT |
| 9 | 文件接收（TXT/DOCX/PDF） | `file-recv` | `untested` | — |
| 10 | 文件发送 | `file-send` | `untested` | — |
| 11 | 撤回自己 2 分钟内的消息 | `recall` | `untested` | — |
| 12 | 群资料查询 | `group-info` | `mock-pass` | `tests/execution-loop.test.js` |
| 13 | 好友/加群请求审批 | `request-approve` | `untested` | — |
| 14 | DSH 重启后的任务恢复 | `restart-recovery` | `untested` | 只有 store reopen 模拟 |
| 15 | 主动联系真实送达 | `proactive-send` | `untested` | 曾真实发送一条任务通知，未做接收确认 |
| 16 | 记忆写入与回忆 | `memory-recall` | `mock-pass` | `tests/memory.test.js` |

## 4. 逐项步骤

### 4.1 `ws-connect` 连接与账号绑定

1. 启动 NapCat 与 DSH，确认机器人 QQ 在线。
2. 打开“运行状态”，确认 `bot/self_id` 与机器人 QQ 一致、状态 `connected`。
3. 用普通好友给机器人发一条消息，确认事件计数增加。

预期：`status.state=connected`、`status.bot` 正确、事件可收到。
证据：`snapshot.status` 截图或 JSON、消息 ID。
失败处理：检查 3001 端口、Token、NapCat 登录；不要把“端口在监听”当成已登录。

### 4.2 `ws-reconnect` 断线与重连

1. 在 NapCat 侧断开连接或重启 NapCat。
2. 观察桥接状态变为 `disconnected`，未完成请求标为 `unknown`。
3. 恢复后确认自动重连、重新 `get_login_info/get_status`。

预期：无重复发送；旧请求不自动重发；状态回到 `connected`。
证据：运行日志时间线、`audit` 中 `state=unknown` 的记录。
失败处理：检查退避时间与 Token；不要手工重发未知结果的消息。

### 4.3 `private-text` 私聊文本

1. 测试好友发送“在吗”，确认收到一条回复。
2. 检查分条、引用设置是否符合配置。
3. 检查 `inbox` 任务为 `done`，`execution.replyState=submitted`。

预期：回复内容与上下文一致，不重复、不刷屏。
证据：QQ 截图 + 发送 `message_id` + `inbox` 任务摘要。

### 4.4 `group-text` 群聊文本

1. 在测试群 `@机器人 介绍一下这个群`。
2. 确认只回复一次，按配置分条，必要时引用。
3. 未 @ 时按“仅被叫/适度参与”策略处理。

预期：群内不越权、不@他人、不泄露私聊内容。
证据：群截图 + `participationDecision` + 发送账本。

### 4.5 `image-recv` 图片接收

1. 向机器人发送一张含文字的图片。
2. 确认图片作为真实图片块进入模型（vision），或回退 OCR。
3. 检查媒体资源 ID 与有效期。

预期：模型能看到图片内容；失败时明确提示，不编造。
证据：工具返回的 `resourceId`、模型描述、日志。

### 4.6 `image-send` 图片发送

1. 让机器人“把这张图发回来”或使用联网图片发送。
2. 确认 `qq.image.send` 返回 `state=submitted` 且带 `messageId`。
3. 在测试账号侧肉眼确认图片显示。

预期：发送成功且对端可见；`accepted/unknown` 不得声称已收到。
证据：截图 + `messageId`。

### 4.7 `voice-recv` 语音接收

1. 发送一条语音给机器人。
2. 确认 NapCat `fetch_ptt_text` 返回转写文本；不支持时明确报错。

预期：转写文本进入上下文；不把转写当成用户原文引用。
证据：转写结果、`message_id`。

### 4.8 `voice-send` 本地 TTS

1. 在设置页启用 `qq-tts` 与 `qq.audio.send`，选择本机音色。
2. 说“用语音说一句……”，确认生成非空音频并发送。
3. 在接收端播放。

预期：音频非空、可解码、可播放；失败时错误包含引擎与 HRESULT。
当前：`blocked`——受限环境 SAPI 返回 `0x80045040`；宿主重载后需重测。
证据：`voice.wav.json`、MP3 大小、接收端播放录屏。

### 4.9 `file-recv` 文件接收

1. 发送 TXT/DOCX/PDF 各一份。
2. 确认正文提取、大小/页数限制、receipt 保存。
3. 发送可执行文件或超限文件，确认拒绝。

预期：只读正文，不执行内容，不访问任意本机路径。
证据：提取摘要、receipt ID、拒绝提示。

### 4.10 `file-send` 文件发送

1. 让机器人发送一个受控资源文件到测试聊天。
2. 确认 `qq.file.send` 的结果状态与 `messageId`。
3. 接收端下载并校验内容。

预期：文件可下载、内容一致；失败不重试未知写操作。
证据：文件哈希 + 截图。

### 4.11 `recall` 撤回

1. 让机器人发送一条消息。
2. 2 分钟内要求撤回；确认只撤回自己发送的当前聊天消息。
3. 超过 2 分钟或他人消息，确认拒绝。

预期：`delete_msg` 执行成功；越界请求被拒绝。
证据：撤回前后截图、审计记录。

### 4.12 `group-info` 群资料

1. 在测试群说“查一下这个群的资料”。
2. 确认回复中的群名/人数与 QQ 实际一致。
3. 在私聊中查询另一个群，确认不会越权读取未监听群。

预期：数据来自真实接口；越权时明确拒绝。
证据：QQ 群资料截图 + 工具返回 JSON。

### 4.13 `request-approve` 请求审批

1. 用测试小号向机器人发好友请求 / 加群请求。
2. 在“请求收件箱”确认出现，选择同意或拒绝。
3. 确认 QQ 侧结果，并确认不会因此获得工具权限。

预期：审批只处理请求，不授予聊天或工具权限。
证据：请求截图 + 审批结果 + `grants` 未变化。

### 4.14 `restart-recovery` 重启恢复

1. 创建一个多步任务并推进到 `executing`。
2. 在步骤执行中重启 DSH（使用 `restart.cmd`）。
3. 重启后检查：步骤被标记 `unknown`，任务 `failed`，不自动重发；人工确认后可重新规划。

预期：不重复执行外部写操作；历史可审计。
证据：重启前后 `tasks.json`、`history`、QQ 侧无重复消息。

### 4.15 `proactive-send` 主动联系

1. 开启主动联系，设置每日上限与安静时段。
2. 等待或触发一次真实事件，确认只发一条且内容有真实依据。
3. 检查频率、去重、`replyState`。

预期：无内容时 SKIP；发送结果如实记录。
证据：`proactive/state.json`、消息 ID、接收截图。

### 4.16 `memory-recall` 记忆

1. 说“记住我不吃香菜”，确认写入。
2. 新会话问“我吃什么忌口”，确认回忆。
3. 检查范围隔离（私聊/群/用户）。

预期：只注入当前聊天可见的记忆；过期/冲突有标记。
证据：`memory.db` 记录 ID、回复截图。

## 5. 证据记录工具

`scripts/acceptance.mjs` 提供最小闭环：

```powershell
node scripts/acceptance.mjs init
node scripts/acceptance.mjs record private-text real-pass --account 测试号 --evidence "截图: evidence/private-text.png; message_id=123"
node scripts/acceptance.mjs record voice-send blocked --note "受限环境 SAPI 0x80045040"
node scripts/acceptance.mjs report
```

约束：

- `real-pass` 必须带 `--evidence`，否则拒绝写入；
- 需要真实账号的检查项必须带 `--account`；
- 状态只能是六种之一；
- 运行记录写入 `acceptance-runs/<timestamp>.json`，报告由记录生成，不手工改状态。

## 6. 当前结论

- 协议、权限、任务恢复、错误分类已有单元/模拟覆盖；
- **真实 QQ 验收尚未执行**：没有专用测试账号/群的证据，也没有接收端确认；
- 本地 TTS 在当前环境 `blocked`；
- 本清单完成前，不得把插件描述为“已通过真实环境验收”。

# 第四阶段交付报告（A–E）

- 项目：`dsh-onebot-bridge`（QQ 框架 + 夜航控制台）
- 时间：2026-11-01
- 范围：可靠性与执行闭环（不新增业务功能）
- 结论：**执行协议、闭环、恢复、错误分类与验收工具已落地；真实 QQ 验收尚未执行，本地 TTS 在宿主中的真实合成仍未验收。**

---

## A. 原有实现审计

### A.1 架构

| 层 | 模块 | 职责 |
|---|---|---|
| 入口 | `src/host/index.js` | 装配、工具注册、定时器、管理 API、snapshot |
| 传输 | `src/onebot/index.js` | 唯一 OneBot 客户端，正/反向 WS、echo、重连 |
| 权限 | `src/core/permissions.js` | 唯一权限系统，执行身份租约、grants、额度、审计 |
| 动作 | `src/core/actions.js`、`src/onebot/extended.js` | 28 个核心动作 + 任务动作 + 包动作 |
| 会话 | `src/session/router.js`、`native.js` | 入站、参与判断、DSH Agent、发送 |
| 任务 | `src/session/tasks.js`、`task-runner.js` | 状态机、步骤、验证、每 tick 一步 |
| 插件 | `src/builtins/*`、`src/sdk.js` | 内置包与可信原生包 |
| 管理 | `src/web/*`、`src/admin/*` | 独立控制台与四个包管理服务 |

关键事实：任务持久化是 `tasks/tasks.json`，不是 SQLite；`data/dsh/profiles/web/node_modules/dsh-onebot-bridge` 是指向源码目录的 junction。

### A.2 执行结果

审计时 `confirmed` 的唯一生产者是 OneBot `status=ok && retcode=0`；生产代码 24 处引用。问题：

- 发送、改资料、审批、空间评论共用同一档 `confirmed`；
- 空间评论仅凭 HTTP 200 即 `confirmed`；
- 任务步骤“任意工具 ok”即成功，`accepted` 也算；
- `unknown` 与失败没有区分，超时会进入自动重试。

### A.3 任务与恢复

状态：`pending → analyzing → planning → waiting_approval → executing → verifying → done`，`failed → planning` 有限重试。审计发现 6 个缺陷：无 write-ahead、unknown 当失败重试、步骤成功判据过宽、`steps` 验证索引漂移、`tool` 验证子串匹配、过期记忆复查任务永久 `pending`。

### A.4 测试

审计时 372 项，全部为单元/模拟；真实环境只有一次发图、一次学习、一次 readback 任务、一条主动消息的历史记录。

### A.5 五个优先问题与顺序

1. `confirmed` 语义混同；2. 结果结构不统一；3. 任务步骤验证太弱；4. 崩溃/超时重复执行；5. 可观测性无关联 ID。
顺序：契约 → 发送/审批 → 追溯 ID → 任务恢复 → TTS → 真实验收。

---

## B. 本次修改清单

### B.1 新增模块

| 文件 | 作用 |
|---|---|
| `src/core/result.js` | 8 状态、合法转换、结果归一化、模型侧状态提示 |
| `src/core/contracts.js` | 能力级确认契约（submitted/accepted/readback） |
| `src/core/errors.js` | 11 类错误分类 + 凭据脱敏 |
| `src/session/verify-task.js` | 可复用的任务验证器（steps/tool/readback/memory） |
| `scripts/acceptance.mjs` | 真实验收记录与报告工具（拒绝无证据 real-pass） |

### B.2 行为变化

| 文件 | 修改 | 原因 | 行为变化 |
|---|---|---|---|
| `src/core/actions.js` | `invoke/request` 归一化、审计 state/errorClass/耗时、契约目录 | 统一结果协议 | 返回值新增 `state/verified/evidence/protocol/finishedAt`，`outcome` 保留 |
| `src/core/permissions.js` | 审计字段 + `traceId` | 关联执行链 | 审计行新增 traceId/state/errorClass/durationMs |
| `src/session/native.js` | 工具审计 + `auditOf()` | 执行证据 | 工具记录含 state/verified/errorClass/durationMs |
| `src/session/router.js` | `job.execution`、`replyState`、errorClass | 回复对应实际结果 | 每条消息任务可查本轮工具状态与最终发送状态 |
| `src/session/tasks.js` | `beginStep/completeStep`、恢复标记、`taskDetail` | write-ahead 与可观测 | 步骤先落盘再执行；崩溃后 `unknown`；步骤含 planIndex/state/verified/idempotent/errorClass/traceId |
| `src/session/task-runner.js` | 意图先行、unknown 不重试、幂等门禁、guard | 安全恢复 | 非幂等失败不自动重放；未知步骤只能通过显式 `qq.task.recover` 人工确认恢复 |
| `src/host/index.js` | 验证器抽取、任务详情、记忆复查调度、guard | 闭环与可观测 | 复查任务进入 planning；snapshot 增加 taskDetails |
| `src/builtins/tts/index.js` | 三级回退、诊断留存、清理正文 | TTS 失败可定位 | 失败错误含引擎/HRESULT/音色；保留 debug/json |
| `src/web/public/app.js` | 任务列表/步骤表 | 管理台可查询 | 展开任务可看工具、状态、错误分类、追踪 ID |

### B.3 兼容性

- `outcome` 未改，旧调用方与 UI 不受影响；
- 旧任务在 `open()` 时补 `planIndex/state/verified/errorClass`；
- 旧步骤缺 `state` 时验证回退 outcome 子串；
- 新增的 `mutating` 动作必须声明契约，否则测试失败。

### B.4 测试与文档

新增测试：`result-protocol`、`execution-loop`、`task-recovery`、`reconnect`、`observability`、`acceptance`。
新增文档：`docs/REAL_ACCEPTANCE.md`、本报告；更新 `API_CONVENTIONS.md`、`TASK_STATE_MACHINE.md`、`TEST_REPORT.md`、`README.md`、`ARCHITECTURE.md`。

调整了 3 处旧断言，均因协议字段/幂等键按设计变化，语义未放宽：

- `tests/core.test.js` 原生 SDK 用例：不再 deepEqual 整个返回值，改为校验 actor/plugin + 新增协议字段；
- `tests/task-runner.test.js`：步骤幂等键从 `plan:` 改为 `exec:<taskId>:<planIndex>:<attempt>`；
- `tests/tts.test.js`：新增本地合成诊断断言，原有用例未删除。

---

## C. 测试结果

### C.1 自动化

```text
npm test
tests 407
pass 407
fail 0
```

复核环境中 `tests/phase4.test.js` 的 ffmpeg 短视频用例已通过；此前沙箱 `spawnSync` 的 EPERM 不再复现。

### C.2 真实/模拟分层

| 层级 | 结果 |
|---|---|
| 单元测试 | 407 通过 |
| 模拟 OneBot 网关 | 通过（发送、查询、断线、重连、任务） |
| 真实 QQ | **未执行** |

验收矩阵（`docs/REAL_ACCEPTANCE.md`）：`mock-pass` 5 项、`blocked` 1 项（本地 TTS）、`untested` 10 项。本轮未向真实 QQ 发送任何消息。

### C.3 额外证据

- 管理控制台：`GET /` 200、`GET /assets/app.js` 200（143 KB），内容已含任务明细渲染；
- TTS 生成脚本：PowerShell Parser `errors=0`；SAPI 音色探测失败不会阻断 `System.Speech` 回退；任一普通失败都会保留已脱敏的 debug/json 诊断；
- 验收 CLI：`init → record → 无证据 real-pass 被拒 → report` 全链路通过。

---

## D. 未解决问题

1. **真实 QQ 验收未执行**：没有专用测试账号/群的证据，也没有接收端确认；10 项 `untested`。
2. **本地 TTS 未在宿主中验收**：受限环境复现到 `0x80045040`（`SPERR_INVALID_REGISTRY_KEY`）与 `.NET` 安全上下文失败；三级回退与诊断已实现，但宿主真实合成仍需重载后确认。
3. **外部写操作没有端到端幂等键**：`qq.message.send` 仍靠“不自动重试”避免重复，不是靠去重键。
4. **管理台任务页未在登录态肉眼验收**：只验证了静态资源与单元逻辑。
5. **记忆自动过期复查/冲突合并仍不完整**：已有字段与复查任务，但没有自动合并策略。
6. **`outcome` 与 `state` 双语义并存**：发送插件已迁移为读取 `state`；兼容窗口内其他旧调用方仍可能读取 `outcome`。
7. **任务执行器只允许只读/记忆工具**：写操作任务仍需人工推进，未扩展。
8. **TTS 失败目录保留**：仅清理正文/脚本，目录本身会留在临时区，需要定期清理策略。

---

## E. 下一阶段建议

**P0｜真实环境验收**
用专用测试账号与测试群执行 `docs/REAL_ACCEPTANCE.md` 的 16 项，先跑连接/文本/图片/群资料/撤回，再跑语音、文件、审批、重启恢复；每项用 `acceptance.mjs` 记录账号与证据。

**P1｜消息级幂等与回执**
为 `qq.message.send` 增加可选 `idempotencyKey`（本机持久化 LRU + 结果对账），把 `submitted` 与真正的送达/回读分开；空间评论改为回读确认。

**P1｜宿主 TTS 复测**
重载插件后调用 `plugin.qq-tts.speak`，读取 `voice.wav.json` 确认实际引擎与 HRESULT；若仍是安全上下文问题，明确本地 TTS 在该宿主不可用，并在设置页提示改用网络语音。

**P2｜可观测性补全**
管理台增加按 `traceId` 搜索、按错误分类过滤；审计与任务步骤做保留/轮转策略。

**P2｜记忆生命周期**
实现过期复查的自动计划与冲突合并，并把复查结果写回记忆状态。

**P2｜执行器扩展**
在写操作具备幂等键与回读验证后，再允许任务执行器推进写步骤；继续保持 `unknown` 不自动重试。

---

## 目标完成对照

| 目标项 | 状态 |
|---|---|
| 先审计并输出 7 项 | 完成（第 1 轮） |
| 任务一 统一执行结果协议 | 完成 |
| 任务二 工具执行闭环（三个试点） | 完成 |
| 任务三 任务恢复与幂等 | 完成（端到端发送幂等除外） |
| 任务四 真实 QQ 验收体系 | 清单/工具完成，真实执行未进行 |
| 任务五 错误分类与可观测性 | 完成 |
| 任务六 TTS 0 字节 | 复现 + 三级回退 + 诊断完成，宿主真实合成未验收 |
| A–E 交付报告 | 本文件 |

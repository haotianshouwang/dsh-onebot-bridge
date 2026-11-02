# TASK_STATE_MACHINE.md

## 1. 实现位置

- 存储与状态机：`src/session/tasks.js`
- 有限执行器：`src/session/task-runner.js`
- 验证器：`src/session/verify-task.js`（`createVerifyTask`，宿主与测试共用）
- 动作：`src/core/actions.js` 的 `qq.task.*`
- 宿主验证器/调度：`src/host/index.js`

动作默认未启用；`taskRunnerEnabled` 默认关闭。

## 2. 状态

```text
pending
  -> analyzing
  -> planning
  -> waiting_approval
  -> executing
  -> verifying
  -> done

任一非终态 -> failed / cancelled
failed -> planning（有限重试）
```

`verifying -> done` 现在必须已有 `verification.ok=true`；没有验证结果会被拒绝。

## 3. 任务字段

- `id`、`goal`、`reason`、`completion`；
- `status`、`createdAt`、`updatedAt`、`closedAt`；
- `plan[]`、`steps[]`、`maxSteps`；
- `attempts`、`maxRetries`；
- `budgetMs`；
- `verificationMethod`：`manual` / `steps` / `tool` / `readback` / `memory`；
- `verificationSpec`：能力、期望结果、回读路径/期望值/参数；
- `idempotencyKey`；
- `verification`：实际验证结果；
- `memoryIds[]`、`history[]`。

每个步骤（`steps[]`）带：`index`、`planIndex`、`title`、`tool`、`status`、`state`、`verified`、`idempotent`、`outcome`、`note`、`traceId`、`operationKey`、`at`。

## 4. 验证策略

### manual

执行完计划步骤后进入 `verifying`，必须显式 `qq.task.verify` 再进入 done。

### steps

要求每个计划步骤都有 `status=done`、`tool` 非空、`state=confirmed`、`verified=true`，并且按 `planIndex` 对得上计划序号。`submitted/accepted` 只代表请求已提交或受理，不能自动完成任务。
重试会产生新的步骤记录，但仍指向同一 `planIndex`，因此不会因为索引漂移永远验证失败。

### tool

要求指定能力曾在成功步骤中出现；优先比较 `state`（如 `submitted`/`confirmed`），没有 `state` 时才要求 outcome 包含指定字符串。
它验证“执行记录存在”，不等同于独立回读。

### memory

检查指定记忆存在、来源非空、未过期且可信度达到下限。

### readback

验证器重新调用一次动作（如 `core.status`），按 `path` 读取结果并与 `equals` 比较。
这是独立回读；只有结果匹配才自动 done。

真实已验证：

```text
verificationMethod=readback
core.status.online == true
```

## 5. 执行器约束

- 每 tick 只推进一步；
- 只自动推进 `planning` / `executing`；
- 失败步骤不计入计划完成；
- 失败按 `maxRetries` 回到 `planning`；
- 超过 `budgetMs` 直接 failed；
- 重启后从持久化步骤继续；
- 不重复执行已成功步骤；
- 任务级 `idempotencyKey` 防止重复创建；
- 步骤级 `operationKey` 防止同一外部操作重复记录；
- 步骤成功必须有工具结果，且写操作状态只能是 `confirmed` / `submitted` / `accepted`；
- 步骤记录 `state`、`verified`、`traceId`，供管理台和验证器使用；
- **执行前写意图**：先 `beginStep` 落盘 `running`，再调用外部能力；进程在调用前/调用中崩溃，重启后该步骤一定是 `unknown`；
- `running` 步骤恢复为 `unknown` 时，执行器不再自动重放，而是把任务置为 `failed`；普通状态迁移不能确认风险，只有主人显式调用 `qq.task.recover {confirmed:true}`（写入 `recovery.acknowledgedAt`）才允许新一次尝试；
- 结果 `unknown` 一律停止自动执行；失败步骤若调用过写操作（`idempotent:false`）也不自动重试；
- 每次 tick 前重新检查前置条件（主人、桥接、暂停、QQ 在线），不满足则任务失败并留历史记录。

## 6. 仍缺少

- 任务专用管理页（列表/详情/步骤/审计关联）；
- 外部发送类步骤的端到端幂等（目前靠“不自动重试”避免重复，不是靠去重键）；
- 学习任务自动创建与来源冲突验证；
- 真实 `verifying -> done` 的更多任务类型验收。

## 7. 测试

`tests/tasks.test.js`、`tests/task-runner.test.js`、`tests/task-actions.test.js` 覆盖：

- 完成前验证门禁；
- 自动 readback/steps 验证；
- manual 不自动完成；
- 失败重试上限；
- 时间预算；
- 重启恢复；
- C 风险动作的 ownerOnly 拒绝；
- 幂等键。

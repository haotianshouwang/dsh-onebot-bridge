# QQ 框架 0.9.0 阶段一：群聊会话连续化

日期：2026-10-30。范围：只做「同一个群复用同一个 DSH 会话」，不引入自我状态、长期记忆与主动任务。

## 这一阶段改了什么

改动集中在 `src/session/router.js` 的会话选择处（原第 188-193 行）：

- 旧行为：`if(session&&(msg.kind==='group'||...))` —— 群聊**每条消息**都 `native.reset()` 旧会话再重建，
  只有私聊才复用。
- 新行为：群聊按 `机器人:group:群号|shared` 复用同一个会话；只有下面三种情况才退役重建：
  1. 框架代次变化（改配置、撤授权、启停插件都会 `invalidate()`）；
  2. 人设 id 或版本变化；
  3. 空闲超过 6 小时（常量 `SESSION_IDLE_MS`）。
- 会话在 DSH 侧已经不存在（`session/not-found` 一类错误）时：本轮自动退役并重建一次再重试。
  重建发生在任何内容发送之前，因此不会重复发消息。

新增 `Router` 私有方法：`stampSession()`、`sessionExpired()`、`retireSession()`，以及模块级常量
`SESSION_IDLE_MS` 与 `isSessionGone()`。`Router` 构造函数新增 `this.boot`（每进程随机），
写入会话记录便于排查「这条会话是哪个进程建的」。

## 没有动的东西

- 执行身份仍然每条消息新建：`receive()` 里的 `permissions.issue(msg, ...)` 未改。
- 权限判断、系统禁止项、授权范围、每分钟额度未改。
- 公共聊天背景（40 行 / 14000 字）仍然每轮注入。
- 续聊窗口、合并窗口、过时检查、取消、分条与发送预算全部保留。
- `state.json` 结构不变：只是在 `sessions[key]` 上多写一个 `boot` 字段，旧文件可直接读。

## 会话生命周期

| 事件 | 旧行为 | 新行为 |
| --- | --- | --- |
| 群聊第一条消息 | 新建会话 | 新建会话 |
| 群聊第二条消息 | 退役旧会话 + 新建 | **复用同一会话** |
| 私聊 | 按用户+模式复用 | 不变 |
| 改配置 / 撤授权 | 重建（代次变化） | 不变 |
| 切换人设 | 重建 | 不变 |
| 空闲 6 小时 | 每条都重建，无此概念 | 退役重建 |
| DSH 会话丢失 | 本轮直接失败 | 自动重建一次并重试 |
| 新建上下文 | 退役并删除映射 | 不变 |

## 权限隔离怎么保证

复用会话**只共享对话文本**，不共享授权：

1. 每条消息都 `permissions.issue()` 生成独立的 `context`（含 `boot`、`generation`、租约）。
2. `native.prepare()` 每轮按当轮 `context` 重新决定注册哪些工具（`permissions.decision`）。
3. 工具执行时 `tools.guard` 回调再查 `active.get(sessionId)`，确保用的是**当前轮**的上下文。
4. 发送前 `permissions.resultReason()` 再复核一次已用能力。
5. 上一轮的上下文在 `finally` 里 `close()`，之后 `valid()` 返回「执行上下文已失效或到期」。

已知残留：模型能看到自己上一轮的工具调用与结果，可能据此**以为**仍有同一权限；实际执行会被守卫拦下。
这是共享对话文本的必然代价，阶段二再评估是否在拼接提示时对历史工具结果做摘要化。

## 测试

```
node --test tests/session-lifecycle.test.js   # 12 项新增，全绿
node --test tests/*.test.js                   # 227 项，全绿
```

新增 `tests/session-lifecycle.test.js` 覆盖：连续多轮复用、两个群隔离、群与私聊隔离、成员交替、
@ 唤醒复用、重启后沿用旧 id、空闲过期重建、代次/人设变化重建、会话丢失自愈、非会话错误不误重建、
并发串行、新建上下文清理。

两个旧测试的断言随契约更新：

- `tests/phase5.test.js`：会话不再逐轮轮换（`runs[0].id === runs[1].id`、`archived.length === 0`），
  但「上一轮执行身份立即失效」的断言保留。
- `tests/core.test.js`：同一群两个用户共用会话，但 `actor` 不同、工具决策按当轮身份重算。

## 未验证

- 真实 DSH 进程重启后能否按 `sessionId` 恢复：代码路径已核对
  （`resolveAgent → resolve → agents.resume({resumeSessionId})`，注释明确为「Load a persisted session」），
  但**没有在真实运行环境里重启验证**，标记为未验证。
- 长会话触发自动压缩后的实际表现（阈值 0.8、保留尾部约 0.16）只在代码层核对，未做真实长对话压测。

## 回滚

`src/session/router.js` 一处改动即可回滚：把会话选择处恢复为
`if(session&&(msg.kind==='group'||session.generation!==...))` 并删除新增的三个方法与常量。
数据无需迁移：`sessions[key].boot` 是可选字段，回滚后照常逐轮重建。

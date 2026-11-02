# 迁移与兼容

## 1. 原则

1. 先盘点，再改 ID/目录/配置。
2. 旧插件 ID、数据目录和配置必须能继续读取。
3. 先加兼容层，再迁移；迁移完成并验证后才清理旧代码。
4. 不直接删除旧目录或旧清单。
5. 升级后验证启用、停用、配置读取、动作执行和卸载。

## 2. 当前映射

| 旧/现有 | 插件 ID | 目录 | 数据 |
|---|---|---|---|
| 表情包 | `qq-sticker` | `src/builtins/sticker/` | `data/.../stickers/` |
| QQ 空间 | `qq-qzone` | `src/builtins/qzone/` | 空间正文不落盘；`qzone/admin-status.json` 只存状态 |
| 长期记忆 | `qq-memory` | `src/builtins/memory/` | `data/.../memory/memory.db` |
| 自主时间 | `qq-autonomy` | `src/builtins/autonomy/` | `autonomy/state.json`、`diary.jsonl`、`activities.jsonl` |
| 声明式扩展 | `<package-id>` | `data/.../extensions/<id>/` | 原目录 + `state.extensions[id]` |
| 市场包 | `<package-id>` | zip → 安装目录 | 与声明式扩展相同 |

没有把 `memory/` 重命名为 `long-term-memory/`，也没有把 `autonomy/` 改成 `autonomous-time/`。目录名变化会破坏已安装路径和用户数据，且没有运行时收益。

## 3. 清单迁移

### 3.1 新增字段

- 在同一 `configVersion` 下增加字段，必须提供默认值。
- 旧配置通过 `migrateConfig(old, manifest)` 自动补默认值。
- 示例：sticker 新增 `collectProbability`、`collectCooldownSec`、`maxPerMessage`、`excludeKeywords`，默认值保持旧行为（100%、0 秒、3 张、无排除词）。

### 3.2 删除/重命名字段

必须提升 `configVersion` 并写 `configMigrations`：

```js
configVersion: 3,
configMigrations: [
  {to: 3, rename: {oldName: 'newName'}, remove: ['obsolete'], defaults: {newField: 10}}
]
```

`migrateConfig` 会拒绝缺少迁移步骤的升级；迁移失败时保留旧配置并设置 `migrationError`，不要静默重置。

### 3.3 manifest.json

`npm run sync:manifests` 生成四个源码插件的 JSON 镜像；`npm run check:manifests` 检查漂移。新增字段时先改 `index.js`，再同步，再跑测试。

## 4. 数据迁移

### 4.1 表情包

- `stickers/index.json` 的 `items` 结构未变。
- 新字段只影响自动收集判定，不改变已有图片文件。
- 删除仍按 hash 判断共享文件。

### 4.2 记忆

- `memories` 表结构未变。
- 新增 `memory_reviews` 表在 `MemoryStore.open()` 中自动创建，旧库无需手动迁移。
- 旧记忆默认视为“未复习”，首次复习后写入真实记录。
- 删除记忆会同时删除其复习记录。

### 4.3 自主时间

- 旧 `diary.jsonl` 条目没有 `source` 字段，读取时默认视为 `auto`。
- 新日记写入 `title`、`source`、`createdAt`、`updatedAt`。
- 旧 `state.json` 的 `log` 在首次启动且没有 `activities.jsonl` 时转换为活动记录；这是从真实运行日志派生，不是伪造。
- 新增 `runLimitMode`、日记/活动保留策略、`timelinePageSize`；旧配置默认 `recommended`/`none`，不会自动删除历史。
- 秘密空间：v1 用户密码空间仍按原密码解锁；v2 角色空间使用 `mode:'character'`、`keyWrap`、`secret-decision.json` 和设备凭据 `QQBOT_SECRET_DEVICE_KEY`。不要删除 `private/` 或 DSH credentials 中的设备密钥，否则角色空间无法恢复。
- 已有秘密数据绝不因角色自动决策被覆盖；决策只在 `vault.configured === false` 时执行。

### 4.4 QQ 空间缓存

- 旧 `qzone/admin-status.json` 继续读取；新增 `qzone/feed.json` 保存同步后的真实好友动态。
- 旧版本不缓存正文；升级后第一次同步会建立缓存。`retentionMode:'none'` 默认不主动删除。
- 动态按 `friendId:postId` 去重；同一好友的重复同步不会重复插入。

### 4.4 管理密码

- `admin/admin.json` 结构未变（scrypt + salt）。
- 管理会话在进程重启后失效；秘密空间解锁状态也会失效。

## 5. 插件升级顺序

1. 备份 `data/dsh-onebot-bridge/state.json`、`memory/memory.db`、`autonomy/`、`private/`。
2. 同步源码到 DSH profile（或重装插件）。
3. 重启 DSH。
4. 打开 3097，检查四个插件是否 `registered`。
5. 逐个保存设置，确认 `state.json` 的 `configVersion` 和字段。
6. 测试启用/停用、动作、数据读取。
7. 检查旧配置未被清空。
8. 最后清理旧文件/旧代码。

## 6. 回滚

### 定时提醒数据兼容

`tasks/tasks.json` 继续使用 version 1；普通任务保持原结构，定时任务增加可选 `reminder` 字段，保存目标聊天、原消息 ID、到期时间、正文和真实发送状态。`qq.task.create` 增加可选 `delaySeconds` / `remindAt` / `reminderText`；旧调用不受影响。

待发提醒重启后继续调度；已进入发送但没有回执的提醒标记 unknown，不自动重发。已有发送回执的任务只恢复完成记录。回滚到不支持提醒的代码前，应通过任务取消动作取消待发提醒；旧代码不会执行这些 pending 提醒。

- 源码插件：恢复上一版 `src` 或 DSH profile 副本，重启。
- 配置：使用 `settingsHistory`（最多 5 份）或 `.bak`；恢复前停止服务。
- 市场扩展：`market.rollback` 保留旧 generation；不要手工覆盖目录。
- 秘密空间：回滚二进制不会恢复忘记的密码；只能从旧密文备份 + 已知密码恢复。
- 回滚后重新验证 3097 和四个页面，不能只看进程启动。

## 7. 废弃策略

新增 `qq-emotion` 时保留所有旧 ID 和目录，默认停用，由正常配置接口启用并指定范围。原生包注册自动补齐自主时间的 `proactiveAllowGroupStories:false`，旧配置继续可读。回滚前可停用该插件并关闭群聊分享；旧代码忽略它的 SDK 存储，不删除历史心情与见闻。主动联系文件保持 version 1，新增可选事件来源与事件键；处理中断记录恢复为 unknown，不重新投递。

- 旧动作名、旧配置字段至少保留一个发布周期。
- 删除字段前先在前端标注“已废弃”，并在迁移中移除。
- 旧声明式扩展格式不再支持时，必须提供明确错误和导出/转换路径。
- 不把市场 zip 直接当成源码插件安装；不把源码插件塞进市场 zip。

## 8. 迁移验收

- [ ] 旧 `state.json` 能启动，revision 正常。
- [ ] 四个插件 ID 不变。
- [ ] 旧配置字段可读，新字段有默认值。
- [ ] 旧表情图片/记忆/日记仍能打开。
- [ ] 管理密码仍能登录。
- [ ] 秘密空间旧密文仍能用原密码解锁。
- [ ] 升级后不重复激活、不丢监听器/定时器。
- [ ] 回滚路径可用。

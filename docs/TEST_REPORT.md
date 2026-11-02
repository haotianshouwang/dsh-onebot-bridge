# TEST_REPORT.md

> 本文件只记录实际执行的测试；mock/单元测试不冒充真实 QQ 验收。
> 第四阶段复核时间：2026-11-01。

## 1. 自动化回归

```powershell
cd F:\大肥鱼\plugins\dsh-onebot-bridge
npm test
```

结果：

```text
tests 407
pass 407
fail 0
```

本轮新增/更新的覆盖：

- `tests/tasks.test.js`：状态机、非法迁移、完成前验证门禁、幂等键、验证方式持久化；
- `tests/task-runner.test.js`：每 tick 一步、工具失败重试上限、时间预算、重启恢复、自动验证通过/失败；
- `tests/task-actions.test.js`：任务动作权限、C 级拒绝、完成事件、A/B/C 风险元数据；
- `tests/proactive.test.js`：安静时段、无内容、回执、每日上限、关闭、内容/事件去重、重启状态；
- `tests/autonomy.test.js`：工具审计、双来源、来源记忆、失败不写成功、学习通知；
- `tests/intent.test.js`：结构化意图、旧格式、失败关闭、lastOwnerAt 只随主人更新；
- `tests/web.test.js`：页面日期提取、配额/参数/未知结果不隔离插件；
- `tests/memory.test.js`：来源/过期/冲突/冲突处理。

## 2. 真实运行证据

### 联网学习

真实 `learn`：

```text
耗时约 10.5 秒
ok=true
verified=true
来源：
  https://www.rili.com.cn/
  https://lishi.yyxw.com/dates
新增 2 条带 source_url 的记忆
```

内容质量一般，其中一页正文动态加载；模型明确写了“没读到具体条目”，没有伪造。
当前记忆数据：10 条，其中 `source=web` 3 条。

### 任务

真实任务 runner：

```text
任务：readback-verification-test
步骤：core.status
验证：readback core.status.online == true
结果：done
```

这证明：

- TaskRunner 真实执行；
- 工具调用记录写入步骤；
- `verificationMethod=readback` 独立回读；
- 只有回读通过才自动 `done`；
- 没有把工具 `confirmed` 直接当成任务完成。

此前还有一次任务第一次 DSH agent setup 失败、重试后到 `verifying` 的真实记录。

### 主动联系

已获用户明确授权，真实发送一条任务完成通知：

```text
outcome=confirmed
chars=29
reason=task
```

随后关闭主动联系并恢复安静时段。
当前 `proactive.enabled=false`、`pending=0`，历史保留 `confirmed` 回执。

### 工具与空间

- `qq-web.search/read` 曾真实返回 4 条 Bing RSS 结果和 2611 字正文；
- QQ 空间审计时好友 187、缓存 185 条，自动同步曾推进；
- 真实图片发送：`plugin.qq-web.image-search` -> `plugin.qq-web.image-send`，outcome=`confirmed`，message_id=1991601745，发送到主人私聊；图片来源不受信，未做内容核实。
- 本地 TTS 直接生成（SAPI COM）：Microsoft Huihui Desktop，第三阶段复测 2.1 秒，19,053 字节，音频头通过；
- 通过宿主 `plugin.qq-tts.speak` 真实发送尝试：SAPI 在 DSH 宿主进程改为内存流后仍返回 0 字节音频，动作明确返回“本地语音没有生成音频数据”，未发送 QQ；直接本地 SAPI 可生成，宿主环境差异未解决。

### 本地 TTS 复现（2026-11-01，受限执行环境）

用与插件相同的脚本在独立 PowerShell 5.1（64 位）中复现：

```text
voices=3（Huihui / Zira / David）
sapi-file   -> HRESULT 0x80045040，只留下 46 字节 WAV 头
sapi-memory -> HRESULT 0x80045040（显式 22kHz/16bit/mono 无效）
dotnet      -> SelectVoice: "No voice installed on the system or none available with the current security setting"
```

`0x80045040` 是 `SPERR_INVALID_REGISTRY_KEY`。现象说明：失败不是“没声音”，而是合成进程读不到 SAPI 语音引擎所需的注册表/安全上下文；`GetVoices()` 能枚举（读 HKLM），但 `Speak`/`SelectVoice` 失败。该执行环境属于受限沙箱，**不能据此断定 DSH 宿主的真实原因**；宿主重载后若再次失败，错误信息与保留的 `voice.wav.json` 会给出实际引擎和 HRESULT。

修复：本地合成改为文件流 → 内存流 → `System.Speech` 三级回退；SAPI 音色探测本身失败也不会阻断后两条路径；普通失败统一保留不含正文/音频的诊断目录并报告引擎/HRESULT/音色；发送语义读取 `state`，`submitted/accepted/unknown` 不会声称已送达。真实 QQ 语音发送仍未验收。

## 3. 当前数据清单

- 任务 5 条，全部为测试任务：
  - 4 条 done；
  - 1 条 cancelled；
  - 没有 active / waiting_approval / failed。
- 长期记忆 10 条，`source=web` 3 条；
- `memory_conflicts` 0 条；
- 早期失败学习留下 1 条 global NOAA 来源记忆，仍保留；
- 主动联系历史 1 条 confirmed 测试通知。

这些数据没有删除；测试任务均为 done/cancelled，不会进入 TaskRunner 的 planning/executing 自动执行队列。

## 4. 未验证 / 未实现

- 图片理解、语音转写、TTS 发送的真实 QQ 端到端；图片发送已完成一次 confirmed 实测；
- 记忆自动过期复查和自动冲突合并；
- C 级操作的统一二次确认；
- 真实管理站点登录态；
- 图像生成；
- 学习来源的自动冲突建模、搜索质量评分、重复学习抑制；
- 真实 QQ 群图片输入/语音回执验收；本轮图片发送是主人私聊单次测试。

## 5. 运行配置

- 当前源码与 profile 安装目录一致；是否已加载最新后端模块仍以进程启动时间和重载结果为准；
- `qq-web` 已启用，private scope=true；
- `qq-autonomy` 已启用；
- `taskRunnerEnabled=true`；
- `qq.task.*` 已启用；
- 主动联系当前关闭；
- 未重置数据库、未删除用户记忆/秘密空间、未改管理员密码。

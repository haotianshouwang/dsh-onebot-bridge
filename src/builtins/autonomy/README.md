# 自主时间（qq-autonomy）

源码可信原生包。入口 `index.js`，清单镜像 `manifest.json`。

- 日记：`data/dsh-onebot-bridge/autonomy/diary.jsonl`。
- 运行日志：`autonomy/state.json`；活动/时间线：`autonomy/activities.jsonl`。
- 私密空间：`data/dsh-onebot-bridge/private/secret-vault.json`，AES-256-GCM + scrypt；与普通日记完全隔离。
- 角色模式：首次启用后由现有受限 Agent 决定是否创建/选择密码气质/是否分享；程序生成密码并用 DSH 设备凭据封装。用户不设置密码，普通界面不显示密码。
- 旧版用户密码空间仍用原密码解锁；刷新、退出或 15 分钟无操作重新锁定。
- 次数策略：推荐（8 次/天）/自定义/不限制；不限制仍受每分钟调度、活动时段和外部接口约束。
- 历史保留：日记/活动支持不主动删除、按数量、按天数；列表仍分页读取。
- 管理页：日历/时间线、日记、时间汇总、设置、秘密空间。
- API：`autonomyAdmin`、`secretAdmin`、`configureNativePackage`。

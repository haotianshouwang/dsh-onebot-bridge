# QQ 空间（qq-qzone）

源码可信原生包。入口 `index.js`，后端 `backend.js`，清单镜像 `manifest.json`。

- 好友列表来自已连接 OneBot 的 `get_friend_list`，不要求用户逐个填写 QQ。
- 动态通过 NapCat 登录账号本来就有权限的空间接口读取，按 `friendId:postId` 去重。
- 解析正文、时间、图片 URL、评论与点赞；接口未提供的字段在页面标记为未返回，不伪造。
- 自动同步是后端串行分批任务，按 `syncCursor` 轮转好友；页面分页与后台同步分离。默认关闭，需在设置页开启，避免首次启动就批量读取空间。
- Cookie 只通过 `get_cookies` 临时使用，不落盘、不回显、不写日志。
- 缓存 `data/dsh-onebot-bridge/qzone/feed.json` 保存真实动态；`admin-status.json` 只存同步元数据。二者都是用户数据，不应发布。
- 每日写入策略：`recommended`（发布 3/天、评论 5/天）、`custom`（使用自定义值）、`unlimited`（不设业务每日上限）；三者都保留冷却与 `readPerHour` 保护。
- 发布/评论仍由 QQ 对话动作执行，管理站点不提供写入按钮。
- 管理页：夜航控制台 → 插件 → QQ 空间。
- API：`qzoneAdmin`、`configureNativePackage`、`/api/qzone-image`、`/api/qzone-avatar`。

修改后必须跑 `tests/qzone.test.js` 与 `tests/admin-pages.test.js`。

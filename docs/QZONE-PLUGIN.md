# QQ空间原生插件（qq-qzone）

独立设置、启停、作用范围及卸载；三个动作全部 ownerOnly，普通群友即使获得工具 grant 也不能使用。不注册后台自动发布/评论。

## 功能与限制

- list：指定 QQ 的最近 1–5 条文字说说，仅访问机器人账号本来有权访问的内容。返回来源链接与 10 分钟有效的 postRef。浏览默认每小时 30 次。
- publish：调用当前 NapCat 的 send_qzone_msg，最多 500 字，初版仅文字。默认好友可见，可在插件页面改为仅自己或公开；滚动 24 小时最多 3 条。
- comment：使用同一聊天、同一主人、同一机器人最近读取的 postRef；最多 300 字，滚动 24 小时最多 5 条。
- 写入操作至少间隔 60 秒，预先持久化执行记录；同一消息的同一操作不能重复提交。网络异常保留 unknown，不自动重试、不在启动后重放。
- 无密码空间解锁、验证码绕过、删除说说、相册或自动互动功能。

## 后台凭据

浏览和评论通过 NapCat get_cookies 固定获取 qzone.qq.com 登录态，在内存中用于固定腾讯 HTTPS 端点；不向模型提供 get_cookies/raw OneBot 能力，不持久化或打印 Cookie、g_tk，不接受模型自定义域名/路径，不跟随携带凭据的重定向。结果只返回挑选后的内容字段。

浏览和评论依赖 QQ 空间网页接口，可能因登录验证、隐私权限或服务变更失败。发布依赖 NapCat 自带接口。失败必须明确报告，不能声称已成功。

## 验证

使用 mock 回归验证发布/评论以避免产生测试内容；真实登录只读取机器人自己的空间，没有发送测试说说或评论。结果见 data/qzone-read-probe.json。

接口核实来源：
- 已安装 NapCat 4.18.41 的 send_qzone_msg/get_cookies 实现。
- https://github.com/NapNeko/NapCatQQ/releases
- https://github.com/diaomin66/astrbot_plugin_qzone_ultra/blob/main/qzone_bridge/client.py （列表/评论端点及字段对照；未复制其客户端实现）

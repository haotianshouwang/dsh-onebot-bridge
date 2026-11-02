# 媒体平台助手

`qq-media-agent` 是 QQ 框架内的统一媒体平台插件骨架，目标是把 B 站和抖音接入同一套权限、额度、任务和持久化边界。

当前版本已提供：

- B 站和抖音平台适配器接口；
- 统一设置和插件存储；
- 真实状态查询动作；
- B 站公开搜索和视频信息读取；
- 受控专用 Playwright 浏览器服务：独立 profile、官方域名校验、页面归属、登录/验证码检测、视频进度观察、有限观看和有界截图；没有 Playwright 时保留 CDP 回退；
- B 站和抖音统一的人工登录入口、登录状态观察、打开、当前页面、已加载字幕、观看、状态和每日观看额度动作。
- 明确确认后的公开评论、当前主人私聊分享；分享通过宿主 `qq.message.send` 发送并按真实 QQ 回执记录状态；
- 平台私信白名单：配置 `platform:contactId`，先打开联系人资料页人工确认，再在当前主人私聊中明确 `confirm=true` 发送；正文只进入页面输入框，不写入存储。

浏览器只有在主人启用 `browserEnabled` 后由动作按需启动，使用插件数据目录下的专用持久化 profile，不读取用户主浏览器资料。Linux 优先探测 `MEDIA_BROWSER_PATH`、Chromium、Chrome、Edge；Windows 继续探测 Edge/Chrome。也可以设置 `MEDIA_BROWSER_HEADLESS=1` 在无桌面 Linux 环境运行。页面只返回标题、官方 URL、有限正文和视频进度，不返回 Cookie、LocalStorage 或秘密正文。登录、验证码、页面域名不匹配或视频元素不存在时会 fail-closed。

评论、私信和分享默认关闭。平台私信额外要求联系人白名单、发送前身份复核、独占发送锁，并只持久化内容哈希与 `reserved/submitted/confirmed/unknown` 状态；外部结果未知时不会自动重发。二维码登录仍由主人在专用 Edge 窗口中人工完成。B 站公开查询继续走宿主安全网页读取器。

本插件的设计参考了 `dsh-bili-scroll` 和 `dsh-douyin-agent` 的公开功能与验证经验；实际保留的第三方源码和许可证必须记录在仓库根目录的 `NOTICE.md` 与 `THIRD_PARTY_NOTICES.md` 中。

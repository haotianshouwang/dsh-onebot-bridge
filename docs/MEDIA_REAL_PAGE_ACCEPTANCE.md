# 媒体插件真实页面验收记录

## 范围

本次验收只访问公开页面，检查页面 URL、标题、`readyState`、登录/验证码提示、视频元素、播放器状态、截图和已加载字幕数量。没有执行真实登录、评论、分享、私信、点赞、关注或其他账号写操作，也没有读取 Cookie、LocalStorage、Token 或密码。

## 运行环境

- 时间：2026-11-02（Asia/Shanghai）
- 浏览器：Microsoft Edge
- 浏览器驱动：Playwright Core
- 浏览器路径：`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`
- profile：插件独立临时 profile `data/dsh-onebot-bridge/real-page-acceptance`
- 验收结束后已关闭浏览器并删除临时 profile。

## 结果

| 页面 | 实际 URL | 标题 | readyState | 登录/验证码 | 视频元素 | 播放器 | 截图 | 字幕 |
|---|---|---|---|---|---:|---|---:|---:|
| B 站首页 | `https://www.bilibili.com/` | `哔哩哔哩 (゜-゜)つロ 干杯~-bilibili` | `interactive` | 检测到登录提示 | 否 | — | 476300 bytes | 0 cues |
| B 站视频页 | `https://www.bilibili.com/video/BV1xx411c7mD/` | `字幕君交流场所_哔哩哔哩_bilibili` | `interactive` | 未检测到登录提示 | 是 | `currentTime=0`, `duration=2056`, `paused=true`, `ended=false`, `muted=false` | 13872 bytes | 0 cues |
| 抖音首页 | `https://www.douyin.com/` | `验证码中间页` | `complete` | 到达验证码中间页 | 否 | — | 3644 bytes | 0 cues |

## 判定

- **B 站首页：real-page-pass**。官方页面可达，页面标题和登录提示可读取；首页没有可观测视频元素属于页面状态，不视为插件故障。
- **B 站视频页：real-page-pass**。官方视频页可达，存在真实 `<video>` 元素并读取到时长和播放状态；本次没有自动播放视频，也没有字幕 cue。
- **抖音首页：blocked**。已访问官方域名，但页面返回“验证码中间页”，没有进入可验证的视频内容页，因此不能声称抖音首页或视频播放功能完整通过。
- **浏览器服务：pass**。Playwright Core 能启动系统 Edge，独立 profile 和官方域名校验生效。

## 限制与后续

抖音若要完成视频页、播放器和字幕的真实验收，需要由用户在专用 profile 中人工完成官方验证码/登录流程，然后重新运行只读验收。该步骤仍不应由自动化脚本代替，也不应保存账号凭据。

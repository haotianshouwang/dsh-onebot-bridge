# 来源与致谢

本插件的统一平台设计参考了以下公开项目的功能边界、生命周期经验和验证记录：

- `dsh-bili-scroll 2.4.0`：MIT，Copyright (c) 2026 c1overzz。
- `dsh-douyin-agent 1.4.6`：MIT，Copyright (c) 2026 LockyBee and contributors。

当前 `qq-media-agent 0.3.0` 只包含本仓库新写的统一插件实现，没有复制上述项目的源码、登录资料、提示词、测试数据或第三方 vendor 代码。浏览器自动化使用 Playwright Core（Apache-2.0），运行时使用用户系统已安装的 Chromium、Chrome 或 Edge，不打包浏览器二进制。后续如果实际引入第三方源码，会在本文件和仓库根目录的 `THIRD_PARTY_NOTICES.md` 中记录固定来源、文件范围和对应许可证。

上述项目与本插件、QQ 框架或平台方没有隶属、授权或背书关系。

# 开发与验证

## 1. 环境

- Windows 10/11（当前生产目录 `F:\大肥鱼`）。
- Node.js **>= 22.13.0**（package.json 的 engines 要求；本项目在 Node 24.21 上验证，记忆库需要内置 `node:sqlite`）。
- DSH 0.2.1-rc.2，NapCat 4.18.41。
- 浏览器：Edge / Chromium；无头验收使用 Edge。

## 2. 目录

```text
F:\大肥鱼\
├─ plugins\dsh-onebot-bridge\   源码（本仓库）
├─ data\dsh-onebot-bridge\      运行时数据
├─ data\dsh\                    DSH 账号、模型、profile
├─ docs\                        设计与开发文档
├─ market-dist\                 项目级分发产物（如果存在）
└─ start.cmd / stop.cmd / status.cmd / verify.cmd
```

## 3. 安装依赖

```powershell
cd F:\大肥鱼\plugins\dsh-onebot-bridge
npm install
```

不要删除 `package-lock.json`，不要用全局依赖替换项目依赖。

## 4. 启动与访问

```powershell
F:\大肥鱼\start.cmd
F:\大肥鱼\status.cmd
F:\大肥鱼\verify.cmd
```

- DSH：<http://127.0.0.1:3080>
- 夜航控制台：<http://127.0.0.1:3097>
- NapCat WebUI：<http://127.0.0.1:6099/webui>
- OneBot：`ws://127.0.0.1:3001`

控制台第一次打开需要设置管理密码（至少 10 位）；密码只保存 scrypt 哈希。修改 `src/web/public/` 下的页面不需要重启，刷新即可；修改 `src/host/`、`src/web/admin-server.js` 或插件逻辑需要重载 DSH 插件/重启服务。

## 5. 开发模式与生产模式

本项目没有独立前端构建。开发即修改源码，DSH profile 里安装的是 `file:` 副本：

- 修改源码后，**生产副本不会自动更新**。
- 用 `scripts/check-deployment.mjs` 对比源码与 `data/dsh/profiles/web/node_modules/dsh-onebot-bridge`。
- 同步/重装后重启 DSH，再到 3097 检查；不能只看源码测试就宣称生产已生效。

```powershell
cd F:\大肥鱼\plugins\dsh-onebot-bridge
node scripts/check-deployment.mjs
```

如果提示漂移，按 `DEPLOYMENT` 文档或 `manage.ps1` 的流程同步，不要手动复制半个目录。

## 6. 测试

```powershell
cd F:\大肥鱼\plugins\dsh-onebot-bridge
npm test
```

重点测试文件：

| 文件 | 覆盖 |
|---|---|
| `tests/admin.test.js` | 管理密码、CSRF、会话、白名单、图片鉴权 |
| `tests/admin-pages.test.js` | 四个管理服务、概率/冷却、星图、复习、秘密空间加密 |
| `tests/manifests.test.js` | manifest.json 与运行时清单一致、统一字段校验 |
| `tests/sticker*.test.js` | 表情收藏、自动收藏、概率/排除词 |
| `tests/qzone.test.js` | 空间读取、图片/评论/点赞解析、写入约束、JSONP |
| `scripts/capture-ui.mjs` | 无头 Edge 交互验证：星图搜索/侧栏、QQ 空间同步、秘密空间锁定 |
| `tests/memory.test.js` | SQLite、检索、上下文注入、设置页 |
| `tests/autonomy.test.js` | 调度、日记、活动、开关 |
| `tests/core.test.js` | 权限、路由、会话、安全回归 |

清单同步：

```powershell
npm run sync:manifests
npm run check:manifests
```

## 7. 前端验收

1. 打开 `http://127.0.0.1:3097/` 并登录。
2. 依次打开总览、连接、聊天、监听、权限、插件、四个功能包、日志、安全。
3. 检查浏览器控制台没有 CSP、404、未捕获异常。
4. 在 1440×900 和 1024×768 检查无水平溢出；窄窗口下侧栏折叠为顶部导航。
5. 检查空状态、请求失败状态、保存后重新读取的值。

隔离 UI 验收工具（不连接真实 3097 数据）：

```powershell
cd F:\大肥鱼\plugins\dsh-onebot-bridge
node scripts/visual-harness.mjs
# 另开终端
node scripts/capture-ui.mjs
```

截图输出到 `F:\大肥鱼\verify\`。QQ 空间在验收工具中使用显式测试后端，不能当作真实空间接口证据。

## 8. 构建与分发

```powershell
npm run build:market
```

该命令只构建声明式市场包。源码插件随 `package.json` 的 `files` 分发，不进入市场 zip。

## 9. 常见问题

### 3097 打不开

- `status.cmd` 检查 DSH 进程；管理站点启动失败只写日志，不影响 QQ。
- 查看 `data/dsh-onebot-bridge/state.json` 的 `logs` 最后几条。
- 必须使用 `127.0.0.1` 或 `localhost`，不要用局域网 IP。

### 修改页面后没变化

- 静态资源按请求读取，普通刷新即可。
- 若改的是 `admin-server.js` 或后端插件，需要重载 DSH 插件。
- 检查是否改到了 profile 副本而不是源码目录。

### 保存后没有生效

- 打开页面顶部的真实值是否变化。
- 看 `state.json` 的 `framework.nativePackages[id].config`。
- 检查插件是否 `enabled`、是否被 quarantine、依赖是否满足。
- 对自动收藏概率，检查作用范围是否命中、图片消息是否带 image 段。

### 表情图片 401/404

- 401：管理会话过期，重新登录。
- 404：表情已被删除、索引损坏或文件缺失；页面应显示明确失败状态，不能用占位图代替。

### 秘密空间忘记密码

无法找回。这是设计选择，不是缺陷。只能在管理会话中明确输入 `RESET` 清空后重新初始化；不要尝试从日志、内存或备份中提取密钥。

## 10. 判断“真的生效”

必须同时满足：

1. 页面显示的是重新读取的真实值，不是前端局部状态。
2. `state.json` / SQLite / JSONL 中能读到对应持久化结果。
3. 插件运行时读取该配置（例如 `sticker/auto.js` 读取 `collectProbability`）。
4. 可观察行为发生变化（例如概率 0 时不再取图）。
5. 重启/刷新后仍然成立。

只完成第 1 条或只改 UI 文案，不算完成。

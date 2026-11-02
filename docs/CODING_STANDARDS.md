# 编码规范

> 适用于 `plugins/dsh-onebot-bridge` 的前后端、插件、测试和脚本。
> 既有文件中存在历史紧凑写法；新代码不得继续扩大这种风格，改动旧文件时优先保持局部一致并逐步整理。

## 1. 语言与格式

- 使用 ES Modules（`import` / `export`），不要新增 CommonJS。
- 新文件使用 2 空格缩进、单引号、必须写分号、行尾 LF。
- 每个语句独立成行，不写一行多个业务语句的压缩代码。
- 函数尽量控制在 60 行以内；超过时按“读取—校验—持久化—渲染”拆分。
- 嵌套不超过 4 层；深层分支用早返回。
- 不提交 `console.log` 调试输出；服务端日志用传入的 `log(level, message)`。
- 不保留被注释掉的旧实现；需要历史时用 Git。

## 2. 命名

- 文件名：`kebab-case.js`，例如 `sticker-admin.js`。
- 变量/函数：`camelCase`；类/构造函数：`PascalCase`；常量：`UPPER_SNAKE_CASE`。
- 插件 ID：`qq-<lowercase-hyphen>`，最多 40 字符（`src/sdk.js` 的 `safeId`）。
- 动作 ID：`plugin.<pluginId>.<action>`；动作名只允许 `[a-z][a-z0-9-]`。
- 页面视图 ID：`overview`、`sticker`、`qzone`、`memory`、`autonomy`，不要用中文 ID。

## 3. 目录组织

- `src/core/`：无 UI、无 HTTP 的领域模型和纯逻辑。
- `src/host/`：DSH 生命周期、状态、动作分发；不要在这里写大段 DOM/样式。
- `src/builtins/<plugin>/`：插件入口、配置、业务逻辑；需要时拆 `services/`、`utils/`。
- `src/admin/`：管理站点专用的读/写服务；不得被 QQ 对话动作直接依赖。
- `src/web/public/`：浏览器资源；不得引入外部 CDN、外部字体或第二套组件库。
- `tests/`：与源码同名的 `*.test.js`；测试不得写生产 `data/`。
- `scripts/`：一次性迁移、构建、验收脚本；不得成为运行时依赖。

不要为了“整齐”把声明式扩展改成源码插件，也不要把源码插件强行压成只有 `rules.json` 的格式。

## 4. 组件与 UI

- 新页面必须复用 `app.js` 的 `card`、`button`、`field`、`toggle`、`select`、`stat`、`pill`、`stateBox`、`pager`、`openModal`。
- 不新增主题色；使用 `app.css` 的 CSS 变量。
- 不写渐变、发光、毛玻璃、背景网格、装饰性动画。
- 不用 Emoji 代替图标；复用 `ICONS` 中的 SVG。
- 空状态、错误状态、加载状态必须显式渲染。
- 所有用户可见的数据来自 API；禁止 `Math.random()`、常量数组或定时器伪造统计。
- 表单控件必须有标签；破坏性操作必须二次确认。
- 页面切换、退出登录、会话过期要清理定时器和弹窗。

## 5. 状态与数据

- 服务端是配置和业务数据的唯一事实来源；前端缓存只用于显示。
- 保存配置必须走 `configureNativePackage` 或明确的专用服务，不能直接改 `state.json`。
- 配置字段必须同时出现在 `manifest.configSchema` 与 `manifest.settings.sections` 中。
- 新增字段要有默认值；删除/重命名字段必须提升 `configVersion` 并写 `configMigrations`。
- 不在浏览器回显密钥；使用 `preserveSecrets` 保留已保存密钥，或明确清除。
- 密码、密钥、Cookie、OneBot Token 不得进入日志、错误消息、URL 查询参数或前端全局状态。

## 6. API 与错误

- 统一响应：成功 `{ok:true,value}`；失败 `{ok:false,error}`。
- 错误消息面向用户、可操作；不得包含堆栈、路径、Token。
- 读取接口不产生副作用；写入接口校验 revision、会话、CSRF 和业务范围。
- 分页参数使用 `offset`/`limit`，返回 `total`、`hasMore`。
- 不要吞掉异常；可以降级，但必须记录可读日志或返回明确错误。
- 异步任务必须可取消/有超时；定时器必须 `unref()` 或在 stop 时清理。

## 7. 测试

- 新功能必须至少有一个行为测试，不只测“函数存在”。
- 涉及持久化时用临时目录，测试结束清理。
- 涉及加密时断言明文不落盘、错误密码不返回正文、锁定后不可读。
- 涉及概率/冷却时注入 `random`/`now`，不要依赖真实随机和时间。
- 涉及插件清单时跑 `npm run check:manifests`。
- 修 bug 时先写能复现的测试，再改实现。

## 8. 日志与注释

- 日志只写必要上下文：插件 ID、动作、结果、耗时；不写正文、密码、Token、Cookie。
- 复杂边界用注释解释“为什么”，不要复述代码。
- 安全相关注释必须说明信任边界和失败策略。
- 文件头注释说明模块职责与不做的事。

## 9. 依赖与兼容

- 不新增前端依赖；控制台必须离线可用。
- 新增 Node 依赖前确认 Node 22.19+ 可用、许可证可接受、安装体积合理。
- 不破坏 `tests/deployment-drift.test.js`、`tests/isolation-guard.test.js` 等安全回归。
- 插件升级必须保证旧配置可读；不能读时提供迁移并记录错误，不得静默重置。

## 10. 自动化检查

每次提交前至少：

```powershell
npm test
npm run check:manifests
node --check src/web/public/app.js
node --check src/host/index.js
```

如果项目以后加入 ESLint/Prettier/TypeScript，沿用其配置，不另起一套。

# 插件系统

本文描述当前真实存在的三类插件，以及统一的管理协议、生命周期和兼容规则。

## 1. 三类插件不是同一种东西

| 类型 | 位置 | 运行时 | 入口 | 是否执行 JavaScript |
|---|---|---|---|---|
| 源码内置包 | `src/builtins/index.js` + `src/builtins/<name>/` | 宿主进程内 | `builtinDefinitions` 与 `Builtins` 方法 | 是 |
| 源码可信原生包 | `src/builtins/<name>/`（如 `sticker`、`qzone`、`memory`、`autonomy`） | 宿主进程内，通过 API 2 SDK | `index.js` 导出的 `manifest` 与 `activate*` | 是，经人工审阅 |
| 声明式扩展 | `data/dsh-onebot-bridge/extensions/<id>/` | `Extensions` 规则引擎 | `manifest.json` + `rules.json` | 否 |
| 市场安装包 | `market-dist/<id>-<version>.zip` | 安装后变成声明式扩展 | zip 内的 `manifest.json`/`rules.json` | 否 |

**统一的是元数据、管理协议、配置校验和生命周期语义，不是内部实现。**
声明式扩展不需要 `index.js`；源码插件也不应被改成只有规则文件。

## 2. 目录

```text
plugins/dsh-onebot-bridge/
├─ src/
│  ├─ builtins/
│  │  ├─ index.js                 核心 builtin 列表与默认值
│  │  ├─ sticker/
│  │  │  ├─ index.js              源码原生包入口（manifest + activate）
│  │  │  ├─ auto.js               自动收藏（概率/冷却/排除词）
│  │  │  └─ manifest.json         工具/文档用元数据镜像
│  │  ├─ qzone/{index.js,backend.js,manifest.json}
│  │  ├─ memory/{index.js,store.js,embedding.js,manifest.json}
│  │  └─ autonomy/{index.js,manifest.json}
│  ├─ core/package-model.js       清单校验、版本、配置迁移、依赖
│  ├─ sdk.js                      可信原生包 API 2
│  ├─ extensions/index.js         声明式扩展加载
│  └─ market/index.js             市场索引与安装/回滚
├─ data/dsh-onebot-bridge/
│  └─ extensions/<id>/{manifest.json,rules.json}
└─ market-dist/<id>-<version>.zip
```

四个目标插件没有改成 `long-term-memory/` 等新目录：现有 ID 和数据路径是兼容边界，重命名会破坏已安装配置和用户数据。目录名 `memory` 对应插件 ID `qq-memory`，`autonomy` 对应 `qq-autonomy`。

## 3. 统一元数据

源码原生包的 `index.js` 导出：

```js
export const manifest = {
  id: 'qq-example',
  name: '示例',
  version: '1.0.0',
  apiVersion: 2,
  type: 'native-source',
  entry: 'src/builtins/example/index.js',
  bundled: true,
  description: '...',
  dependencies: {framework: '>=0.13.0'},
  configVersion: 1,
  capabilities: ['actions'],
  configSchema: {},
  settings: {title: '示例', sections: []},
  configMigrations: []
};
```

字段含义：

- `id`：`qq-` 开头、小写/数字/连字符；也是数据键和动作前缀。
- `name`/`version`/`description`：展示和版本比较。
- `apiVersion`：当前为 2。
- `type`：`native-source`、`declarative`、`builtin`、`market`。
- `entry`：包内相对入口；不得包含 `..` 或以 `/` 开头。
- `bundled`：是否随源码分发。
- `dependencies`：`framework` 或其它插件 ID 的版本范围。
- `configVersion`：配置结构版本，变化时必须提供迁移。
- `capabilities`：`events`、`actions`、`resources`、`storage`、`automatic-replies`、`context`。
- `configSchema`：`string`/`number`/`boolean`/`string[]`，含默认值与边界。
- `settings`：设置页标题、说明和字段分组；字段必须存在于 `configSchema`。
- `configMigrations`：`to`、`rename`、`defaults`、`remove`。

`manifest.json` 是 `npm run sync:manifests` 生成的镜像，带 `permissions`（由 capabilities 派生）。运行时仍以 `index.js` 为准；`tests/manifests.test.js` 防止两份漂移。

声明式 manifest 额外要求：

- `hostApiVersion: 2`
- `runtime: 'declarative'`
- `entry: 'rules.json'`
- `capabilities` 只能使用 `commands`、`inbound`、`notice`、`actions`
- 规则和动作由 `src/extensions/index.js` 校验

## 4. 生命周期

当前实现没有统一的 `onEnable/onDisable` 导出；生命周期由宿主和 SDK 共同保证：

1. **注册**：宿主启动时调用 `activateX(sdk.facade(), deps)`，内部 `registerTrustedPackage(manifest)`。
2. **初始化**：`activateX` 建立存储、订阅、动作、上下文提供器；失败只停用该插件。
3. **启用**：`framework.nativePackages[id].enabled=true`；插件的 `api.active()` 检查 enabled、未卸载、未隔离、依赖满足。
4. **停用**：`enabled=false`；动作 `available()` 立即为 false；事件回调在 `api.on` 内检查 active；后台任务应自行取消。
5. **配置更新**：`configureNativePackage` → `checkConfig` → 写状态 → `invalidate/native.revoke`；插件下次读取 `api.getConfig()` 时得到新值。后台定时器、自动收藏等旁路任务必须用 `api.active()` 或宿主传入的 `enabled` 自行停止。
6. **状态查询**：`snapshot` / `pageData` / 专用 admin 服务。
7. **资源释放**：宿主 stop 时清定时器、监听、HTTP、SQLite、媒体资源；SDK `stop()` 释放动作和页面。
8. **错误处理**：SDK 连续失败 3 次会 quarantine 并停用；单个插件异常不影响其他插件。

约束：

- 同一 ID 不能重复注册。
- 启用失败必须返回可读错误，不能只改前端开关。
- 停用后不能继续响应事件或动作。
- 配置保存失败不能提示成功。
- 不通过修改前端 `enabled` 伪装后端已启用。

## 5. 配置与迁移

- 所有配置写入经过 `validateConfig`，数字必须是 number 且满足 min/max/integer。
- 新字段可以在同一 `configVersion` 下增加默认值；删除字段、改类型、改语义必须提升版本并写迁移。
- 旧配置迁移失败时保留旧配置并记录 `migrationError`，不要静默重置。
- 升级不应丢失数据；`settingsHistory` 只保留最近 5 份。
- 敏感字段（`embeddingKey` 等）不在页面回显；保存时用 `preserveSecrets` 保留未修改的值。

## 6. 依赖与隔离

- `dependencies` 校验已安装、版本范围、启用状态和循环依赖。
- 停用被依赖的包会被阻止，除非先停用依赖它的包。
- 原生插件使用独立 `AsyncLocalStorage` lease；回调结束后不能继续使用旧权限。
- 声明式扩展只执行固定回复，不获得任意代码执行。
- 市场包不加载外部 JavaScript。

## 7. 旧版本兼容

- 新增 `qq-emotion`（情绪与见闻），独立 SDK 插件，不替换任何旧插件；数据保存在 `framework.pluginData['qq-emotion']`。私聊分享复用自主时间的主动联系服务，新字段 `proactiveAllowGroupStories` 默认关闭。

- 旧插件 ID 不变：`qq-sticker`、`qq-qzone`、`qq-memory`、`qq-autonomy`。
- 旧数据路径不变：`stickers/`、`memory/`、`autonomy/`。
- 旧 `configVersion` 通过 `configMigrations` 迁移；sticker v1→v2 已有迁移。
- 旧声明式扩展仍从原目录读取；市场包格式未改变。
- 升级后先验证启用、停用、配置读取、动作执行，再清理旧文件。
- 不要直接删除旧目录；需要废弃时先提供迁移和回滚。

## 8. 插件清单与市场的关系

源码插件随 npm 包/`src` 分发，不进入 `market-dist`。市场只分发声明式包。两者共享元数据字段和配置校验，但入口和运行时不同。

新增市场包时必须验证：

1. `manifest.json` 通过 `validateManifest`。
2. `rules.json` 通过 `validateRules`。
3. 安装到 `data/.../extensions` 后能加载。
4. 停用/卸载不抛异常，配置和数据保留。

详细教程见 `PLUGIN_DEVELOPMENT.md`。

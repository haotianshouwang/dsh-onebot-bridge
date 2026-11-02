# 插件开发教程

本文按当前仓库真实 API 编写。不要照抄旧版市场指南里的 JavaScript 扩展接口——那套已经被禁用。

## 1. 先选类型

- **要执行 QQ 动作、监听事件、接模型上下文**：源码可信原生包（`src/builtins/<name>/`，API 2 SDK）。
- **只做固定命令/关键词/通知回复**：声明式扩展（`manifest.json` + `rules.json`），可打包进市场。
- **只是核心行为开关**：内置包（`src/builtins/index.js`），不要新建原生包。

本教程以源码原生包为例。

## 2. 创建目录

```text
src/builtins/qq-example/
├─ index.js
├─ manifest.json          # npm run sync:manifests 生成
└─ README.md
```

ID 必须匹配 `/^qq-[a-z0-9][a-z0-9-]{0,38}$/`。目录名不必等于 ID，但建议一致。

## 3. 编写清单与入口

```js
// src/builtins/qq-example/index.js
export const manifest = {
  id: 'qq-example',
  name: '示例插件',
  version: '1.0.0',
  apiVersion: 2,
  type: 'native-source',
  entry: 'src/builtins/qq-example/index.js',
  bundled: true,
  description: '演示一个真实动作和一个设置页数据接口。',
  dependencies: {framework: '>=0.13.0'},
  configVersion: 1,
  capabilities: ['actions', 'storage'],
  configSchema: {
    enabledHint: {type: 'boolean', title: '示例开关', default: false},
    limit: {type: 'number', title: '条数', default: 10, min: 1, max: 100, integer: true}
  },
  settings: {
    title: '示例插件',
    description: '动作与设置都由宿主真实读取。',
    sections: [{title: '设置', fields: ['enabledHint', 'limit']}]
  }
};

export function activateExample(framework) {
  const api = framework.registerTrustedPackage(manifest);

  api.action('ping', {
    description: '仅主人：返回插件当前配置。',
    ownerOnly: true,
    timeoutMs: 5000,
    parameters: {
      type: 'object',
      properties: {text: {type: 'string', maxLength: 100}},
      required: [],
      additionalProperties: false
    }
  }, async args => {
    const config = api.getConfig();
    if (config.enabledHint !== true) api.reject('示例开关未开启');
    return {ok: true, text: String(args.text || ''), limit: config.limit};
  });

  return api;
}
```

注意：

- `api.active()` 返回当前包是否真正启用；后台定时器、自动收藏和旁路任务必须检查它。
- `api.reject(message)` 会变成明确的输入错误，不会 quarantine 插件。
- 抛普通异常会被 SDK 记为失败；连续 3 次可能 quarantine。
- 不要自己读写 `state.json`；用 `api.getConfig()` 和 `api.storage`。
- 不要用 `console.log` 打印用户正文。

## 4. 在宿主注册

```js
// src/host/index.js
import {activateExample} from '../builtins/qq-example/index.js';
// ...
activateExample(sdk.facade());
```

宿主启动后，`snapshot.nativePackages['qq-example']` 会出现；默认 `enabled=false`。在插件管理页或 `configureNativePackage` 中启用。

## 5. 作用范围与权限

- 动作默认仅主人可用；`ownerOnly: true` 强制主人。
- 普通用户要使用动作，需要 `Permissions` 的 grant，并且插件 `scope` 命中。
- 事件回调通过 `api.on(['message'], handler)` 订阅；SDK 会先检查 active 和 scope。
- 资源读写必须用 `api.putResource` / `api.invoke('qq.media.receive')`，不能直接读任意 URL 或本机路径。

## 6. 设置页

原生包可以只声明 `manifest.settings`，`snapshot.pluginPages` 会带配置；如果要在设置页显示表格数据，使用：

```js
api.settings(manifest.settings, async query => ({
  stats: [{label: '条数', value: 3}],
  columns: [{key: 'time', label: '时间', format: 'datetime'}, {key: 'text', label: '内容'}],
  rows: [{time: new Date().toISOString(), text: '示例'}],
  total: 1,
  offset: 0,
  hasMore: false
}));
```

限制：最多 100 行、20 列、10 个统计、128 KiB；列必须 `{key,label}`，`format` 只能是 `datetime`。这是 DSH 内设置页的通用表格协议，不适合图片网格或复杂表单。

## 7. 接入独立管理页

如果插件需要图片、日历、星图等复杂 UI，**不要塞进 `pageData` 的表格**。按现有四插件的方式：

1. 新建 `src/admin/<plugin>-admin.js`，只暴露真实读写方法。
2. 在 `src/host/index.js` 创建服务并处理专用 action（如 `exampleAdmin`）。
3. 在 `src/web/admin-server.js` 的 `ALLOWED_ACTIONS` 加入 action 名。
4. 在 `src/web/public/app.js` 增加视图、loader、导航入口；复用现有 `card`/`field`/`stateBox` 等组件。
5. 所有写操作经过 `secureApi`，破坏性操作二次确认。
6. 后端仍要校验参数、范围、存在性和权限，不能只靠前端隐藏按钮。

### 7.1 让角色做决定

需要“角色自主”时，复用现有受限 Agent，不要新建随机模块：

```js
const verdict = await native.autonomy({
  title: '角色决定',
  allow: [],              // 不给工具
  timeoutMs: 45000,
  system: persona + '\n只输出 JSON...',
  user: '现在做决定。'
});
```

规则：

- 模型只返回结构化决定（create/choice/share/reason），不接触密码、数据库或文件路径。
- 程序负责生成高强度密码、scrypt 派生、AES-256-GCM 加密和设备密钥封装。
- 决定结果持久化；已有数据时不得重新初始化或覆盖。
- 失败时保持未初始化/锁定，不要用默认密码兜底。
- 普通 API 不返回密码；分享只解锁内容，并写不含密码的审计。

QQ 空间好友列表同理：通过宿主 `bot.call('get_friend_list')` 提供真实好友列表，再由后端批量读取动态；不要让用户逐个填写好友。

## 8. manifest.json 与测试

```powershell
npm run sync:manifests
```

然后新增测试：

```js
// tests/example.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Store} from '../src/host/store.js';
import {Permissions} from '../src/core/permissions.js';
import {Actions} from '../src/core/actions.js';
import {Events} from '../src/core/events.js';
import {Media} from '../src/core/media.js';
import {PluginSDK} from '../src/sdk.js';
import {activateExample, manifest} from '../src/builtins/qq-example/index.js';

test('示例插件注册并返回配置', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qq-example-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const store = await new Store(dir).open();
  const permissions = new Permissions(store);
  const events = new Events(store, () => {});
  const media = new Media(store);
  const actions = new Actions(store, permissions, events, media);
  const sdk = new PluginSDK({store, permissions, events, media, actions});
  activateExample(sdk.facade());
  const item = store.data.framework.nativePackages[manifest.id];
  item.enabled = true;
  const result = await sdk.pageList();
  assert.ok(result.some(row => row.id === manifest.id));
  await sdk.stop();
});
```

真实动作调用还需要构造权限上下文；参考 `tests/sticker.test.js` 的 `permissions.issue(...)` 与 `actions.invoke(...)`。

## 9. 打包

- 源码原生包随 `package.json` 的 `"files": ["src", ...]` 分发，不需要 zip。
- 声明式扩展：

```powershell
npm run build:market
```

生成 `market-dist/<id>-<version>.zip`，安装流程走 `src/market/index.js`。不要手工改 zip 里的 manifest 后跳过校验。

## 10. 验证清单

- [ ] `npm test` 通过。
- [ ] `npm run check:manifests` 通过。
- [ ] 启用后 `nativePackages[id].enabled=true` 且 `registered=true`。
- [ ] 停用后动作 `available=false`，再启用可恢复。
- [ ] 配置保存后重新读取一致，重启后仍存在。
- [ ] 作用范围外的用户/聊天不能调用。
- [ ] 失败返回可读错误，主程序不崩溃。
- [ ] 日志中没有密码、Token、Cookie、用户正文。
- [ ] 独立管理页在 1440×900 和 1024×768 无溢出、无控制台错误。

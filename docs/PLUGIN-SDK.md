# QQ 框架插件开发指南

版本：0.4.0 / Plugin API 2。日期：2026-10-29。

## 选择扩展形式

| 形式 | 用途 | 安装和执行边界 |
| --- | --- | --- |
| 声明式市场包 | 固定命令、关键词、通知回复、固定结果动作 | 只读 JSON，无外部脚本执行 |
| 可信 DSH 原生包 | 需要独立实现的业务、QQ 动作组合和资源处理 | 由主人通过 DSH 安装审阅过的宿主代码；不属于沙箱插件 |
| 内置包 | AI 聊天、人设、欢迎、市场 | 随框架分发，独立启停/卸载，核心不可卸载 |

不能把原生代码 ZIP 放入规则市场。声明 capabilities 不会把 Node.js 代码变成安全沙箱。

## 声明式包

ZIP 根目录仅允许 manifest.json、rules.json。manifest 示例：

~~~json
{
  "id": "qq-greeting",
  "name": "问候",
  "version": "1.0.0",
  "hostApiVersion": 2,
  "runtime": "declarative",
  "entry": "rules.json",
  "capabilities": ["commands", "actions"],
  "configSchema": {
    "text": {"type": "string", "title": "回复文字", "default": "你好呀"}
  }
}
~~~

rules.json：

~~~json
{
  "rules": [
    {"type": "command", "match": "/你好", "reply": "{{config.text}}"}
  ],
  "actions": [
    {"id": "greet", "description": "获取问候文字", "reply": "{{config.text}}"}
  ]
}
~~~

规则类型为 command（首个固定命令）、contains（固定关键词）、notice（通知名称）。规则权限分别为 commands、inbound、notice；公开动作另声明 actions。核心使用自然语言管理，插件命令不参与身份授权。

模板只展开 config 中的配置值，不执行表达式或代码。规则最多 50 条，AI 动作最多 10 个；动作只返回声明的文字结果。普通规则回复仍经过监听、回复白名单、账号校验、去重和限速。

AI 动作注册为 plugin.qq-greeting.greet。安装包、启用包、启用具体动作、授予普通用户是不同步骤。AI 不会因包已启用而获得动作权限。

作用范围在扩展设置中单独填写私聊开关、用户 QQ、群号。群范围必须处于核心监听范围；规则通知回复是主人启用的固定自动化，不使用通知中成员的主人身份。

## 市场索引

~~~json
{
  "schema": 1,
  "extensions": [
    {
      "...": "完整 manifest 字段",
      "url": "qq-greeting-1.0.0.zip",
      "sha256": "ZIP 文件的 64 位 SHA-256"
    }
  ]
}
~~~

该示意中的省略字段需要换成完整 manifest。可参考 plugins/dsh-onebot-bridge/market-dist/index.json 的实际文件。

本地索引使用绝对路径，ZIP 需位于索引目录范围。HTTPS 源只访问公开地址，重定向重新检查；包与解压体积最大 8 MiB，最多 64 个 ZIP 条目，实际规则包只允许两个 JSON 文件。哈希用于内容一致性，不代替来源判断。

## 可信原生 SDK

在自己的 DSH Host 插件中声明依赖 qqFramework。类型见框架 src/sdk.d.ts。最小例子：

~~~js
export const name = 'qq-example';
export const inject = ['qqFramework'];

export function apply(ctx) {
  const api = ctx.qqFramework.registerTrustedPackage({
    id: 'qq-example',
    name: '状态助手',
    version: '1.0.0',
    capabilities: ['actions']
  });

  api.action('status', {
    description: '通过框架查看机器人状态',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  }, async (_args, execution, signal) => {
    return api.invoke('core.status', {}, execution, signal);
  });

  ctx.effect(() => () => api.dispose());
}
~~~

注册后默认停用，在插件管理中启用并设置范围。再在主人与权限中启用 plugin.qq-example.status。底层 core.status 也必须启用；普通用户若调用组合动作，需要获得这两个具体能力的授权。

升级原生包版本后需重新启用。不要把 DSH 根 Context、OneBot 原始对象、凭据或任意执行代理传给 QQ 模型。SDK 不提供这些对象。

### SDK 接口

- getConfig()：返回经过 Schema 检查的配置副本。
- on(types, handler)：订阅获准范围内事件；回调为 (event, execution, signal)。
- action(name, definition, handler)：注册具体 AI 动作；核心先校验调用者，再传入原始身份绑定的 execution。
- invoke(capability, args, execution, signal)：调用明确 QQ 能力，重新验证底层能力和参数。
- putResource(bytes, execution, options)：建立当前插件/聊天绑定的资源；返回资源 ID。
- storage.get/set：按稳定插件 ID 隔离 JSON 数据，单包最多 64 KiB。
- dispose()：注销事件和动作，撤销旧执行代次。

消息事件回调可获得不可伪造的执行上下文。成员通知、请求和元事件只提供数据，execution 为 null；通知中出现主人 QQ 也不能转为主人任务。插件收到的请求不会包含网关审批 flag；媒体事件不直接暴露本机文件和原始资源路径。

上下文不能从 JSON、昵称或 user_id 重建。普通用户事件不能通过工具组合、插件互调或共享群上下文变成主人。委派到插件时保留原始发起者，只改变插件资源命名空间。每层动作都检查原始权限。

handler 必须把 signal 继续传给异步调用，取消后尽快结束。结果发送前还会重新核对本轮用过的能力，授权到期或动作消失时停止待发结果。

## 媒体动作示例

在已授权的插件动作中：

~~~js
const resource = await api.putResource(pngBytes, execution, {purpose: 'image'});
return api.invoke('qq.image.send', {resourceId: resource.id}, execution, signal);
~~~

发送目标固定为 execution 所在聊天，不能提交任意目的 QQ 或群号。资源不能跨插件、跨聊天使用。头像修改调用 qq.profile.avatar，同样使用受控图片 ID，但仅主人私聊可执行且须单独启用。

这里不提供任意本机路径参数。需要获取收到的媒体时使用 qq.media.receive，参数为已观察到的当前聊天 messageId 和媒体 index。资源传输不自动附带图片理解或语音转写。

## 当前边界

声明式规则支持的动作是固定结果；复杂计算/外部服务需要审阅过的原生包。原生包与 DSH 宿主处于同一信任边界，SDK 对 QQ 操作进行约束，不声称能够限制恶意宿主代码。

外部脚本低权限沙箱、后台通用调度、动态 MCP 安装不在本版开放范围。已实现能力见下文及能力清单；不支持的能力不会通过 raw action 绕过。

## 验证

运行 npm test 测核心行为；本地集成脚本位于 scripts/framework-*.cjs。模拟网关验收代码不会将消息发送到真实 QQ。开发自己的包时，先验证默认停用、普通用户拒绝、范围隔离、撤权、到期、卸载以及结果未知行为。


## 0.3.0：独立设置页与生命周期

框架会在“插件管理 → 打开设置”渲染 configSchema 和 settings。插件仅声明字段和数据，不向页面提供 HTML 或脚本。数字使用文字草稿，清空时阻止保存，不转换为 0。configSchema 支持 string、boolean、number、string[]，以及 required、enum、integer、min/max、maxLength、maxItems；数值不接受字符串。

~~~json
{
  "dependencies": {"framework": ">=0.3.0", "persona": "^1.0.0"},
  "configVersion": 2,
  "configSchema": {
    "reply": {"type": "string", "title": "回复内容", "default": "你好"}
  },
  "configMigrations": [{"to": 2, "rename": {"text": "reply"}}],
  "settings": {"title": "问候设置", "sections": [{"title": "回复", "fields": ["reply"]}]}
}
~~~

将这些字段加入完整 manifest。依赖版本支持精确版本、*、^、~ 和单个比较符，不支持复合范围；依赖必须安装且兼容，启用包时依赖也必须启用。循环依赖会阻止启用；启用中的依赖者阻止依赖包停用、卸载或不兼容升级。框架不会自动下载依赖。

配置版本从 1 开始，删除字段或改变类型必须递增并逐版本声明迁移。每步支持 rename、defaults、remove；不执行 JS。改名冲突、缺少步骤或迁移结果非法会中止升级并保留旧版本。迁移仍应尽量不删除用户内容。

升级声明式包后保持停用，确认后再启用；最多保留三个历史版本，加当前共四份。回滚使用保留的实际文件和当时配置，并校验完整性。原生宿主代码需通过 DSH 自身管理版本，框架不替换宿主 npm 包。设置历史最多五次，恢复设置后也保持停用；业务数据已清理的部分不会随设置恢复。

### 原生设置页、存储与故障

~~~js
api.settings({
  title: '统计',
  sections: [{title: '保存', fields: ['retentionDays']}]
}, async query => ({
  stats: [{label: '记录数', value: 1}],
  columns: [{key: 'time', label: '时间', format: 'datetime'}],
  rows: [{time: new Date().toISOString()}],
  total: 1, offset: 0, hasMore: false
}));

await api.storage.update(data => ({...data, count: Number(data.count || 0) + 1}));
~~~

settings 的字段必须属于自己的 configSchema。provider 每次最多返回 100 行、128 KiB JSON；页面负责纯文字渲染、分页和当前页 CSV 导出。query 需要插件验证，不要把查询变为任意文件或网关访问。参数错误使用 api.reject(message)，不计入故障次数。

storage.update 更新器必须同步返回。存储按稳定插件 ID 隔离，单包最多 64 KiB。getScope 返回插件范围，并将群范围与核心监听范围取交集。

on 的签名为 (event, execution, signal)，同一插件事件串行、最多排队 50 个；不同插件独立分发。事件默认期限五秒，可通过 eventTimeoutMs 设置 500–30000 ms。action 可声明 timeoutMs，默认十五秒、上限三十秒。settings 数据期限五秒。连续三次失败停用该包，正常回调重置连续错误数；输入错误与撤销不计故障。回调结束、超时或权限代次变化后，SDK 拦截后续写入与 QQ 调用。

这些机制不能终止可信宿主代码中的 CPU 死循环或任意 Node.js 行为，不是进程沙箱。不要运行未审阅的原生包。

可声明存储保留策略，由核心每分钟和范围/设置变更时清理：

~~~json
{
  "storagePolicy": {
    "collection": "records", "timestamp": "time", "group": "groupId",
    "daysField": "retentionDays", "limitField": "maxRecords"
  }
}
~~~

时间使用毫秒。保留条数从数组头开始，因此由插件按时间倒序写入；group 可省略。两个配置字段必须为 number；无效保留值不会被用于清理。停用不阻止过期数据清理。

### 固定事件回复

原生包声明 automatic-replies 能力和有限通知规则：

~~~js
automations: [{
  id: 'welcome', event: 'group_increase',
  title: '自动欢迎', configGate: 'welcomeEnabled'
}]
~~~

在实际 on 回调中调用 await api.automaticReply(event, 'welcome', text)。只接受框架交付的当前事件对象，不能自行拼装、复制、缓存后调用。必须启用插件、选择群、批准该规则；configGate 还要求对应布尔设置为 true。设置页中开启该布尔开关并保存即批准对应规则；无 configGate 的规则显示独立授权开关。

回复最多 500 字，目的群固定为事件所在群。核心检查账号、监听、暂停、代次、期限和配额；每个插件每群每分钟最多三次。自动回复使用 configured-event-rule 身份，不具有主人或 AI 执行权限。失败、结果未知和重启不重发。

完整示例为 src/builtins/group-members/index.js。该包默认停用，记录不包含聊天正文，欢迎默认关闭。其查询动作 plugin.qq-group-members.recent 使用 ownerOnly: true，并且要在权限页单独批准；包启用与动作授权彼此独立。

### 新增 OneBot 能力

- qq.forward.send：最多十个节点，发送者固定为机器人，消息段沿用资源和当前聊天约束。
- qq.files.list：只浏览授权群，子目录须来自最近十分钟已观察的目录，不返回下载 URL。
- qq.poke：当前发起者，同一对象每分钟一次。
- qq.announcements.list、qq.essence.list：只读授权群，短期缓存，返回的 QQ 内容为不可信数据。

这些能力全部默认关闭，网关扩展需 NapCat；不通过 raw action 弥补不兼容。各媒体展示和网关版本差异需要在明确测试对象下验收。


## 0.3.1：聊天与查询共享

主人身份不再限定私聊：在已允许且满足触发条件的群内，主人也能使用已启用工具。改群名、机器人群名片的 groupId 为可选项；群内省略即当前群，私聊仍需明确目标。只能操作已监听群，群内不能转向另一个群；QQ 平台自身的管理员权限仍需满足。

普通消息直接按本轮真实权限提供工具，无需命令前缀。旧的核心斜杠指令入口已移除。聊天关闭时，普通用户的 AI 回复停止；主人的核心管理与受限工具任务继续保留。

聊天设置分私聊和群聊用户范围：all 或 allowlist。私聊监听新增 listenAllPrivate；群监听始终覆盖所选群内的成员，是否回复由聊天设置决定。saveConversation 同时更新对应私聊监听、补齐所选群监听，保存不重连网关。

公开查询规则使用 allUsers: true，仍明确指定 private、groups、expires、perMinute。只允许标记为 publicSafe 的非主人专属、非修改动作；普通用户的配额按个人计算。明确拒绝、过期、撤权及结果发送前复核继续有效。单个用户的特殊规则仍独立管理。

原生查询动作可声明：

~~~js
api.action('lookup', {
  description: '查询城市天气',
  publicSafe: true,
  parameters: {
    type: 'object',
    properties: {city: {type: 'string', maxLength: 50}},
    required: ['city'], additionalProperties: false
  }
}, async (args, execution, signal) => {
  // weatherProvider 由可信插件实现固定服务的城市查询，不能接受任意 URL 或系统命令。
  return weatherProvider.lookup(args.city, {signal});
});
~~~

这段是接口示例，不是已安装的天气服务。publicSafe 仅声明可共享，不自动授权。插件需要启用，在独立设置页选择适用用户（scope.allUsers 或指定 QQ）及生效群，再在“主人与权限 → 其他人的查询工具”开放该动作。每层调用仍保留原始 QQ 身份，底层 QQ 动作仍须另行授权。mutating: true 和 ownerOnly: true 都阻止公开共享。

声明式固定结果动作可被标记为安全查询，但也校验插件的用户/聊天范围。服务器命令、电脑控制、任意本机文件、任意代码和原始网关调用没有授权入口。原生包属于可信宿主代码，SDK 不等于恶意代码的进程沙箱。

回复支持 single、length、paragraphs。按段落模式以空行分条，列表和代码块尽量保持完整；每条按 Unicode 字符限制，最多三十条，每条发送前重新检查身份和权限。single 模式在超过四千字符时仍自动拆分。网关受理或结果未知时不盲目重发。


## 0.4.0 媒体与群聊门控

群聊设置新增 groupReplyMode（direct/smart/all）、groupReplyProbability（0–100）、groupReplyCooldown（0–600 秒）、groupAutoLimit（1–10 次/分钟）、botAliases 和 followupEnabled。随机参与使用 ambient 执行模式，所有动作在权限层直接拒绝；被动监听不等于执行授权。@、可信本群已发消息引用和称呼唤醒使用正常权限；续聊限定同一原始发起者、30 秒最多两轮，窗口不延长。

核心在接受触发后才取回媒体。图片使用 DSH image 内容块；其他原文件通过 DSH fileUploads 的会话级 receipt 发送，另提取文字、语音转写或视频帧。模型支持情况读取实际 adapter 元数据，不根据模型名称猜测。文件句柄不会授予任意文件工具。群文件通知和同一发起者的两分钟附件缓存在核心处理，不开放跨用户缓存读取。

媒体开关为 mediaImages/mediaAudio/mediaFiles/mediaVideo；PDF 提取依赖 pdfjs-dist，Node 至少 22.13，视频需要管理员预装 ffmpeg。所有转换参数由核心固定，SDK 不新增 Shell、进程或任意路径入口。详细测试范围见随包 TESTING.md。

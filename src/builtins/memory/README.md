# 长期记忆（qq-memory）

源码可信原生包。入口 `index.js`，SQLite 存储 `store.js`，嵌入客户端 `embedding.js`。

- 记忆存 `data/dsh-onebot-bridge/memory/memory.db`。
- 复习记录存同库 `memory_reviews` 表；理论曲线参数集中在 `store.js`。
- 管理页支持列表、详情、编辑、删除、星图、复习曲线和设置。
- 嵌入密钥不回显；保存时使用 `preserveSecrets:['embeddingKey']`。
- 管理页：夜航控制台 → 插件 → 长期记忆。
- API：`memoryAdmin`、`configureNativePackage`。

星图连线是共享标签或向量相似度的**推断**关系，不是人工确认的事实。

# 长期记忆星图技术方案

文件：`src/web/public/star-map.js`，入口在 `memoryGraphView()`。

## 1. 渲染技术

- **Three.js/WebGL 真实 3D**，Three.js 模块作为本地静态资源随插件分发，不依赖 CDN。
- 节点先在确定性 3D 球/环坐标中布局，再由 `PerspectiveCamera` 投影到画布。
- 当前后台最多返回 120 个节点、500 条边；低性能或不支持 WebGL 的浏览器显示明确降级提示，记忆数据仍可从列表和复习曲线查看。
- 管理协议和数据结构保持不变，后续可以在不改 API 的情况下优化材质或大规模节点渲染。

## 2. 数据映射

| 视觉属性 | 数据来源 |
|---|---|
| 节点大小 | `importance`（1–5） |
| 节点颜色 | `scope`：global 暖金、user 雾蓝、group 绿 |
| 节点亮度 | `updatedAt` 新近度（90 天衰减，最低 0.35） |
| 连线颜色/线宽 | `kind`（shared-tag / similarity）与 `weight` |
| 节点位置 | 由记忆 ID 哈希确定，刷新不随机跳变 |
| 选中高亮 | 当前节点 + 真实边相邻节点；其他节点降低亮度 |
| 粒子 | 背景星点与连线流动，仅装饰，不代表数据 |

**连线不是随机的**：后端 `MemoryStore.graph()` 只根据共享标签或已保存向量的余弦相似度生成，并标记 `inferred:true`。没有标签/向量的节点不会凭空连线。

## 3. 交互

- 拖动：旋转 yaw/pitch。
- 滚轮：缩放（0.55–3.2）。
- 点击节点：选中并在右侧面板读取完整记忆。
- 悬停：显示节点摘要 tooltip。
- 双击：聚焦节点并放大。
- 搜索：命中真实节点，定位第一个并打开侧栏。
- 范围筛选：global/user/group。
- 暂停动态：停止旋转、浮动、粒子流动。
- 重置视角：恢复初始 yaw/pitch/zoom/筛选。
- 关闭侧栏：清除选中，不重置场景。
- “完整详情”打开原有记忆详情弹窗；弹窗关闭后星图 canvas 不重建，视角保留。

## 4. 性能与资源

- 节点 120 上限；边 500 上限。
- `devicePixelRatio` 上限 2。
- `requestAnimationFrame` 单循环；页面隐藏不额外创建循环。
- `ResizeObserver` 只调整 canvas 尺寸。
- `destroy()` 取消 RAF、断开 observer、移除所有 pointer/wheel/resize 监听。
- `render()` 在重建页面前调用 `state.starMap.destroy()`。
- 低性能/减少动态：暂停按钮；系统 `prefers-reduced-motion` 自动以暂停状态启动；暂停时约 5fps 重绘静态场景，避免满帧占用。
- 没有外部 CDN、字体或图片。

## 5. 后端数据

`memoryAdmin/graph` 返回：

```json
{
  "nodes": [{"id":"...","label":"...","scope":"user","importance":3,"tags":[],"degree":2,"updatedAt":"..."}],
  "edges": [{"source":"...","target":"...","kind":"shared-tag","weight":0.6,"inferred":true,"label":"标签"}],
  "inferred": true,
  "note": "连线是推断关系。"
}
```

节点详情仍走 `memoryAdmin/get`；星图不复制一份记忆正文，避免数据不一致。

## 6. 验收

- 浏览器控制台 0 异常（隔离验收脚本）。
- 搜索“生日”定位到真实节点并打开侧栏。
- 暂停/恢复、重置、拖动、缩放可用。
- 页面切换后旧 RAF 停止，不持续占用 CPU。
- 深色 canvas 只存在于星图区域，夜航控制台其余部分保持暖白。

// 首页监控与组件用量。只渲染服务端数据，所有控件复用控制台组件。
export const COMPONENT_NAMES = {
  'qq-chat': '聊天回复', 'qq-participation': '参与判断', 'qq-sticker': '表情包',
  'qq-memory': '长期记忆', 'qq-autonomy': '自主时间', 'qq-emotion': '心情观察',
  'qq-interest': '兴趣', 'qq-proactive': '主动联系', 'qq-private': '私密思考',
  'qq-media-agent': '抖音 / B 站', 'qq-wechat': '微信', 'qq-official-bot': 'QQ 官方机器人',
  'qq-tasks': '任务', 'qq-core': 'QQ 动作', 'qq-messages': '消息记录', framework: '框架'
};
const PURPOSE_NAMES = {
  'participation-decision': '判断是否参与聊天', 'sticker-selection': '选择聊天表情',
  'sticker-classification': '识别收到的表情', 'memory-embedding': '生成记忆向量',
  'private-thinking': '私密思考', 'emotion-reflection': '观察心情与见闻',
  'video-summary': '概括视频内容', 'bilibili-summary': '概括 B 站视频', 'douyin-summary': '概括抖音视频',
  'context-compaction': '压缩聊天上下文', compaction: '压缩聊天上下文', 'session-title': '生成会话标题',
  autonomy: '自主活动', proactive: '生成主动消息', observer: '观察聊天', chat: '生成聊天回复',
  'external-chat': '生成平台回复', poke: '回应戳一戳', ambient: '群聊参与', context: '接续聊天', rewrite: '调整回复表达',
  'write-diary': '写日记', 'publish-qzone': '发布空间', 'learn-web': '上网学习', 'learn-slang': '学习群聊用语',
  'browse-qzone': '浏览空间', 'save-learning': '整理学习记忆', 'task-step': '推进任务',
  'message-send': '发送消息', 'message-receive': '接收消息', 'session-auxiliary': '会话辅助调用', 'video-watch': '处理视频观看任务', 'video-read': '通过 API 读取视频内容'
};
const STATUS_NAMES = {success: '成功', failed: '失败', cancelled: '已取消', denied: '已拒绝', unknown: '结果未知', accepted: '已受理', interrupted: '已中断', pending: '进行中'};
const KIND_NAMES = {model: '模型', tool: '工具', action: '工具', operation: '活动', media: '媒体', message: '消息'};
const numberText = value => Number.isFinite(value) ? value.toLocaleString('zh-CN') : '—';
const percentText = value => Number.isFinite(value) ? value.toFixed(1) + '%' : '等待采样';
export const purposeName = value => PURPOSE_NAMES[value] || value || '未分类';
const componentName = value => COMPONENT_NAMES[value] || value || '框架';

function uptime(value) {
  if (!Number.isFinite(value)) return '未知';
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor(value % 3600 / 60);
  return hours ? hours + ' 小时 ' + minutes + ' 分钟' : minutes + ' 分钟';
}

function tokenValue(value) {
  if (!value.calls) return '0';
  if (!value.reportedCalls) return '未返回';
  return (value.incompleteCalls || value.unreportedCalls ? '≥ ' : '') + numberText(value.totalTokens);
}

function sparkline(samples, field, label) {
  const rows = samples.filter(row => Number.isFinite(row[field]));
  if (rows.length < 2) return null;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 280 54');
  svg.setAttribute('class', 'monitor-spark');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label + '，最近 ' + rows.length + ' 次真实采样');
  const line = document.createElementNS(ns, 'polyline');
  const max = field.endsWith('Percent') ? 100 : Math.max(1, ...rows.map(row => row[field]));
  line.setAttribute('points', rows.map((row, index) => (4 + index / (rows.length - 1) * 272).toFixed(1) + ',' + (50 - row[field] / max * 46).toFixed(1)).join(' '));
  svg.append(line);
  return svg;
}

function characterPanel(data, h) {
  const {el, pill, card, bytesText} = h;
  const value = data.character;
  const labels = {sleeping: '正在休息', working: '正在处理', paused: '收发已暂停', idle: '在线值守', offline: '连接离线'};
  const portrait = el('div', {class: 'monitor-portrait'});
  if (value.avatarUrl) {
    const image = el('img', {src: value.avatarUrl, alt: value.name ? value.name + '的 QQ 头像' : 'QQ 头像', referrerpolicy: 'no-referrer', onerror: () => {
      image.remove();
      portrait.append(el('span', {class: 'muted'}, '头像暂不可用'));
    }});
    portrait.append(image);
  } else portrait.append(el('span', {class: 'muted'}, '等待账号连接'));
  const active = value.active || [];
  const mood = value.moodEnabled ? value.moodObserved ? value.mood?.mood || '未知' : '尚无观察记录' : '观察已停用';
  const identity = el('div', {class: 'monitor-identity'}, portrait,
    el('div', {}, el('h2', {}, value.name || '等待她上线'), el('p', {class: 'mono muted'}, value.qq ? 'QQ ' + value.qq : '尚未取得 QQ 号'),
      pill(labels[value.state] || '状态未知', value.state === 'offline' ? 'warn' : value.state === 'working' ? '' : 'ok')));
  const facts = el('dl', {class: 'monitor-character-facts'},
    el('div', {}, el('dt', {}, '此刻心情'), el('dd', {}, mood)),
    el('div', {}, el('dt', {}, '生活状态'), el('dd', {}, value.sleepLabel)),
    el('div', {}, el('dt', {}, '身体精力'), el('dd', {}, value.energy == null ? '未知' : Math.round(value.energy * 100) + '%')),
    el('div', {}, el('dt', {}, '社交精力'), el('dd', {}, value.socialEnergy == null ? '未知' : Math.round(value.socialEnergy * 100) + '%')));
  const activity = el('div', {class: 'monitor-now'}, el('span', {class: 'muted'}, '现在在做什么'),
    active.length ? el('ul', {}, active.slice(-3).map(row => el('li', {}, purposeName(row.purpose), el('small', {class: 'mono'}, row.kind === 'media' ? (row.platform === 'bilibili' ? 'B 站' : row.platform === 'douyin' ? '抖音' : row.platform) + ' · 等待播放结果确认' : row.model || row.platform || ''))))
      : el('p', {}, value.state === 'sleeping' ? '睡眠中' : value.state === 'paused' ? '等待恢复收发' : value.online ? '当前没有执行中的模型任务' : '等待恢复连接'),
    el('small', {class: 'muted'}, '待处理消息 ' + numberText(value.queueCount) + ' 条'));
  const panel = card('', '', identity, facts, activity);
  panel.classList.add('monitor-character');
  return panel;
}

function resourcePanel(data, h) {
  const {el, card, stat, grid, bytesText, dateText} = h;
  const resources = data.resources;
  const value = resources.current || {};
  const memoryPercent = value.hostMemoryTotal ? value.hostMemoryUsed / value.hostMemoryTotal * 100 : null;
  return card('系统资源', '每 10 秒采样。进程数据覆盖 DSH 和同进程插件。',
    grid([
      stat('进程 CPU', percentText(value.processCpuPercent), resources.cores + ' 个逻辑核心，总容量为 100%'),
      stat('进程内存', value.rss == null ? '未知' : bytesText(value.rss), '堆内存 ' + bytesText(value.heapUsed))
    ]),
    sparkline(resources.samples || [], 'processCpuPercent', '进程 CPU'),
    el('div', {class: 'monitor-resource-line'}, el('span', {}, '整机 CPU'), el('strong', {class: 'mono'}, percentText(value.hostCpuPercent))),
    el('div', {class: 'monitor-resource-line'}, el('span', {}, '整机内存'), el('strong', {class: 'mono'}, percentText(memoryPercent)), el('small', {class: 'muted'}, bytesText(value.hostMemoryUsed) + ' / ' + bytesText(value.hostMemoryTotal))),
    el('div', {class: 'monitor-resource-line'}, el('span', {}, '连续运行'), el('strong', {}, uptime(value.uptimeSeconds))),
    el('p', {class: 'section-note'}, value.at ? '采样于 ' + dateText(value.at) : '正在建立首个资源采样'));
}

function networkPanel(data, h) {
  const {el, card, bytesText, stateBox, dateText} = h;
  const network = data.resources.network;
  const rows = network.interfaces || [];
  const rate = value => value == null ? '等待采样' : bytesText(value) + '/s';
  return card('网络流量', network.scope === 'host-physical-adapters' ? '整机已连接物理网卡，包含其他程序的流量。' : '整机网卡流量，累计值由系统提供。',
    network.available ? rows.map(row => el('div', {class: 'monitor-network'},
      el('h3', {}, row.name),
      el('div', {class: 'monitor-network-rates'},
        el('div', {}, el('span', {class: 'muted'}, '接收'), el('strong', {class: 'mono'}, rate(row.receivePerSecond))),
        el('div', {}, el('span', {class: 'muted'}, '发送'), el('strong', {class: 'mono'}, rate(row.sendPerSecond)))),
      el('p', {class: 'section-note'}, '网卡累计接收 ' + bytesText(row.receivedBytes) + '，发送 ' + bytesText(row.sentBytes))))
      : stateBox('网络采样不可用', network.error || '等待操作系统返回网卡数据'),
    network.sampledAt ? el('small', {class: 'muted'}, '最近成功采样 ' + dateText(network.sampledAt)) : null);
}

function usageStats(usage, h) {
  const {el, stat, grid} = h;
  const model = usage.model;
  return el('div', {class: 'monitor-totals'},
    stat('模型 Token', tokenValue(model), '已返回用量 ' + model.reportedCalls + ' / ' + model.calls + ' 次调用'),
    stat('模型成功', numberText(model.success), '模型流完整结束；消息送达另计'),
    stat('模型失败', numberText(model.failed), '取消 ' + model.cancelled + '，中断 ' + model.interrupted),
    stat('工具成功 / 失败', numberText(usage.tool.success) + ' / ' + numberText(usage.tool.failed), '已受理 ' + usage.tool.accepted + '，未知 ' + usage.tool.unknown + '，拒绝 ' + usage.tool.denied));
}

export function createUsageTable(rows, h, {onComponent} = {}) {
  const {el, button} = h;
  if (!rows.length) return el('p', {class: 'empty'}, '所选范围尚无调用记录。产生实际模型或工具调用后会自动记入。');
  return el('div', {class: 'table-wrap monitor-table-wrap'}, el('table', {class: 'table'},
    el('thead', {}, el('tr', {}, ['部分 / 用途', '模型 / 平台', '调用', 'Token', '输入 / 输出', '缓存读 / 写', '成功', '失败', '其他'].map(text => el('th', {}, text)))),
    el('tbody', {}, rows.map(row => el('tr', {},
      el('td', {}, onComponent ? button(componentName(row.component), () => onComponent(row.component), {ghost: true, small: true}) : el('strong', {}, componentName(row.component)), el('small', {class: 'monitor-cell-note'}, purposeName(row.purpose)), el('small', {class: 'muted'}, KIND_NAMES[row.kind] || row.kind)),
      el('td', {class: 'monitor-model'}, row.model || '无模型调用', el('small', {class: 'monitor-cell-note'}, [row.provider, row.platform].filter(Boolean).join(' / '))),
      el('td', {class: 'mono'}, numberText(row.calls)),
      el('td', {class: 'mono'}, row.kind === 'model' ? tokenValue(row) : '—'),
      el('td', {class: 'mono'}, row.kind === 'model' && row.reportedCalls ? numberText(row.inputTokens) + ' / ' + numberText(row.outputTokens) : '—'),
      el('td', {class: 'mono'}, row.kind === 'model' && row.reportedCalls ? numberText(row.cacheReadTokens) + ' / ' + numberText(row.cacheWriteTokens) : '—'),
      el('td', {class: 'mono'}, numberText(row.success)),
      el('td', {class: 'mono'}, numberText(row.failed)),
      el('td', {}, '取消 ' + row.cancelled, el('small', {class: 'monitor-cell-note'}, '未知 ' + row.unknown + ' / 中断 ' + row.interrupted + ' / 受理 ' + row.accepted), row.unreportedCalls && row.kind === 'model' ? el('small', {class: 'monitor-cell-note'}, '缺用量 ' + row.unreportedCalls) : null))))));
}

function recordsPanel(records, controls, h) {
  const {el, card, field, select, button, pill, stateBox, dateText, pager} = h;
  const filters = el('div', {class: 'monitor-filters'},
    field('记录类型', select(controls.kind || '', controls.onKind, [['', '全部类型'], ['model', '模型调用'], ['action', '工具动作'], ['media', '媒体活动'], ['message', '消息收发']])),
    field('部分', select(controls.component || '', controls.onComponent, [['', '全部部分'], ...controls.components.map(id => [id, componentName(id)])])),
    field('模型', select(controls.model || '', controls.onModel, [['', '全部模型'], ...controls.models.map(id => [id, id])])),
    field('平台', select(controls.platform || '', controls.onPlatform, [['', '全部平台'], ...controls.platforms.map(id => [id, id])])),
    field('结果', select(controls.status || '', controls.onStatus, [['', '全部结果'], ['completed', '模型完成'], ['confirmed', '动作 / 活动已确认'], ['failed', '失败'], ['aborted', '模型已取消'], ['cancelled', '任务已取消'], ['accepted', '已受理'], ['denied', '已拒绝'], ['running', '进行中'], ['unknown', '结果未知'], ['interrupted', '已中断']])),
    button('刷新记录', controls.onRecordsRefresh, {ghost: true, icon: 'refresh'}));
  let body;
  if (controls.recordsError) body = stateBox('调用记录读取失败', controls.recordsError, button('重试', controls.onRecordsRefresh, {ghost: true}));
  else if (!records) body = stateBox('正在读取调用记录', '来自统一活动账本');
  else if (!records.items.length) body = el('p', {class: 'empty'}, '当前筛选条件没有记录。可切换部分、类型或时间范围。');
  else body = el('div', {class: 'table-wrap monitor-table-wrap'}, el('table', {class: 'table'},
    el('thead', {}, el('tr', {}, ['时间 / 部分', '用途 / 模型', '结果', '输入', '输出', '总 Token', '耗时'].map(text => el('th', {}, text)))),
    el('tbody', {}, records.items.map(row => {
      const usage = row.usage;
      return el('tr', {},
        el('td', {}, el('span', {class: 'mono'}, dateText(row.at)), el('small', {class: 'monitor-cell-note'}, componentName(row.component))),
        el('td', {class: 'monitor-model'}, purposeName(row.purpose), el('small', {class: 'monitor-cell-note'}, row.model || KIND_NAMES[row.kind] || row.kind)),
        el('td', {}, pill(STATUS_NAMES[row.status] || row.status, row.status === 'success' ? 'ok' : row.status === 'failed' ? 'bad' : 'warn'), row.errorCode ? el('small', {class: 'monitor-cell-note'}, row.errorCode) : null),
        el('td', {class: 'mono'}, usage?.inputTokens == null ? '—' : numberText(usage.inputTokens)),
        el('td', {class: 'mono'}, usage?.outputTokens == null ? '—' : numberText(usage.outputTokens)),
        el('td', {class: 'mono'}, usage ? (usage.complete ? '' : '≥ ') + numberText(usage.totalTokens ?? usage.knownTokens) : '—'),
        el('td', {class: 'mono'}, row.durationMs == null ? '—' : (row.durationMs / 1000).toFixed(2) + ' s'));
    }))));
  return card('调用明细', '每条记录对应实际调用。模型成功表示本次生成完成，工具受理和送达回执单独记录。', filters, controls.recordsLoading ? el('p', {class: 'muted'}, '正在更新记录…') : null, body,
    records ? pager(records.total, records.offset, records.limit, controls.onPage) : null);
}

export function createMonitorDashboard(data, records, controls, h) {
  const {el, pageHeader, button, pill, card, field, select, grid, dateText} = h;
  const usage = data.usage;
  const rows = usage.breakdown.filter(row => row.kind === 'model' || row.kind === 'tool');
  const header = pageHeader('监控台', '她的当前状态、系统资源和每一笔模型用量。', [pill(controls.refreshing ? '正在更新' : '10 秒自动刷新'), pill('数据采集自 ' + dateText(usage.startedAt))], [
    field('统计范围', select(controls.range, controls.onRange, [['today', '今天'], ['7d', '近 7 天'], ['30d', '近 30 天'], ['all', '全部保留记录']])),
    button('刷新监控', controls.onRefresh, {ghost: true, icon: 'refresh'})
  ]);
  const input = usage.model;
  header.querySelector('.eyebrow')?.remove();
  const packages = data.packages || [];
  return [header,
    controls.error ? el('p', {class: 'notice danger', role: 'status'}, '刷新失败：' + controls.error + '。下方保留上次读取结果。') : null,
    data.runtime.writeFailures ? el('p', {class: 'notice danger'}, '账本写入失败 ' + data.runtime.writeFailures + ' 次，统计可能缺失。请检查磁盘和服务日志。') : null,
    el('div', {class: 'monitor-station'}, characterPanel(data, h), resourcePanel(data, h), networkPanel(data, h)),
    usageStats(usage, h),
    card('Token 用在什么地方', '提供方报告的实际用量；缓存与思考 Token 是明细，不重复加到总量。',
      el('div', {class: 'monitor-token-ledger'},
        h.stat('输入', numberText(input.inputTokens), '已报告部分'), h.stat('输出', numberText(input.outputTokens), '包含提供方计入的思考'),
        h.stat('缓存读取', numberText(input.cacheReadTokens), '已报告部分'), h.stat('缓存写入', numberText(input.cacheWriteTokens), '已报告部分')),
      input.unreportedCalls || input.incompleteCalls ? el('p', {class: 'notice warn'}, input.unreportedCalls + ' 次未返回用量，' + input.incompleteCalls + ' 次用量不完整。总量只汇总已知部分。') : null,
      createUsageTable(rows, h, {onComponent: controls.onComponent})),
    recordsPanel(records, controls, h),
    grid([
      card('消息送达', '当前保留的消息回执，独立于上面的模型调用统计。',
        el('div', {class: 'monitor-delivery'}, h.stat('确认送达', numberText(data.delivery.confirmed)), h.stat('失败', numberText(data.delivery.failed)), h.stat('未知 / 已受理', data.delivery.unknown + ' / ' + data.delivery.accepted)),
        el('p', {class: 'section-note'}, '共 ' + data.delivery.retained + ' 条保留回执；' + usage.retention.detailDays + ' 天调用记录，统计时区为北京时间。')),
      card('功能包状态', '读取真实启用、注册和隔离状态。',
        el('div', {class: 'monitor-package-list'}, packages.map(item => el('div', {class: 'monitor-resource-line'},
          el('span', {}, item.name || componentName(item.id)), pill(item.quarantined ? '已隔离' : item.error ? '有错误' : !item.registered ? '未注册' : item.enabled ? '已启用' : '未启用', item.error || item.quarantined ? 'bad' : item.enabled && item.registered ? 'ok' : '')))))
    ])];
}

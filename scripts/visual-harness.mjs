// 隔离的 UI 验收工具：用真实的 Store / StickerStore / MemoryStore / AutonomyStore
// 构造临时数据，并在本机随机端口启动一个只用于无头浏览器截图的静态站点。
//
// 它不是生产服务，也不会读写 data/ 下的真实数据。QQ 空间使用显式的测试后端，
// 只用于验证页面状态，不代表真实空间接口已经返回这些内容。
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createCanvas} from '@napi-rs/canvas';
import {Store} from '../src/host/store.js';
import {StickerStore} from '../src/core/stickers.js';
import {createStickerAdmin} from '../src/admin/sticker-admin.js';
import {createQzoneAdmin} from '../src/admin/qzone-admin.js';
import {MemoryStore} from '../src/builtins/memory/store.js';
import {createMemoryAdmin} from '../src/admin/memory-admin.js';
import {AutonomyStore} from '../src/builtins/autonomy/index.js';
import {createAutonomyAdmin} from '../src/admin/autonomy-admin.js';
import {manifest as stickerManifest} from '../src/builtins/sticker/index.js';
import {manifest as qzoneManifest} from '../src/builtins/qzone/index.js';
import {manifest as memoryManifest} from '../src/builtins/memory/index.js';
import {manifest as autonomyManifest} from '../src/builtins/autonomy/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, '..', 'src', 'web', 'public');
const temp = await mkdtemp(path.join(os.tmpdir(), 'qq-visual-'));
const store = await new Store(path.join(temp, 'state')).open();
const item = (manifest, config) => ({manifest, enabled: true, registered: true, uninstalled: false, config, scope: {private: true, allUsers: false, users: ['1484475153'], groups: ['992733790']}, health: {consecutive: 0, quarantined: false}, error: null});
store.data.framework.nativePackages = {
  'qq-sticker': item(stickerManifest, {listLimit: 8, autoSaveIncoming: true, autoSaveSent: false, collectProbability: 65, collectCooldownSec: 30, maxPerMessage: 3, excludeKeywords: ['广告'], meaningEnabled: true, maxStickers: 300}),
  'qq-qzone': item(qzoneManifest, {publishEnabled: true, commentEnabled: true, visibility: 'friends', dailyLimitMode: 'recommended', readPerHour: 30, publishPerDay: 3, commentPerDay: 5, cooldownSec: 60, allowedTargets: [], autoSync: true, syncIntervalMinutes: 15, syncBatchFriends: 10, postsPerFriend: 5, retentionMode: 'none', retentionCount: 5000, retentionDays: 365}),
  'qq-memory': item(memoryManifest, {autoRecall: true, autoRecallMode: 'keyword', autoRecallLimit: 6, contextChars: 800, embeddingProvider: 'off', embeddingUrl: '', embeddingModel: 'BAAI/bge-m3', embeddingKey: '', maxMemories: 2000, retentionDays: 730}),
  'qq-autonomy': item(autonomyManifest, {enabled: true, activeHours: '09:00-23:30', runLimitMode: 'recommended', maxRunsPerDay: 8, autoRecordActivities: true, diaryEnabled: true, diaryHour: 22, learnEnabled: true, learnEveryHours: 8, slangEnabled: true, slangEveryHours: 2, qzonePostEnabled: false, browseEnabled: false, browseTargets: [], browseEveryHours: 4, commentEnabled: false, secretAutoDecide: true, diaryRetentionMode: 'none', diaryRetentionCount: 1000, diaryRetentionDays: 365, activityRetentionMode: 'none', activityRetentionCount: 5000, activityRetentionDays: 365, timelinePageSize: 50})
};
store.data.framework.listenGroups = ['992733790'];
store.data.framework.listenUsers = ['1484475153'];
store.data.framework.listenPrivate = true;
store.data.framework.ownerQQ = '1484475153';
store.data.settings.allowedUsers = ['1484475153'];
store.data.settings.allowedGroups = ['992733790'];

const stickers = await new StickerStore(path.join(temp, 'stickers')).open();
const canvasColors = [['#f0d7b8', '开心'], ['#c9dde2', '无语'], ['#e3c7c1', '生气'], ['#d8dfc8', '得意']];
for (const [color, emotion] of canvasColors) {
  const canvas = createCanvas(240, 180);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 240, 180);
  ctx.fillStyle = '#6f4a22';
  ctx.font = '30px "Microsoft YaHei"';
  ctx.textAlign = 'center';
  ctx.fillText(emotion, 120, 100);
  await stickers.save({
    bytes: canvas.toBuffer('image/png'),
    name: emotion + '表情',
    emotion,
    tags: ['测试', emotion],
    usage: '用于界面验收',
    source: 'stolen',
    context: {kind: 'group', peer: '992733790'},
    max: 300
  });
}
const stickerAdmin = createStickerAdmin({stickers, getItem: () => store.data.framework.nativePackages['qq-sticker']});

const memory = await new MemoryStore(path.join(temp, 'memory')).open();
const memoryRows = [
  memory.insert({scope: 'user', owner: '1484475153', kind: 'preference', text: '主人不吃香菜', tags: ['饮食'], importance: 4}),
  memory.insert({scope: 'user', owner: '1484475153', kind: 'fact', text: '主人的生日是 5 月 3 日', tags: ['生日'], importance: 5}),
  memory.insert({scope: 'group', owner: '992733790', kind: 'event', text: '本群每周五晚上开黑', tags: ['群规', '开黑'], importance: 3}),
  memory.insert({scope: 'global', owner: '', kind: 'note', text: '鲸鱼会唱歌，而且同一片海域的鲸会学习同一首歌', tags: ['学习', '鲸鱼'], importance: 3})
];
memory.addReview({memoryId: memoryRows[1].id, reviewedAt: Date.now() - 26 * 3600000, note: '第一次复习'});
const memoryAdmin = createMemoryAdmin({store: memory, getItem: () => store.data.framework.nativePackages['qq-memory']});

const autoStore = new AutonomyStore(path.join(temp, 'autonomy'));
await autoStore.open();
const diary = await autoStore.writeDiary({title: '清晨', mood: '平静', text: '今天醒得很早，窗外还没有完全亮。把昨天没做完的事重新理了一遍，决定先慢慢来。', source: 'auto', now: Date.now() - 6 * 3600000});
await autoStore.addActivity({title: '自主活动 · 写日记', description: '写下了清晨的片段', start: Date.now() - 6 * 3600000, end: Date.now() - 6 * 3600000 + 420000, category: 'diary', source: 'autonomy', diaryId: diary.id});
await autoStore.addActivity({title: '整理书桌', description: '手动补记的日常活动', start: Date.now() - 2 * 3600000, end: Date.now() - 1.5 * 3600000, category: 'life', source: 'manual'});
const auto = {store: autoStore, choose: () => 'diary'};
const autonomyAdmin = await createAutonomyAdmin({
  auto, dir: path.join(temp, 'private'), getItem: () => store.data.framework.nativePackages['qq-autonomy'], log: () => {},
  deviceKey: Buffer.alloc(32, 7),
  decideSecret: async () => ({create: true, choice: 1, shareWithOwner: true, reason: '想给自己留一点空间'})
}).open();
await autonomyAdmin.ensureDecision({force: true});
await autonomyAdmin.secret('request-share', {}, 'visual-session');
await autonomyAdmin.secret('create', {title: '只给她看的一段话', text: '今天其实有一点累，但没有关系。'}, 'visual-session');

const qzoneAdmin = await createQzoneAdmin({
  dir: path.join(temp, 'qzone'),
  getItem: () => store.data.framework.nativePackages['qq-qzone'],
  friends: async () => [
    {id: '1484475153', name: '小鱼'},
    {id: '1532220644', name: '另一个好友'},
    {id: '10001', name: '安静的朋友'}
  ],
  backend: {list: async (userId, count, _signal, offset = 0) => [
    userId === '1484475153'
      ? {id: 'p1', userId, userName: '小鱼', text: '今天路过一家很安静的小店，买了一本旧书。', time: Date.now() - 3600000, url: 'https://user.qzone.qq.com/1484475153/mood/p1', images: ['https://m.qpic.cn/psc?visual'], comments: [{uin: '10001', name: '安静的朋友', text: '这家店看起来不错。', create_time: Date.now() - 3000000}], likes: [{uin: '1532220644', name: '另一个好友'}], likeCount: 1, commentCount: 1, liked: true}
      : {id: 'p' + userId + '-' + offset, userId, userName: '好友' + userId, text: '最近开始重新听以前的歌。', time: Date.now() - 86400000, url: 'https://user.qzone.qq.com/' + userId + '/mood/p2'}
  ]}
}).open();
await qzoneAdmin.sync({reason: 'visual'});

function snapshot() {
  return {
    revision: 1,
    status: {online: true, state: 'connected', bot: '1532220644', nickname: '小鱼'},
    framework: {paused: false, enabledActions: ['qq.message.send', 'plugin.qq-memory.recall'], listenGroups: ['992733790'], listenUsers: ['1484475153'], listenPrivate: true, listenAllPrivate: false, ownerQQ: '1484475153', audit: []},
    capabilities: [],
    builtins: [],
    nativePackages: Object.values(store.data.framework.nativePackages),
    extensions: [],
    sources: [],
    diagnostics: {received: 12, accepted: 10, ignored: 2, recentIgnored: []},
    settings: {enabled: true, mode: 'forward', url: 'ws://127.0.0.1:3001', privateEnabled: true, groupEnabled: true, allowedUsers: ['1484475153'], allowedGroups: ['992733790'], groupReplyMode: 'smart', groupReplyProbability: 10, groupReplyCooldown: 30, groupAutoLimit: 2, replySplit: 'natural', replyQuoteMode: 'off', replyTotalChars: 240, replyMaxParts: 2, sendInterval: 1100, maxReplyChars: 1800, botAliases: ['小鱼'], intentRecognition: true, privateAudience: 'all', groupAudience: 'all'},
    logs: [],
    jobs: [],
    compatibility: {framework: '0.13.0', dsh: '0.2.1-rc.2', extensionApi: 2},
    personas: [],
    personaDefaults: {global: 'default', bots: {}},
    bindings: {},
    sessions: {},
    eventState: {},
    systemDenied: [],
    pluginPages: []
  };
}

async function run(body, meta = {}) {
  const action = body.action;
  if (action === 'snapshot') return snapshot();
  if (action === 'stickerAdmin') {
    if (body.op === 'overview') return stickerAdmin.overview();
    if (body.op === 'list') return stickerAdmin.list(body.query || body);
    if (body.op === 'remove') return stickerAdmin.remove(body.id);
    if (body.op === 'annotate') return stickerAdmin.annotate(body);
  }
  if (action === 'qzoneAdmin') {
    if (body.op === 'overview') return qzoneAdmin.overview();
    if (body.op === 'friends') return qzoneAdmin.friendList(body.query || body);
    if (body.op === 'refresh-friends') return {items: await qzoneAdmin.refreshFriends(), overview: qzoneAdmin.overview()};
    if (body.op === 'feed') return qzoneAdmin.list(body.query || body);
    if (body.op === 'sync') return {result: await qzoneAdmin.sync({reason: 'visual'}), overview: qzoneAdmin.overview()};
  }
  if (action === 'memoryAdmin') {
    if (body.op === 'overview') return memoryAdmin.overview();
    if (body.op === 'list') return memoryAdmin.list(body.query || body);
    if (body.op === 'get') return memoryAdmin.get(body.id);
    if (body.op === 'graph') return memoryAdmin.graph(body.query || body);
    if (body.op === 'reviewOverview') return memoryAdmin.reviewOverview(body.query || body);
    if (body.op === 'reviewComplete') return memoryAdmin.reviewComplete(body);
    if (body.op === 'update') return memoryAdmin.update(body);
    if (body.op === 'create') return memoryAdmin.create(body);
    if (body.op === 'remove') return memoryAdmin.remove(body.id);
  }
  if (action === 'autonomyAdmin') {
    if (body.op === 'overview') return autonomyAdmin.overview();
    if (body.op === 'diaryList') return autonomyAdmin.diaryList(body.query || body);
    if (body.op === 'diaryGet') return autonomyAdmin.diaryGet(body.id);
    if (body.op === 'diaryCreate') return autonomyAdmin.diaryCreate(body);
    if (body.op === 'diaryUpdate') return autonomyAdmin.diaryUpdate(body);
    if (body.op === 'diaryDelete') return autonomyAdmin.diaryDelete(body.id);
    if (body.op === 'activityList') return autonomyAdmin.activityList(body.query || body);
    if (body.op === 'activityCreate') return autonomyAdmin.activityCreate(body);
    if (body.op === 'activityUpdate') return autonomyAdmin.activityUpdate(body);
    if (body.op === 'activityDelete') return autonomyAdmin.activityDelete(body.id);
    if (body.op === 'timeSummary') return autonomyAdmin.timeSummary(body.query || body);
  }
  if (action === 'secretAdmin') return autonomyAdmin.secret(String(body.op || 'status'), body, 'visual-session');
  if (action === 'configureNativePackage') return {ok: true};
  throw new Error('harness 不支持：' + action + '/' + (body.op || ''));
}

const types = {'.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8'};
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/api/session') return json(res, {ok: true, configured: true, authenticated: true, csrf: 'visual'});
  if (['/api/sticker-image', '/api/qzone-image', '/api/qzone-avatar'].includes(url.pathname)) {
    try {
      const row = stickers.list({limit: 1})[0];
      const id = url.pathname === '/api/sticker-image' ? (url.searchParams.get('id') || row.id) : row.id;
      const image = await stickerAdmin.image(id);
      res.writeHead(200, {'content-type': image.mime, 'cache-control': 'no-store'});
      return res.end(image.bytes);
    } catch { return json(res, {ok: false}, 404); }
  }
  if (url.pathname === '/api/action' && req.method === 'POST') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    try {
      const body = JSON.parse(raw || '{}');
      const value = await run(body, {adminSession: 'visual-session'});
      return json(res, {ok: true, value});
    } catch (error) { return json(res, {ok: false, error: String(error.message || error)}, 400); }
  }
  const name = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/assets\//, '');
  if (['index.html', 'app.css', 'app.js', 'star-map.js', 'three.module.js'].includes(name)) {
    const body = await readFile(path.join(publicDir, name));
    res.writeHead(200, {'content-type': types[path.extname(name)] || 'application/octet-stream', 'cache-control': 'no-store'});
    return res.end(body);
  }
  json(res, {ok: false, error: 'not found'}, 404);
});

function json(res, value, status = 200) {
  const body = JSON.stringify(value);
  res.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'});
  res.end(body);
}

const port = Number(process.env.VISUAL_PORT) || 4010;
server.listen(port, '127.0.0.1', () => console.log('VISUAL_READY http://127.0.0.1:' + port));
process.on('SIGINT', async () => { await rm(temp, {recursive: true, force: true}); process.exit(0); });

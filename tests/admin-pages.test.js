import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdtemp, readFile, rm, stat} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {StickerStore} from '../src/core/stickers.js';
import {createStickerAdmin} from '../src/admin/sticker-admin.js';
import {createStickerAutoSave} from '../src/builtins/sticker/auto.js';
import {createQzoneAdmin} from '../src/admin/qzone-admin.js';
import {MemoryStore} from '../src/builtins/memory/store.js';
import {createMemoryAdmin} from '../src/admin/memory-admin.js';
import {AutonomyStore} from '../src/builtins/autonomy/index.js';
import {createAutonomyAdmin} from '../src/admin/autonomy-admin.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

async function temp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qq-admin-page-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  return dir;
}

const stickerItem = () => ({
  enabled: true, registered: true, uninstalled: false, manifest: {name: '表情包', version: '1.1.0', description: '测试'},
  config: {listLimit: 8, autoSaveIncoming: true, autoSaveSent: false, meaningEnabled: true, maxStickers: 20, collectProbability: 100, collectCooldownSec: 0, maxPerMessage: 3, excludeKeywords: []},
  scope: {private: true, allUsers: false, users: ['10000001'], groups: ['88888']}, health: {}, error: null
});

test('表情包管理：真实索引分页、详情图片、删除与未分类统计', async t => {
  const dir = await temp(t);
  const store = await new StickerStore(path.join(dir, 'stickers')).open();
  const first = await store.save({bytes: png, name: '开心', emotion: '开心', tags: ['猫'], source: 'stolen', context: {kind: 'group', peer: '88888'}, max: 20});
  await store.save({bytes: Buffer.concat([png, Buffer.from('x')]), name: '无标签', source: 'auto-incoming', context: {kind: 'group', peer: '88888'}, max: 20});
  const admin = createStickerAdmin({stickers: store, getItem: () => stickerItem()});
  const overview = admin.overview();
  assert.equal(overview.stats.total, 2);
  const today = new Date();
  const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  assert.equal(admin.list({from: day, to: day}).total, 2);
  assert.equal(admin.list({from: '2099-01-01'}).total, 0);
  assert.equal(overview.categories.find(row => row.emotion === '开心').count, 1);
  assert.equal(overview.categories.find(row => !row.emotion).count, 1);
  const list = admin.list({query: '猫'});
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].sourceLabel, '偷图');
  assert.match(list.items[0].imageUrl, /^\/api\/sticker-image\?id=/);
  const image = await admin.image(first.sticker.id);
  assert.equal(image.mime, 'image/png');
  assert.equal(image.bytes.length, png.length);
  const removed = await admin.remove(first.sticker.id);
  assert.equal(removed.removed.name, '开心');
  assert.equal(admin.overview().stats.total, 1);
});

test('自动收藏概率、冷却、排除词与单条上限都参与真实判定', async t => {
  const dir = await temp(t);
  const store = await new StickerStore(path.join(dir, 'stickers')).open();
  const config = {autoSaveIncoming: true, autoSaveSent: true, collectProbability: 100, collectCooldownSec: 0, maxPerMessage: 1, excludeKeywords: ['广告'], maxStickers: 20};
  const scope = () => ({config, scope: {private: true, users: ['10000001'], groups: ['88888']}});
  let fetches = 0;
  const auto = createStickerAutoSave({
    stickers: store, readResource: async () => png,
    fetchMessageBytes: async () => { fetches += 1; return png; },
    scope, random: () => 0.99, now: () => Date.now()
  });
  const context = {kind: 'group', peer: '88888', key: 'bot:group:88888', actor: '10000001'};
  const message = {sender: '群友', text: '广告图片', parts: [{type: 'image'}, {type: 'image'}]};
  assert.equal(await auto.fromMessage(message, context), null, '排除词应先拦截，不读取图片');
  config.collectProbability = 0;
  assert.equal(await auto.fromMessage(message, context), null);
  assert.equal(fetches, 0);
  config.collectProbability = 100;
  config.excludeKeywords = [];
  const saved = await auto.fromMessage(message, context);
  assert.equal(saved.length, 1, 'maxPerMessage=1 只处理第一张');
  assert.equal(fetches, 1);
  config.collectCooldownSec = 3600;
  assert.equal(await auto.fromMessage({...message, parts: [{type: 'image'}]}, context), null, '冷却期内不读取图片');
  assert.equal(fetches, 1);
});

test('QQ 空间管理：自动好友列表、批量同步、分页、图片/评论/点赞与去重', async t => {
  const dir = await temp(t);
  const config = {
    readPerHour: 30, publishEnabled: true, commentEnabled: true, syncBatchFriends: 10, postsPerFriend: 5,
    retentionMode: 'none', retentionCount: 5000, retentionDays: 365
  };
  const calls = [];
  const admin = await createQzoneAdmin({
    dir,
    getItem: () => ({enabled: true, uninstalled: false, manifest: {name: 'QQ空间', version: '1.0.0'}, config, scope: {}, health: {}}),
    friends: async () => [{id: '10001', name: '好友甲'}, {id: '10002', name: '好友乙'}],
    backend: {
      list: async (userId, count, _signal, offset = 0) => {
        calls.push({userId, count, offset});
        return [{
          id: 'p' + userId + '-' + offset, userId, userName: '发布者' + userId, text: '真实正文 ' + userId,
          time: Date.now() - Number(userId.slice(-1)) * 1000,
          url: 'https://user.qzone.qq.com/' + userId + '/mood/p',
          images: ['https://m.qpic.cn/psc?real-image'],
          comments: [{uin: '20001', name: '评论者', content: '评论内容', create_time: Date.now()}],
          likes: [{uin: '20002', name: '点赞者'}],
          likeCount: 1, commentCount: 1, liked: true
        }];
      }
    }
  }).open();
  const sync = await admin.sync({reason: 'test'});
  assert.equal(sync.friends, 2);
  assert.equal(sync.failed, 0);
  assert.equal(sync.newPosts, 2);
  assert.equal(admin.overview().status.friendCount, 2);
  assert.equal(admin.overview().status.feedCount, 2);
  const friends = await admin.friendList({query: '好友甲'});
  assert.equal(friends.items.length, 1);
  assert.match(friends.items[0].avatarUrl, /^\/api\/qzone-avatar\?id=10001/);
  const feed = admin.list({limit: 1, offset: 0});
  assert.equal(feed.total, 2);
  assert.equal(feed.hasMore, true);
  assert.equal(feed.items[0].images[0], 'https://m.qpic.cn/psc?real-image');
  assert.equal(feed.items[0].comments[0].content, '评论内容');
  assert.equal(feed.items[0].likes[0].name, '点赞者');
  assert.equal(feed.items[0].liked, true);
  assert.equal(admin.list({friendId: '10001'}).total, 1);
  const again = await admin.sync({reason: 'test'});
  assert.equal(again.newPosts, 0, '重复同步不应产生重复动态');
  assert.ok(calls.length >= 4, '同步与重复同步都应走真实后端');
  const statusRaw = await readFile(path.join(dir, 'admin-status.json'), 'utf8');
  assert.ok(!statusRaw.includes('真实正文'), '状态元数据不缓存正文');
  const feedRaw = await readFile(path.join(dir, 'feed.json'), 'utf8');
  assert.ok(feedRaw.includes('真实正文 10001'), '动态缓存保存真实接口返回内容');
  const reopened = await createQzoneAdmin({
    dir,
    getItem: () => ({enabled: true, uninstalled: false, manifest: {name: 'QQ空间', version: '1.0.0'}, config, scope: {}, health: {}}),
    friends: async () => { throw new Error('重启后不应为读取缓存而请求好友列表'); },
    backend: {list: async () => { throw new Error('重启后不应自动请求空间'); }}
  }).open();
  assert.equal(reopened.list({}).total, 2);
  assert.equal((await reopened.friendList({})).items.length, 2);
});

test('QQ 空间同步：单个好友失败不阻断其他好友，读取保护上限会停止批次', async t => {
  const dir = await temp(t);
  let mode = 'one-fails';
  const config = {readPerHour: 30, syncBatchFriends: 10, postsPerFriend: 1, retentionMode: 'none'};
  const admin = await createQzoneAdmin({
    dir,
    getItem: () => ({enabled: true, uninstalled: false, manifest: {name: 'QQ空间', version: '1.0.0'}, config, scope: {}, health: {}}),
    friends: async () => [{id: '10001', name: '正常'}, {id: '10002', name: '不可访问'}],
    backend: {
      list: async userId => {
        if (mode === 'one-fails' && userId === '10002') throw new Error('无访问权限');
        if (mode === 'rate') throw new Error('空间读取达到本地每小时保护上限（1 次）');
        return [{id: 'p' + userId, userId, text: '正文' + userId, time: Date.now(), url: 'https://user.qzone.qq.com/' + userId + '/mood/p'}];
      }
    }
  }).open();
  const first = await admin.sync({reason: 'test'});
  assert.equal(first.failed, 1);
  assert.equal(first.newPosts, 1);
  assert.equal(admin.list({}).total, 1, '失败好友不应阻断正常好友');
  assert.equal((await admin.friendList({})).items.find(row => row.id === '10002').error, '无访问权限');
  mode = 'rate';
  config.readPerHour = 1;
  const second = await admin.sync({reason: 'test'});
  assert.ok(second.failed >= 1);
});

test('QQ 空间批量同步按游标轮转，保留策略只影响缓存', async t => {
  const dir = await temp(t);
  const config = {readPerHour: 30, syncBatchFriends: 1, postsPerFriend: 1, retentionMode: 'count', retentionCount: 1};
  const seen = [];
  const admin = await createQzoneAdmin({
    dir,
    getItem: () => ({enabled: true, uninstalled: false, manifest: {name: 'QQ空间', version: '1.0.0'}, config, scope: {}, health: {}}),
    friends: async () => [{id: '10001', name: 'A'}, {id: '10002', name: 'B'}, {id: '10003', name: 'C'}],
    backend: {list: async userId => {
      seen.push(userId);
      return [{id: 'p' + userId, userId, text: '正文' + userId, time: Date.now(), url: 'https://user.qzone.qq.com/' + userId + '/mood/p'}];
    }}
  }).open();
  await admin.sync({reason: 'first'});
  await admin.sync({reason: 'second'});
  await admin.sync({reason: 'third'});
  assert.deepEqual([...new Set(seen)].sort(), ['10001', '10002', '10003']);
  assert.equal(admin.overview().status.feedCount, 1, '自定义保留策略应生效');
  assert.equal(admin.list({}).total, 1);
});

test('长期记忆管理：编辑清除向量、星图只使用真实标签/向量、复习记录持久化', async t => {
  const dir = await temp(t);
  const store = await new MemoryStore(dir).open();
  const a = store.insert({scope: 'user', owner: '10001', text: '主人喜欢猫', tags: ['宠物'], importance: 4});
  const b = store.insert({scope: 'group', owner: '88888', text: '群里周五开黑', tags: ['宠物'], importance: 3});
  store.db.prepare('UPDATE memories SET dim = 3, model = ?, embedding = ? WHERE id = ?').run('test', Buffer.from(new Float32Array([1, 0, 0]).buffer), a.id);
  const admin = createMemoryAdmin({store, getItem: () => ({enabled: true, manifest: {name: '长期记忆', version: '1.0.0'}, config: {embeddingKey: 'sk-secret', maxMemories: 100, retentionDays: 30}, scope: {}})});
  const overview = admin.overview();
  assert.equal(overview.config.embeddingKey, undefined, '设置页不能回显密钥');
  assert.equal(overview.secrets.embeddingKeyConfigured, true);
  const list = admin.list({});
  assert.equal(list.total, 2);
  assert.equal(admin.get(a.id).memory.text, '主人喜欢猫');
  const updated = admin.update({id: a.id, text: '主人非常喜欢猫', tags: ['宠物', '猫'], importance: 5});
  assert.equal(updated.memory.hasVector, false, '正文变化应清除旧向量');
  const graph = admin.graph({});
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.edges[0].kind, 'shared-tag');
  assert.equal(graph.edges[0].inferred, true);
  const detail = admin.get(b.id);
  assert.equal(detail.related[0].id, a.id);
  assert.equal(detail.historyAvailable, false);
  assert.match(detail.historyNote, /不保存逐次编辑历史/);
  const completed = admin.reviewComplete({id: b.id, note: '第一次复习'});
  assert.equal(completed.history.length, 1);
  assert.equal(admin.get(b.id).reviews.length, 1);
  const review = admin.reviewOverview({id: b.id});
  assert.equal(review.detail.reviews.length, 1);
  assert.ok(review.detail.series.length > 0);
  admin.remove(a.id);
  assert.throws(() => admin.get(a.id), /不存在/);
  store.close();
});

test('自主时间管理：日记 CRUD、活动与时间汇总', async t => {
  const dir = await temp(t);
  const store = new AutonomyStore(path.join(dir, 'autonomy'));
  await store.open();
  const admin = createAutonomyAdmin({
    auto: {store, choose: () => 'diary'}, dir: path.join(dir, 'private'),
    getItem: () => ({enabled: true, manifest: {name: '自主时间', version: '1.0.0'}, config: {enabled: true, maxRunsPerDay: 8}, scope: {}})
  });
  await admin.open();
  const created = await admin.diaryCreate({title: '清晨', mood: '平静', text: '今天起得很早。'});
  assert.ok(created.created.id);
  const list = await admin.diaryList({query: '清晨'});
  assert.equal(list.total, 1);
  await admin.diaryUpdate({id: created.created.id, text: '今天起得很早，窗外很安静。'});
  assert.match((await admin.diaryGet(created.created.id)).text, /安静/);
  const activity = await admin.activityCreate({title: '散步', start: new Date(Date.now() - 3600000).toISOString(), end: new Date().toISOString(), category: 'life'});
  assert.equal(activity.created.minutes, 60);
  const summary = await admin.timeSummary({});
  assert.equal(summary.totalMinutes, 60);
  assert.equal(summary.byCategory[0].label, '生活');
  await admin.activityDelete(activity.created.id);
  assert.equal((await admin.activityList({})).total, 0);
  await admin.diaryDelete(created.created.id);
  assert.equal((await admin.diaryList({})).total, 0);
});

test('秘密空间：AES-GCM 加密、密码验证、锁定、修改密码与清空', async t => {
  const dir = await temp(t);
  const audit = [];
  const store = new AutonomyStore(path.join(dir, 'autonomy'));
  await store.open();
  const admin = await createAutonomyAdmin({
    auto: {store, choose: () => null}, dir: path.join(dir, 'private'), log: (...args) => audit.push(args),
    getItem: () => ({enabled: true, manifest: {name: '自主时间', version: '1.0.0'}, config: {enabled: true}, scope: {}})
  }).open();
  await assert.rejects(admin.secret('list', {}, 's1'), /尚未设置|锁定/);
  const setup = await admin.secret('setup', {password: 'correct horse battery', legacy: true}, 'admin|page1');
  assert.equal(setup.status.unlocked, true);
  const otherPage = await admin.secret('status', {}, 'admin|page2');
  assert.equal(otherPage.status.unlocked, false, '刷新后的页面 nonce 必须重新锁定');
  await assert.rejects(admin.secret('list', {}, 'admin|page2'), /已锁定/);
  const created = await admin.secret('create', {title: '秘密标题', text: '这句正文绝不能出现在明文文件或日志里'}, 'admin|page1');
  const file = path.join(dir, 'private', 'secret-vault.json');
  const raw = await readFile(file, 'utf8');
  assert.ok(!raw.includes('这句正文绝不能出现在明文文件或日志里'));
  assert.ok(!raw.includes('秘密标题'));
  assert.ok(!audit.flat().join(' ').includes('这句正文绝不能出现在明文文件或日志里'));
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
  const list = await admin.secret('list', {}, 'admin|page1');
  assert.equal(list.items[0].title, '秘密标题');
  assert.equal((await admin.secret('get', {id: created.created.id}, 'admin|page1')).secret.body, '这句正文绝不能出现在明文文件或日志里');
  admin.lockSession('admin');
  await assert.rejects(admin.secret('get', {id: created.created.id}, 'admin|page1'), /已锁定/);
  await assert.rejects(admin.secret('unlock', {password: 'wrong password'}, 's2'), /密码不正确/);
  const unlocked = await admin.secret('unlock', {password: 'correct horse battery'}, 's2');
  assert.equal(unlocked.status.unlocked, true);
  const changed = await admin.secret('change-password', {current: 'correct horse battery', password: 'a new secret passphrase'}, 's2');
  assert.equal(changed.status.unlocked, true);
  assert.equal((await admin.secret('get', {id: created.created.id}, 's2')).secret.body, '这句正文绝不能出现在明文文件或日志里');
  await admin.secret('reset', {confirmation: 'RESET'}, 's2');
  assert.equal(admin.overview().secret.configured, false);
});

test('角色自主秘密空间：受限决策创建、设备密钥重启解锁、分享门控与不覆盖', async t => {
  const dir = await temp(t);
  const deviceKey = Buffer.alloc(32, 9);
  const store = new AutonomyStore(path.join(dir, 'autonomy'));
  await store.open();
  let decisions = 0;
  const decideSecret = async ({options}) => {
    decisions += 1;
    assert.ok(options.length >= 3);
    return {create: true, choice: 1, shareWithOwner: true, reason: '想给自己留一点空间'};
  };
  const make = async () => createAutonomyAdmin({
    auto: {store, choose: () => null}, dir: path.join(dir, 'private'), deviceKey, decideSecret,
    getItem: () => ({enabled: true, manifest: {name: '自主时间', version: '1.0.0'}, config: {enabled: true}, scope: {}})
  }).open();
  let admin = await make();
  const decided = await admin.secret('decide', {force: true}, 'admin|page');
  assert.equal(decisions, 1);
  assert.equal(decided.status.configured, true);
  assert.equal(decided.status.mode, 'character');
  assert.equal(decided.status.unlocked, false);
  assert.equal(decided.status.character.shareWithOwner, true);
  assert.equal((await admin.secret('status', {}, 'admin|page')).status.mode, 'character');
  await assert.rejects(admin.secret('setup', {password: 'user chosen password'}, 'admin|page'), /角色自主设置/);
  const shared = await admin.secret('request-share', {}, 'admin|page');
  assert.equal(shared.status.unlocked, true);
  const created = await admin.secret('create', {title: '角色秘密', text: '只有她同意后可见的正文'}, 'admin|page');
  const raw = await readFile(path.join(dir, 'private', 'secret-vault.json'), 'utf8');
  assert.ok(!raw.includes('只有她同意后可见的正文'));
  assert.ok(!raw.includes('角色秘密'));
  assert.ok(raw.includes('keyWrap'));
  assert.ok(!raw.includes('nw-'), '角色密码不能以明文形式出现在文件里');
  // 重启后同一个设备密钥仍能解封；页面仍要重新请求分享。
  admin = await make();
  const afterRestart = await admin.secret('status', {}, 'admin|page');
  assert.equal(afterRestart.status.configured, true);
  assert.equal(afterRestart.status.unlocked, false);
  const reopened = await admin.secret('request-share', {}, 'admin|page');
  assert.equal(reopened.status.unlocked, true);
  assert.equal((await admin.secret('get', {id: created.created.id}, 'admin|page')).secret.body, '只有她同意后可见的正文');
  // 已存在秘密时再次决策不能覆盖。
  const again = await admin.secret('decide', {force: true}, 'admin|page');
  assert.equal(again.status.entries, 1);
  assert.equal(admin.vault.characterPassword !== undefined, true);
  await admin.vault.rotateCharacterPassword('rotated character secret 42', 'admin|page');
  assert.equal((await admin.secret('get', {id: created.created.id}, 'admin|page')).secret.body, '只有她同意后可见的正文');
});

test('角色自主秘密空间：拒绝创建时不生成默认密码，不分享时管理员不可读', async t => {
  const dir = await temp(t);
  const deviceKey = Buffer.alloc(32, 4);
  const store = new AutonomyStore(path.join(dir, 'autonomy'));
  await store.open();
  const decline = await createAutonomyAdmin({
    auto: {store, choose: () => null}, dir: path.join(dir, 'private'), deviceKey,
    decideSecret: async () => ({create: false, choice: 0, shareWithOwner: false, reason: '还没想好'}),
    getItem: () => ({enabled: true, manifest: {name: '自主时间', version: '1.0.0'}, config: {enabled: true}, scope: {}})
  }).open();
  const result = await decline.secret('decide', {force: true}, 'admin|page');
  assert.equal(result.created, false);
  assert.equal(result.status.configured, false);
  assert.equal(existsSync(path.join(dir, 'private', 'secret-vault.json')), false);
  assert.match((await decline.secret('status', {}, 'admin|page')).status.decision.reason, /没想好/);
});

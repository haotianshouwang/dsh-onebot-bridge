// QQ 空间管理页的数据服务。
//
// 好友列表来自已连接的 OneBot 网关（get_friend_list），动态来自当前登录账号本来就有权限
// 访问的空间接口。管理站点只做聚合、去重和分页展示，不绕过空间隐私，也不保存 Cookie。
//
// 动态缓存是真实接口返回的数据，便于页面刷新后继续浏览；保留策略由用户配置。
import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {mediaType, safeDownload} from '../core/media.js';

const MAX_FEED_PAGE = 100;
const IMAGE_HOSTS = /(^|\.)(qpic\.cn|qlogo\.cn|qzone\.qq\.com|qq\.com|gtimg\.cn)$/i;

function iso(value) {
  const number = Number(value) || 0;
  return number ? new Date(number).toISOString() : null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeFriend(row) {
  const id = String(row?.id || row?.user_id || row?.userId || '').trim();
  if (!/^[1-9]\d{3,15}$/.test(id)) return null;
  return {
    id,
    name: String(row?.name || row?.nickname || row?.remark || id).slice(0, 80),
    remark: String(row?.remark || '').slice(0, 80)
  };
}

function normalizePost(row, friend) {
  const id = String(row?.id || '').slice(0, 120);
  if (!id) return null;
  return {
    key: friend.id + ':' + id,
    id,
    friendId: friend.id,
    friendName: friend.name || friend.remark || friend.id,
    userId: String(row?.userId || friend.id),
    userName: String(row?.userName || friend.name || friend.remark || '').slice(0, 80),
    text: String(row?.text || '').slice(0, 3000),
    time: Number(row?.time) || 0,
    url: /^https:\/\/user\.qzone\.qq\.com\//.test(String(row?.url || '')) ? String(row.url) : '',
    images: Array.isArray(row?.images) ? row.images.filter(url => /^https:\/\//.test(String(url))).slice(0, 9) : [],
    comments: Array.isArray(row?.comments) ? row.comments.slice(0, 20) : [],
    likes: Array.isArray(row?.likes) ? row.likes.slice(0, 50) : [],
    likeCount: Number(row?.likeCount) || 0,
    commentCount: Number(row?.commentCount) || 0,
    liked: row?.liked === true
  };
}

export function createQzoneAdmin({backend, dir, getItem, friends, now = () => Date.now(), log = () => {}}) {
  if (!backend) throw new Error('QQ 空间后端不可用');
  const statusFile = path.join(dir, 'admin-status.json');
  const feedFile = path.join(dir, 'feed.json');
  let status = {
    version: 2, lastAttempt: 0, lastSuccess: 0, lastError: '', lastFetched: 0, lastTarget: '',
    totalFetched: 0, lastSyncAt: 0, lastSyncError: '', syncInProgress: false, syncDone: 0, syncTotal: 0,
    friendCount: 0, feedCount: 0, syncCursor: 0
  };
  let feed = {version: 1, friends: [], posts: [], syncedAt: 0};
  let reads = [];
  let syncPromise = null;
  let timer = null;
  let initialTimer = null;
  let schedulerStopped = false;
  let lastAuto = 0;
  let ready = false;

  async function open() {
    await mkdir(dir, {recursive: true});
    try {
      const raw = JSON.parse(await readFile(statusFile, 'utf8'));
      if (raw && [1, 2].includes(raw.version)) status = {...status, ...raw, version: 2, syncInProgress: false, syncDone: 0, syncTotal: 0};
    } catch (error) {
      if (error.code !== 'ENOENT') status.lastError = '空间管理状态文件无法读取';
    }
    try {
      const raw = JSON.parse(await readFile(feedFile, 'utf8'));
      if (raw?.version === 1 && Array.isArray(raw.friends) && Array.isArray(raw.posts)) {
        feed = {
          version: 1,
          friends: raw.friends.filter(row => row && /^[1-9]\d{3,15}$/.test(String(row.id))).map(row => ({
            ...row,
            id: String(row.id),
            name: String(row.name || row.remark || row.id).slice(0, 80),
            remark: String(row.remark || '').slice(0, 80),
            postCount: Number(row.postCount) || 0,
            lastSyncAt: Number(row.lastSyncAt) || 0,
            error: String(row.error || '').slice(0, 200)
          })),
          posts: raw.posts.filter(row => row && row.key && row.id).slice(0, 100000),
          syncedAt: Number(raw.syncedAt) || 0
        };
      }
    } catch (error) {
      if (error.code !== 'ENOENT') status.lastSyncError = '空间动态缓存无法读取';
    }
    status.feedCount = feed.posts.length;
    status.friendCount = feed.friends.length;
    ready = true;
    return api;
  }

  async function persistStatus() {
    const text = JSON.stringify(status, null, 2);
    await writeFile(statusFile + '.tmp', text, {encoding: 'utf8', mode: 0o600});
    await rename(statusFile + '.tmp', statusFile);
  }

  async function persistFeed() {
    const text = JSON.stringify(feed, null, 2);
    await writeFile(feedFile + '.tmp', text, {encoding: 'utf8', mode: 0o600});
    await rename(feedFile + '.tmp', feedFile);
  }

  function item() {
    const value = getItem();
    if (!value) throw new Error('QQ 空间插件当前未注册');
    return value;
  }

  function config() {
    return item().config || {};
  }

  function feedCounts() {
    const counts = new Map();
    for (const post of feed.posts) counts.set(post.friendId, (counts.get(post.friendId) || 0) + 1);
    return counts;
  }

  function publicFriends(query = '') {
    const text = String(query || '').trim().toLowerCase();
    const counts = feedCounts();
    const allowed = Array.isArray(config().allowedTargets) ? config().allowedTargets : [];
    return feed.friends
      .filter(friend => !allowed.length || allowed.includes(friend.id))
      .filter(friend => !text || friend.name.toLowerCase().includes(text) || friend.remark.toLowerCase().includes(text) || friend.id.includes(text))
      .map(friend => ({
        ...friend,
        avatarUrl: '/api/qzone-avatar?id=' + encodeURIComponent(friend.id),
        postCount: counts.get(friend.id) || 0
      }));
  }

  function overview() {
    const value = item();
    const cfg = value.config || {};
    const errors = feed.friends.filter(friend => friend.error).length;
    return {
      id: 'qq-qzone',
      name: value.manifest?.name || 'QQ 空间',
      version: value.manifest?.version || '',
      description: value.manifest?.description || '',
      enabled: value.enabled === true,
      registered: value.registered === true,
      uninstalled: value.uninstalled === true,
      health: value.health || {},
      error: value.error || null,
      migrationError: value.migrationError || null,
      config: cfg,
      scope: value.scope || null,
      status: {
        lastAttempt: iso(status.lastAttempt),
        lastSuccess: iso(status.lastSuccess),
        lastError: status.lastError,
        lastFetched: status.lastFetched,
        lastTarget: status.lastTarget,
        totalFetched: status.totalFetched,
        lastSyncAt: iso(status.lastSyncAt),
        lastSyncError: status.lastSyncError,
        syncInProgress: status.syncInProgress,
        syncDone: status.syncDone,
        syncTotal: status.syncTotal,
        friendCount: feed.friends.length,
        feedCount: feed.posts.length,
        friendErrors: errors
      },
      capabilities: {
        list: true,
        friends: true,
        autoSync: true,
        publish: cfg.publishEnabled === true,
        comment: cfg.commentEnabled === true,
        images: true,
        likes: true,
        comments: true,
        avatars: true,
        adminWrites: false,
        note: '字段是否出现取决于 QQ 当前返回；页面不会为缺失字段填入猜测值。'
      }
    };
  }

  function takeRead() {
    const at = now();
    reads = reads.filter(time => at - time < 3600000);
    const perHour = Math.max(1, Math.min(120, Number(config().readPerHour) || 30));
    if (reads.length >= perHour) throw new Error(`空间读取达到本地每小时保护上限（${perHour} 次）`);
    reads.push(at);
  }

  async function refreshFriends() {
    if (typeof friends !== 'function') throw new Error('当前没有好友列表接口');
    const rows = await friends();
    const list = [];
    const seen = new Set();
    for (const row of Array.isArray(rows) ? rows : []) {
      const normalized = normalizeFriend(row);
      if (!normalized || seen.has(normalized.id)) continue;
      seen.add(normalized.id);
      const previous = feed.friends.find(friend => friend.id === normalized.id);
      list.push({
        ...normalized,
        postCount: previous?.postCount || 0,
        lastSyncAt: previous?.lastSyncAt || 0,
        error: previous?.error || ''
      });
    }
    feed.friends = list;
    status.friendCount = list.length;
    await persistFeed();
    await persistStatus();
    return publicFriends();
  }

  async function friendList(query = {}) {
    if (!ready) throw new Error('QQ 空间管理服务尚未就绪');
    if (!feed.friends.length) await refreshFriends();
    const items = publicFriends(query.query || '');
    return {items, total: items.length, query: String(query.query || '').slice(0, 80), fetchedAt: iso(status.lastSyncAt)};
  }

  function list(query = {}) {
    if (!ready) throw new Error('QQ 空间管理服务尚未就绪');
    const offset = Math.max(0, Math.min(100000, Number(query.offset) || 0));
    const limit = Math.max(1, Math.min(MAX_FEED_PAGE, Number(query.limit) || 20));
    const friendId = String(query.friendId || '').trim();
    const text = String(query.query || '').trim().toLowerCase();
    let rows = feed.posts.filter(post => {
      if (friendId && post.friendId !== friendId) return false;
      if (!text) return true;
      return String(post.text || '').toLowerCase().includes(text)
        || String(post.userName || '').toLowerCase().includes(text)
        || String(post.friendName || '').toLowerCase().includes(text)
        || String(post.friendId || '').includes(text);
    });
    rows = rows.slice().sort((a, b) => query.order === 'asc' ? a.time - b.time : b.time - a.time);
    return {
      items: rows.slice(offset, offset + limit),
      total: rows.length,
      offset,
      limit,
      hasMore: offset + limit < rows.length,
      syncedAt: iso(feed.syncedAt),
      friendId
    };
  }

  async function sync({friendIds = [], reason = 'manual'} = {}) {
    if (syncPromise) return syncPromise;
    syncPromise = (async () => {
      const value = item();
      if (value.enabled !== true || value.uninstalled) throw new Error('QQ 空间插件未启用');
      const cfg = config();
      status.lastAttempt = now();
      status.syncInProgress = true;
      status.lastSyncError = '';
      status.syncDone = 0;
      status.syncTotal = 0;
      await persistStatus();
      try {
        await refreshFriends();
        const requested = new Set((Array.isArray(friendIds) ? friendIds : []).map(String));
        const allowed = Array.isArray(cfg.allowedTargets) ? cfg.allowedTargets : [];
        const all = (requested.size ? feed.friends.filter(friend => requested.has(friend.id)) : feed.friends)
          .filter(friend => !allowed.length || allowed.includes(friend.id));
        const batchLimit = Math.max(1, Math.min(200, Number(cfg.syncBatchFriends) || 10));
        let ordered = all;
        if (!requested.size && all.length > batchLimit) {
          const cursor = Math.max(0, Number(status.syncCursor) || 0) % all.length;
          ordered = [...all.slice(cursor), ...all.slice(0, cursor)];
        }
        const batch = ordered.slice(0, batchLimit);
        if (!requested.size) status.syncCursor = all.length ? ((Math.max(0, Number(status.syncCursor) || 0) + batch.length) % all.length) : 0;
        const perFriend = Math.max(1, Math.min(20, Number(cfg.postsPerFriend) || 5));
        status.syncTotal = batch.length;
        let newPosts = 0;
        let failed = 0;
        const index = new Map(feed.posts.map(post => [post.key, post]));
        for (const friend of batch) {
          try {
            takeRead();
            const rows = await backend.list(friend.id, perFriend, AbortSignal.timeout(20000), 0);
            const normalized = (Array.isArray(rows) ? rows : []).map(row => normalizePost(row, friend)).filter(Boolean);
            for (const post of normalized) {
              if (!index.has(post.key)) newPosts += 1;
              index.set(post.key, post);
            }
            friend.lastSyncAt = now();
            friend.error = '';
            status.lastSuccess = now();
            status.lastTarget = friend.id;
            status.lastFetched = normalized.length;
            status.totalFetched += normalized.length;
          } catch (error) {
            failed += 1;
            friend.error = String(error?.message || error).replace(/(?:cookie|token|key)=[^&\s]+/gi, '$1=[已隐藏]').slice(0, 200);
            status.lastSyncError = friend.error;
            if (/保护上限/.test(friend.error)) break;
          }
          status.syncDone += 1;
          await persistStatus();
          await sleep(200);
        }
        feed.posts = [...index.values()];
        applyRetention();
        feed.syncedAt = now();
        status.lastSyncAt = now();
        status.feedCount = feed.posts.length;
        await persistFeed();
        await persistStatus();
        log('info', 'QQ 空间同步完成', {reason, friends: batch.length, failed, newPosts, total: feed.posts.length});
        return {friends: batch.length, failed, newPosts, total: feed.posts.length, syncedAt: iso(feed.syncedAt)};
      } catch (error) {
        status.lastSyncError = String(error?.message || error).slice(0, 300);
        await persistStatus();
        throw error;
      } finally {
        status.syncInProgress = false;
        try { await persistStatus(); } catch { /* 状态写入失败不阻断释放同步锁 */ }
        syncPromise = null;
      }
    })();
    return syncPromise;
  }

  function applyRetention() {
    const cfg = config();
    if (cfg.retentionMode === 'days') {
      const cutoff = now() - Math.max(1, Number(cfg.retentionDays) || 365) * 86400000;
      feed.posts = feed.posts.filter(post => post.time >= cutoff);
    } else if (cfg.retentionMode === 'count') {
      const count = Math.max(1, Math.min(100000, Number(cfg.retentionCount) || 5000));
      feed.posts.sort((a, b) => b.time - a.time);
      feed.posts = feed.posts.slice(0, count);
    }
    const counts = feedCounts();
    for (const friend of feed.friends) friend.postCount = counts.get(friend.id) || 0;
  }

  async function image(url) {
    let parsed;
    try { parsed = new URL(String(url || '')); } catch { throw new Error('图片地址无效'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !IMAGE_HOSTS.test(parsed.hostname)) throw new Error('图片域名不在允许范围');
    const bytes = await safeDownload(parsed.href, {maxBytes: 5 * 1024 * 1024});
    const mime = mediaType(bytes);
    if (!/^image\/(png|jpeg|gif|webp)$/.test(mime)) throw new Error('资源不是支持的图片');
    return {bytes, mime};
  }

  async function avatar(id) {
    const target = String(id || '');
    if (!/^[1-9]\d{3,15}$/.test(target)) throw new Error('QQ 号无效');
    return image('https://q1.qlogo.cn/g?b=qq&nk=' + target + '&s=100');
  }

  function startScheduler() {
    if (timer) return;
    schedulerStopped = false;
    const tick = async () => {
      if (schedulerStopped) return;
      const cfg = config();
      if (!cfg.autoSync || syncPromise || item().enabled !== true) return;
      const interval = Math.max(2, Math.min(1440, Number(cfg.syncIntervalMinutes) || 15)) * 60000;
      if (now() - lastAuto < interval) return;
      lastAuto = now();
      try { await sync({reason: 'auto'}); }
      catch (error) { log('warn', 'QQ 空间自动同步失败：' + String(error?.message || error).slice(0, 160)); }
    };
    timer = setInterval(() => { void tick(); }, 60000);
    timer.unref?.();
    initialTimer = setTimeout(() => { void tick(); }, 5000);
    initialTimer.unref?.();
  }

  function stopScheduler() {
    schedulerStopped = true;
    if (timer) clearInterval(timer);
    if (initialTimer) clearTimeout(initialTimer);
    timer = null;
    initialTimer = null;
  }

  const api = {open, overview, friendList, refreshFriends, list, sync, image, avatar, startScheduler, stopScheduler, capabilities: () => overview().capabilities};
  return api;
}

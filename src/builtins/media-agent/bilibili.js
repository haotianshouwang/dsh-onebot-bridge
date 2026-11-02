import {plain, publicUrl} from '../web/network.js';

export function createBilibiliAdapter({read, browser} = {}) {
  return createBilibiliAdapterWithRead(read, browser);
}

function createBilibiliAdapterWithRead(read, browser) {
  return {
    id: 'bilibili',
    async status() {
      return {
        id: 'bilibili',
        label: 'B 站',
        state: typeof read === 'function' || browser ? 'ready' : 'unavailable',
        connected: !!(await browser?.status?.())?.connected,
        configured: typeof read === 'function' || !!browser,
        mode: browser ? 'public-read+dedicated-browser' : 'public-read',
        capabilities: ['search', 'video-info', ...(browser ? ['open', 'watch', 'snapshot', 'subtitles', 'comment', 'message', 'screenshot'] : [])],
        reason: browser ? '公开接口和专用浏览器已接入，账号外发能力仍需明确授权' : typeof read === 'function' ? '只读公开接口已接入，账号能力尚未接入' : '缺少安全网页读取器'
      };
    },
    async search({query, limit = 5, signal}) {
      if (typeof read !== 'function') throw new Error('B 站安全网页读取器不可用');
      const url = new URL('https://api.bilibili.com/x/web-interface/search/type');
      url.searchParams.set('search_type', 'video');
      url.searchParams.set('keyword', query);
      url.searchParams.set('page_size', String(limit));
      const payload = await read(publicUrl(url.href).href, {signal});
      const data = parseJson(payload.body);
      if (Number(data.code) !== 0) throw new Error(`B 站搜索失败：${String(data.message || data.code || '未知错误').slice(0, 120)}`);
      return {
        provider: 'bilibili-public-api',
        query,
        results: (data.data?.result || []).slice(0, limit).map(row => ({
          bvid: String(row.bvid || ''),
          title: plain(String(row.title || '')).slice(0, 240),
          author: String(row.author || '').slice(0, 80),
          url: row.arcurl ? safeUrl(row.arcurl) : `https://www.bilibili.com/video/${encodeURIComponent(String(row.bvid || ''))}`,
          duration: String(row.duration || '').slice(0, 20),
          play: Number(row.play) || 0,
          description: plain(String(row.description || '')).slice(0, 500)
        })).filter(row => row.bvid && row.url)
      };
    },
    async info({bvid, signal}) {
      if (typeof read !== 'function') throw new Error('B 站安全网页读取器不可用');
      const url = new URL('https://api.bilibili.com/x/web-interface/view');
      url.searchParams.set('bvid', bvid);
      const payload = await read(publicUrl(url.href).href, {signal});
      const data = parseJson(payload.body);
      if (Number(data.code) !== 0 || !data.data) throw new Error(`B 站视频信息读取失败：${String(data.message || data.code || '未知错误').slice(0, 120)}`);
      const row = data.data;
      return {
        bvid: String(row.bvid || bvid),
        aid: Number(row.aid) || 0,
        title: plain(String(row.title || '')).slice(0, 240),
        author: String(row.owner?.name || '').slice(0, 80),
        url: `https://www.bilibili.com/video/${encodeURIComponent(String(row.bvid || bvid))}`,
        description: plain(String(row.desc || '')).slice(0, 2000),
        durationSeconds: Number(row.duration) || 0,
        publishedAt: Number(row.pubdate) > 0 ? new Date(Number(row.pubdate) * 1000).toISOString() : null,
        stats: {
          view: Number(row.stat?.view) || 0,
          like: Number(row.stat?.like) || 0,
          coin: Number(row.stat?.coin) || 0,
          favorite: Number(row.stat?.favorite) || 0,
          comment: Number(row.stat?.reply) || 0
        }
      };
    },
    async start({id, seconds = 30, signal} = {}) {
      if (!browser) throw new Error('B 站专用浏览器服务不可用，未执行任何账号操作');
      const url = `https://www.bilibili.com/video/${encodeURIComponent(String(id || ''))}`;
      await browser.open('bilibili', url);
      return browser.watch('bilibili', {seconds, signal});
    },
    async open({id}) {
      if (!browser) throw new Error('B 站专用浏览器服务不可用');
      return browser.open('bilibili', `https://www.bilibili.com/video/${encodeURIComponent(String(id || ''))}`);
    },
    async current() {
      if (!browser) throw new Error('B 站专用浏览器服务不可用');
      return browser.snapshot('bilibili');
    },
    async screenshot() {
      if (!browser) throw new Error('B 站专用浏览器服务不可用');
      return browser.screenshot('bilibili');
    },
    async subtitles() {
      if (!browser) throw new Error('B 站专用浏览器服务不可用');
      return browser.subtitles('bilibili');
    },
    async comment({content}) {
      if (!browser) throw new Error('B 站专用浏览器服务不可用');
      return browser.comment('bilibili', content);
    },
    async openContact({contactId}) {
      if (!browser) throw new Error('B 站专用浏览器服务不可用');
      return browser.openContact('bilibili', contactId);
    },
    async message({contactId, content}) {
      if (!browser) throw new Error('B 站专用浏览器服务不可用');
      return browser.message('bilibili', {contactId, content});
    },
    async close() { await browser?.close?.(); }
  };
}

function parseJson(body) {
  try {
    return JSON.parse(String(body));
  } catch {
    throw new Error('B 站接口返回的不是合法 JSON');
  }
}

function safeUrl(value) {
  try {
    return publicUrl(String(value)).href;
  } catch {
    return '';
  }
}

export function createDouyinAdapter({browser} = {}) {
  if (browser) return createBrowserAdapter(browser);
  return createUnavailableAdapter('douyin', '抖音');
}

function createBrowserAdapter(browser) {
  return {
    id: 'douyin',
    async status() {
      const state = await browser.status();
      return {id: 'douyin', label: '抖音', state: state.state === 'closed' ? 'ready' : state.state, connected: state.connected, configured: true, mode: 'dedicated-browser', capabilities: ['open', 'watch', 'snapshot', 'video-info', 'subtitles', 'comment', 'message', 'screenshot'], reason: '使用专用 Edge profile，页面读取和播放进度受边界限制'};
    },
    async start({id, url, seconds = 30, signal} = {}) {
      const target = url || `https://www.douyin.com/video/${encodeURIComponent(String(id || ''))}`;
      await browser.open('douyin', target);
      return browser.watch('douyin', {seconds, signal});
    },
    async open({url, id} = {}) {
      return browser.open('douyin', url || `https://www.douyin.com/video/${encodeURIComponent(String(id || ''))}`);
    },
    async current() { return browser.snapshot('douyin'); },
    async info() {
      const page = await browser.snapshot('douyin');
      return {platform: 'douyin', title: page.title, url: page.url, text: page.text, video: page.video, loginRequired: page.loginRequired, observedAt: page.observedAt};
    },
    async subtitles() { return browser.subtitles('douyin'); },
    async comment({content}) { return browser.comment('douyin', content); },
    async openContact({contactId}) { return browser.openContact('douyin', contactId); },
    async message({contactId, content}) { return browser.message('douyin', {contactId, content}); },
    async screenshot() { return browser.screenshot('douyin'); },
    async close() { await browser.close(); }
  };
}

function createUnavailableAdapter(id, label) {
  return {
    id,
    async status() {
      return {
        id,
        label,
        state: 'requires-browser',
        connected: false,
        configured: false,
        capabilities: [],
        reason: '抖音适配器需要专用 Edge/Playwright 服务和登录资料，当前宿主尚未提供该能力'
      };
    },
    async start() {
      throw new Error('抖音浏览器服务尚未接入，未执行任何账号操作');
    },
    async close() {}
  };
}

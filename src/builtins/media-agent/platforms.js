import {createBilibiliAdapter} from './bilibili.js';
import {createDouyinAdapter} from './douyin.js';

export function createMediaPlatformRegistry({read, browser} = {}) {
  const adapters = new Map([
    ['bilibili', createBilibiliAdapter({read, browser})],
    ['douyin', createDouyinAdapter({browser})]
  ]);
  return {
    get(id) {
      return adapters.get(id) || null;
    },
    async status() {
      return Promise.all([...adapters.values()].map(adapter => adapter.status()));
    },
    async close() {
      await Promise.all([...adapters.values()].map(adapter => adapter.close()));
    }
  };
}

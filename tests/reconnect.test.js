import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket, {WebSocketServer} from 'ws';
import {once} from 'node:events';
import {OneBot} from '../src/onebot/index.js';
import {defaults} from '../src/host/store.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('OneBot 断线把未完成请求标记结果未知，并在重连后重新握手', async t => {
  const server = new WebSocketServer({port: 0});
  await once(server, 'listening');
  const port = server.address().port;
  server.on('connection', ws => {
    ws.on('message', buffer => {
      const request = JSON.parse(buffer.toString());
      if (request.action === 'send_group_msg') return; // 故意不回执，模拟断线时结果未知
      const data = request.action === 'get_login_info' ? {user_id: 10000002, nickname: '机器人'}
        : request.action === 'get_status' ? {online: true, good: true}
          : request.action === 'get_version_info' ? {app_name: 'NapCat'}
            : {yes: true};
      ws.send(JSON.stringify({echo: request.echo, status: 'ok', retcode: 0, data}));
    });
  });
  const bot = new OneBot({...defaults().settings, url: 'ws://127.0.0.1:' + port}, '');
  t.after(async () => {
    await bot.stop();
    await new Promise(resolve => server.close(resolve));
  });

  const firstReady = once(bot, 'ready');
  await bot.start();
  await firstReady;

  // 网关收到请求但不回复：断线时这条请求的结果必须变成 unknown，而不是失败或成功。
  const pending = bot.request('send_group_msg', {group_id: 1, message: []}, 5000);
  await delay(50);
  for (const ws of server.clients) ws.terminate();
  await assert.rejects(pending, error => error.code === 'UNKNOWN_OUTCOME');
  assert.equal(bot.status.state, 'disconnected');

  // 正向连接按退避重连；重连成功后重新走 get_login_info/get_status 握手。
  let timer;
  const reconnected = await Promise.race([
    once(bot, 'ready').then(() => true),
    new Promise(resolve => { timer = setTimeout(() => resolve(false), 8000); timer.unref?.(); })
  ]);
  clearTimeout(timer);
  assert.equal(reconnected, true);
  assert.equal(bot.status.state, 'connected');
  assert.equal((await bot.call('get_status')).online, true);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {QQQrConnector, QR_STATES} from '../src/builtins/qq-official/qr-connector.js';
import {selectQrCredentials} from '../src/builtins/qq-official/index.js';

function fakeSdk() {
  let callbacks;
  let stopped = 0;
  return {
    module: {
      startQrConnect(value) {
        callbacks = value;
        return () => { stopped += 1; };
      }
    },
    callbacks: () => callbacks,
    stopped: () => stopped
  };
}

test('QQ 二维码会话展示二维码并处理扫码成功', async () => {
  const sdk = fakeSdk();
  let success;
  const connector = new QQQrConnector({sdkLoader: async () => sdk.module, onSuccess: async value => { success = value; }});
  await connector.start();
  sdk.callbacks().onQrDisplayed('https://q.qq.com/connect/task-1');
  assert.equal(connector.snapshot().state, QR_STATES.WAITING_SCAN);
  sdk.callbacks().onSuccess([{appId: '1001', appSecret: 'secret-1'}]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(connector.snapshot().state, QR_STATES.AUTHENTICATED);
  assert.equal(success[0].appId, '1001');
  assert.equal(sdk.stopped(), 1);
});

test('QQ 二维码会话拒绝重复启动并支持取消', async () => {
  const sdk = fakeSdk();
  const connector = new QQQrConnector({sdkLoader: async () => sdk.module});
  await connector.start();
  await assert.rejects(() => connector.start(), /已有 QQ 二维码登录会话正在运行/);
  const status = connector.cancel();
  assert.equal(status.state, QR_STATES.CANCELLED);
  assert.equal(sdk.stopped(), 1);
});

test('QQ 二维码会话处理过期和失败', async () => {
  const sdk = fakeSdk();
  const connector = new QQQrConnector({sdkLoader: async () => sdk.module});
  await connector.start();
  sdk.callbacks().onQrExpired();
  assert.equal(connector.snapshot().state, QR_STATES.EXPIRED);
  sdk.callbacks().onFailure(new Error('网络错误'));
  assert.equal(connector.snapshot().state, QR_STATES.FAILED);
  assert.equal(connector.snapshot().error, '网络错误');
});

test('SDK 缺失时返回可操作错误', async () => {
  const connector = new QQQrConnector({sdkLoader: async () => { throw new Error('Cannot find package'); }});
  await assert.rejects(() => connector.start(), /Cannot find package/);
  assert.equal(connector.snapshot().state, QR_STATES.FAILED);
});

test('扫码凭据遍历后只接受有效 AppID 和 AppSecret', () => {
  assert.deepEqual(selectQrCredentials([{appId: '', appSecret: 'bad'}, {appId: '1002', appSecret: 'secret-2'}]), {appId: '1002', clientSecret: 'secret-2'});
  assert.throws(() => selectQrCredentials([{appId: '1002', appSecret: ''}]), /未返回有效/);
  assert.throws(() => selectQrCredentials(null), /格式无效/);
});

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
  sdk.callbacks().onFailure(new Error('internal-secret-marker'));
  assert.equal(connector.snapshot().state, QR_STATES.FAILED);
  assert.match(connector.snapshot().error, /请检查 SDK/);
  assert.doesNotMatch(connector.snapshot().error, /internal-secret-marker/);
});

test('SDK 缺失时返回可操作错误', async () => {
  const connector = new QQQrConnector({sdkLoader: async () => { throw Object.assign(new Error('package loader trace'), {code:'ERR_MODULE_NOT_FOUND'}); }});
  await assert.rejects(() => connector.start(), /未安装可选的 QQ 二维码 SDK/);
  assert.equal(connector.snapshot().state, QR_STATES.FAILED);
});

test('扫码凭据遍历后只接受有效 AppID 和 AppSecret', () => {
  assert.deepEqual(selectQrCredentials([{appId: '', appSecret: 'bad'}, {appId: '1002', appSecret: 'secret-2'}]), {appId: '1002', clientSecret: 'secret-2'});
  assert.throws(() => selectQrCredentials([{appId: '1002', appSecret: ''}]), /未返回有效/);
  assert.throws(() => selectQrCredentials(null), /格式无效/);
});

test('扫码等待业务连接确认，取消后不采信旧任务完成回调', async () => {
  const sdk = fakeSdk();
  const gate = Promise.withResolvers();
  const connector = new QQQrConnector({sdkLoader: async () => sdk.module, onSuccess: () => gate.promise});
  await connector.start();
  sdk.callbacks().onSuccess([{appId: '1001', appSecret: 'dummy'}]);
  assert.equal(connector.snapshot().state, QR_STATES.SCANNED);
  assert.equal(connector.snapshot().running, true);
  connector.cancel();
  gate.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(connector.snapshot().state, QR_STATES.CANCELLED);
});

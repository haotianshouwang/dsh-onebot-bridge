import test from 'node:test';
import assert from 'node:assert/strict';
import {ResourceMonitor, networkDelta} from '../src/host/resource-monitor.js';

test('网卡首次采样、重置和新增网卡不会生成伪造速率', () => {
  const first = [{name: 'physical', receivedBytes: 100, sentBytes: 200}];
  assert.equal(networkDelta(null, first, 1000)[0].receivePerSecond, null);
  assert.equal(networkDelta(first, [{...first[0], receivedBytes: 500}], 2000)[0].receivePerSecond, 200);
  assert.equal(networkDelta(first, [{...first[0], receivedBytes: 20}], 2000)[0].receivePerSecond, null);
  assert.equal(networkDelta(first, [{name: 'new', receivedBytes: 500, sentBytes: 100}], 2000)[0].sendPerSecond, null);
});

test('网卡失败显式标记不可用，恢复时使用实际采样间隔', async () => {
  let now = 1000;
  let fail = false;
  let receivedBytes = 100;
  const monitor = new ResourceMonitor({now: () => now, network: async () => {
    if (fail) throw new Error('os failed');
    return [{name: 'physical', receivedBytes, sentBytes: 100}];
  }});
  await monitor.sampleNetwork();
  assert.equal(monitor.snapshot().network.interfaces[0].receivePerSecond, null);
  fail = true;
  now = 2000;
  await monitor.sampleNetwork();
  assert.equal(monitor.snapshot().network.available, false);
  fail = false;
  receivedBytes = 500;
  now = 3000;
  await monitor.sampleNetwork();
  assert.equal(monitor.snapshot().network.interfaces[0].receivePerSecond, 200);
  monitor.stop();
});

test('停用后延迟网卡响应不会重新更新监控', async () => {
  let release;
  const monitor = new ResourceMonitor({network: () => new Promise(resolve => { release = resolve; })});
  const request = monitor.sampleNetwork();
  monitor.stop();
  release([{name: 'physical', receivedBytes: 500, sentBytes: 100}]);
  await request;
  assert.equal(monitor.snapshot().network.available, false);
});

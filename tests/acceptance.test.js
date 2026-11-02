import test from 'node:test';
import assert from 'node:assert/strict';
import {CHECKS, STATUSES, createRun, recordResult, renderReport, summarize} from '../scripts/acceptance.mjs';

test('验收清单覆盖协议、消息、媒体、资料、重启与主动联系', () => {
  const ids = CHECKS.map(check => check.id);
  for (const required of ['ws-connect', 'ws-reconnect', 'private-text', 'group-text', 'image-recv', 'image-send', 'voice-recv', 'voice-send', 'file-recv', 'file-send', 'recall', 'group-info', 'request-approve', 'restart-recovery']) {
    assert.ok(ids.includes(required), '缺少检查项 ' + required);
  }
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual([...STATUSES], ['unit-pass', 'mock-pass', 'real-pass', 'real-fail', 'untested', 'blocked']);
});

test('新运行所有检查项都是 untested，且不能被直接写成已验收', () => {
  const run = createRun(Date.UTC(2026, 10, 1, 3, 0, 0));
  assert.match(run.id, /^acc-\d{8}T\d{6}$/);
  assert.equal(Object.keys(run.results).length, CHECKS.length);
  assert.ok(Object.values(run.results).every(row => row.status === 'untested'));
  assert.deepEqual(summarize(run), {'unit-pass': 0, 'mock-pass': 0, 'real-pass': 0, 'real-fail': 0, untested: CHECKS.length, blocked: 0});
});

test('real-pass 必须有证据，真实账号类检查项还必须有账号', () => {
  const run = createRun();
  assert.throws(() => recordResult(run, 'private-text', {status: 'real-pass', account: '12345678'}), /证据/);
  assert.throws(() => recordResult(run, 'private-text', {status: 'real-pass', evidence: '截图'}), /账号/);
  const ok = recordResult(run, 'private-text', {status: 'real-pass', account: '12345678', evidence: '截图: evidence/private.png; message_id=123'});
  assert.equal(ok.results['private-text'].status, 'real-pass');
  assert.equal(ok.results['private-text'].account, '12345678');
});

test('非法状态、未知检查项被拒绝，原记录不被修改', () => {
  const run = createRun();
  assert.throws(() => recordResult(run, 'private-text', {status: 'done'}), /状态无效/);
  assert.throws(() => recordResult(run, 'not-a-check', {status: 'blocked'}), /未知检查项/);
  assert.equal(run.results['private-text'].status, 'untested');
});

test('blocked 与 untested 可以记录说明，报告保留原文并提示证据要求', () => {
  let run = createRun();
  run = recordResult(run, 'voice-send', {status: 'blocked', note: '受限环境 SAPI 0x80045040'});
  run = recordResult(run, 'image-send', {status: 'mock-pass', note: '曾真实提交一次 message_id=1991601745，未确认对端显示'});
  const report = renderReport(run);
  assert.match(report, /voice-send/);
  assert.match(report, /0x80045040/);
  assert.match(report, /1991601745/);
  assert.match(report, /real-pass/);
  assert.match(report, /必须同时有账号和证据/);
});

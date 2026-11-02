import test from 'node:test';
import assert from 'node:assert/strict';
import {capabilityContext} from '../src/session/capability-context.js';

test('能力说明逐轮读取真实权限，区分未注册、范围不开放和可用', () => {
  const definitions = new Map([['plugin.qq-tts.speak', {id: 'plugin.qq-tts.speak'}], ['qq.task.create', {id: 'qq.task.create'}]]);
  let voiceAllowed = false;
  const permissions = {decision: cap => cap.id === 'plugin.qq-tts.speak' && !voiceAllowed ? '此插件未对当前聊天开放' : null};
  const options = {actions: {definitions}, permissions, context: {}, now: 0};
  const first = capabilityContext(options);
  assert.match(first, /语音：功能已注册，但本轮不可用/);
  assert.match(first, /定时提醒：本轮可用/);
  assert.match(first, /表情表达：当前未注册/);
  voiceAllowed = true;
  assert.match(capabilityContext(options), /语音：本轮可用/);
  assert.match(first, /1970-01-01T00:00:00.000Z/);
});

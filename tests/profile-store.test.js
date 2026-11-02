import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProfileStore } from '../src/session/profile-store.js';

test('人物画像跨聊天共享昵称、偏好和边界，但不保存私聊原文或秘密', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qq-profile-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const profiles = await new ProfileStore(dir).open();
  profiles.observe({ user: '10001', sender: '小鱼', kind: 'private', peer: '10001', bot: '20001', owner: '10001', messageId: 'p1', text: '我叫小鱼' });
  profiles.observe({ user: '10001', sender: '小鱼', kind: 'group', peer: '30001', bot: '20001', owner: '10001', messageId: 'g1', text: '我喜欢猫' });
  profiles.observe({ user: '10001', sender: '小鱼', kind: 'private', peer: '10001', bot: '20001', owner: '10001', messageId: 'p2', text: '我的密码是 secret-value' });
  const row = profiles.public('10001');
  assert.equal(row.relationship, 'owner');
  assert.equal(row.canonicalName, '小鱼');
  assert.deepEqual(row.preferences, ['猫']);
  assert.equal(JSON.stringify(row).includes('secret-value'), false);
  assert.equal(JSON.stringify(row).includes('我的密码'), false);
  const context = profiles.context({ actor: '10001', kind: 'group', peer: '30001', owner: '10001', bot: '20001' });
  assert.match(context, /共享人物画像/);
  assert.match(context, /小鱼/);
  assert.match(context, /私聊原文不在这里注入/);
  await profiles.persist();
  const reopened = await new ProfileStore(dir).open();
  assert.equal(reopened.public('10001').preferences[0], '猫');
});

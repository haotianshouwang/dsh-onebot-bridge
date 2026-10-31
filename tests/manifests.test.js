import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {manifest as sticker} from '../src/builtins/sticker/index.js';
import {manifest as qzone} from '../src/builtins/qzone/index.js';
import {manifest as memory} from '../src/builtins/memory/index.js';
import {manifest as autonomy} from '../src/builtins/autonomy/index.js';
import {validatePackageMetadata, PACKAGE_API_VERSION} from '../src/core/package-model.js';

const root = path.dirname(fileURLToPath(import.meta.url));

test('四个源码插件都有同步的 manifest.json 镜像', async () => {
  for (const manifest of [sticker, qzone, memory, autonomy]) {
    const file = path.join(root, '..', manifest.entry.replace(/index\.js$/, 'manifest.json'));
    const json = JSON.parse(await readFile(file, 'utf8'));
    const expected = JSON.parse(JSON.stringify({
      ...manifest,
      apiVersion: PACKAGE_API_VERSION,
      type: 'native-source',
      permissions: [...(manifest.capabilities || [])]
    }));
    assert.deepEqual(json, expected, `${manifest.id} 的 manifest.json 已漂移，请运行 npm run sync:manifests`);
    assert.equal(json.apiVersion, 2);
    assert.equal(json.type, 'native-source');
    assert.ok(json.entry.startsWith('src/builtins/'));
    assert.ok(json.permissions.includes('actions'));
    validatePackageMetadata(json);
  }
});

test('统一清单校验拒绝错误的 apiVersion、类型和越界入口', () => {
  const base = {...sticker, id: 'qq-manifest-test', name: '清单测试', version: '1.0.0'};
  assert.throws(() => validatePackageMetadata({...base, apiVersion: 1}), /apiVersion/);
  assert.throws(() => validatePackageMetadata({...base, type: 'binary'}), /type/);
  assert.throws(() => validatePackageMetadata({...base, entry: '../outside.js'}), /entry/);
  assert.throws(() => validatePackageMetadata({...base, permissions: ['ok', 'Bad Permission!']}), /permissions/);
  assert.doesNotThrow(() => validatePackageMetadata({...base, apiVersion: 2, type: 'native-source', entry: 'src/builtins/sticker/index.js', permissions: ['actions', 'resources']}));
});

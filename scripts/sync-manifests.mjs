// 把源码插件的 manifest 导出同步为 JSON 镜像，供工具、文档和市场校验使用。
// 运行时仍以 index.js 导出的 manifest 为准；tests/manifests.test.js 会检查两份没有漂移。
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {manifest as sticker} from '../src/builtins/sticker/index.js';
import {manifest as qzone} from '../src/builtins/qzone/index.js';
import {manifest as memory} from '../src/builtins/memory/index.js';
import {manifest as autonomy} from '../src/builtins/autonomy/index.js';
import {manifest as emotion} from '../src/builtins/emotion/index.js';
import {manifest as mediaAgent} from '../src/builtins/media-agent/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const manifest of [sticker, qzone, memory, autonomy, emotion, mediaAgent]) {
  const file = path.join(root, manifest.entry.replace('src/builtins/', 'src/builtins/').replace('index.js', 'manifest.json'));
  const payload = {
    ...manifest,
    apiVersion: 2,
    type: 'native-source',
    permissions: [...(manifest.capabilities || [])]
  };
  await writeFile(file, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  console.log('已写入', path.relative(root, file));
}

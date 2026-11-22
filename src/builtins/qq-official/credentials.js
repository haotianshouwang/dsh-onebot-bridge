import {randomBytes} from 'node:crypto';
import {seal, unseal} from '../../core/sealed-data.js';

export const APP_ID_REF = 'DSH_QQ_OFFICIAL_APP_ID';
export const CLIENT_SECRET_REF = 'DSH_QQ_OFFICIAL_CLIENT_SECRET';
const KEY_REF = 'DSH_QQ_OFFICIAL_DEVICE_KEY';
const aad = Buffer.from('night-watch/qq-official/credentials/v1');

// Store a single authenticated pair; never put its key in the plugin store or a settings snapshot.
export function officialCredentials(storage, credentials) {
  async function key(create) {
    const saved = (await credentials.resolve(KEY_REF))?.value;
    if (saved) {
      const bytes = Buffer.from(saved, 'base64url');
      if (bytes.length === 32 && bytes.toString('base64url') === saved) return bytes;
    } else if (create) {
      const bytes = randomBytes(32);
      await credentials.set(KEY_REF, bytes.toString('base64url'));
      return bytes;
    }
    throw new Error('官方机器人凭据密钥不可用');
  }
  async function removeLegacy() {
    for (const ref of [CLIENT_SECRET_REF, APP_ID_REF]) {
      if ((await credentials.resolve(ref))?.source === 'file') await credentials.unset(ref);
    }
  }
  return {
    async read() {
      const box = storage.get()?.credentialBox;
      if (box) {
        try { return JSON.parse(unseal(box, await key(false), aad).toString('utf8')); }
        catch { throw new Error('无法解密官方机器人凭据，请恢复设备密钥或清除后重新绑定'); }
      }
      // Backwards compatible with managed refs and administrator-provided environment variables.
      return {appId: (await credentials.resolve(APP_ID_REF))?.value || process.env.DSH_QQ_OFFICIAL_APP_ID || process.env.QQBOT_APP_ID || '',
        clientSecret: (await credentials.resolve(CLIENT_SECRET_REF))?.value || process.env.DSH_QQ_OFFICIAL_CLIENT_SECRET || process.env.QQBOT_APP_SECRET || ''};
    },
    async write(pair, signal) {
      if (pair) {
        const bytes = await key(!storage.get()?.credentialBox);
        const credentialBox = seal(Buffer.from(JSON.stringify(pair)), bytes, aad);
        signal.throwIfAborted();
        await storage.update(data => ({...data, credentialBox}));
        await removeLegacy();
      } else {
        await removeLegacy();
        signal.throwIfAborted();
        await storage.update(({credentialBox, ...rest}) => rest);
      }
    }
  };
}

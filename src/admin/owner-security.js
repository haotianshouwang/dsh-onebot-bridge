// Only called by the exact owner-authenticated DSH route; never registered on the web action dispatcher.
import {randomBytes} from 'node:crypto';
import QRCode from 'qrcode';
import {AdminAuth} from '../web/admin-auth.js';
const ref = 'QQBOT_ADMIN_MFA_DEVICE_KEY';
export async function ownerSecurity(dir, credentials, onSessionEnd) {
  const deviceKey = async create => {
    const saved = (await credentials.resolve(ref))?.value;
    if (saved) { const key = Buffer.from(saved,'base64url'); if (key.length === 32 && key.toString('base64url') === saved) return key; }
    if (saved || !create) throw new Error('管理凭据密钥不可用');
    const key = randomBytes(32); await credentials.set(ref,key.toString('base64url')); return key;
  };
  const auth = await new AdminAuth(dir,{deviceKey,onSessionEnd}).open();
  async function invoke(body) {
    if (body.op === 'setup') { await auth.setPassword(body.password); return auth.status(); }
    if (body.op === 'begin') {
      const secret = await auth.beginEnrollment();
      const uri = `otpauth://totp/Night%20Watch:Admin?secret=${secret}&issuer=Night%20Watch&digits=6&period=30`;
      return {secret,qr:await QRCode.toDataURL(uri,{width:192,margin:4})};
    }
    if (body.op === 'confirm') return {codes:await auth.confirmEnrollment(body.code)};
    if (body.op === 'cancel') { await auth.serial(() => auth.clearPending()); return {}; }
    if (body.op === 'revoke') { await auth.serial(() => auth.revokeAll()); await auth.audit({outcome:'owner-revoked-sessions'}); return {}; }
    throw new Error('不支持的网页安全操作');
  }
  return {auth,invoke};
}

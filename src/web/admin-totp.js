// RFC 4226/6238. SHA-1 is the authenticator interoperability profile, not the password KDF.
import {createHmac, createHash, timingSafeEqual} from 'node:crypto';
import {seal as sealData, unseal as unsealData} from '../core/sealed-data.js';
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(bytes) {
  let bits = 0, value = 0, result = '';
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { bits -= 5; result += alphabet[(value >>> bits) & 31]; }
  }
  return result + (bits ? alphabet[(value << (5 - bits)) & 31] : '');
}
export function totp(seed, counter) {
  const message = Buffer.alloc(8); message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', seed).update(message).digest();
  return String((mac.readUInt32BE(mac.at(-1) & 15) & 0x7fffffff) % 1000000).padStart(6, '0');
}
export function matchCounter(seed, code, last, now) {
  if (!/^\d{6}$/.test(code)) return null;
  const current = Math.floor(now / 30000);
  for (const n of [current, current - 1, current + 1]) {
    if (n >= 0 && n > last && timingSafeEqual(Buffer.from(totp(seed, n)), Buffer.from(code))) return n;
  }
  return null;
}
const aad = Buffer.from('night-watch/admin/totp/v1');
export const seal = (seed, key) => sealData(seed, key, aad);
export const unseal = (box, key) => unsealData(box, key, aad);
export function recoveryHash(text) { return createHash('sha256').update('night-watch/recovery/v1:' + text.trim().toLowerCase()).digest('hex'); }

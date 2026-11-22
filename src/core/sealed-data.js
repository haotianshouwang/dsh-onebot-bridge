import {createCipheriv, createDecipheriv, randomBytes} from 'node:crypto';

export function seal(seed, key, aad) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(seed), cipher.final()]);
  return {iv: iv.toString('base64'), body: body.toString('base64'), tag: cipher.getAuthTag().toString('base64')};
}
export function unseal(box, key, aad) {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
  decipher.setAAD(aad); decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(box.body, 'base64')), decipher.final()]);
}

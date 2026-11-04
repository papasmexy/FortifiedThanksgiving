import { randomBytes, scrypt, timingSafeEqual, createHmac, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';
const derive = promisify(scrypt);
export const token = () => randomBytes(24).toString('base64url');
export const digest = (key, purpose, value) => createHmac('sha256', key).update(purpose + ':' + value).digest('hex');
export function equal(a, b) { const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || '')); return x.length === y.length && timingSafeEqual(x, y); }
export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 14 || Buffer.byteLength(password) > 256) throw Object.assign(new Error('Use an administrator password of 14–128 characters.'), { status: 400 });
  if (password.length > 128) throw Object.assign(new Error('Use an administrator password of 14–128 characters.'), { status: 400 });
  const salt = randomBytes(16).toString('hex');
  const key = await derive(password, salt, 32, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
  return 's1:' + salt + ':' + key.toString('hex');
}
export async function checkPassword(password, stored) {
  if (typeof password !== 'string' || password.length > 128 || Buffer.byteLength(password) > 256) return false;
  const [, salt, expected] = stored.split(':');
  const key = await derive(password, salt, 32, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
  return equal(key.toString('hex'), expected);
}
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function totpSecret() { return Array.from(randomBytes(32), b => alphabet[b & 31]).join(''); }
function decodeBase32(text) {
  let bits = 0, value = 0; const out = [];
  for (const c of text) { value = (value << 5) | alphabet.indexOf(c); bits += 5; if (bits >= 8) { bits -= 8; out.push((value >>> bits) & 255); } }
  return Buffer.from(out);
}
export function totp(secret, step = Math.floor(Date.now() / 30000)) {
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', decodeBase32(secret)).update(counter).digest(); const offset = h[19] & 15;
  return String((h.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}
export function verifyTotp(secret, code, lastStep = -1, now = Date.now()) {
  if (!/^\d{6}$/.test(String(code || ''))) return null;
  const step = Math.floor(now / 30000);
  for (const n of [step, step - 1, step + 1]) if (n > lastStep && equal(totp(secret, n), code)) return n;
  return null;
}
export function seal(secret, key) {
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(key).digest(), iv);
  return [iv.toString('base64url'), Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]).toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
}
export function unseal(value, key) {
  const [iv, body, tag] = value.split('.'); const cipher = createDecipheriv('aes-256-gcm', createHash('sha256').update(key).digest(), Buffer.from(iv, 'base64url'));
  cipher.setAuthTag(Buffer.from(tag, 'base64url')); return Buffer.concat([cipher.update(Buffer.from(body, 'base64url')), cipher.final()]).toString('utf8');
}
export function fullName(value) {
  if (typeof value !== 'string') throw Object.assign(new Error('Enter your full name.'), { status: 400 });
  const name = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (name.length < 2 || name.length > 100 || /[\p{Cc}\p{Cf}]/u.test(name) || !/\p{L}/u.test(name)) throw Object.assign(new Error('Enter a name of 2–100 characters without invisible control characters.'), { status: 400 });
  return { name, normalized: name.toLocaleLowerCase('en-US') };
}
export function roomCode(value) {
  if (typeof value !== 'string') return '';
  return value.normalize('NFKC').trim().toUpperCase();
}

import { scryptSync, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';
import { db, getSetting, setSetting } from './db.js';

export function hashPassword(pw) {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(pw, salt, 64).toString('hex')}`;
}
export function verifyPassword(pw, stored) {
  const [saltHex, hashHex] = stored.split(':');
  const hash = Buffer.from(hashHex, 'hex');
  const test = scryptSync(pw, Buffer.from(saltHex, 'hex'), 64);
  return hash.length === test.length && timingSafeEqual(hash, test);
}

function secret() {
  let s = getSetting('session_secret');
  if (!s) { s = randomBytes(32).toString('hex'); setSetting('session_secret', s); }
  return s;
}
const sign = (payload) => createHmac('sha256', secret()).update(payload).digest('base64url');

const TTL_MS = 12 * 3600 * 1000;
export function makeToken(userId) {
  const payload = `${userId}.${Date.now() + TTL_MS}`;
  return `${payload}.${sign(payload)}`;
}
export function readToken(token) {
  if (!token) return null;
  const [uid, exp, sig] = token.split('.');
  if (!uid || !exp || !sig) return null;
  const expected = sign(`${uid}.${exp}`);
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b) || Number(exp) < Date.now()) return null;
  return db.prepare('SELECT id,name,username,role FROM users WHERE id=? AND active=1').get(Number(uid)) ?? null;
}

// Role matrix: what each role may do
const CAN = {
  owner: ['*'],
  accountant: ['view', 'sales', 'purchases', 'cashbook', 'parties', 'products', 'reports', 'settings_basic'],
  cashier: ['view', 'sales', 'cashbook_add', 'products_view'],
};
export const can = (user, perm) => !!user && (CAN[user.role].includes('*') || CAN[user.role].includes(perm));

// Shared request helpers (validation, errors, permissions, cashbook writes).
import { db, r2, getSetting, MODES } from './db.js';
import { can } from './auth.js';

export class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
export const bad = (msg) => new HttpError(400, msg);
export const iso = /^\d{4}-\d{2}-\d{2}$/;
export const num = (v, name, { min = 0, allowZero = true } = {}) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || (!allowZero && n === 0)) throw bad(`${name} must be a valid number`);
  return n;
};
export const date = (v, name = 'Date') => { if (!iso.test(v ?? '') || Number.isNaN(Date.parse(v))) throw bad(`${name} must be a valid date (YYYY-MM-DD)`); return v; };
export const str = (v, max = 200) => (v == null || v === '' ? null : String(v).trim().slice(0, max));
export const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
export const vatRate = () => Number(getSetting('vat_rate', '0.15'));
export const modeOk = (m) => { if (!MODES.includes(m)) throw bad('Choose a valid payment mode'); return m; };

export const need = (perm) => (req, res, next) => {
  if (!req.user) return next(new HttpError(401, 'Please sign in'));
  if (!can(req.user, perm)) return next(new HttpError(403, 'Your role does not allow this'));
  next();
};

export async function cashEntry(o, user) {
  const r = await db.prepare(`INSERT INTO cashbook(date,ref,description,party,category,mode,receipt,payment,notes,customer_id,supplier_id,sale_id,purchase_id,return_id,created_by)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(o.date, o.ref ?? null, o.description ?? null, o.party ?? null, o.category, o.mode ?? 'Cash',
    r2(o.receipt ?? 0), r2(o.payment ?? 0), o.notes ?? null, o.customer_id ?? null, o.supplier_id ?? null, o.sale_id ?? null, o.purchase_id ?? null, o.return_id ?? null, user?.id ?? null);
  return Number(r.lastInsertRowid);
}

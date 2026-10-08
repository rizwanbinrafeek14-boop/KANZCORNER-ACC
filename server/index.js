import express from 'express';
import QRCode from 'qrcode';
import { db, tx, r2, claimOnce, getSetting, setSetting, allSettings, nextInvoiceNumber, audit, CATEGORIES, MODES, CAT_CUSTOMER_PAYMENT, CAT_SUPPLIER_PAYMENT, CAT_SALES, CAT_PURCHASE } from './db.js';
import { hashPassword, verifyPassword, makeToken, readToken, can } from './auth.js';
import { cashPosition, customerLedger, supplierLedger, yearReport, dashboard } from './ledger.js';

export const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY',
  });
  next();
});

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const bad = (msg) => new HttpError(400, msg);
const iso = /^\d{4}-\d{2}-\d{2}$/;
const num = (v, name, { min = 0, allowZero = true } = {}) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || (!allowZero && n === 0)) throw bad(`${name} must be a valid number`);
  return n;
};
const date = (v, name = 'Date') => { if (!iso.test(v ?? '') || Number.isNaN(Date.parse(v))) throw bad(`${name} must be a valid date (YYYY-MM-DD)`); return v; };
const str = (v, max = 200) => (v == null || v === '' ? null : String(v).trim().slice(0, max));
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const vatRate = () => Number(getSetting('vat_rate', '0.15'));

// ---------- cookies / auth ----------
const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, v.join('=')]));
app.use('/api', async (req, res, next) => {
  // mutations must be JSON (blocks cross-site form posts) – combined with SameSite=Strict cookie
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method) && req.body && !req.is('application/json') && req.headers['content-length'] !== '0')
    return next(new HttpError(415, 'JSON required'));
  req.user = await readToken(cookies(req).kanz_session);
  next();
});
const need = (perm) => (req, res, next) => {
  if (!req.user) return next(new HttpError(401, 'Please sign in'));
  if (!can(req.user, perm)) return next(new HttpError(403, 'Your role does not allow this'));
  next();
};

const attempts = new Map();
app.post('/api/auth/login', async (req, res) => {
  const { username = '', password = '' } = req.body ?? {};
  const key = `${req.ip}|${String(username).toLowerCase()}`;
  const a = attempts.get(key) ?? { n: 0, until: 0 };
  if (a.until > Date.now()) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
  const u = await db.prepare('SELECT * FROM users WHERE lower(username)=lower(?) AND active=1').get(String(username).trim());
  if (!u || !verifyPassword(String(password), u.pass_hash)) {
    a.n++; if (a.n >= 5) { a.until = Date.now() + 5 * 60000; a.n = 0; }
    attempts.set(key, a);
    throw new HttpError(401, 'Wrong username or password');
  }
  attempts.delete(key);
  res.cookie('kanz_session', makeToken(u.id), { httpOnly: true, sameSite: 'strict', secure: req.secure, maxAge: 12 * 3600 * 1000 });
  await audit(u, 'login', 'user', u.id);
  res.json({ id: u.id, name: u.name, username: u.username, role: u.role });
});
async function setupOpen() {
  if (getSetting('setup_complete') === 'true') return false;
  // closed as soon as anybody has ever signed in
  return (await db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action='login'").get()).c === 0;
}
app.get('/api/auth/setup', async (req, res) => res.json({ open: await setupOpen(), needsCode: !!process.env.KANZ_SETUP_CODE }));
app.post('/api/auth/setup', async (req, res) => {
  const key = `${req.ip}|setup`;
  const a = attempts.get(key) ?? { n: 0, until: 0 };
  if (a.until > Date.now()) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
  if (!(await setupOpen())) throw new HttpError(403, 'Setup is already complete. Please sign in.');
  const b = req.body ?? {};
  if (process.env.KANZ_SETUP_CODE && String(b.code ?? '') !== process.env.KANZ_SETUP_CODE) {
    a.n++; if (a.n >= 5) { a.until = Date.now() + 5 * 60000; a.n = 0; }
    attempts.set(key, a);
    throw new HttpError(403, 'Wrong setup code');
  }
  const name = str(b.name, 80), username = String(b.username ?? '').trim();
  if (!name) throw bad('Enter your name');
  if (!/^[a-z0-9._-]{3,30}$/i.test(username)) throw bad('Username: 3-30 letters or numbers (. _ - allowed)');
  if (String(b.password ?? '').length < 8) throw bad('Password must be at least 8 characters');
  const userId = await tx(async () => {
    if (!(await claimOnce('setup_complete'))) throw new HttpError(403, 'Setup is already complete. Please sign in.');
    await db.prepare('DELETE FROM users').run(); // remove any placeholder account nobody has used
    const r = await db.prepare("INSERT INTO users(name,username,pass_hash,role) VALUES(?,?,?, 'owner')").run(name, username, hashPassword(String(b.password)));
    return Number(r.lastInsertRowid);
  });
  const u = { id: userId, name, username, role: 'owner' };
  res.cookie('kanz_session', makeToken(userId), { httpOnly: true, sameSite: 'strict', secure: req.secure, maxAge: 12 * 3600 * 1000 });
  await audit(u, 'login', 'user', userId, 'first-time setup');
  res.status(201).json(u);
});
app.post('/api/auth/logout', async (req, res) => { res.clearCookie('kanz_session'); res.json({ ok: true }); });
app.get('/api/auth/me', async (req, res) => res.json(req.user ?? null));
app.post('/api/auth/password', need('view'), async (req, res) => {
  const { current = '', next = '' } = req.body ?? {};
  if (String(next).length < 8) throw bad('New password must be at least 8 characters');
  const u = await db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!verifyPassword(String(current), u.pass_hash)) throw bad('Current password is wrong');
  await db.prepare('UPDATE users SET pass_hash=? WHERE id=?').run(hashPassword(String(next)), u.id);
  await audit(req.user, 'password_change', 'user', u.id);
  res.json({ ok: true });
});

// ---------- meta / settings ----------
app.get('/api/meta', need('view'), async (req, res) => {
  const s = allSettings();
  res.json({ categories: CATEGORIES, modes: MODES, settings: s, user: req.user });
});
app.put('/api/settings', need('*'), async (req, res) => {
  const allowed = ['company_name', 'company_address', 'company_vat_no', 'vat_rate', 'financial_year', 'opening_cash', 'opening_bank', 'default_credit_days'];
  for (const [k, v] of Object.entries(req.body ?? {})) if (allowed.includes(k)) await setSetting(k, String(v).slice(0, 200));
  await audit(req.user, 'settings', 'settings', null, JSON.stringify(req.body));
  res.json({ ok: true });
});

app.get('/api/dashboard', need('view'), async (req, res) => res.json(await dashboard()));

// ---------- customers ----------
const asOf = (req) => (iso.test(req.query.asOf ?? '') ? req.query.asOf : new Date().toISOString().slice(0, 10));
app.get('/api/customers', need('view'), async (req, res) => res.json(await customerLedger(asOf(req))));
app.get('/api/customers/:id', need('view'), async (req, res) => {
  const c = (await customerLedger(asOf(req))).find((x) => x.id === Number(req.params.id));
  if (!c) throw new HttpError(404, 'Customer not found');
  const sales = await db.prepare("SELECT id,inv_no,date,due_date,type,total,status,description FROM sales WHERE customer_id=? ORDER BY date DESC,id DESC").all(c.id);
  const payments = await db.prepare('SELECT id,date,ref,mode,receipt,notes FROM cashbook WHERE customer_id=? AND category=? ORDER BY date DESC,id DESC').all(c.id, CAT_CUSTOMER_PAYMENT);
  res.json({ ...c, sales, payments });
});
function partyBody(b, withLimit) {
  const name = str(b.name, 120);
  if (!name) throw bad('Name is required');
  const o = { name, contact: str(b.contact, 80), phone: str(b.phone, 60), vat_no: str(b.vat_no, 30), notes: str(b.notes, 300), opening_balance: num(b.opening_balance ?? 0, 'Opening balance', { min: -1e9 }) };
  if (withLimit) o.credit_limit = num(b.credit_limit ?? 0, 'Credit limit');
  return o;
}
function saveParty(table, withLimit) {
  return async (req, res) => {
    const o = partyBody(req.body ?? {}, withLimit);
    const cols = Object.keys(o);
    try {
      if (req.params.id) {
        await db.prepare(`UPDATE ${table} SET ${cols.map((c) => `${c}=?`).join(',')} WHERE id=?`).run(...cols.map((c) => o[c]), req.params.id);
        await audit(req.user, 'update', table, Number(req.params.id), o.name);
        return res.json({ id: Number(req.params.id) });
      }
      const r = await db.prepare(`INSERT INTO ${table}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`).run(...cols.map((c) => o[c]));
      await audit(req.user, 'create', table, Number(r.lastInsertRowid), o.name);
      res.status(201).json({ id: Number(r.lastInsertRowid) });
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) throw bad('A record with this name already exists');
      throw e;
    }
  };
}
app.post('/api/customers', need('parties'), saveParty('customers', true));
app.put('/api/customers/:id', need('parties'), saveParty('customers', true));
app.post('/api/customers/:id/archive', need('parties'), async (req, res) => { await db.prepare('UPDATE customers SET active=0 WHERE id=?').run(req.params.id); await audit(req.user, 'archive', 'customers', Number(req.params.id)); res.json({ ok: true }); });

async function cashEntry(o, user) {
  const r = await db.prepare(`INSERT INTO cashbook(date,ref,description,party,category,mode,receipt,payment,notes,customer_id,supplier_id,sale_id,purchase_id,created_by)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(o.date, o.ref ?? null, o.description ?? null, o.party ?? null, o.category, o.mode ?? 'Cash',
    r2(o.receipt ?? 0), r2(o.payment ?? 0), o.notes ?? null, o.customer_id ?? null, o.supplier_id ?? null, o.sale_id ?? null, o.purchase_id ?? null, user?.id ?? null);
  return Number(r.lastInsertRowid);
}
const modeOk = (m) => { if (!MODES.includes(m)) throw bad('Choose a valid payment mode'); return m; };

app.post('/api/customers/:id/payment', need('cashbook_add'), async (req, res) => {
  const c = await db.prepare('SELECT * FROM customers WHERE id=?').get(req.params.id);
  if (!c) throw new HttpError(404, 'Customer not found');
  const b = req.body ?? {};
  const amount = num(b.amount, 'Amount', { allowZero: false });
  const id = await cashEntry({ date: date(b.date), ref: str(b.ref, 40), description: 'Payment received', party: c.name, category: CAT_CUSTOMER_PAYMENT, mode: modeOk(b.mode ?? 'Cash'), receipt: amount, notes: str(b.notes, 300), customer_id: c.id }, req.user);
  await audit(req.user, 'customer_payment', 'cashbook', id, `${c.name} ${amount}`);
  res.status(201).json({ id });
});

// ---------- suppliers ----------
app.get('/api/suppliers', need('view'), async (req, res) => res.json(await supplierLedger(asOf(req))));
app.get('/api/suppliers/:id', need('view'), async (req, res) => {
  const s = (await supplierLedger(asOf(req))).find((x) => x.id === Number(req.params.id));
  if (!s) throw new HttpError(404, 'Supplier not found');
  const purchases = await db.prepare('SELECT id,bill_no,date,due_date,terms,total,status FROM purchases WHERE supplier_id=? ORDER BY date DESC,id DESC').all(s.id);
  const payments = await db.prepare('SELECT id,date,ref,mode,payment,notes FROM cashbook WHERE supplier_id=? AND category=? ORDER BY date DESC,id DESC').all(s.id, CAT_SUPPLIER_PAYMENT);
  res.json({ ...s, purchases, payments });
});
app.post('/api/suppliers', need('parties'), saveParty('suppliers', false));
app.put('/api/suppliers/:id', need('parties'), saveParty('suppliers', false));
app.post('/api/suppliers/:id/payment', need('cashbook'), async (req, res) => {
  const s = await db.prepare('SELECT * FROM suppliers WHERE id=?').get(req.params.id);
  if (!s) throw new HttpError(404, 'Supplier not found');
  const b = req.body ?? {};
  const amount = num(b.amount, 'Amount', { allowZero: false });
  const id = await cashEntry({ date: date(b.date), ref: str(b.ref, 40), description: 'Payment to supplier', party: s.name, category: CAT_SUPPLIER_PAYMENT, mode: modeOk(b.mode ?? 'Cash'), payment: amount, notes: str(b.notes, 300), supplier_id: s.id }, req.user);
  await audit(req.user, 'supplier_payment', 'cashbook', id, `${s.name} ${amount}`);
  res.status(201).json({ id });
});

// ---------- products & stock ----------
app.get('/api/products', need('products_view'), async (req, res) => {
  const rows = await db.prepare(`SELECT p.*, COALESCE((SELECT SUM(qty) FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE si.product_id=p.id AND s.status='active'),0) sold
    FROM products p WHERE active=1 ORDER BY name`).all();
  res.json(rows.map((p) => ({ ...p, margin: p.price ? r2(((p.price - p.cost) / p.price) * 100) : 0, value: r2(p.stock * p.cost), low: p.reorder_level > 0 && p.stock <= p.reorder_level })));
});
async function saveProduct(req, res) {
  const b = req.body ?? {};
  const name = str(b.name, 160); if (!name) throw bad('Product name is required');
  const o = { sku: str(b.sku, 40), name, category: str(b.category, 60), unit: str(b.unit, 20) ?? 'pcs', cost: num(b.cost ?? 0, 'Cost'), price: num(b.price ?? 0, 'Price'), reorder_level: num(b.reorder_level ?? 0, 'Reorder level') };
  const dup = await db.prepare('SELECT id FROM products WHERE active=1 AND lower(name)=lower(?) AND id<>?').get(name, Number(req.params.id) || 0);
  if (dup) throw bad('A product with this name already exists');
  try {
    if (req.params.id) {
      const cols = Object.keys(o);
      await db.prepare(`UPDATE products SET ${cols.map((c) => `${c}=?`).join(',')} WHERE id=?`).run(...cols.map((c) => o[c]), req.params.id);
      await audit(req.user, 'update', 'products', Number(req.params.id), name);
      return res.json({ id: Number(req.params.id) });
    }
    o.sku ??= `P-${String((await db.prepare('SELECT COALESCE(MAX(id),0)+1 n FROM products').get()).n).padStart(4, '0')}`;
    const stock = num(b.stock ?? 0, 'Opening stock', { min: -1e9 });
    const id = await tx(async () => {
      const r = await db.prepare('INSERT INTO products(sku,name,category,unit,cost,price,reorder_level,stock) VALUES(?,?,?,?,?,?,?,?)').run(o.sku, o.name, o.category, o.unit, o.cost, o.price, o.reorder_level, stock);
      if (stock) await db.prepare("INSERT INTO stock_moves(product_id,date,qty,reason,user_id) VALUES(?,?,?,'Opening stock',?)").run(r.lastInsertRowid, new Date().toISOString().slice(0, 10), stock, req.user.id);
      return Number(r.lastInsertRowid);
    });
    await audit(req.user, 'create', 'products', id, name);
    res.status(201).json({ id });
  } catch (e) { if (String(e.message).includes('UNIQUE')) throw bad('This SKU already exists'); throw e; }
}
app.post('/api/products', need('products'), saveProduct);
app.put('/api/products/:id', need('products'), saveProduct);
app.post('/api/products/:id/adjust', need('products'), async (req, res) => {
  const p = await db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  if (!p) throw new HttpError(404, 'Product not found');
  const qty = num(req.body?.qty, 'Quantity', { min: -1e9, allowZero: false });
  const reason = str(req.body?.reason, 100) ?? 'Stock adjustment';
  await tx(async () => {
    await db.prepare('UPDATE products SET stock=stock+? WHERE id=?').run(qty, p.id);
    await db.prepare('INSERT INTO stock_moves(product_id,date,qty,reason,user_id) VALUES(?,?,?,?,?)').run(p.id, new Date().toISOString().slice(0, 10), qty, reason, req.user.id);
  });
  await audit(req.user, 'stock_adjust', 'products', p.id, `${qty} ${reason}`);
  res.json({ ok: true });
});
app.get('/api/products/:id/moves', need('products_view'), async (req, res) => res.json(await db.prepare('SELECT * FROM stock_moves WHERE product_id=? ORDER BY id DESC LIMIT 100').all(req.params.id)));

// ---------- sales ----------
app.get('/api/sales', need('view'), async (req, res) => {
  const { q = '', type = '', from = '', to = '' } = req.query;
  const rows = await db.prepare(`SELECT s.id,s.inv_no,s.date,s.due_date,s.type,s.payment_mode,s.total,s.status,s.source,c.name customer
    FROM sales s LEFT JOIN customers c ON c.id=s.customer_id
    WHERE (?1='' OR s.inv_no LIKE '%'||?1||'%' OR c.name LIKE '%'||?1||'%' OR s.description LIKE '%'||?1||'%')
      AND (?2='' OR s.type=?2) AND (?3='' OR s.date>=?3) AND (?4='' OR s.date<=?4)
    ORDER BY s.date DESC, s.id DESC LIMIT 500`).all(String(q), String(type), String(from), String(to));
  res.json(rows);
});
app.get('/api/sales/:id', need('view'), async (req, res) => {
  const s = await db.prepare('SELECT s.*, c.name customer FROM sales s LEFT JOIN customers c ON c.id=s.customer_id WHERE s.id=?').get(req.params.id);
  if (!s) throw new HttpError(404, 'Invoice not found');
  res.json({ ...s, items: await db.prepare('SELECT * FROM sale_items WHERE sale_id=?').all(s.id) });
});
app.post('/api/sales', need('sales'), async (req, res) => {
  const b = req.body ?? {};
  const type = b.type === 'credit' ? 'credit' : 'cash';
  const d = date(b.date);
  if (!Array.isArray(b.items) || !b.items.length) throw bad('Add at least one item');
  const items = await Promise.all(b.items.map(async (i, n) => {
    const qty = num(i.qty, `Item ${n + 1} quantity`, { allowZero: false }), price = num(i.unit_price, `Item ${n + 1} price`);
    let p = null;
    if (i.product_id) { p = await db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(i.product_id); if (!p) throw bad(`Item ${n + 1}: product not found`); }
    const description = str(i.description, 200) ?? p?.name;
    if (!description) throw bad(`Item ${n + 1} needs a description or product`);
    return { p, description, qty, price, amount: r2(qty * price) };
  }));
  const subtotal = r2(items.reduce((s, i) => s + i.amount, 0)), vat = r2(subtotal * vatRate()), total = r2(subtotal + vat);
  let cust = null;
  if (b.customer_id) { cust = (await customerLedger()).find((c) => c.id === Number(b.customer_id)); if (!cust) throw bad('Customer not found'); }
  if (type === 'credit') {
    if (!cust) throw bad('Choose a customer for a credit sale');
    if (cust.credit_limit > 0 && cust.balance + total > cust.credit_limit && !(b.override_limit && can(req.user, 'parties')))
      throw new HttpError(409, `Credit limit exceeded: ${cust.name} owes ${cust.balance.toFixed(2)} of ${cust.credit_limit.toFixed(2)}. An owner/accountant can override.`);
  }
  if (!b.allow_negative) for (const i of items) if (i.p && i.p.stock < i.qty) throw new HttpError(409, `Not enough stock for "${i.p.name}" (have ${i.p.stock}, need ${i.qty}).`);
  const days = type === 'credit' ? Math.round(num(b.credit_days ?? getSetting('default_credit_days', '30'), 'Credit days')) : null;
  const mode = type === 'cash' ? modeOk(b.payment_mode ?? 'Cash') : null;
  const id = await tx(async () => {
    const invNo = `INV-${await nextInvoiceNumber()}`;
    const sr = await db.prepare(`INSERT INTO sales(inv_no,date,customer_id,type,payment_mode,subtotal,vat,total,credit_days,due_date,description,notes,created_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(invNo, d, cust?.id ?? null, type, mode, subtotal, vat, total, days, type === 'credit' ? addDays(d, days) : null, items.map((i) => i.description).join('; ').slice(0, 300), str(b.notes, 300), req.user.id);
    const sid = Number(sr.lastInsertRowid);
    for (const i of items) {
      await db.prepare('INSERT INTO sale_items(sale_id,product_id,description,qty,unit_price,amount,unit_cost) VALUES(?,?,?,?,?,?,?)').run(sid, i.p?.id ?? null, i.description, i.qty, i.price, i.amount, i.p?.cost ?? 0);
      if (i.p) {
        await db.prepare('UPDATE products SET stock=stock-? WHERE id=?').run(i.qty, i.p.id);
        await db.prepare("INSERT INTO stock_moves(product_id,date,qty,reason,ref,user_id) VALUES(?,?,?,'Sale',?,?)").run(i.p.id, d, -i.qty, invNo, req.user.id);
      }
    }
    if (type === 'cash') await cashEntry({ date: d, ref: invNo, description: 'Counter sale', party: cust?.name ?? 'Walk-in customer', category: CAT_SALES, mode, receipt: total, sale_id: sid, customer_id: cust?.id }, req.user);
    await audit(req.user, 'create', 'sales', sid, `${invNo} ${total}`);
    return sid;
  });
  res.status(201).json({ id: id, inv_no: (await db.prepare('SELECT inv_no FROM sales WHERE id=?').get(id)).inv_no });
});
app.post('/api/sales/:id/void', need('purchases'), async (req, res) => {
  const s = await db.prepare('SELECT * FROM sales WHERE id=?').get(req.params.id);
  if (!s) throw new HttpError(404, 'Invoice not found');
  if (s.status === 'void') throw bad('Already voided');
  await tx(async () => {
    for (const i of await db.prepare('SELECT * FROM sale_items WHERE sale_id=? AND product_id IS NOT NULL').all(s.id)) {
      if (s.source === 'excel') break; // imported lines never moved stock
      await db.prepare('UPDATE products SET stock=stock+? WHERE id=?').run(i.qty, i.product_id);
      await db.prepare("INSERT INTO stock_moves(product_id,date,qty,reason,ref,user_id) VALUES(?,?,?,'Void sale',?,?)").run(i.product_id, new Date().toISOString().slice(0, 10), i.qty, s.inv_no, req.user.id);
    }
    await db.prepare('DELETE FROM cashbook WHERE sale_id=?').run(s.id);
    await db.prepare("UPDATE sales SET status='void' WHERE id=?").run(s.id);
  });
  await audit(req.user, 'void', 'sales', s.id, s.inv_no);
  res.json({ ok: true });
});

// printable invoice (simplified tax invoice with ZATCA phase-1 style QR)
const tlv = (tag, value) => { const v = Buffer.from(value, 'utf8'); return Buffer.concat([Buffer.from([tag, v.length]), v]); };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
app.get('/invoice/:id', async (req, res) => {
  const user = await readToken(cookies(req).kanz_session);
  if (!user) return res.status(401).send('Please sign in first');
  const s = await db.prepare('SELECT s.*, c.name customer, c.phone, c.vat_no cvat FROM sales s LEFT JOIN customers c ON c.id=s.customer_id WHERE s.id=?').get(req.params.id);
  if (!s) return res.status(404).send('Invoice not found');
  const items = await db.prepare('SELECT * FROM sale_items WHERE sale_id=?').all(s.id);
  const st = allSettings();
  const qrPayload = Buffer.concat([tlv(1, st.company_name || ''), tlv(2, st.company_vat_no || ''), tlv(3, `${s.date}T00:00:00Z`), tlv(4, s.total.toFixed(2)), tlv(5, s.vat.toFixed(2))]).toString('base64');
  const qr = await QRCode.toDataURL(qrPayload, { margin: 1, width: 180 });
  const money = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Invoice ${esc(s.inv_no)}</title><link rel="stylesheet" href="/invoice.css"></head><body>
<div class="bar"><button id="print">Print / Save as PDF</button><a href="/">Back to app</a></div>
<main class="sheet"><header><div><h1>${esc(st.company_name)}</h1><p>${esc(st.company_address)}</p><p>VAT No: ${esc(st.company_vat_no) || '<b class="warn">not set (Settings)</b>'}</p></div>
<div class="meta"><h2>${s.status === 'void' ? 'VOID – ' : ''}Tax Invoice</h2><p><b>${esc(s.inv_no)}</b></p><p>Date: ${esc(s.date)}</p>${s.due_date ? `<p>Due: ${esc(s.due_date)}</p>` : ''}</div></header>
<section class="to"><b>Bill to:</b> ${esc(s.customer || 'Walk-in customer')} ${s.phone ? `· ${esc(s.phone)}` : ''} ${s.cvat ? `· VAT ${esc(s.cvat)}` : ''}</section>
<table><thead><tr><th>#</th><th>Description</th><th class="n">Qty</th><th class="n">Unit price</th><th class="n">Amount</th></tr></thead><tbody>
${items.map((i, n) => `<tr><td>${n + 1}</td><td>${esc(i.description)}</td><td class="n">${i.qty}</td><td class="n">${money(i.unit_price)}</td><td class="n">${money(i.amount)}</td></tr>`).join('')}
</tbody></table>
<footer><img src="${qr}" alt="ZATCA QR" width="120" height="120"><table class="tot"><tr><td>Subtotal (excl. VAT)</td><td class="n">${money(s.subtotal)}</td></tr><tr><td>VAT ${Math.round(Number(st.vat_rate) * 100)}%</td><td class="n">${money(s.vat)}</td></tr><tr class="g"><td>Total (${esc(st.currency)})</td><td class="n">${money(s.total)}</td></tr></table></footer>
<p class="note">${s.type === 'credit' ? `Credit sale – payment due ${esc(s.due_date)}.` : `Paid by ${esc(s.payment_mode)}.`} QR follows the ZATCA Phase 1 format; full Phase 2 e-invoicing is not enabled.</p></main>
<script src="/invoice.js"></script></body></html>`);
});

// ---------- purchases ----------
app.get('/api/purchases', need('purchases'), async (req, res) => {
  res.json(await db.prepare(`SELECT p.id,p.bill_no,p.date,p.due_date,p.terms,p.subtotal,p.vat,p.total,p.status,p.description,s.name supplier FROM purchases p JOIN suppliers s ON s.id=p.supplier_id ORDER BY p.date DESC,p.id DESC LIMIT 500`).all());
});
app.post('/api/purchases', need('purchases'), async (req, res) => {
  const b = req.body ?? {};
  const d = date(b.date), terms = b.terms === 'credit' ? 'credit' : 'cash';
  const sup = await db.prepare('SELECT * FROM suppliers WHERE id=? AND active=1').get(b.supplier_id);
  if (!sup) throw bad('Choose a supplier');
  let items = [];
  if (Array.isArray(b.items) && b.items.length) {
    items = await Promise.all(b.items.map(async (i, n) => {
      const qty = num(i.qty, `Item ${n + 1} quantity`, { allowZero: false }), cost = num(i.unit_cost, `Item ${n + 1} cost`);
      const p = i.product_id ? await db.prepare('SELECT * FROM products WHERE id=?').get(i.product_id) : null;
      const description = str(i.description, 200) ?? p?.name; if (!description) throw bad(`Item ${n + 1} needs a description or product`);
      return { p, description, qty, cost, amount: r2(qty * cost) };
    }));
  }
  const subtotal = items.length ? r2(items.reduce((s, i) => s + i.amount, 0)) : num(b.subtotal, 'Amount excl. VAT', { allowZero: false });
  const vat = b.vat != null && b.vat !== '' ? r2(num(b.vat, 'VAT')) : r2(subtotal * vatRate());
  const total = r2(subtotal + vat);
  const days = terms === 'credit' ? Math.round(num(b.credit_days ?? getSetting('default_credit_days', '30'), 'Credit days')) : null;
  const mode = terms === 'cash' ? modeOk(b.payment_mode ?? 'Cash') : null;
  const id = await tx(async () => {
    const r = await db.prepare(`INSERT INTO purchases(bill_no,date,supplier_id,description,subtotal,vat,total,terms,payment_mode,credit_days,due_date,notes,created_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(str(b.bill_no, 60), d, sup.id, str(b.description, 300) ?? items.map((i) => i.description).join('; ').slice(0, 300) ?? null, subtotal, vat, total, terms, mode, days, terms === 'credit' ? addDays(d, days) : null, str(b.notes, 300), req.user.id);
    const pid = Number(r.lastInsertRowid);
    for (const i of items) {
      await db.prepare('INSERT INTO purchase_items(purchase_id,product_id,description,qty,unit_cost,amount) VALUES(?,?,?,?,?,?)').run(pid, i.p?.id ?? null, i.description, i.qty, i.cost, i.amount);
      if (i.p) {
        const newStock = i.p.stock + i.qty;
        const avg = i.p.stock > 0 ? r2((i.p.stock * i.p.cost + i.qty * i.cost) / newStock) : i.cost; // weighted average cost
        await db.prepare('UPDATE products SET stock=?, cost=? WHERE id=?').run(newStock, avg, i.p.id);
        await db.prepare("INSERT INTO stock_moves(product_id,date,qty,reason,ref,user_id) VALUES(?,?,?,'Purchase',?,?)").run(i.p.id, d, i.qty, b.bill_no ?? null, req.user.id);
      }
    }
    if (terms === 'cash') await cashEntry({ date: d, ref: str(b.bill_no, 40), description: `Purchase – ${sup.name}`, party: sup.name, category: CAT_PURCHASE, mode, payment: total, purchase_id: pid, supplier_id: sup.id }, req.user);
    await audit(req.user, 'create', 'purchases', pid, `${sup.name} ${total}`);
    return pid;
  });
  res.status(201).json({ id });
});
app.post('/api/purchases/:id/void', need('purchases'), async (req, res) => {
  const p = await db.prepare('SELECT * FROM purchases WHERE id=?').get(req.params.id);
  if (!p) throw new HttpError(404, 'Bill not found');
  if (p.status === 'void') throw bad('Already voided');
  await tx(async () => {
    for (const i of await db.prepare('SELECT * FROM purchase_items WHERE purchase_id=? AND product_id IS NOT NULL').all(p.id)) {
      await db.prepare('UPDATE products SET stock=stock-? WHERE id=?').run(i.qty, i.product_id);
      await db.prepare("INSERT INTO stock_moves(product_id,date,qty,reason,ref,user_id) VALUES(?,?,?,'Void purchase',?,?)").run(i.product_id, new Date().toISOString().slice(0, 10), -i.qty, p.bill_no, req.user.id);
    }
    await db.prepare('DELETE FROM cashbook WHERE purchase_id=?').run(p.id);
    await db.prepare("UPDATE purchases SET status='void' WHERE id=?").run(p.id);
  });
  await audit(req.user, 'void', 'purchases', p.id, p.bill_no ?? '');
  res.json({ ok: true });
});

// ---------- cashbook ----------
const catMap = new Map(CATEGORIES.map((c) => [c.name, c]));
app.get('/api/cashbook', need('view'), async (req, res) => {
  const { q = '', category = '', mode = '', from = '', to = '' } = req.query;
  const open = Number(getSetting('opening_cash', 0)) + Number(getSetting('opening_bank', 0));
  const rows = await db.prepare(`SELECT * FROM (SELECT cb.*, ?6::float8 + SUM(receipt-payment) OVER (ORDER BY date, id) balance FROM cashbook cb) t
    WHERE (?1='' OR description LIKE '%'||?1||'%' OR party LIKE '%'||?1||'%' OR ref LIKE '%'||?1||'%' OR notes LIKE '%'||?1||'%')
      AND (?2='' OR category=?2) AND (?3='' OR mode=?3) AND (?4='' OR date>=?4) AND (?5='' OR date<=?5)
    ORDER BY date DESC, id DESC LIMIT 1000`).all(String(q), String(category), String(mode), String(from), String(to), open);
  res.json({ rows: rows.map((r) => ({ ...r, balance: r2(r.balance) })), position: await cashPosition() });
});
async function cashBody(b) {
  const category = String(b.category ?? '');
  const cat = catMap.get(category);
  if (!cat) throw bad('Choose a valid category');
  const receipt = r2(num(b.receipt ?? 0, 'Receipt')), payment = r2(num(b.payment ?? 0, 'Payment'));
  if ((receipt > 0) === (payment > 0)) throw bad('Enter either a Receipt or a Payment (not both, not neither)');
  if (cat.type === 'Receipt' && !receipt) throw bad(`"${category}" is a money-in category`);
  if (cat.type === 'Payment' && !payment) throw bad(`"${category}" is a money-out category`);
  let customer_id = null, supplier_id = null, party = str(b.party, 120);
  if (category === CAT_CUSTOMER_PAYMENT) {
    const c = await db.prepare('SELECT * FROM customers WHERE id=?').get(b.customer_id); if (!c) throw bad('Choose the customer who paid');
    customer_id = c.id; party = c.name;
  }
  if (category === CAT_SUPPLIER_PAYMENT) {
    const s = await db.prepare('SELECT * FROM suppliers WHERE id=?').get(b.supplier_id); if (!s) throw bad('Choose the supplier you paid');
    supplier_id = s.id; party = s.name;
  }
  return { date: date(b.date), ref: str(b.ref, 40), description: str(b.description, 200), party, category, mode: modeOk(b.mode ?? 'Cash'), receipt, payment, notes: str(b.notes, 300), customer_id, supplier_id };
}
app.post('/api/cashbook', need('cashbook_add'), async (req, res) => {
  const id = await cashEntry(await cashBody(req.body ?? {}), req.user);
  await audit(req.user, 'create', 'cashbook', id, `${req.body.category} ${req.body.receipt || req.body.payment}`);
  res.status(201).json({ id });
});
app.put('/api/cashbook/:id', need('cashbook'), async (req, res) => {
  const old = await db.prepare('SELECT * FROM cashbook WHERE id=?').get(req.params.id);
  if (!old) throw new HttpError(404, 'Entry not found');
  if (old.sale_id || old.purchase_id) throw bad('This entry belongs to an invoice/bill. Void that document instead.');
  const o = await cashBody(req.body ?? {});
  await db.prepare(`UPDATE cashbook SET date=?,ref=?,description=?,party=?,category=?,mode=?,receipt=?,payment=?,notes=?,customer_id=?,supplier_id=? WHERE id=?`)
    .run(o.date, o.ref, o.description, o.party, o.category, o.mode, o.receipt, o.payment, o.notes, o.customer_id, o.supplier_id, old.id);
  await audit(req.user, 'update', 'cashbook', old.id, JSON.stringify({ was: [old.category, old.receipt, old.payment], now: [o.category, o.receipt, o.payment] }));
  res.json({ ok: true });
});
app.delete('/api/cashbook/:id', need('cashbook'), async (req, res) => {
  const old = await db.prepare('SELECT * FROM cashbook WHERE id=?').get(req.params.id);
  if (!old) throw new HttpError(404, 'Entry not found');
  if (old.sale_id || old.purchase_id) throw bad('This entry belongs to an invoice/bill. Void that document instead.');
  await db.prepare('DELETE FROM cashbook WHERE id=?').run(old.id);
  await audit(req.user, 'delete', 'cashbook', old.id, JSON.stringify(old));
  res.json({ ok: true });
});

// ---------- reports ----------
app.get('/api/reports/year', need('reports'), async (req, res) => res.json(await yearReport(Number(req.query.year) || undefined)));
app.get('/api/reports/ageing', need('reports'), async (req, res) => res.json({ asOf: asOf(req), customers: (await customerLedger(asOf(req))).filter((c) => c.balance !== 0), suppliers: (await supplierLedger(asOf(req))).filter((s) => s.balance !== 0) }));

const csvCell = (v) => { const s = String(v ?? ''); const safe = /^[=+\-@]/.test(s) && Number.isNaN(Number(s)) ? `'${s}` : s; return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe; };
app.get('/api/export/:what', need('reports'), async (req, res) => {
  const sets = {
    cashbook: () => db.prepare('SELECT date,ref,description,party,category,mode,receipt,payment,notes FROM cashbook ORDER BY date,id').all(),
    sales: () => db.prepare('SELECT s.inv_no,s.date,c.name customer,s.type,s.subtotal,s.vat,s.total,s.due_date,s.status FROM sales s LEFT JOIN customers c ON c.id=s.customer_id ORDER BY s.date').all(),
    purchases: () => db.prepare('SELECT p.bill_no,p.date,s.name supplier,p.terms,p.subtotal,p.vat,p.total,p.due_date,p.status FROM purchases p JOIN suppliers s ON s.id=p.supplier_id ORDER BY p.date').all(),
    customers: async () => (await customerLedger()).map(({ name, phone, credit_limit, credit, paid, balance, overdue, status }) => ({ name, phone, credit_limit, credit, paid, balance, overdue, status })),
    suppliers: async () => (await supplierLedger()).map(({ name, phone, credit, paid, balance, overdue, status }) => ({ name, phone, credit, paid, balance, overdue, status })),
    products: () => db.prepare('SELECT sku,name,category,unit,cost,price,stock,reorder_level FROM products WHERE active=1 ORDER BY name').all(),
  };
  if (!sets[req.params.what]) throw new HttpError(404, 'Unknown export');
  const rows = await sets[req.params.what]();
  const head = rows.length ? Object.keys(rows[0]) : [];
  res.type('text/csv').attachment(`${req.params.what}-${new Date().toISOString().slice(0, 10)}.csv`)
    .send('﻿' + [head.join(','), ...rows.map((r) => head.map((h) => csvCell(r[h])).join(','))].join('\n'));
});

// ---------- users, audit, import issues ----------
app.get('/api/users', need('*'), async (req, res) => res.json(await db.prepare('SELECT id,name,username,role,active,created_at FROM users ORDER BY id').all()));
app.post('/api/users', need('*'), async (req, res) => {
  const b = req.body ?? {};
  if (!['owner', 'accountant', 'cashier'].includes(b.role)) throw bad('Choose a role');
  if (!/^[a-z0-9._-]{3,30}$/i.test(b.username ?? '')) throw bad('Username: 3-30 letters/numbers');
  if (String(b.password ?? '').length < 8) throw bad('Password must be at least 8 characters');
  try {
    const r = await db.prepare('INSERT INTO users(name,username,pass_hash,role) VALUES(?,?,?,?)').run(str(b.name, 80) ?? b.username, b.username, hashPassword(String(b.password)), b.role);
    await audit(req.user, 'create', 'users', Number(r.lastInsertRowid), `${b.username} (${b.role})`);
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  } catch (e) { if (String(e.message).includes('UNIQUE')) throw bad('Username already taken'); throw e; }
});
app.put('/api/users/:id', need('*'), async (req, res) => {
  const b = req.body ?? {};
  const u = await db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u) throw new HttpError(404, 'User not found');
  if (u.id === req.user.id && (b.active === false || (b.role && b.role !== 'owner'))) throw bad("You can't remove your own owner access");
  if (b.role && ['owner', 'accountant', 'cashier'].includes(b.role)) await db.prepare('UPDATE users SET role=? WHERE id=?').run(b.role, u.id);
  if (typeof b.active === 'boolean') await db.prepare('UPDATE users SET active=? WHERE id=?').run(b.active ? 1 : 0, u.id);
  if (b.password) { if (String(b.password).length < 8) throw bad('Password must be at least 8 characters'); await db.prepare('UPDATE users SET pass_hash=? WHERE id=?').run(hashPassword(String(b.password)), u.id); }
  await audit(req.user, 'update', 'users', u.id, u.username);
  res.json({ ok: true });
});
app.get('/api/audit', need('*'), async (req, res) => res.json(await db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 300').all()));
app.get('/api/issues', need('view'), async (req, res) => res.json(await db.prepare("SELECT * FROM import_issues ORDER BY resolved, CASE severity WHEN 'error' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END, id").all()));
app.post('/api/issues/:id/resolve', need('cashbook'), async (req, res) => { await db.prepare('UPDATE import_issues SET resolved=? WHERE id=?').run(req.body?.resolved === false ? 0 : 1, req.params.id); res.json({ ok: true }); });

// ---------- static + errors ----------
app.use(express.static(new URL('../public', import.meta.url).pathname, { extensions: ['html'] }));
app.use('/api', async (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server' });
});

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => console.log(`Kanz Corner Accounting running on http://localhost:${port}`));
}

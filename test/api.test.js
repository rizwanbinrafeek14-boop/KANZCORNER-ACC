import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'kanz-'));
process.env.KANZ_DATA_DIR = join(dir, 'pg');
const { app } = await import('../server/index.js');
const { importExcel } = await import('../server/seed.js');
const { cashPosition, customerLedger, supplierLedger } = await import('../server/ledger.js');

let server, base, cookie = '';
const call = async (method, path, body, ck = cookie) => {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', cookie: ck }, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get('set-cookie');
  if (sc && path.includes('login')) cookie = sc.split(';')[0];
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
};

before(async () => {
  await importExcel({ adminPassword: 'test-password-1' });
  server = app.listen(0); base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

test('Excel import reconciles with the workbook', async () => {
  const p = await cashPosition();
  assert.equal(p.receipts, 13558.91);
  assert.equal(p.payments, 3982.05);
  assert.equal(p.total, 9576.86);
  const cust = await customerLedger('2026-10-08');
  assert.equal(Math.round(cust.reduce((s, c) => s + c.balance, 0) * 100) / 100, 4353.92);
  const sup = await supplierLedger('2026-10-08');
  assert.equal(Math.round(sup.reduce((s, c) => s + c.balance, 0) * 100) / 100, 6752.11);
});

test('auth: rejects anonymous and wrong password, accepts owner', async () => {
  assert.equal((await call('GET', '/api/customers', null, '')).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { username: 'owner', password: 'nope' }, '')).status, 401);
  const ok = await call('POST', '/api/auth/login', { username: 'owner', password: 'test-password-1' }, '');
  assert.equal(ok.status, 200); assert.equal(ok.body.role, 'owner');
});

test('cash sale creates cashbook receipt, reduces stock, adds VAT', async () => {
  const prod = await call('POST', '/api/products', { name: 'Test Valve', cost: 40, price: 100, stock: 10, reorder_level: 3 });
  assert.equal(prod.status, 201);
  const sale = await call('POST', '/api/sales', { date: '2026-10-08', type: 'cash', payment_mode: 'Mada / Card', items: [{ product_id: prod.body.id, qty: 2, unit_price: 100 }] });
  assert.equal(sale.status, 201);
  const inv = (await call('GET', `/api/sales/${sale.body.id}`)).body;
  assert.equal(inv.subtotal, 200); assert.equal(inv.vat, 30); assert.equal(inv.total, 230);
  const products = (await call('GET', '/api/products')).body;
  assert.equal(products.find((p) => p.id === prod.body.id).stock, 8);
  const cb = (await call('GET', '/api/cashbook?q=' + inv.inv_no)).body;
  assert.equal(cb.rows[0].receipt, 230);
  assert.equal(cb.position.total, 9576.86 + 230);
  // void restores everything
  assert.equal((await call('POST', `/api/sales/${sale.body.id}/void`, {})).status, 200);
  assert.equal((await call('GET', '/api/products')).body.find((p) => p.id === prod.body.id).stock, 10);
  assert.equal((await call('GET', '/api/cashbook')).body.position.total, 9576.86);
});

test('duplicate product names are rejected', async () => {
  assert.equal((await call('POST', '/api/products', { name: 'Dup Item', price: 1 })).status, 201);
  assert.equal((await call('POST', '/api/products', { name: 'dup item', price: 1 })).status, 400);
});

test('stock cannot go negative unless forced', async () => {
  const prod = await call('POST', '/api/products', { name: 'Scarce', price: 10, stock: 1 });
  const r = await call('POST', '/api/sales', { date: '2026-10-08', type: 'cash', items: [{ product_id: prod.body.id, qty: 5, unit_price: 10 }] });
  assert.equal(r.status, 409);
});

test('credit sale: limit enforced, payment reduces balance', async () => {
  const c = await call('POST', '/api/customers', { name: 'Test Co', credit_limit: 500 });
  const big = await call('POST', '/api/sales', { date: '2026-10-08', type: 'credit', customer_id: c.body.id, credit_days: 30, items: [{ description: 'Pipes', qty: 1, unit_price: 600 }] });
  assert.equal(big.status, 409);
  const ok = await call('POST', '/api/sales', { date: '2026-10-08', type: 'credit', customer_id: c.body.id, credit_days: 30, items: [{ description: 'Pipes', qty: 1, unit_price: 400 }] });
  assert.equal(ok.status, 201);
  let cu = (await call('GET', `/api/customers/${c.body.id}`)).body;
  assert.equal(cu.balance, 460);
  assert.equal((await call('POST', `/api/customers/${c.body.id}/payment`, { date: '2026-10-08', amount: 460, mode: 'Cash' })).status, 201);
  cu = (await call('GET', `/api/customers/${c.body.id}`)).body;
  assert.equal(cu.balance, 0); assert.equal(cu.status, 'Settled');
});

test('purchases: credit builds payable, cash hits cashbook, stock uses weighted cost', async () => {
  const s = await call('POST', '/api/suppliers', { name: 'Test Supplier' });
  const prod = await call('POST', '/api/products', { name: 'Fitting', cost: 10, price: 20, stock: 10 });
  const cr = await call('POST', '/api/purchases', { date: '2026-10-08', supplier_id: s.body.id, terms: 'credit', credit_days: 30, items: [{ product_id: prod.body.id, qty: 10, unit_cost: 20 }] });
  assert.equal(cr.status, 201);
  const p = (await call('GET', '/api/products')).body.find((x) => x.id === prod.body.id);
  assert.equal(p.stock, 20); assert.equal(p.cost, 15);
  assert.equal((await call('GET', `/api/suppliers/${s.body.id}`)).body.balance, 230);
  assert.equal((await call('POST', `/api/suppliers/${s.body.id}/payment`, { date: '2026-10-08', amount: 100, mode: 'Bank Transfer' })).status, 201);
  assert.equal((await call('GET', `/api/suppliers/${s.body.id}`)).body.balance, 130);
});

test('cashbook validation', async () => {
  const both = await call('POST', '/api/cashbook', { date: '2026-10-08', category: 'Shop Rent', mode: 'Cash', receipt: 5, payment: 5 });
  assert.equal(both.status, 400);
  const wrongSide = await call('POST', '/api/cashbook', { date: '2026-10-08', category: 'Shop Rent', mode: 'Cash', receipt: 5 });
  assert.equal(wrongSide.status, 400);
  const badDate = await call('POST', '/api/cashbook', { date: 'yesterday', category: 'Shop Rent', mode: 'Cash', payment: 5 });
  assert.equal(badDate.status, 400);
  assert.equal((await call('POST', '/api/cashbook', { date: '2026-10-08', category: 'Shop Rent', mode: 'Cash', payment: 5 })).status, 201);
});

test('roles: cashier can sell but not manage users or view reports', async () => {
  assert.equal((await call('POST', '/api/users', { name: 'Cashier', username: 'cash1', password: 'longenough1', role: 'cashier' })).status, 201);
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'cash1', password: 'longenough1' }) });
  const ck = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('GET', '/api/users', null, ck)).status, 403);
  assert.equal((await call('GET', '/api/reports/year', null, ck)).status, 403);
  assert.equal((await call('GET', '/api/dashboard', null, ck)).status, 200);
  assert.equal((await call('DELETE', '/api/cashbook/1', null, ck)).status, 403);
});

test('reports: month figures and CSV export are safe', async () => {
  const y = (await call('GET', '/api/reports/year?year=2026')).body;
  assert.equal(y.monthly.closing[8], 6857);
  const c = await call('POST', '/api/customers', { name: '=HYPERLINK("x")' });
  assert.equal(c.status, 201);
  const csv = (await call('GET', '/api/export/customers')).body;
  assert.ok(csv.includes("'=HYPERLINK"));
});

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'kanz-feat-'));
process.env.KANZ_DATA_DIR = join(dir, 'pg');
const { app } = await import('../server/index.js');
const { importExcel } = await import('../server/seed.js');
const { cashPosition } = await import('../server/ledger.js');

let server, base, cookie = '';
const call = async (method, path, body) => {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get('set-cookie'); if (sc && path.includes('login')) cookie = sc.split(';')[0];
  const t = await res.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: res.status, body: j };
};
const stock = async (id) => (await call('GET', '/api/products')).body.find((p) => p.id === id).stock;
const D = '2026-10-08';

before(async () => {
  await importExcel({ adminPassword: 'test-password-1' });
  server = app.listen(0); base = `http://127.0.0.1:${server.address().port}`;
  await call('POST', '/api/auth/login', { username: 'owner', password: 'test-password-1' });
});
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

test('edit a cash invoice: stock, totals and the cashbook line follow', async () => {
  const p = (await call('POST', '/api/products', { name: 'Edit Item', cost: 40, price: 100, stock: 10 })).body.id;
  const before = (await cashPosition()).total;
  const s = (await call('POST', '/api/sales', { date: D, type: 'cash', payment_mode: 'Cash', items: [{ product_id: p, qty: 2, unit_price: 100 }] })).body;
  assert.equal(await stock(p), 8);
  const e = await call('PUT', `/api/sales/${s.id}`, { date: D, payment_mode: 'Mada / Card', items: [{ product_id: p, qty: 3, unit_price: 100 }] });
  assert.equal(e.status, 200); assert.equal(e.body.inv_no, s.inv_no);
  assert.equal(await stock(p), 7);
  const inv = (await call('GET', `/api/sales/${s.id}`)).body;
  assert.equal(inv.total, 345);
  assert.equal((await cashPosition()).total, Math.round((before + 345) * 100) / 100);
  const cb = (await call('GET', `/api/cashbook?q=${s.inv_no}`)).body.rows;
  assert.equal(cb.length, 1); assert.equal(cb[0].receipt, 345); assert.equal(cb[0].mode, 'Mada / Card');
});

test('cash refund return: stock back, cashbook payment, limits and locks enforced', async () => {
  const p = (await call('POST', '/api/products', { name: 'Return Item', cost: 10, price: 50, stock: 10 })).body.id;
  const s = (await call('POST', '/api/sales', { date: D, type: 'cash', payment_mode: 'Cash', items: [{ product_id: p, qty: 4, unit_price: 50 }] })).body;
  const inv = (await call('GET', `/api/sales/${s.id}`)).body;
  const itemId = inv.items[0].id;
  const before = (await cashPosition()).total;
  const over = await call('POST', `/api/sales/${s.id}/returns`, { date: D, refund_type: 'cash', refund_mode: 'Cash', items: [{ sale_item_id: itemId, qty: 5 }] });
  assert.equal(over.status, 400);
  const r = await call('POST', `/api/sales/${s.id}/returns`, { date: D, refund_type: 'cash', refund_mode: 'Cash', items: [{ sale_item_id: itemId, qty: 1 }] });
  assert.equal(r.status, 201); assert.equal(r.body.total, 57.5);
  assert.equal(await stock(p), 7);
  assert.equal((await cashPosition()).total, Math.round((before - 57.5) * 100) / 100);
  assert.equal((await call('POST', `/api/sales/${s.id}/returns`, { date: D, refund_type: 'cash', items: [{ sale_item_id: itemId, qty: 4 }] })).status, 400); // only 3 left
  assert.equal((await call('POST', `/api/sales/${s.id}/void`, {})).status, 400);
  assert.equal((await call('PUT', `/api/sales/${s.id}`, { date: D, payment_mode: 'Cash', items: [{ product_id: p, qty: 1, unit_price: 50 }] })).status, 400);
  assert.equal((await call('POST', `/api/returns/${r.body.id}/void`, {})).status, 200);
  assert.equal(await stock(p), 6);
  assert.equal((await cashPosition()).total, before);
});

test('credit note to the customer account reduces what they owe; statement matches', async () => {
  const c = (await call('POST', '/api/customers', { name: 'Statement Co', credit_limit: 5000, phone: 'AHMED - 055 123 4567' })).body.id;
  const s = (await call('POST', '/api/sales', { date: '2026-10-01', type: 'credit', customer_id: c, credit_days: 30, items: [{ description: 'Valves', qty: 10, unit_price: 100 }] })).body;
  const itemId = (await call('GET', `/api/sales/${s.id}`)).body.items[0].id;
  assert.equal((await call('GET', `/api/customers/${c}`)).body.balance, 1150);
  const r = await call('POST', `/api/sales/${s.id}/returns`, { date: '2026-10-03', refund_type: 'credit', items: [{ sale_item_id: itemId, qty: 2 }] });
  assert.equal(r.status, 201);
  assert.equal((await call('GET', `/api/customers/${c}`)).body.balance, 920);
  await call('POST', `/api/customers/${c}/payment`, { date: '2026-10-05', amount: 400, mode: 'Cash' });
  const st = (await call('GET', `/api/customers/${c}/statement`)).body;
  assert.deepEqual(st.rows.map((x) => x.kind), ['Invoice', 'Credit note', 'Payment']);
  assert.equal(st.closing, 520);
  assert.equal((await call('GET', `/api/customers/${c}/statement?from=2026-10-04`)).body.opening, 920);
  const page = await call('GET', `/statement/${c}`);
  assert.equal(page.status, 200); assert.match(page.body, /Statement of Account/);
  assert.match((await call('GET', `/creditnote/${r.body.id}`)).body, /Credit Note/);
});

test('edit a credit bill: payable and stock follow; terms cannot change', async () => {
  const s = (await call('POST', '/api/suppliers', { name: 'Edit Supplier' })).body.id;
  const p = (await call('POST', '/api/products', { name: 'Bought Item', cost: 0, price: 30, stock: 0 })).body.id;
  const b = (await call('POST', '/api/purchases', { date: D, supplier_id: s, terms: 'credit', credit_days: 30, items: [{ product_id: p, qty: 10, unit_cost: 20 }] })).body.id;
  assert.equal(await stock(p), 10);
  assert.equal((await call('GET', `/api/suppliers/${s}`)).body.balance, 230);
  const e = await call('PUT', `/api/purchases/${b}`, { date: D, supplier_id: s, terms: 'cash', credit_days: 30, items: [{ product_id: p, qty: 5, unit_cost: 20 }] });
  assert.equal(e.status, 200);
  assert.equal(await stock(p), 5);
  const sup = (await call('GET', `/api/suppliers/${s}`)).body;
  assert.equal(sup.balance, 115);               // still a credit bill – the terms change was ignored
  assert.equal((await call('GET', `/api/purchases/${b}`)).body.terms, 'credit');
});

test('accrual report: revenue by invoice, cost from product costs, by product and customer', async () => {
  const p = (await call('POST', '/api/products', { name: 'Accrual Item', cost: 60, price: 100, stock: 10 })).body.id;
  const c = (await call('POST', '/api/customers', { name: 'Accrual Co', credit_limit: 0 })).body.id;
  await call('POST', '/api/sales', { date: '2026-10-02', type: 'credit', customer_id: c, credit_days: 30, items: [{ product_id: p, qty: 5, unit_price: 100 }] });
  const r = (await call('GET', '/api/reports/accrual?year=2026')).body;
  const prod = r.byProduct.find((x) => x.name === 'Accrual Item');
  assert.equal(prod.revenue, 500); assert.equal(prod.cost, 300); assert.equal(prod.profit, 200); assert.equal(prod.margin, 40);
  const cust = r.byCustomer.find((x) => x.name === 'Accrual Co');
  assert.equal(cust.revenue, 500); assert.equal(cust.cost, 300);
  assert.ok(r.revenue[9] >= 500 && r.cogs[9] >= 300);
  assert.ok(r.costCoverage > 0 && r.costCoverage <= 100);
});

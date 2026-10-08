import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const DB_PATH = process.env.KANZ_DB || new URL('../data/kanz.db', import.meta.url).pathname;
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, username TEXT NOT NULL UNIQUE,
  pass_hash TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('owner','accountant','cashier')),
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, contact TEXT, phone TEXT, vat_no TEXT,
  credit_limit REAL NOT NULL DEFAULT 0, opening_balance REAL NOT NULL DEFAULT 0, notes TEXT,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, contact TEXT, phone TEXT, vat_no TEXT,
  opening_balance REAL NOT NULL DEFAULT 0, notes TEXT, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY, sku TEXT UNIQUE, name TEXT NOT NULL, category TEXT, unit TEXT NOT NULL DEFAULT 'pcs',
  cost REAL NOT NULL DEFAULT 0, price REAL NOT NULL DEFAULT 0, stock REAL NOT NULL DEFAULT 0,
  reorder_level REAL NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS stock_moves (
  id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id), date TEXT NOT NULL,
  qty REAL NOT NULL, reason TEXT NOT NULL, ref TEXT, user_id INTEGER
);
CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY, inv_no TEXT UNIQUE, date TEXT NOT NULL, customer_id INTEGER REFERENCES customers(id),
  type TEXT NOT NULL CHECK (type IN ('cash','credit')), payment_mode TEXT,
  subtotal REAL NOT NULL, vat REAL NOT NULL, total REAL NOT NULL,
  credit_days INTEGER, due_date TEXT, description TEXT, notes TEXT,
  status TEXT NOT NULL DEFAULT 'active', source TEXT NOT NULL DEFAULT 'app', created_by INTEGER
);
CREATE TABLE IF NOT EXISTS sale_items (
  id INTEGER PRIMARY KEY, sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id), description TEXT NOT NULL,
  qty REAL NOT NULL, unit_price REAL NOT NULL, amount REAL NOT NULL, unit_cost REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY, bill_no TEXT, date TEXT NOT NULL, supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  description TEXT, subtotal REAL NOT NULL, vat REAL NOT NULL, total REAL NOT NULL,
  terms TEXT NOT NULL CHECK (terms IN ('cash','credit')), payment_mode TEXT, credit_days INTEGER, due_date TEXT, notes TEXT,
  status TEXT NOT NULL DEFAULT 'active', source TEXT NOT NULL DEFAULT 'app', created_by INTEGER
);
CREATE TABLE IF NOT EXISTS purchase_items (
  id INTEGER PRIMARY KEY, purchase_id INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id), description TEXT NOT NULL,
  qty REAL NOT NULL, unit_cost REAL NOT NULL, amount REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS cashbook (
  id INTEGER PRIMARY KEY, date TEXT NOT NULL, ref TEXT, description TEXT, party TEXT, category TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'Cash', receipt REAL NOT NULL DEFAULT 0, payment REAL NOT NULL DEFAULT 0, notes TEXT,
  customer_id INTEGER REFERENCES customers(id), supplier_id INTEGER REFERENCES suppliers(id),
  sale_id INTEGER REFERENCES sales(id) ON DELETE CASCADE, purchase_id INTEGER REFERENCES purchases(id) ON DELETE CASCADE,
  created_by INTEGER
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY, at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, user_id INTEGER, user_name TEXT,
  action TEXT NOT NULL, entity TEXT, entity_id INTEGER, detail TEXT
);
CREATE TABLE IF NOT EXISTS import_issues (
  id INTEGER PRIMARY KEY, severity TEXT NOT NULL, sheet TEXT, row_ref TEXT, message TEXT NOT NULL, resolved INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_cash_date ON cashbook(date);
CREATE INDEX IF NOT EXISTS ix_cash_cust ON cashbook(customer_id);
CREATE INDEX IF NOT EXISTS ix_cash_sup ON cashbook(supplier_id);
CREATE INDEX IF NOT EXISTS ix_sales_cust ON sales(customer_id);
CREATE INDEX IF NOT EXISTS ix_pur_sup ON purchases(supplier_id);
`);

export const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

export function tx(fn) {
  db.exec('BEGIN');
  try { const out = fn(); db.exec('COMMIT'); return out; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
export function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
}
export function audit(user, action, entity, entityId, detail) {
  db.prepare('INSERT INTO audit_log(user_id,user_name,action,entity,entity_id,detail) VALUES(?,?,?,?,?,?)')
    .run(user?.id ?? null, user?.name ?? 'system', action, entity ?? null, entityId ?? null, detail ?? null);
}

// Cashbook categories (mirrors the Excel Setup sheet, plus commission/card fees)
export const CATEGORIES = [
  ['Sales (Counter)', 'Receipt', 1], ['Customer Payment (Credit Invoice)', 'Receipt', 0],
  ['Supplier Refund / Credit Note', 'Receipt', 0], ['Owner Capital Introduced', 'Receipt', 0], ['Other Income', 'Receipt', 0],
  ['Stock / Material Purchases', 'Payment', 1], ['Supplier Payment (Credit Invoices)', 'Payment', 0],
  ['Freight, Customs & Clearance', 'Payment', 1], ['Shop Rent', 'Payment', 1], ['Salaries & Wages', 'Payment', 0],
  ['Electricity, Water & Internet', 'Payment', 1], ['Phone & Communication', 'Payment', 1],
  ['Government Fees & Licences', 'Payment', 0], ['Vehicle & Fuel', 'Payment', 1], ['Repairs & Maintenance', 'Payment', 1],
  ['Marketing & Advertising', 'Payment', 1], ['Bank Charges', 'Payment', 0], ['Card / Commission Fees', 'Payment', 0],
  ['VAT Paid to ZATCA', 'Payment', 0], ['Owner Drawings', 'Payment', 0], ['Miscellaneous Expenses', 'Payment', 1],
  ['Sales (Return)', 'Payment', 1],
].map(([name, type, vat]) => ({ name, type, vat: !!vat }));
export const CAT_CUSTOMER_PAYMENT = 'Customer Payment (Credit Invoice)';
export const CAT_SUPPLIER_PAYMENT = 'Supplier Payment (Credit Invoices)';
export const CAT_SALES = 'Sales (Counter)';
export const CAT_RETURN = 'Sales (Return)';
export const CAT_PURCHASE = 'Stock / Material Purchases';
export const MODES = ['Cash', 'Bank Transfer', 'Mada / Card', 'Cheque', 'Other'];

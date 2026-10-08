import { readFileSync } from 'node:fs';
import { db, tx, r2, setSetting, claimOnce, audit, CAT_CUSTOMER_PAYMENT, CAT_SALES, CAT_RETURN, CAT_PURCHASE } from './db.js';
import { hashPassword } from './auth.js';

const SRC = new URL('../data/excel-export.json', import.meta.url).pathname;
const issueStmt = db.prepare('INSERT INTO import_issues(severity,sheet,row_ref,message) VALUES(?,?,?,?)');
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

function parseItem(desc, amount) {
  const text = norm(desc);
  const m = text.match(/\s*-?\s*(?:(\d+)\s*BOX\s*)?(\d+)\s*PCS?$/i);
  const qty = m ? Number(m[2]) : 1;
  const name = (m ? text.slice(0, m.index) : text).replace(/[-\s]+$/, '').trim() || text;
  return { name, qty, unitPrice: qty ? r2(amount / qty) : amount };
}

function mapCashCategory(row) {
  const cat = norm(row.cat).toLowerCase(), desc = norm(row.desc).toLowerCase();
  if (cat === 'return') return CAT_RETURN;
  if (cat === 'expense') {
    if (/salary|wages/.test(desc)) return 'Salaries & Wages';
    if (/internet|wifi|water|electric/.test(desc)) return 'Electricity, Water & Internet';
    return 'Miscellaneous Expenses';
  }
  return norm(row.cat);
}

export async function importExcel({ adminPassword, adminUsername } = {}) {
  const src = JSON.parse(readFileSync(SRC, 'utf8'));
  return await tx(async () => {
    const n = { customers: 0, suppliers: 0, products: 0, sales: 0, purchases: 0, cashbook: 0 };
    for (const [k, v] of Object.entries({
      company_name: 'Kanz Corner Trading', company_address: 'Saudi Arabia', company_vat_no: '', currency: 'SAR',
      vat_rate: '0.15', financial_year: '2026', opening_cash: '0', opening_bank: '0', default_credit_days: '30',
    })) await setSetting(k, v);

    // --- owner account (only when a password is supplied; otherwise the first visitor creates the admin on the setup screen)
    const password = adminPassword || process.env.KANZ_ADMIN_PASSWORD;
    if (password) {
      const owner = (adminUsername || process.env.KANZ_ADMIN_USERNAME || 'owner').trim();
      await db.prepare("INSERT INTO users(name,username,pass_hash,role) VALUES(?,?,?, 'owner') ON CONFLICT(username) DO NOTHING")
        .run(owner === 'owner' ? 'Owner' : owner, owner, hashPassword(password));
      await claimOnce('setup_complete');
    }

    // --- parties
    const custId = new Map(), supId = new Map();
    for (const c of src.cus) {
      const r = await db.prepare('INSERT INTO customers(name,contact,phone,credit_limit,opening_balance) VALUES(?,?,?,?,?)')
        .run(norm(c.name), (c.phone || '').split(' - ')[0] || null, c.phone || null, c.limit || 0, c.opening || 0);
      custId.set(norm(c.name), Number(r.lastInsertRowid)); n.customers++;
    }
    for (const s of src.sup) {
      const r = await db.prepare('INSERT INTO suppliers(name,phone,opening_balance) VALUES(?,?,?)').run(norm(s.name), s.phone || null, s.opening || 0);
      supId.set(norm(s.name), Number(r.lastInsertRowid)); n.suppliers++;
      if (!src.pur.some((p) => norm(p.supplier) === norm(s.name)))
        await issueStmt.run('info', 'Supplier Debts', s.name, 'Supplier has no purchase bills yet (kept in the supplier list).');
    }

    // --- credit sales (+ product catalogue derived from descriptions)
    const prodId = new Map();
    let seq = 0;
    const noInv = [];
    for (const s of src.cs.sort((a, b) => a.date.localeCompare(b.date))) {
      seq++;
      const cust = custId.get(norm(s.customer));
      const subtotal = r2(s.amt || 0), vat = r2(s.vat || 0), total = r2(s.total ?? subtotal + vat);
      const due = s.due || addDays(s.date, s.days || 0);
      const invNo = s.inv ? String(s.inv) : `LEG-CS-${String(seq).padStart(4, '0')}`;
      if (!s.inv) noInv.push(invNo);
      const sr = await db.prepare(`INSERT INTO sales(inv_no,date,customer_id,type,subtotal,vat,total,credit_days,due_date,description,notes,source)
        VALUES(?,?,?,?,?,?,?,?,?,?,?, 'excel')`).run(invNo, s.date, cust, 'credit', subtotal, vat, total, s.days ?? 0, due, norm(s.desc), s.notes || null);
      const it = parseItem(s.desc, subtotal);
      let pid = prodId.get(it.name.toUpperCase());
      if (!pid) {
        const pr = await db.prepare("INSERT INTO products(sku,name,unit,price,cost,stock,category) VALUES(?,?, 'pcs', ?, 0, 0, 'Imported')")
          .run(`P-${String(prodId.size + 1).padStart(4, '0')}`, it.name, it.unitPrice);
        pid = Number(pr.lastInsertRowid); prodId.set(it.name.toUpperCase(), pid); n.products++;
      } else if (it.unitPrice) await db.prepare('UPDATE products SET price=? WHERE id=?').run(it.unitPrice, pid);
      await db.prepare('INSERT INTO sale_items(sale_id,product_id,description,qty,unit_price,amount) VALUES(?,?,?,?,?,?)')
        .run(sr.lastInsertRowid, pid, norm(s.desc), it.qty, it.unitPrice, subtotal);
      n.sales++;
      if (!subtotal) await issueStmt.run('error', 'Credit Sales', `${s.date} ${s.customer}`, `"${norm(s.desc)}" was entered with no amount. Add the price so the customer balance is correct.`);
      if (!s.due && !s.days) await issueStmt.run('info', 'Credit Sales', `${s.date} ${s.customer}`, 'No credit days / due date. Due date set to the invoice date (immediately due).');
    }
    if (noInv.length) await issueStmt.run('warn', 'Credit Sales', `${noInv.length} invoices`, `Invoices had no number. Temporary numbers ${noInv[0]} … ${noInv.at(-1)} were assigned. Replace with your real invoice numbers.`);

    // --- purchases
    let noBill = 0;
    for (const p of src.pur) {
      if (!p.date) {
        p.date = p.due;
        await issueStmt.run('warn', 'Purchases', `${p.supplier} ${p.bill || ''}`.trim(), `Bill of ${p.total} had no invoice date (Excel flagged "Check date"). The due date ${p.due} was used as the bill date – please correct it.`);
      }
      const sid = supId.get(norm(p.supplier));
      const terms = String(p.terms || '').toLowerCase() === 'credit' ? 'credit' : 'cash';
      const due = terms === 'credit' ? (p.due || addDays(p.date, p.days || 0)) : null;
      if (p.bill == null) noBill++;
      await db.prepare(`INSERT INTO purchases(bill_no,date,supplier_id,description,subtotal,vat,total,terms,credit_days,due_date,notes,source)
        VALUES(?,?,?,?,?,?,?,?,?,?,?, 'excel')`).run(p.bill == null ? null : String(p.bill), p.date, sid, p.desc || null,
        r2(p.amt), r2(p.vat), r2(p.total), terms, p.days ?? 0, due, p.notes || null);
      n.purchases++;
      if (terms === 'cash')
        await issueStmt.run('warn', 'Purchases', `${p.date} ${p.supplier}`, `Cash bill of ${p.total} has no matching cashbook payment on that date. Cashbook shows "PURCHASE SAHER" 28.00 on 2026-09-30 – check whether these are the same purchase.`);
    }
    if (noBill) await issueStmt.run('warn', 'Purchases', `${noBill} bills`, 'Supplier bills with no bill number. Add them from the supplier paperwork.');

    // --- cashbook (split rows that had money in AND out)
    const addCash = db.prepare(`INSERT INTO cashbook(date,ref,description,party,category,mode,receipt,payment,notes,customer_id)
      VALUES(?,?,?,?,?,?,?,?,?,?)`);
    let split = 0, remapped = 0;
    for (const r of src.cash.sort((a, b) => a.date.localeCompare(b.date))) {
      let cat = mapCashCategory(r);
      let rec = r2(r.rec || 0), pay = r2(r.pay || 0), party = norm(r.party), custIdForRow = null;
      if (cat !== norm(r.cat)) remapped++;
      const base = [r.date, r.ref || null, norm(r.desc), party];
      if (rec && pay) {
        split++;
        await addCash.run(...base, cat, r.mode, rec, 0, r.notes || null, null);
        await addCash.run(r.date, r.ref || null, `Commission / fee on ${r.ref || 'sale'}`, party, 'Card / Commission Fees', r.mode, 0, pay, r.notes || null, null);
        n.cashbook += 2; continue;
      }
      if (cat === CAT_SALES && pay && !rec) { cat = 'Card / Commission Fees'; remapped++; }
      // Receipt equals Kathoom's only invoice (93.73): the Excel ledger treated it as their payment
      if (r.ref === 'INV-1018' && rec === 93.73) {
        cat = CAT_CUSTOMER_PAYMENT; party = 'KATHOOM AL KHOBAR TRADING CO.'; custIdForRow = custId.get(party);
        await issueStmt.run('warn', 'Cashbook', 'INV-1018 · 2026-10-06', 'Receipt 93.73 labelled "market sale" equals Kathoom Al Khobar\'s credit invoice. Imported as THEIR PAYMENT (so their balance is settled). If it really was a counter sale, edit this entry.');
      }
      await addCash.run(...base.slice(0, 3), party, cat, r.mode, rec, pay, r.notes || null, custIdForRow);
      n.cashbook++;
    }
    if (split) await issueStmt.run('info', 'Cashbook', `${split} rows`, 'Rows that had both "Receipt" and "Payment" were split into two lines (sale + card commission). Totals are unchanged.');
    if (remapped) await issueStmt.run('info', 'Cashbook', `${remapped} rows`, 'Categories not on your category list ("Expense", "return ", commission payments under Sales) were mapped to the right ones (Salaries, Internet/Water, Miscellaneous, Sales Return, Card / Commission Fees).');
    await issueStmt.run('warn', 'Cashbook', 'qtn 1030 · 2026-10-01', 'Receipt 2,411.38 is referenced to a quotation (qtn 1030), not an invoice. Confirm an invoice exists for it.');
    await issueStmt.run('info', 'Cashbook', 'INV-1010 · 2026-09-21', 'Large counter sale of 4,715.00 to "Riyadh". If this was a repeat customer, add them as a customer.');
    await issueStmt.run('warn', 'Excel formulas', 'Profit & Loss', 'Your Excel deducted the sales return (9.20, VAT included) from VAT-exclusive revenue. The new system deducts 8.00 (excl. VAT), so net sales differ by 1.20.');
    await issueStmt.run('info', 'Products', `${n.products} products`, 'Your workbook had no product list. Products were created from credit-sale descriptions (price = last sold unit price, cost 0, stock 0). Enter cost prices and opening stock on the Products page.');

    const cashNow = (await db.prepare("SELECT SUM(receipt-payment) v FROM cashbook WHERE mode='Cash'").get()).v;
    if (cashNow < 0) await issueStmt.run('warn', 'Cashbook', 'Cash in hand', `Cash in hand is negative (${r2(cashNow)}): cash payments are larger than cash receipts. Check your opening cash, or whether some "Mada / Card" or bank receipts were really cash (or cash withdrawals from the bank are missing).`);

    await audit(null, 'import', 'excel', null, JSON.stringify(n));
    return { counts: n };
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if ((await db.prepare('SELECT COUNT(*) c FROM users').get()).c > 0) {
    console.error('Database already has data. Delete data/kanz.db to re-import.');
    process.exit(1);
  }
  const out = await importExcel();
  console.log('Imported:', out.counts);
  console.log('\nNow run `npm start` and open the site: the first screen lets you create your admin account.');
}

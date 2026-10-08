// Create / edit a sales invoice (shared by POST and PUT so both follow the same rules).
import { db, tx, r2, getSetting, audit, nextNumber, CAT_SALES } from './db.js';
import { can } from './auth.js';
import { HttpError, bad, num, date, str, addDays, vatRate, modeOk, cashEntry } from './util.js';
import { customerLedger } from './ledger.js';

export async function parseSale(b, user, existing = null) {
  const type = existing ? existing.type : (b.type === 'credit' ? 'credit' : 'cash');
  const d = date(b.date);
  if (!Array.isArray(b.items) || !b.items.length) throw bad('Add at least one item');
  const items = await Promise.all(b.items.map(async (i, n) => {
    const qty = num(i.qty, `Item ${n + 1} quantity`, { allowZero: false }), price = num(i.unit_price, `Item ${n + 1} price`);
    let p = null;
    if (i.product_id) { p = await db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(i.product_id); if (!p) throw bad(`Item ${n + 1}: product not found`); }
    const description = str(i.description, 200) ?? p?.name;
    if (!description) throw bad(`Item ${n + 1} needs a description or product`);
    return { productId: p?.id ?? null, description, qty, price, amount: r2(qty * price) };
  }));
  const subtotal = r2(items.reduce((s, i) => s + i.amount, 0)), vat = r2(subtotal * vatRate()), total = r2(subtotal + vat);
  let cust = null;
  if (b.customer_id) { cust = (await customerLedger()).find((c) => c.id === Number(b.customer_id)); if (!cust) throw bad('Customer not found'); }
  if (type === 'credit') {
    if (!cust) throw bad('Choose a customer for a credit sale');
    const already = existing && existing.customer_id === cust.id && existing.status === 'active' ? existing.total : 0; // do not count this invoice twice
    if (cust.credit_limit > 0 && cust.balance - already + total > cust.credit_limit && !(b.override_limit && can(user, 'parties')))
      throw new HttpError(409, `Credit limit exceeded: ${cust.name} owes ${(cust.balance - already).toFixed(2)} of ${cust.credit_limit.toFixed(2)}. An owner/accountant can override.`);
  }
  const days = type === 'credit' ? Math.round(num(b.credit_days ?? getSetting('default_credit_days', '30'), 'Credit days')) : null;
  const mode = type === 'cash' ? modeOk(b.payment_mode ?? 'Cash') : null;
  return { type, d, items, subtotal, vat, total, cust, days, mode, notes: str(b.notes, 300), allowNegative: !!b.allow_negative };
}

export async function saveSale(p, user, existing = null) {
  return tx(async () => {
    let sid, invNo;
    const stockMoves = !existing || existing.source !== 'excel'; // imported Excel lines never moved stock
    const description = p.items.map((i) => i.description).join('; ').slice(0, 300);
    if (!existing) {
      invNo = `INV-${await nextNumber('next_invoice')}`;
      const sr = await db.prepare(`INSERT INTO sales(inv_no,date,customer_id,type,payment_mode,subtotal,vat,total,credit_days,due_date,description,notes,created_by)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(invNo, p.d, p.cust?.id ?? null, p.type, p.mode, p.subtotal, p.vat, p.total, p.days, p.type === 'credit' ? addDays(p.d, p.days) : null, description, p.notes, user.id);
      sid = Number(sr.lastInsertRowid);
    } else {
      sid = existing.id; invNo = existing.inv_no;
      if (stockMoves) for (const o of await db.prepare('SELECT * FROM sale_items WHERE sale_id=? AND product_id IS NOT NULL').all(sid)) {
        await db.prepare('UPDATE products SET stock=stock+? WHERE id=?').run(o.qty, o.product_id);
        await db.prepare("INSERT INTO stock_moves(product_id,date,qty,reason,ref,user_id) VALUES(?,?,?,'Edit invoice (reverse)',?,?)").run(o.product_id, p.d, o.qty, invNo, user.id);
      }
      await db.prepare('DELETE FROM sale_items WHERE sale_id=?').run(sid);
      await db.prepare(`UPDATE sales SET date=?,customer_id=?,payment_mode=?,subtotal=?,vat=?,total=?,credit_days=?,due_date=?,description=?,notes=? WHERE id=?`)
        .run(p.d, p.cust?.id ?? null, p.mode, p.subtotal, p.vat, p.total, p.days, p.type === 'credit' ? addDays(p.d, p.days) : null, description, p.notes, sid);
    }
    for (const i of p.items) {
      const prod = i.productId ? await db.prepare('SELECT * FROM products WHERE id=?').get(i.productId) : null;
      if (stockMoves && prod && !p.allowNegative && prod.stock < i.qty) throw new HttpError(409, `Not enough stock for "${prod.name}" (have ${prod.stock}, need ${i.qty}).`);
      await db.prepare('INSERT INTO sale_items(sale_id,product_id,description,qty,unit_price,amount,unit_cost) VALUES(?,?,?,?,?,?,?)').run(sid, prod?.id ?? null, i.description, i.qty, i.price, i.amount, prod?.cost ?? 0);
      if (stockMoves && prod) {
        await db.prepare('UPDATE products SET stock=stock-? WHERE id=?').run(i.qty, prod.id);
        await db.prepare("INSERT INTO stock_moves(product_id,date,qty,reason,ref,user_id) VALUES(?,?,?,'Sale',?,?)").run(prod.id, p.d, -i.qty, invNo, user.id);
      }
    }
    if (p.type === 'cash') {
      if (!existing) await cashEntry({ date: p.d, ref: invNo, description: 'Counter sale', party: p.cust?.name ?? 'Walk-in customer', category: CAT_SALES, mode: p.mode, receipt: p.total, sale_id: sid, customer_id: p.cust?.id }, user);
      else await db.prepare('UPDATE cashbook SET date=?, party=?, mode=?, receipt=?, customer_id=? WHERE sale_id=?').run(p.d, p.cust?.name ?? 'Walk-in customer', p.mode, p.total, p.cust?.id ?? null, sid);
    }
    await audit(user, existing ? 'edit' : 'create', 'sales', sid, `${invNo} ${p.total}`);
    return { id: sid, inv_no: invNo };
  });
}

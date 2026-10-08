// Create / edit a supplier bill (shared by POST and PUT).
import { db, tx, r2, getSetting, audit, CAT_PURCHASE } from './db.js';
import { bad, num, date, str, addDays, vatRate, modeOk, cashEntry } from './util.js';

export async function savePurchase(b, user, existing = null) {
  const d = date(b.date), terms = existing ? existing.terms : (b.terms === 'credit' ? 'credit' : 'cash');
  const sup = await db.prepare('SELECT * FROM suppliers WHERE id=? AND active=1').get(b.supplier_id);
  if (!sup) throw bad('Choose a supplier');
  let items = [];
  if (Array.isArray(b.items) && b.items.length) {
    items = await Promise.all(b.items.map(async (i, n) => {
      const qty = num(i.qty, `Item ${n + 1} quantity`, { allowZero: false }), cost = num(i.unit_cost, `Item ${n + 1} cost`);
      const p = i.product_id ? await db.prepare('SELECT * FROM products WHERE id=?').get(i.product_id) : null;
      const description = str(i.description, 200) ?? p?.name; if (!description) throw bad(`Item ${n + 1} needs a description or product`);
      return { productId: p?.id ?? null, description, qty, cost, amount: r2(qty * cost) };
    }));
  }
  const subtotal = items.length ? r2(items.reduce((s, i) => s + i.amount, 0)) : num(b.subtotal, 'Amount excl. VAT', { allowZero: false });
  const vat = b.vat != null && b.vat !== '' ? r2(num(b.vat, 'VAT')) : r2(subtotal * vatRate());
  const total = r2(subtotal + vat);
  const days = terms === 'credit' ? Math.round(num(b.credit_days ?? getSetting('default_credit_days', '30'), 'Credit days')) : null;
  const mode = terms === 'cash' ? modeOk(b.payment_mode ?? 'Cash') : null;
  const due = terms === 'credit' ? addDays(d, days) : null;
  const desc = str(b.description, 300) ?? (items.map((i) => i.description).join('; ').slice(0, 300) || null);
  return tx(async () => {
    let pid;
    if (!existing) {
      const r = await db.prepare(`INSERT INTO purchases(bill_no,date,supplier_id,description,subtotal,vat,total,terms,payment_mode,credit_days,due_date,notes,created_by)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(str(b.bill_no, 60), d, sup.id, desc, subtotal, vat, total, terms, mode, days, due, str(b.notes, 300), user.id);
      pid = Number(r.lastInsertRowid);
    } else {
      pid = existing.id;
      for (const o of await db.prepare('SELECT * FROM purchase_items WHERE purchase_id=? AND product_id IS NOT NULL').all(pid)) {
        await db.prepare('UPDATE products SET stock=stock-? WHERE id=?').run(o.qty, o.product_id); // cost average is left as is
        await db.prepare("INSERT INTO stock_moves(product_id,date,qty,reason,ref,user_id) VALUES(?,?,?,'Edit bill (reverse)',?,?)").run(o.product_id, d, -o.qty, existing.bill_no, user.id);
      }
      await db.prepare('DELETE FROM purchase_items WHERE purchase_id=?').run(pid);
      await db.prepare(`UPDATE purchases SET bill_no=?,date=?,supplier_id=?,description=?,subtotal=?,vat=?,total=?,payment_mode=?,credit_days=?,due_date=?,notes=? WHERE id=?`)
        .run(str(b.bill_no, 60), d, sup.id, desc, subtotal, vat, total, mode, days, due, str(b.notes, 300), pid);
    }
    for (const i of items) {
      await db.prepare('INSERT INTO purchase_items(purchase_id,product_id,description,qty,unit_cost,amount) VALUES(?,?,?,?,?,?)').run(pid, i.productId, i.description, i.qty, i.cost, i.amount);
      if (i.productId) {
        const p = await db.prepare('SELECT * FROM products WHERE id=?').get(i.productId);
        const newStock = p.stock + i.qty;
        const avg = p.stock > 0 ? r2((p.stock * p.cost + i.qty * i.cost) / newStock) : i.cost; // weighted average cost
        await db.prepare('UPDATE products SET stock=?, cost=? WHERE id=?').run(newStock, avg, p.id);
        await db.prepare("INSERT INTO stock_moves(product_id,date,qty,reason,ref,user_id) VALUES(?,?,?,'Purchase',?,?)").run(p.id, d, i.qty, b.bill_no ?? null, user.id);
      }
    }
    if (terms === 'cash') {
      if (!existing) await cashEntry({ date: d, ref: str(b.bill_no, 40), description: `Purchase – ${sup.name}`, party: sup.name, category: CAT_PURCHASE, mode, payment: total, purchase_id: pid, supplier_id: sup.id }, user);
      else await db.prepare('UPDATE cashbook SET date=?, ref=?, description=?, party=?, mode=?, payment=?, supplier_id=? WHERE purchase_id=?').run(d, str(b.bill_no, 40), `Purchase – ${sup.name}`, sup.name, mode, total, sup.id, pid);
    }
    await audit(user, existing ? 'edit' : 'create', 'purchases', pid, `${sup.name} ${total}`);
    return pid;
  });
}

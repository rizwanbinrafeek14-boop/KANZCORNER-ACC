// Sales returns / credit notes, customer statements, accrual report, printable documents.
import { db, tx, r2, audit, nextNumber, CAT_RETURN, allSettings } from './db.js';
import { readToken } from './auth.js';
import { HttpError, bad, num, date, str, vatRate, modeOk, need, cashEntry, iso } from './util.js';
import { accrualReport, customerStatement } from './ledger.js';
import { esc, money, qrFor, header, docPage } from './docs.js';

const cookieToken = (req) => (req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith('kanz_session='))?.slice('kanz_session='.length);

export function registerFeatures(app) {
  // ---- list / read returns
  app.get('/api/returns', need('view'), async (req, res) => {
    res.json(await db.prepare(`SELECT r.id,r.ret_no,r.date,r.refund_type,r.refund_mode,r.total,r.status,s.inv_no,c.name customer
      FROM sale_returns r JOIN sales s ON s.id=r.sale_id LEFT JOIN customers c ON c.id=r.customer_id ORDER BY r.date DESC, r.id DESC LIMIT 500`).all());
  });
  app.get('/api/sales/:id/returns', need('view'), async (req, res) => {
    res.json(await db.prepare('SELECT id,ret_no,date,refund_type,refund_mode,total,status FROM sale_returns WHERE sale_id=? ORDER BY id DESC').all(req.params.id));
  });

  // ---- create a return (credit note) against an invoice
  app.post('/api/sales/:id/returns', need('sales'), async (req, res) => {
    const sale = await db.prepare('SELECT s.*, c.name customer FROM sales s LEFT JOIN customers c ON c.id=s.customer_id WHERE s.id=?').get(req.params.id);
    if (!sale) throw new HttpError(404, 'Invoice not found');
    if (sale.status !== 'active') throw bad('Only an active invoice can have returns');
    const b = req.body ?? {};
    const d = date(b.date);
    const refundType = b.refund_type === 'credit' ? 'credit' : 'cash';
    if (refundType === 'credit' && !sale.customer_id) throw bad('A credit note to the customer account needs a customer on the invoice. Refund in cash instead.');
    const mode = refundType === 'cash' ? modeOk(b.refund_mode ?? 'Cash') : null;
    if (!Array.isArray(b.items) || !b.items.length) throw bad('Choose at least one item to return');
    const id = await tx(async () => {
      const lines = [];
      for (const [n, it] of b.items.entries()) {
        const qty = num(it.qty, `Return quantity ${n + 1}`, { allowZero: true });
        if (!qty) continue;
        const si = await db.prepare('SELECT * FROM sale_items WHERE id=? AND sale_id=?').get(it.sale_item_id, sale.id);
        if (!si) throw bad('That item is not on this invoice');
        const done = (await db.prepare(`SELECT COALESCE(SUM(ri.qty),0) q FROM sale_return_items ri JOIN sale_returns r ON r.id=ri.return_id WHERE ri.sale_item_id=? AND r.status='active'`).get(si.id)).q;
        if (qty > si.qty - done + 1e-9) throw bad(`Cannot return ${qty} of "${si.description}": only ${si.qty - done} left to return`);
        lines.push({ si, qty, amount: r2(qty * si.unit_price) });
      }
      if (!lines.length) throw bad('Enter a quantity for at least one item');
      const subtotal = r2(lines.reduce((s, l) => s + l.amount, 0)), vat = r2(subtotal * vatRate()), total = r2(subtotal + vat);
      const retNo = `CN-${await nextNumber('next_return')}`;
      const r = await db.prepare(`INSERT INTO sale_returns(ret_no,date,sale_id,customer_id,refund_type,refund_mode,subtotal,vat,total,notes,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
        .run(retNo, d, sale.id, sale.customer_id, refundType, mode, subtotal, vat, total, str(b.notes, 300), req.user.id);
      const rid = Number(r.lastInsertRowid);
      for (const l of lines) {
        await db.prepare('INSERT INTO sale_return_items(return_id,sale_item_id,product_id,description,qty,unit_price,amount,unit_cost) VALUES(?,?,?,?,?,?,?,?)')
          .run(rid, l.si.id, l.si.product_id, l.si.description, l.qty, l.si.unit_price, l.amount, l.si.unit_cost);
        if (l.si.product_id && sale.source !== 'excel') { // put the goods back on the shelf
          await db.prepare('UPDATE products SET stock=stock+? WHERE id=?').run(l.qty, l.si.product_id);
          await db.prepare("INSERT INTO stock_moves(product_id,date,qty,reason,ref,user_id) VALUES(?,?,?,'Sales return',?,?)").run(l.si.product_id, d, l.qty, retNo, req.user.id);
        }
      }
      if (refundType === 'cash')
        await cashEntry({ date: d, ref: retNo, description: `Refund – ${sale.inv_no}`, party: sale.customer ?? 'Walk-in customer', category: CAT_RETURN, mode, payment: total, return_id: rid, customer_id: sale.customer_id }, req.user);
      await audit(req.user, 'create', 'sale_returns', rid, `${retNo} ${total} (${sale.inv_no})`);
      return { id: rid, ret_no: retNo, total };
    });
    res.status(201).json(id);
  });

  app.post('/api/returns/:id/void', need('purchases'), async (req, res) => {
    const r = await db.prepare('SELECT r.*, s.source FROM sale_returns r JOIN sales s ON s.id=r.sale_id WHERE r.id=?').get(req.params.id);
    if (!r) throw new HttpError(404, 'Credit note not found');
    if (r.status === 'void') throw bad('Already voided');
    await tx(async () => {
      if (r.source !== 'excel') for (const i of await db.prepare('SELECT * FROM sale_return_items WHERE return_id=? AND product_id IS NOT NULL').all(r.id)) {
        await db.prepare('UPDATE products SET stock=stock-? WHERE id=?').run(i.qty, i.product_id);
        await db.prepare("INSERT INTO stock_moves(product_id,date,qty,reason,ref,user_id) VALUES(?,?,?,'Void sales return',?,?)").run(i.product_id, new Date().toISOString().slice(0, 10), -i.qty, r.ret_no, req.user.id);
      }
      await db.prepare('DELETE FROM cashbook WHERE return_id=?').run(r.id);
      await db.prepare("UPDATE sale_returns SET status='void' WHERE id=?").run(r.id);
    });
    await audit(req.user, 'void', 'sale_returns', r.id, r.ret_no);
    res.json({ ok: true });
  });

  // ---- reports / statements (JSON)
  app.get('/api/reports/accrual', need('reports'), async (req, res) => res.json(await accrualReport(Number(req.query.year) || undefined)));
  app.get('/api/customers/:id/statement', need('view'), async (req, res) => {
    const from = iso.test(req.query.from ?? '') ? req.query.from : '', to = iso.test(req.query.to ?? '') ? req.query.to : '';
    const s = await customerStatement(Number(req.params.id), from, to);
    if (!s) throw new HttpError(404, 'Customer not found');
    res.json(s);
  });

  // ---- printable pages (cookie-authenticated, open in a new tab)
  const gate = async (req, res) => { const u = await readToken(cookieToken(req)); if (!u) { res.status(401).send('Please sign in first'); return null; } return u; };

  app.get('/creditnote/:id', async (req, res) => {
    if (!(await gate(req, res))) return;
    const r = await db.prepare(`SELECT r.*, s.inv_no, c.name customer, c.phone, c.vat_no cvat FROM sale_returns r JOIN sales s ON s.id=r.sale_id LEFT JOIN customers c ON c.id=r.customer_id WHERE r.id=?`).get(req.params.id);
    if (!r) return res.status(404).send('Credit note not found');
    const items = await db.prepare('SELECT * FROM sale_return_items WHERE return_id=? ORDER BY id').all(r.id);
    const st = allSettings();
    const qr = await qrFor(r.date, r.total, r.vat);
    res.type('html').send(docPage(`Credit note ${r.ret_no}`, `${header(`${r.status === 'void' ? 'VOID – ' : ''}Credit Note`, `<p><b>${esc(r.ret_no)}</b></p><p>Date: ${esc(r.date)}</p><p>Against invoice ${esc(r.inv_no)}</p>`)}
<section class="to"><b>Customer:</b> ${esc(r.customer || 'Walk-in customer')} ${r.phone ? `· ${esc(r.phone)}` : ''} ${r.cvat ? `· VAT ${esc(r.cvat)}` : ''}</section>
<table><thead><tr><th>#</th><th>Description</th><th class="n">Qty</th><th class="n">Unit price</th><th class="n">Amount</th></tr></thead><tbody>
${items.map((i, n) => `<tr><td>${n + 1}</td><td>${esc(i.description)}</td><td class="n">${i.qty}</td><td class="n">${money(i.unit_price)}</td><td class="n">${money(i.amount)}</td></tr>`).join('')}</tbody></table>
<footer><img src="${qr}" alt="QR" width="120" height="120"><table class="tot"><tr><td>Subtotal (excl. VAT)</td><td class="n">${money(r.subtotal)}</td></tr><tr><td>VAT ${Math.round(Number(st.vat_rate) * 100)}%</td><td class="n">${money(r.vat)}</td></tr><tr class="g"><td>Credit total (${esc(st.currency)})</td><td class="n">${money(r.total)}</td></tr></table></footer>
<p class="note">${r.refund_type === 'credit' ? 'Credited to the customer account.' : `Refunded by ${esc(r.refund_mode)}.`} ${esc(r.notes || '')}</p>`));
  });

  app.get('/statement/:id', async (req, res) => {
    if (!(await gate(req, res))) return;
    const from = iso.test(req.query.from ?? '') ? req.query.from : '', to = iso.test(req.query.to ?? '') ? req.query.to : '';
    const s = await customerStatement(Number(req.params.id), from, to);
    if (!s) return res.status(404).send('Customer not found');
    const today = new Date().toISOString().slice(0, 10);
    res.type('html').send(docPage(`Statement ${s.customer.name}`, `${header('Statement of Account', `<p><b>${esc(s.customer.name)}</b></p><p>${from ? `From ${esc(from)} ` : ''}to ${esc(to || today)}</p>`)}
<section class="to"><b>Customer:</b> ${esc(s.customer.name)} ${s.customer.phone ? `· ${esc(s.customer.phone)}` : ''} ${s.customer.vat_no ? `· VAT ${esc(s.customer.vat_no)}` : ''}</section>
<table><thead><tr><th>Date</th><th>Type</th><th>Ref</th><th class="n">Debit</th><th class="n">Credit</th><th class="n">Balance</th></tr></thead><tbody>
<tr><td colspan="5"><i>Opening balance</i></td><td class="n">${money(s.opening)}</td></tr>
${s.rows.map((r) => `<tr><td>${esc(r.date)}</td><td>${esc(r.kind)}</td><td>${esc(r.ref)}</td><td class="n">${r.debit ? money(r.debit) : ''}</td><td class="n">${r.credit ? money(r.credit) : ''}</td><td class="n">${money(r.balance)}</td></tr>`).join('')}
</tbody></table>
<footer><div><p><b>Ageing</b></p><p>0–30 days: ${money(s.ageing.current)}</p><p>31–60 days: ${money(s.ageing.d31_60)}</p><p>61–90 days: ${money(s.ageing.d61_90)}</p><p>Over 90 days: ${money(s.ageing.over90)}</p><p>Overdue: ${money(s.ageing.overdue)}</p></div>
<table class="tot"><tr class="g"><td>Balance due (SAR)</td><td class="n">${money(s.closing)}</td></tr></table></footer>
<p class="note">Please settle any overdue amount. Thank you for your business.</p>`));
  });
}

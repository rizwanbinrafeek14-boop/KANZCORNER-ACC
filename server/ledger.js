import { db, r2, getSetting, CAT_CUSTOMER_PAYMENT, CAT_SUPPLIER_PAYMENT, CAT_SALES, CAT_RETURN, CAT_PURCHASE, CATEGORIES } from './db.js';

const vatRate = () => Number(getSetting('vat_rate', '0.15'));
const today = () => new Date().toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.floor((new Date(a) - new Date(b)) / 86400000);

export async function cashPosition(asOf = '9999-12-31') {
  const open = Number(getSetting('opening_cash', 0)), openBank = Number(getSetting('opening_bank', 0));
  const rows = await db.prepare(`SELECT CASE WHEN mode='Cash' THEN 'cash' ELSE 'bank' END k, SUM(receipt) r, SUM(payment) p
    FROM cashbook WHERE date<=? GROUP BY k`).all(asOf);
  const g = (k) => rows.find((x) => x.k === k) ?? { r: 0, p: 0 };
  const cash = r2(open + g('cash').r - g('cash').p), bank = r2(openBank + g('bank').r - g('bank').p);
  return { cash, bank, total: r2(cash + bank), receipts: r2(g('cash').r + g('bank').r), payments: r2(g('cash').p + g('bank').p) };
}

// Ageing buckets by invoice age (same rule as the Excel); "overdue" is by due date.
function ageing(invoices, balance, asOf) {
  const out = { overdue: 0, b0_30: 0, b31_60: 0, b61_90: 0, b90: 0 };
  if (balance <= 0) return out;
  // payments are applied to the OLDEST invoices first (FIFO); what remains is outstanding
  let toSettle = r2(invoices.reduce((s, i) => s + i.total, 0) - balance);
  for (const inv of [...invoices].sort((a, b) => a.date.localeCompare(b.date))) {
    let open = inv.total;
    if (toSettle > 0) { const used = Math.min(open, toSettle); open = r2(open - used); toSettle = r2(toSettle - used); }
    if (open <= 0) continue;
    const age = daysBetween(asOf, inv.date);
    if (age <= 30) out.b0_30 += open; else if (age <= 60) out.b31_60 += open; else if (age <= 90) out.b61_90 += open; else out.b90 += open;
    if (inv.due_date && inv.due_date < asOf) out.overdue += open;
  }
  for (const k of Object.keys(out)) out[k] = r2(out[k]);
  return out;
}

export async function customerLedger(asOf = today()) {
  const custs = await db.prepare('SELECT * FROM customers WHERE active=1 ORDER BY name').all();
  const sales = await db.prepare("SELECT customer_id, date, due_date, total FROM sales WHERE type='credit' AND status='active' AND customer_id IS NOT NULL").all();
  const pays = await db.prepare(`SELECT customer_id, SUM(receipt) paid, MAX(date) last FROM cashbook WHERE category=? AND customer_id IS NOT NULL GROUP BY customer_id`).all(CAT_CUSTOMER_PAYMENT);
  const rets = await db.prepare(`SELECT customer_id, SUM(total) returned FROM sale_returns WHERE status='active' AND refund_type='credit' AND customer_id IS NOT NULL GROUP BY customer_id`).all();
  return custs.map((c) => {
    const inv = sales.filter((s) => s.customer_id === c.id);
    const credit = r2(inv.reduce((s, i) => s + i.total, 0));
    const p = pays.find((x) => x.customer_id === c.id);
    const returned = r2(rets.find((x) => x.customer_id === c.id)?.returned ?? 0);
    const paid = r2(p?.paid ?? 0), balance = r2(c.opening_balance + credit - paid - returned);
    const openInv = c.opening_balance ? [{ date: '1900-01-01', due_date: '1900-01-01', total: c.opening_balance }, ...inv] : inv;
    const ag = ageing(openInv, balance, asOf);
    const status = balance < 0 ? 'Advance' : balance === 0 ? 'Settled' : ag.overdue > 0 ? 'Overdue' : 'Current';
    return { ...c, credit, paid, returned, balance, last_payment: p?.last ?? null, ...ag, status,
      over_limit: c.credit_limit > 0 && balance > c.credit_limit, available: r2(c.credit_limit - balance) };
  });
}

export async function supplierLedger(asOf = today()) {
  const sups = await db.prepare('SELECT * FROM suppliers WHERE active=1 ORDER BY name').all();
  const purs = await db.prepare("SELECT supplier_id, date, due_date, total FROM purchases WHERE terms='credit' AND status='active'").all();
  const pays = await db.prepare(`SELECT supplier_id, SUM(payment) paid, MAX(date) last FROM cashbook WHERE category=? AND supplier_id IS NOT NULL GROUP BY supplier_id`).all(CAT_SUPPLIER_PAYMENT);
  return sups.map((s) => {
    const inv = purs.filter((p) => p.supplier_id === s.id);
    const credit = r2(inv.reduce((a, i) => a + i.total, 0));
    const p = pays.find((x) => x.supplier_id === s.id);
    const paid = r2(p?.paid ?? 0), balance = r2(s.opening_balance + credit - paid);
    const openInv = s.opening_balance ? [{ date: '1900-01-01', due_date: '1900-01-01', total: s.opening_balance }, ...inv] : inv;
    const ag = ageing(openInv, balance, asOf);
    const status = balance < 0 ? 'Overpaid' : balance === 0 ? 'Settled' : ag.overdue > 0 ? 'Overdue' : 'Current';
    return { ...s, credit, paid, balance, last_payment: p?.last ?? null, ...ag, status };
  });
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const zero = () => Array(12).fill(0);
const sumTo = (arr) => r2(arr.reduce((a, b) => a + b, 0));

// Monthly aggregates for one financial year, cash-basis like the Excel (cashbook + credit registers)
export async function yearReport(year = Number(getSetting('financial_year', new Date().getFullYear()))) {
  const vr = vatRate(), vatShare = vr / (1 + vr);
  const catVat = new Map(CATEGORIES.map((c) => [c.name, c.vat]));
  const rows = await db.prepare(`SELECT CAST(substr(date,6,2) AS INTEGER) m, category, SUM(receipt) r, SUM(payment) p
    FROM cashbook WHERE substr(date,1,4)=? GROUP BY m, category`).all(String(year));
  const cs = await db.prepare(`SELECT CAST(substr(date,6,2) AS INTEGER) m, SUM(subtotal) s, SUM(vat) v FROM sales
    WHERE type='credit' AND status='active' AND substr(date,1,4)=? GROUP BY m`).all(String(year));
  const cp = await db.prepare(`SELECT CAST(substr(date,6,2) AS INTEGER) m, SUM(subtotal) s, SUM(vat) v FROM purchases
    WHERE terms='credit' AND status='active' AND substr(date,1,4)=? GROUP BY m`).all(String(year));

  const receipts = zero(), payments = zero();
  const outCash = zero(), outRet = zero(), outCredit = zero(), inCash = zero(), inCredit = zero();
  const revCash = zero(), revCredit = zero(), revRet = zero(), cogsCash = zero(), cogsCredit = zero(), other = zero();
  const exp = {};
  for (const x of rows) {
    const i = x.m - 1;
    receipts[i] += x.r; payments[i] += x.p;
    const vatable = catVat.get(x.category);
    if (x.category === CAT_SALES) { revCash[i] += x.r / (1 + vr); outCash[i] += x.r * vatShare; }
    else if (x.category === CAT_RETURN) { revRet[i] += x.p / (1 + vr); outRet[i] += x.p * vatShare; }
    else if (x.category === 'Other Income') other[i] += x.r / (1 + vr);
    else if (x.category === CAT_PURCHASE) { cogsCash[i] += x.p / (1 + vr); inCash[i] += x.p * vatShare; }
    else if (x.p && !['Owner Drawings', 'VAT Paid to ZATCA', CAT_SUPPLIER_PAYMENT, CAT_RETURN].includes(x.category)) {
      const net = vatable ? x.p / (1 + vr) : x.p;
      (exp[x.category] ??= zero())[i] += net;
      if (vatable) inCash[i] += x.p * vatShare;
    }
  }
  for (const x of cs) { revCredit[x.m - 1] += x.s; outCredit[x.m - 1] += x.v; }
  const crn = await db.prepare(`SELECT CAST(substr(date,6,2) AS INTEGER) m, SUM(subtotal) s, SUM(vat) v FROM sale_returns
    WHERE status='active' AND refund_type='credit' AND substr(date,1,4)=? GROUP BY m`).all(String(year));
  for (const x of crn) { revRet[x.m - 1] += x.s; outRet[x.m - 1] += x.v; }
  for (const x of cp) { cogsCredit[x.m - 1] += x.s; inCredit[x.m - 1] += x.v; }

  const open = Number(getSetting('opening_cash', 0)) + Number(getSetting('opening_bank', 0));
  const opening = [], closing = [];
  let bal = open;
  for (let i = 0; i < 12; i++) { opening.push(r2(bal)); bal += receipts[i] - payments[i]; closing.push(r2(bal)); }
  const add = (...a) => a[0].map((_, i) => a.reduce((s, x) => s + x[i], 0));
  const sub = (a, b) => a.map((v, i) => v - b[i]);
  const R = (a) => a.map(r2);

  const netSales = sub(add(revCash, revCredit), revRet);
  const cogs = add(cogsCash, cogsCredit);
  const gross = sub(netSales, cogs);
  const expKeys = Object.keys(exp).sort();
  const totalExp = expKeys.length ? add(...expKeys.map((k) => exp[k])) : zero();
  const net = sub(add(gross, other), totalExp);
  const outTotal = sub(add(outCash, outCredit), outRet), inTotal = add(inCash, inCredit);

  return {
    year, months: MONTHS,
    monthly: { opening, receipts: R(receipts), payments: R(payments), net: R(sub(receipts, payments)), closing },
    vat: { outputCash: R(outCash), outputCredit: R(outCredit), returns: R(outRet), outputTotal: R(outTotal),
      inputCash: R(inCash), inputCredit: R(inCredit), inputTotal: R(inTotal), payable: R(sub(outTotal, inTotal)) },
    pnl: { salesCash: R(revCash), salesCredit: R(revCredit), returns: R(revRet), netSales: R(netSales),
      cogsCash: R(cogsCash), cogsCredit: R(cogsCredit), cogs: R(cogs), gross: R(gross), other: R(other),
      expenses: Object.fromEntries(expKeys.map((k) => [k, R(exp[k])])), totalExpenses: R(totalExp), net: R(net) },
    totals: { receipts: sumTo(receipts), payments: sumTo(payments), netSales: sumTo(netSales), net: sumTo(net) },
  };
}

export async function dashboard() {
  const year = Number(getSetting('financial_year', new Date().getFullYear()));
  const asOf = today();
  const rep = await yearReport(year);
  const cash = await cashPosition();
  const cust = await customerLedger(asOf), sup = await supplierLedger(asOf);
  const m = new Date().getMonth();
  const low = await db.prepare('SELECT id,sku,name,stock,reorder_level,unit FROM products WHERE active=1 AND stock<=reorder_level AND reorder_level>0 ORDER BY stock LIMIT 8').all();
  const stockValue = (await db.prepare('SELECT COALESCE(SUM(stock*cost),0) v FROM products WHERE active=1 AND stock>0').get()).v;
  const top = await db.prepare(`SELECT c.name, SUM(s.total) total FROM sales s JOIN customers c ON c.id=s.customer_id WHERE s.status='active' GROUP BY c.id ORDER BY total DESC LIMIT 5`).all();
  const recent = await db.prepare('SELECT * FROM cashbook ORDER BY date DESC, id DESC LIMIT 8').all();
  const sum = (a, k) => r2(a.reduce((s, x) => s + x[k], 0));
  return {
    year, asOf, cash, stockValue: r2(stockValue),
    receivable: sum(cust, 'balance'), receivableOverdue: sum(cust, 'overdue'),
    payable: sum(sup, 'balance'), payableOverdue: sum(sup, 'overdue'),
    month: { name: rep.months[m], receipts: rep.monthly.receipts[m], payments: rep.monthly.payments[m], netSales: rep.pnl.netSales[m], profit: rep.pnl.net[m] },
    series: { months: rep.months, receipts: rep.monthly.receipts, payments: rep.monthly.payments, netSales: rep.pnl.netSales, closing: rep.monthly.closing },
    overdueCustomers: cust.filter((c) => c.overdue > 0).sort((a, b) => b.overdue - a.overdue).slice(0, 6),
    overdueSuppliers: sup.filter((s) => s.overdue > 0).sort((a, b) => b.overdue - a.overdue).slice(0, 6),
    lowStock: low, topCustomers: top, recent,
  };
}


// ---------- accrual profit & loss: revenue when invoiced, cost of what was actually sold ----------
export async function accrualReport(year = Number(getSetting('financial_year', new Date().getFullYear()))) {
  const vr = vatRate(), y = String(year);
  const base = await yearReport(year);
  const rev = zero(), ret = zero(), cogs = zero(), retCost = zero(), covered = zero(), invoiced = zero();
  const byMonth = async (sql, ...p) => (await db.prepare(sql).all(...p));
  for (const x of await byMonth(`SELECT CAST(substr(date,6,2) AS INTEGER) m, SUM(subtotal) s FROM sales WHERE status='active' AND substr(date,1,4)=? GROUP BY m`, y)) { rev[x.m - 1] += x.s; invoiced[x.m - 1] += x.s; }
  for (const x of await byMonth(`SELECT CAST(substr(date,6,2) AS INTEGER) m, SUM(receipt) s FROM cashbook WHERE category=? AND sale_id IS NULL AND substr(date,1,4)=? GROUP BY m`, CAT_SALES, y)) rev[x.m - 1] += x.s / (1 + vr);
  for (const x of await byMonth(`SELECT CAST(substr(date,6,2) AS INTEGER) m, SUM(subtotal) s FROM sale_returns WHERE status='active' AND substr(date,1,4)=? GROUP BY m`, y)) ret[x.m - 1] += x.s;
  for (const x of await byMonth(`SELECT CAST(substr(date,6,2) AS INTEGER) m, SUM(payment) s FROM cashbook WHERE category=? AND return_id IS NULL AND substr(date,1,4)=? GROUP BY m`, CAT_RETURN, y)) ret[x.m - 1] += x.s / (1 + vr);
  for (const x of await byMonth(`SELECT CAST(substr(s.date,6,2) AS INTEGER) m, SUM(i.qty*i.unit_cost) c, SUM(CASE WHEN i.unit_cost>0 THEN i.amount ELSE 0 END) cv
      FROM sale_items i JOIN sales s ON s.id=i.sale_id WHERE s.status='active' AND substr(s.date,1,4)=? GROUP BY m`, y)) { cogs[x.m - 1] += x.c; covered[x.m - 1] += x.cv; }
  for (const x of await byMonth(`SELECT CAST(substr(r.date,6,2) AS INTEGER) m, SUM(i.qty*i.unit_cost) c FROM sale_return_items i JOIN sale_returns r ON r.id=i.return_id WHERE r.status='active' AND substr(r.date,1,4)=? GROUP BY m`, y)) retCost[x.m - 1] += x.c;

  const netRev = rev.map((v, i) => v - ret[i]), netCogs = cogs.map((v, i) => v - retCost[i]);
  const gross = netRev.map((v, i) => v - netCogs[i]);
  const other = base.pnl.other, expenses = base.pnl.expenses, totalExp = base.pnl.totalExpenses;
  const net = gross.map((v, i) => v + other[i] - totalExp[i]);
  const R = (a) => a.map(r2);
  const sum = (a) => r2(a.reduce((s, v) => s + v, 0));

  const prod = new Map();
  const add = (name, q, rv, c) => { const o = prod.get(name) ?? { name, qty: 0, revenue: 0, cost: 0 }; o.qty += q; o.revenue += rv; o.cost += c; prod.set(name, o); };
  for (const x of await byMonth(`SELECT COALESCE(p.name, i.description) name, SUM(i.qty) q, SUM(i.amount) rv, SUM(i.qty*i.unit_cost) c FROM sale_items i JOIN sales s ON s.id=i.sale_id
      LEFT JOIN products p ON p.id=i.product_id WHERE s.status='active' AND substr(s.date,1,4)=? GROUP BY 1`, y)) add(x.name, x.q, x.rv, x.c);
  for (const x of await byMonth(`SELECT COALESCE(p.name, i.description) name, SUM(i.qty) q, SUM(i.amount) rv, SUM(i.qty*i.unit_cost) c FROM sale_return_items i JOIN sale_returns r ON r.id=i.return_id
      LEFT JOIN products p ON p.id=i.product_id WHERE r.status='active' AND substr(r.date,1,4)=? GROUP BY 1`, y)) add(x.name, -x.q, -x.rv, -x.c);
  const cust = new Map();
  for (const x of await byMonth(`SELECT COALESCE(c.name,'Walk-in / no customer') name, SUM(i.amount) rv, SUM(i.qty*i.unit_cost) c FROM sale_items i JOIN sales s ON s.id=i.sale_id
      LEFT JOIN customers c ON c.id=s.customer_id WHERE s.status='active' AND substr(s.date,1,4)=? GROUP BY 1`, y)) cust.set(x.name, { name: x.name, revenue: x.rv, cost: x.c });
  const tidy = (m) => [...m.values()].map((o) => ({ ...o, qty: o.qty === undefined ? undefined : r2(o.qty), revenue: r2(o.revenue), cost: r2(o.cost), profit: r2(o.revenue - o.cost), margin: o.cost > 0 && o.revenue ? r2(((o.revenue - o.cost) / o.revenue) * 100) : null }))
    .sort((a, b) => b.revenue - a.revenue);

  const coverage = sum(invoiced) ? r2((sum(covered) / sum(invoiced)) * 100) : null;
  return { year, months: base.months, revenue: R(rev), returns: R(ret), netRevenue: R(netRev), cogs: R(netCogs), gross: R(gross), other: R(other),
    expenses, totalExpenses: R(totalExp), net: R(net), costCoverage: coverage,
    totals: { netRevenue: sum(netRev), cogs: sum(netCogs), gross: sum(gross), net: sum(net) }, byProduct: tidy(prod), byCustomer: tidy(cust) };
}

// ---------- customer statement ----------
export async function customerStatement(id, from = '', to = '') {
  const c = (await customerLedger(to || undefined)).find((x) => x.id === id);
  if (!c) return null;
  const tx = [];
  for (const s of await db.prepare("SELECT date,inv_no ref,total FROM sales WHERE customer_id=? AND type='credit' AND status='active'").all(id)) tx.push({ date: s.date, kind: 'Invoice', ref: s.ref, debit: s.total, credit: 0 });
  for (const p of await db.prepare('SELECT date,ref,receipt FROM cashbook WHERE customer_id=? AND category=?').all(id, CAT_CUSTOMER_PAYMENT)) tx.push({ date: p.date, kind: 'Payment', ref: p.ref || '', debit: 0, credit: p.receipt });
  for (const r of await db.prepare("SELECT date,ret_no ref,total FROM sale_returns WHERE customer_id=? AND status='active' AND refund_type='credit'").all(id)) tx.push({ date: r.date, kind: 'Credit note', ref: r.ref, debit: 0, credit: r.total });
  tx.sort((a, b) => a.date.localeCompare(b.date) || (a.kind === 'Invoice' ? -1 : 1));
  let bal = c.opening_balance;
  const before = tx.filter((t) => from && t.date < from);
  for (const t of before) bal += t.debit - t.credit;
  const opening = r2(bal);
  const rows = [];
  for (const t of tx.filter((t) => (!from || t.date >= from) && (!to || t.date <= to))) { bal += t.debit - t.credit; rows.push({ ...t, balance: r2(bal) }); }
  return { customer: { id: c.id, name: c.name, phone: c.phone, vat_no: c.vat_no, credit_limit: c.credit_limit }, from, to, opening, rows, closing: r2(bal),
    ageing: { current: c.b0_30, d31_60: c.b31_60, d61_90: c.b61_90, over90: c.b90, overdue: c.overdue, balance: c.balance } };
}

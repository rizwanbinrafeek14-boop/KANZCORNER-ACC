import { h, api, state, money, sar, today, monthStart, fmtDate, debounce, toast, badge, statusBadge, can, openModal, formModal, confirmDialog, table, kpi, waLink, download, icon } from './lib.js';

export const pageHead = (title, sub, ...actions) => h('div', { class: 'top' }, h('button', { class: 'btn ghost menu-btn', 'aria-label': 'Menu', onclick: () => document.querySelector('.side').classList.toggle('open') }, icon('menu')),
  h('div', null, h('h1', null, title), sub ? h('div', { class: 'sub' }, sub) : null), h('div', { class: 'grow' }), ...actions);
const btn = (label, onclick, cls = '', ic) => h('button', { class: `btn ${cls}`, onclick }, ic ? icon(ic) : null, label);
const optEls = (rows, label, empty) => opts(rows, label, empty).map((o) => h('option', { value: o.value }, o.label));
const opts = (rows, label = (r) => r.name, empty) => [...(empty ? [{ value: '', label: empty }] : []), ...rows.map((r) => ({ value: r.id, label: label(r) }))];

/* ============ SALES ============ */
export async function salesPage(root) {
  const f = { q: '', type: '', from: '', to: '' };
  let tab = 'invoices';
  const holder = h('div');
  const filters = h('div', { class: 'toolbar' },
    h('input', { class: 'search', type: 'search', placeholder: 'Search invoice, customer…', 'aria-label': 'Search', oninput: debounce((e) => { f.q = e.target.value; load(); }) }),
    h('select', { 'aria-label': 'Type', onchange: (e) => { f.type = e.target.value; load(); } }, h('option', { value: '' }, 'All types'), h('option', { value: 'cash' }, 'Cash'), h('option', { value: 'credit' }, 'Credit')),
    h('input', { type: 'date', 'aria-label': 'From', onchange: (e) => { f.from = e.target.value; load(); } }),
    h('input', { type: 'date', 'aria-label': 'To', onchange: (e) => { f.to = e.target.value; load(); } }));
  async function load() {
    filters.classList.toggle('hide', tab !== 'invoices');
    if (tab === 'returns') {
      const rows = await api('/returns');
      holder.replaceChildren(table([
        { label: 'Credit note', render: (r) => h('b', null, r.ret_no) }, { label: 'Date', render: (r) => fmtDate(r.date) }, { label: 'Invoice', key: 'inv_no' },
        { label: 'Customer', render: (r) => r.customer || 'Walk-in customer' },
        { label: 'Refund', render: (r) => badge(r.refund_type === 'credit' ? 'To account' : r.refund_mode || 'Cash', r.refund_type === 'credit' ? 'warn' : 'info') },
        { label: 'Total', num: true, render: (r) => money(r.total) },
        { label: '', render: (r) => (r.status === 'void' ? statusBadge('void') : h('div', { class: 'row-act' },
          h('a', { class: 'btn sm', href: `/creditnote/${r.id}`, target: '_blank', rel: 'noopener' }, icon('print'), 'Print'),
          can('purchases') ? h('button', { class: 'btn sm danger', onclick: async () => { if (await confirmDialog('Void this credit note? Stock and refund will be reversed.', 'Void')) { await api(`/returns/${r.id}/void`, { method: 'POST', body: {} }); toast('Credit note voided'); load(); } } }, 'Void') : null)) },
      ], rows, { empty: 'No returns yet. Open an invoice and choose "Return items".' }));
      return;
    }
    const rows = await api('/sales?' + new URLSearchParams(f));
    holder.replaceChildren(table([
      { label: 'Invoice', render: (r) => h('b', null, r.inv_no) },
      { label: 'Date', render: (r) => fmtDate(r.date) },
      { label: 'Customer', render: (r) => r.customer || 'Walk-in customer' },
      { label: 'Type', render: (r) => badge(r.type === 'credit' ? 'Credit' : r.payment_mode || 'Cash', r.type === 'credit' ? 'warn' : 'info') },
      { label: 'Due', render: (r) => fmtDate(r.due_date) },
      { label: 'Total', num: true, render: (r) => money(r.total) },
      { label: 'Status', render: (r) => (r.status === 'void' ? statusBadge('void') : '') },
    ], rows, { onRow: (r) => saleDetail(r.id, load), empty: 'No invoices match.' }));
  }
  const tabBar = h('div', { class: 'tabs', role: 'tablist' }, [['invoices', 'Invoices'], ['returns', 'Credit notes / returns']].map(([k, l]) =>
    h('button', { role: 'tab', class: k === tab ? 'on' : '', onclick: (e) => { tab = k; tabBar.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === e.currentTarget)); load(); } }, l)));
  root.append(pageHead('Sales', 'Cash and credit invoices', btn('Export', () => download('/export/sales'), '', 'down'), btn('New invoice', () => newInvoice(load), 'primary', 'plus')), tabBar, filters, holder);
  await load();
}

async function saleDetail(id, reload) {
  const [s, rets] = await Promise.all([api('/sales/' + id), api(`/sales/${id}/returns`)]);
  const activeRets = rets.filter((r) => r.status === 'active');
  const anyReturned = s.items.some((i) => i.returned > 0);
  const modal = openModal({ title: `Invoice ${s.inv_no}`, body: h('div', { class: 'grid' },
    h('div', { class: 'fields' }, h('div', null, h('div', { class: 'muted' }, 'Customer'), h('b', null, s.customer || 'Walk-in customer')), h('div', null, h('div', { class: 'muted' }, 'Date / Due'), h('b', null, fmtDate(s.date) + (s.due_date ? ` → ${fmtDate(s.due_date)}` : '')))),
    table([{ label: 'Item', key: 'description' }, { label: 'Qty', num: true, key: 'qty' }, ...(anyReturned ? [{ label: 'Returned', num: true, key: 'returned' }] : []), { label: 'Price', num: true, render: (r) => money(r.unit_price) }, { label: 'Amount', num: true, render: (r) => money(r.amount) }], s.items),
    h('div', { class: 'totals' }, h('div', null, h('span', null, 'Subtotal'), money(s.subtotal)), h('div', null, h('span', null, 'VAT'), money(s.vat)), h('div', { class: 'g' }, h('span', null, 'Total'), sar(s.total))),
    rets.length ? h('div', null, h('h3', { style: 'margin-bottom:8px' }, 'Credit notes'), h('div', { class: 'list' }, rets.map((r) => h('div', { class: 'it' }, h('div', null, h('b', null, r.ret_no), h('div', { class: 'muted' }, `${fmtDate(r.date)} · ${r.refund_type === 'credit' ? 'to account' : r.refund_mode}`)),
      h('div', { class: 'row-act' }, r.status === 'void' ? statusBadge('void') : h('b', null, money(r.total)), h('a', { class: 'btn sm', href: `/creditnote/${r.id}`, target: '_blank', rel: 'noopener' }, icon('print'), 'Print')))))) : null,
    s.status === 'void' ? h('div', { class: 'err' }, 'This invoice is void.') : null),
    footer: (close) => [
      s.status !== 'void' && can('purchases') && !activeRets.length ? h('button', { class: 'btn danger', onclick: async () => { if (await confirmDialog('Void this invoice? Stock and the cashbook entry will be reversed.', 'Void invoice')) { await api(`/sales/${id}/void`, { method: 'POST', body: {} }); toast('Invoice voided'); close(); reload(); } } }, 'Void') : null,
      s.status !== 'void' && can('purchases') && !activeRets.length ? h('button', { class: 'btn', onclick: () => { close(); newInvoice(reload, s); } }, 'Edit') : null,
      s.status !== 'void' && can('sales') ? h('button', { class: 'btn', onclick: () => { close(); returnModal(s, reload); } }, 'Return items') : null,
      h('a', { class: 'btn primary', href: `/invoice/${id}`, target: '_blank', rel: 'noopener' }, icon('print'), 'Print / PDF')] });
  return modal;
}

function returnModal(s, reload) {
  const left = s.items.map((i) => ({ ...i, left: Math.round((i.qty - i.returned) * 1000) / 1000 })).filter((i) => i.left > 0);
  const err = h('div', { class: 'err hide', role: 'alert' });
  if (!left.length) { toast('Everything on this invoice has already been returned', true); return; }
  const type = h('select', { name: 'refund_type', onchange: sync }, ...(s.customer_id ? [h('option', { value: 'credit' }, `Credit note to ${s.customer}'s account`)] : []), h('option', { value: 'cash' }, 'Refund money now'));
  const mode = h('select', { name: 'refund_mode' }, state.meta.modes.map((m) => h('option', null, m)));
  const modeL = h('label', { class: 'f' }, 'Refund by', mode);
  const date = h('input', { type: 'date', value: today(), required: true });
  const notes = h('input', { placeholder: 'Reason (optional)' });
  function sync() { modeL.classList.toggle('hide', type.value !== 'cash'); }
  sync();
  const qtys = left.map((i) => h('input', { type: 'number', min: 0, max: i.left, step: 'any', value: 0, 'aria-label': `Return quantity ${i.description}`, style: 'max-width:110px' }));
  const total = h('b', null, sar(0));
  const recalc = () => { const sub = left.reduce((t, i, n) => t + (Number(qtys[n].value) || 0) * i.unit_price, 0); total.textContent = sar(Math.round(sub * (1 + Number(state.meta.settings.vat_rate)) * 100) / 100); };
  qtys.forEach((q) => { q.oninput = recalc; });
  openModal({ title: `Return items – ${s.inv_no}`, wide: true, body: h('div', null, err,
    table([{ label: 'Item', key: 'description' }, { label: 'Can return', num: true, key: 'left' }, { label: 'Price', num: true, render: (r) => money(r.unit_price) }, { label: 'Return qty', render: (r) => qtys[left.indexOf(r)] }], left),
    h('div', { class: 'fields', style: 'margin-top:14px' }, h('label', { class: 'f' }, 'Date', date), h('label', { class: 'f' }, 'What happens to the money', type), modeL, h('label', { class: 'f' }, 'Notes', notes)),
    h('div', { class: 'totals' }, h('div', { class: 'g' }, h('span', null, 'Credit total (incl. VAT)'), total))),
  footer: (close) => [h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', onclick: async (e) => {
    const items = left.map((i, n) => ({ sale_item_id: i.id, qty: Number(qtys[n].value) || 0 })).filter((i) => i.qty > 0);
    e.currentTarget.disabled = true; err.classList.add('hide');
    try { const r = await api(`/sales/${s.id}/returns`, { method: 'POST', body: { date: date.value, refund_type: type.value, refund_mode: mode.value, notes: notes.value, items } }); toast(`Credit note ${r.ret_no} created`); close(); reload(); window.open(`/creditnote/${r.id}`, '_blank', 'noopener'); }
    catch (ex) { err.textContent = ex.message; err.classList.remove('hide'); e.currentTarget.disabled = false; }
  } }, 'Create credit note')] });
}

async function newInvoice(reload, existing = null) {
  const [customers, products] = await Promise.all([api('/customers'), api('/products')]);
  const rate = Number(state.meta.settings.vat_rate);
  const rows = h('div', { class: 'items' });
  const totals = h('div', { class: 'totals' });
  const typeSel = h('select', { name: 'type', onchange: sync, disabled: !!existing }, h('option', { value: 'cash', selected: existing?.type === 'cash' }, 'Cash / card sale'), h('option', { value: 'credit', selected: existing?.type === 'credit' }, 'Credit sale'));
  const cust = h('select', { name: 'customer_id', value: existing?.customer_id ?? '' }, optEls(customers, (c) => `${c.name}${c.balance ? ` (owes ${money(c.balance)})` : ''}`, 'Walk-in customer'));
  const mode = h('select', { name: 'payment_mode' }, state.meta.modes.map((m) => h('option', { selected: m === existing?.payment_mode }, m)));
  const days = h('input', { name: 'credit_days', type: 'number', min: 0, value: existing?.credit_days ?? (state.meta.settings.default_credit_days || 30) });
  const date = h('input', { name: 'date', type: 'date', value: existing?.date ?? today(), required: true });
  const notes = h('input', { name: 'notes', placeholder: 'Optional', value: existing?.notes ?? '' });
  const lab = (t, el, cls = '') => h('label', { class: 'f ' + cls }, t, el);
  const cashOnly = lab('Payment mode', mode), creditOnly = lab('Credit days', days, 'hide');
  function sync() { const credit = typeSel.value === 'credit'; cashOnly.classList.toggle('hide', credit); creditOnly.classList.toggle('hide', !credit); }
  function recalc() {
    const sub = [...rows.children].reduce((s, r) => s + (Number(r.querySelector('[name=qty]').value) || 0) * (Number(r.querySelector('[name=price]').value) || 0), 0);
    const vat = Math.round(sub * rate * 100) / 100;
    totals.replaceChildren(h('div', null, h('span', null, 'Subtotal'), money(sub)), h('div', null, h('span', null, `VAT ${Math.round(rate * 100)}%`), money(vat)), h('div', { class: 'g' }, h('span', null, 'Total'), sar(sub + vat)));
  }
  function addRow(pre) {
    const prod = h('select', { name: 'product', 'aria-label': 'Product' }, h('option', { value: '' }, '— custom item —'), products.map((p) => h('option', { value: p.id }, `${p.name} (${p.stock} in stock)`)));
    const desc = h('input', { name: 'desc', placeholder: 'Description', 'aria-label': 'Description' });
    const qty = h('input', { name: 'qty', type: 'number', min: 0, step: 'any', value: 1, 'aria-label': 'Quantity' });
    const price = h('input', { name: 'price', type: 'number', min: 0, step: 'any', placeholder: 'Price excl. VAT', 'aria-label': 'Unit price' });
    const total = h('div', { class: 'num' }, '0.00');
    const row = h('div', { class: 'ir' }, h('div', { style: 'display:grid;gap:6px' }, prod, desc), qty, price, total, h('button', { class: 'btn ghost sm', type: 'button', 'aria-label': 'Remove line', onclick: () => { row.remove(); recalc(); } }, icon('x')));
    prod.onchange = () => { const p = products.find((x) => String(x.id) === prod.value); desc.classList.toggle('hide', !!p); if (p) price.value = p.price; upd(); };
    const upd = () => { total.textContent = money((Number(qty.value) || 0) * (Number(price.value) || 0)); recalc(); };
    qty.oninput = price.oninput = upd;
    rows.append(row);
    if (pre && pre.description !== undefined) { prod.value = pre.product_id ?? ''; if (pre.product_id) desc.classList.add('hide'); desc.value = pre.description; qty.value = pre.qty; price.value = pre.unit_price; upd(); }
  }
  if (existing) existing.items.forEach((i) => addRow(i)); else addRow();
  recalc(); sync(); if (existing) cust.value = existing.customer_id ?? '';
  const err = h('div', { class: 'err hide', role: 'alert' });
  const modal = openModal({ title: existing ? `Edit invoice ${existing.inv_no}` : 'New invoice', wide: true, body: h('div', null, err,
    h('div', { class: 'fields' }, lab('Sale type', typeSel), lab('Date', date), lab('Customer', cust), cashOnly, creditOnly, lab('Notes', notes, 'full')),
    h('h3', { style: 'margin:18px 0 8px' }, 'Items'), h('div', { class: 'items' }, h('div', { class: 'ih' }, h('span', null, 'Product / description'), h('span', null, 'Qty'), h('span', null, 'Price excl. VAT'), h('span', { class: 'num' }, 'Amount'), h('span'))),
    rows, h('div', { style: 'margin-top:10px' }, btn('Add line', addRow, 'sm', 'plus')), totals),
    footer: (close) => [h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', onclick: (e) => submit(e.currentTarget, close, {}) }, existing ? 'Save changes' : 'Create invoice')] });
  async function submit(button, close, extra) {
    const items = [...rows.children].map((r) => ({ product_id: r.querySelector('[name=product]').value || null, description: r.querySelector('[name=desc]').value, qty: r.querySelector('[name=qty]').value, unit_price: r.querySelector('[name=price]').value }));
    button.disabled = true; err.classList.add('hide');
    try {
      const r = await api(existing ? `/sales/${existing.id}` : '/sales', { method: existing ? 'PUT' : 'POST', body: { type: typeSel.value, date: date.value, customer_id: cust.value || null, payment_mode: mode.value, credit_days: days.value, notes: notes.value, items, ...extra } });
      toast(existing ? `Invoice ${r.inv_no} updated` : `Invoice ${r.inv_no} created`); close(); reload();
      if (!existing) window.open(`/invoice/${r.id}`, '_blank', 'noopener');
    } catch (ex) {
      button.disabled = false;
      if (ex.status === 409 && /Credit limit/.test(ex.message) && can('parties') && await confirmDialog(ex.message + ' Create it anyway?', 'Override limit')) return submit(button, close, { ...extra, override_limit: true });
      if (ex.status === 409 && /stock/i.test(ex.message) && await confirmDialog(ex.message + ' Sell anyway and let stock go negative?', 'Sell anyway')) return submit(button, close, { ...extra, allow_negative: true });
      err.textContent = ex.message; err.classList.remove('hide');
    }
  }
}

/* ============ PARTIES (customers & suppliers) ============ */
function reminderText(kind, p) {
  const co = state.meta.settings.company_name;
  return kind === 'customer'
    ? `Assalamu alaikum, this is a friendly reminder from ${co}. Your account shows an outstanding balance of SAR ${money(p.balance)} (SAR ${money(p.overdue)} overdue). Kindly arrange payment. Thank you.`
    : `Assalamu alaikum, ${co} here. We are preparing payment of SAR ${money(p.balance)} on your account. Please send us your latest statement. Thank you.`;
}

async function partiesPage(root, kind) {
  const isC = kind === 'customer', base = isC ? '/customers' : '/suppliers';
  const holder = h('div'), kpis = h('div', { class: 'grid g3', style: 'margin-bottom:16px' });
  let all = [], q = '';
  function render() {
    const rows = all.filter((c) => !q || c.name.toLowerCase().includes(q));
    holder.replaceChildren(table([
      { label: isC ? 'Customer' : 'Supplier', render: (c) => h('div', null, h('b', null, c.name), h('div', { class: 'muted' }, c.phone || '')) },
      ...(isC ? [{ label: 'Credit used', render: (c) => c.credit_limit ? h('div', { style: 'min-width:120px' }, h('div', { class: 'bar' }, h('i', { style: `width:${Math.min(100, Math.max(0, c.balance / c.credit_limit * 100))}%;${c.over_limit ? 'background:var(--red)' : ''}` })), h('small', { class: 'muted' }, `${money(c.balance, 0)} / ${money(c.credit_limit, 0)}`)) : h('span', { class: 'muted' }, 'No limit') }] : []),
      { label: isC ? 'Invoiced' : 'Bought', num: true, render: (c) => money(c.credit) },
      { label: isC ? 'Received' : 'Paid', num: true, render: (c) => money(c.paid) },
      { label: 'Balance', num: true, render: (c) => h('b', { class: c.balance > 0 ? '' : 'muted' }, money(c.balance)) },
      { label: 'Overdue', num: true, render: (c) => (c.overdue ? h('span', { class: 'neg' }, money(c.overdue)) : '–') },
      { label: 'Status', render: (c) => statusBadge(c.status) },
    ], rows, { onRow: (c) => partyDetail(kind, c.id, load), empty: `No ${kind}s yet.` }));
  }
  async function load() {
    all = await api(base);
    const tot = all.reduce((s, c) => s + c.balance, 0), ov = all.reduce((s, c) => s + c.overdue, 0);
    kpis.replaceChildren(kpi(isC ? 'Customers owe you' : 'You owe suppliers', sar(tot), `${all.filter((c) => c.balance > 0).length} open accounts`, isC ? 'users' : 'truck'), kpi('Overdue', sar(ov), ov ? 'Needs attention' : 'All current', 'alert', ov ? 'red' : 'teal'), kpi(isC ? 'Customers' : 'Suppliers', all.length, '', 'book', 'amber'));
    render();
  }
  root.append(pageHead(isC ? 'Customers' : 'Suppliers', isC ? 'Who owes you, how much and since when' : 'Who you owe and when it is due',
    btn('Export', () => download(base.replace('/', '/export/')), '', 'down'), can('parties') ? btn(isC ? 'New customer' : 'New supplier', () => editParty(kind, null, load), 'primary', 'plus') : null),
    kpis, h('div', { class: 'toolbar' }, h('input', { class: 'search', type: 'search', placeholder: 'Search…', 'aria-label': 'Search', oninput: (e) => { q = e.target.value.toLowerCase(); render(); } })), holder);
  await load();
}
export const customersPage = (r) => partiesPage(r, 'customer');
export const suppliersPage = (r) => partiesPage(r, 'supplier');

function editParty(kind, p, reload) {
  const isC = kind === 'customer';
  formModal({ title: p ? `Edit ${p.name}` : `New ${kind}`, fields: [
    { name: 'name', label: 'Name', value: p?.name, required: true, full: true },
    { name: 'phone', label: 'Phone / contact', value: p?.phone, hint: 'e.g. JASIM - 056 576 6401 (used for WhatsApp)' },
    { name: 'vat_no', label: 'VAT number', value: p?.vat_no },
    ...(isC ? [{ name: 'credit_limit', label: 'Credit limit (SAR)', type: 'number', value: p?.credit_limit ?? 0 }] : []),
    { name: 'opening_balance', label: 'Opening balance (SAR)', type: 'number', value: p?.opening_balance ?? 0, hint: 'Amount already owed before using this system' },
    { name: 'notes', label: 'Notes', type: 'textarea', value: p?.notes, full: true }],
  onSubmit: async (v) => { await api(`/${kind}s${p ? '/' + p.id : ''}`, { method: p ? 'PUT' : 'POST', body: v }); toast('Saved'); reload(); } });
}

async function partyDetail(kind, id, reload) {
  const isC = kind === 'customer', p = await api(`/${kind}s/${id}`);
  const docs = isC ? p.sales : p.purchases, pays = p.payments;
  const wa = p.balance > 0 ? waLink(p.phone, reminderText(kind, p)) : null;
  const stmtText = isC ? `Assalamu alaikum, statement of account from ${state.meta.settings.company_name} for ${p.name} (as of ${fmtDate(today())}):\n`
    + `Balance due: SAR ${money(p.balance)} (overdue SAR ${money(p.overdue)})\n`
    + (p.sales.filter((x) => x.type === 'credit' && x.status === 'active').slice(0, 5).map((x) => `• ${x.inv_no} ${fmtDate(x.date)} – SAR ${money(x.total)}`).join('\n') || '')
    + (p.payments.length ? '\nLatest payments:\n' + p.payments.slice(0, 3).map((x) => `• ${fmtDate(x.date)} – SAR ${money(x.receipt)}`).join('\n') : '')
    + '\nKindly confirm and arrange payment. Thank you.' : '';
  const waStmt = isC ? waLink(p.phone, stmtText) : null;
  openModal({ title: p.name, wide: true, body: h('div', { class: 'grid' },
    h('div', { class: 'grid g4' }, kpi('Balance', sar(p.balance), '', 'wallet'), kpi('Overdue', sar(p.overdue), '', 'alert', p.overdue ? 'red' : 'teal'), kpi('0–30 days', money(p.b0_30), '', 'trend', 'teal'), kpi('31+ days', money(p.b31_60 + p.b61_90 + p.b90), '', 'trend', 'amber')),
    isC && p.credit_limit ? h('p', { class: 'muted' }, `Credit limit ${sar(p.credit_limit)} · available ${sar(p.available)}${p.over_limit ? ' · OVER LIMIT' : ''}`) : null,
    h('div', { class: 'grid g2' },
      h('div', null, h('h3', { style: 'margin-bottom:8px' }, isC ? 'Invoices' : 'Bills'), table([{ label: 'No.', render: (r) => r.inv_no || r.bill_no || '–' }, { label: 'Date', render: (r) => fmtDate(r.date) }, { label: 'Total', num: true, render: (r) => money(r.total) }, { label: '', render: (r) => (r.status === 'void' ? statusBadge('void') : r.terms === 'cash' ? badge('Cash') : '') }], docs, { empty: 'None yet' })),
      h('div', null, h('h3', { style: 'margin-bottom:8px' }, isC ? 'Payments received' : 'Payments made'), table([{ label: 'Date', render: (r) => fmtDate(r.date) }, { label: 'Mode', key: 'mode' }, { label: 'Amount', num: true, render: (r) => money(r.receipt ?? r.payment) }], pays, { empty: 'No payments yet' })))),
  footer: (close) => [
    isC ? h('a', { class: 'btn', href: `/statement/${id}`, target: '_blank', rel: 'noopener' }, icon('print'), 'Statement') : null,
    waStmt ? h('a', { class: 'btn', href: waStmt, target: '_blank', rel: 'noopener' }, icon('wa'), 'Send statement') : null,
    wa ? h('a', { class: 'btn', href: wa, target: '_blank', rel: 'noopener' }, icon('wa'), isC ? 'Payment reminder' : 'WhatsApp') : null,
    can('parties') ? btn('Edit', () => { close(); editParty(kind, p, reload); }) : null,
    can('cashbook_add') && (isC || can('cashbook')) ? btn(isC ? 'Record payment received' : 'Pay supplier', () => { close(); recordPayment(kind, p, reload); }, 'primary') : null] });
}

function recordPayment(kind, p, reload) {
  const isC = kind === 'customer';
  formModal({ title: `${isC ? 'Payment from' : 'Pay'} ${p.name}`, fields: [
    { name: 'date', label: 'Date', type: 'date', value: today(), required: true },
    { name: 'amount', label: 'Amount (SAR)', type: 'number', value: p.balance > 0 ? p.balance : '', required: true, min: 0.01 },
    { name: 'mode', label: 'Payment mode', type: 'select', options: state.meta.modes.map((m) => ({ value: m, label: m })) },
    { name: 'ref', label: 'Reference / cheque no.' }, { name: 'notes', label: 'Notes', full: true }],
  submitText: 'Record', onSubmit: async (v) => { await api(`/${kind}s/${p.id}/payment`, { method: 'POST', body: v }); toast('Payment recorded'); reload(); } });
}

/* ============ PURCHASES ============ */
export async function purchasesPage(root) {
  const holder = h('div');
  async function load() {
    const rows = await api('/purchases');
    holder.replaceChildren(table([
      { label: 'Bill', render: (r) => h('b', null, r.bill_no || '—') }, { label: 'Date', render: (r) => fmtDate(r.date) }, { label: 'Supplier', key: 'supplier' },
      { label: 'Terms', render: (r) => badge(r.terms === 'credit' ? 'Credit' : 'Cash', r.terms === 'credit' ? 'warn' : 'info') }, { label: 'Due', render: (r) => fmtDate(r.due_date) },
      { label: 'Excl. VAT', num: true, render: (r) => money(r.subtotal) }, { label: 'VAT', num: true, render: (r) => money(r.vat) }, { label: 'Total', num: true, render: (r) => money(r.total) },
      { label: '', render: (r) => (r.status === 'void' ? statusBadge('void') : r.status === 'active' && can('purchases') ? h('div', { class: 'row-act' }, h('button', { class: 'btn sm', onclick: async (e) => { e.stopPropagation(); newBill(load, await api('/purchases/' + r.id)); } }, 'Edit'), h('button', { class: 'btn sm danger', onclick: async (e) => { e.stopPropagation(); if (await confirmDialog('Void this bill? Stock and cashbook entry will be reversed.', 'Void bill')) { await api(`/purchases/${r.id}/void`, { method: 'POST', body: {} }); toast('Bill voided'); load(); } } }, 'Void')) : '') },
    ], rows, { empty: 'No purchase bills yet.' }));
  }
  root.append(pageHead('Purchases', 'Supplier bills — credit bills build what you owe', btn('Export', () => download('/export/purchases'), '', 'down'), btn('New bill', () => newBill(load), 'primary', 'plus')), holder);
  await load();
}

async function newBill(reload, existing = null) {
  const [sups, products] = await Promise.all([api('/suppliers'), api('/products')]);
  const rate = Number(state.meta.settings.vat_rate);
  let itemised = false;
  const rows = h('div', { class: 'items hide' });
  const quick = h('div', { class: 'fields' });
  const inputs = {
    supplier: h('select', { name: 'supplier_id', required: true, value: existing?.supplier_id ?? '' }, optEls(sups, (s) => s.name, 'Choose supplier…')),
    bill: h('input', { name: 'bill_no', placeholder: 'Supplier invoice number', value: existing?.bill_no ?? '' }),
    date: h('input', { name: 'date', type: 'date', value: existing?.date ?? today(), required: true }),
    terms: h('select', { name: 'terms', onchange: sync, disabled: !!existing }, h('option', { value: 'credit', selected: existing?.terms === 'credit' }, 'Credit (pay later)'), h('option', { value: 'cash', selected: existing?.terms === 'cash' }, 'Paid now')),
    mode: h('select', { name: 'payment_mode' }, state.meta.modes.map((m) => h('option', { selected: m === existing?.payment_mode }, m))),
    days: h('input', { name: 'credit_days', type: 'number', min: 0, value: existing?.credit_days ?? (state.meta.settings.default_credit_days || 30) }),
    amount: h('input', { name: 'subtotal', type: 'number', min: 0, step: 'any', oninput: recalc, value: existing && !existing.items.length ? existing.subtotal : '' }),
    desc: h('input', { name: 'description', placeholder: 'What was bought', value: existing && !existing.items.length ? existing.description ?? '' : '' }),
    vat: h('input', { name: 'vat', type: 'number', min: 0, step: 'any', placeholder: 'Auto (15%)', oninput: recalc, value: existing && Math.abs(existing.vat - existing.subtotal * rate) > 0.01 ? existing.vat : '' }),
  };
  const lab = (t, el, cls = '') => h('label', { class: 'f ' + cls }, t, el);
  const modeL = lab('Payment mode', inputs.mode, 'hide'), daysL = lab('Credit days', inputs.days);
  function sync() { const credit = inputs.terms.value === 'credit'; modeL.classList.toggle('hide', credit); daysL.classList.toggle('hide', !credit); }
  const totals = h('div', { class: 'totals' });
  function recalc() {
    const sub = itemised ? [...rows.children].reduce((s, r) => s + (Number(r.querySelector('[name=qty]').value) || 0) * (Number(r.querySelector('[name=cost]').value) || 0), 0) : Number(inputs.amount.value) || 0;
    const vat = inputs.vat.value !== '' ? Number(inputs.vat.value) : Math.round(sub * rate * 100) / 100;
    totals.replaceChildren(h('div', null, h('span', null, 'Excl. VAT'), money(sub)), h('div', null, h('span', null, 'VAT'), money(vat)), h('div', { class: 'g' }, h('span', null, 'Total'), sar(sub + vat)));
  }
  function addRow(pre) {
    const prod = h('select', { name: 'product', 'aria-label': 'Product' }, h('option', { value: '' }, '— other item —'), products.map((p) => h('option', { value: p.id }, p.name)));
    const desc = h('input', { name: 'desc', placeholder: 'Description' });
    const qty = h('input', { name: 'qty', type: 'number', min: 0, step: 'any', value: 1, 'aria-label': 'Quantity' });
    const cost = h('input', { name: 'cost', type: 'number', min: 0, step: 'any', placeholder: 'Unit cost excl. VAT', 'aria-label': 'Unit cost' });
    const tot = h('div', { class: 'num' }, '0.00');
    const row = h('div', { class: 'ir' }, h('div', { style: 'display:grid;gap:6px' }, prod, desc), qty, cost, tot, h('button', { class: 'btn ghost sm', type: 'button', 'aria-label': 'Remove line', onclick: () => { row.remove(); recalc(); } }, icon('x')));
    prod.onchange = () => { const p = products.find((x) => String(x.id) === prod.value); desc.classList.toggle('hide', !!p); if (p && p.cost) cost.value = p.cost; upd(); };
    const upd = () => { tot.textContent = money((Number(qty.value) || 0) * (Number(cost.value) || 0)); recalc(); };
    qty.oninput = cost.oninput = upd;
    rows.append(row);
    if (pre && pre.description !== undefined) { prod.value = pre.product_id ?? ''; if (pre.product_id) desc.classList.add('hide'); desc.value = pre.description; qty.value = pre.qty; cost.value = pre.unit_cost; upd(); }
  }
  const toggle = h('button', { class: 'btn sm', type: 'button', onclick: () => { itemised = !itemised; rows.classList.toggle('hide', !itemised); itemBox.classList.toggle('hide', !itemised); quick.classList.toggle('hide', itemised); toggle.textContent = itemised ? 'Switch to quick amount' : 'Itemise (updates stock)'; recalc(); if (itemised && !rows.children.length) addRow(); } }, 'Itemise (updates stock)');
  const itemBox = h('div', { class: 'hide' }, h('div', { class: 'items' }, h('div', { class: 'ih' }, h('span', null, 'Product / description'), h('span', null, 'Qty'), h('span', null, 'Unit cost'), h('span', { class: 'num' }, 'Amount'), h('span'))), rows, h('div', { style: 'margin-top:10px' }, btn('Add line', addRow, 'sm', 'plus')));
  quick.append(lab('Amount excl. VAT', inputs.amount), lab('Description', inputs.desc));
  sync(); recalc();
  if (existing?.items.length) { existing.items.forEach((i) => addRow(i)); toggle.click(); }
  const err = h('div', { class: 'err hide', role: 'alert' });
  openModal({ title: existing ? `Edit bill ${existing.bill_no ?? ''}` : 'New purchase bill', wide: true, body: h('div', null, err,
    h('div', { class: 'fields' }, lab('Supplier', inputs.supplier), lab('Bill number', inputs.bill), lab('Date', inputs.date), lab('Terms', inputs.terms), modeL, daysL, lab('VAT override', inputs.vat, 'full')),
    h('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin:18px 0 10px' }, h('h3', null, 'Amount'), toggle), quick, itemBox, totals),
    footer: (close) => [h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', onclick: async (e) => {
      e.currentTarget.disabled = true; err.classList.add('hide');
      const body = { supplier_id: inputs.supplier.value, bill_no: inputs.bill.value, date: inputs.date.value, terms: inputs.terms.value, payment_mode: inputs.mode.value, credit_days: inputs.days.value, vat: inputs.vat.value, description: inputs.desc.value };
      if (itemised) body.items = [...rows.children].map((r) => ({ product_id: r.querySelector('[name=product]').value || null, description: r.querySelector('[name=desc]').value, qty: r.querySelector('[name=qty]').value, unit_cost: r.querySelector('[name=cost]').value }));
      else body.subtotal = inputs.amount.value;
      try { await api(existing ? `/purchases/${existing.id}` : '/purchases', { method: existing ? 'PUT' : 'POST', body }); toast('Bill saved'); close(); reload(); }
      catch (ex) { err.textContent = ex.message; err.classList.remove('hide'); e.currentTarget.disabled = false; }
    } }, existing ? 'Save changes' : 'Save bill')] });
}

/* ============ PRODUCTS ============ */
export async function productsPage(root) {
  const holder = h('div'), kpis = h('div', { class: 'grid g3', style: 'margin-bottom:16px' });
  let all = [], q = '';
  const canEdit = can('products');
  function render() {
    const rows = all.filter((p) => !q || (p.name + (p.sku || '') + (p.category || '')).toLowerCase().includes(q));
    holder.replaceChildren(table([
      { label: 'Product', render: (p) => h('div', null, h('b', null, p.name), h('div', { class: 'muted' }, `${p.sku || ''}${p.category ? ' · ' + p.category : ''}`)) },
      { label: 'Stock', num: true, render: (p) => h('span', null, `${money(p.stock, p.stock % 1 ? 2 : 0)} ${p.unit} `, p.low ? badge('Low', 'bad') : p.stock < 0 ? badge('Negative', 'bad') : '') },
      { label: 'Cost', num: true, render: (p) => (p.cost ? money(p.cost) : h('span', { class: 'muted' }, 'not set')) }, { label: 'Price', num: true, render: (p) => money(p.price) },
      { label: 'Margin', num: true, render: (p) => (p.cost ? h('span', { class: p.margin >= 20 ? 'pos' : p.margin < 10 ? 'neg' : '' }, p.margin + '%') : '–') },
      { label: 'Stock value', num: true, render: (p) => money(p.value) }, { label: 'Sold', num: true, render: (p) => p.sold },
      ...(canEdit ? [{ label: '', render: (p) => h('div', { class: 'row-act' }, btn('Adjust', (e) => { e.stopPropagation(); adjust(p, load); }, 'sm'), btn('Edit', (e) => { e.stopPropagation(); editProduct(p, load); }, 'sm')) }] : []),
    ], rows, { empty: 'No products yet.' }));
  }
  async function load() {
    all = await api('/products');
    const value = all.reduce((s, p) => s + Math.max(0, p.value), 0), low = all.filter((p) => p.low).length, nocost = all.filter((p) => !p.cost).length;
    kpis.replaceChildren(kpi('Stock value (at cost)', sar(value), `${all.length} products`, 'box'), kpi('Low stock', low, low ? 'Reorder soon' : 'All healthy', 'alert', low ? 'red' : 'teal'), kpi('Missing cost price', nocost, nocost ? 'Add costs to see real margins' : 'Margins are accurate', 'trend', nocost ? 'amber' : 'teal'));
    render();
  }
  root.append(pageHead('Products & stock', 'Prices, stock levels and margins', btn('Export', () => download('/export/products'), '', 'down'), canEdit ? btn('New product', () => editProduct(null, load), 'primary', 'plus') : null),
    kpis, h('div', { class: 'toolbar' }, h('input', { class: 'search', type: 'search', placeholder: 'Search products…', 'aria-label': 'Search', oninput: (e) => { q = e.target.value.toLowerCase(); render(); } })), holder);
  await load();
}
function editProduct(p, reload) {
  formModal({ title: p ? `Edit ${p.name}` : 'New product', fields: [
    { name: 'name', label: 'Name', value: p?.name, required: true, full: true }, { name: 'sku', label: 'SKU / code', value: p?.sku, hint: 'Leave blank to auto-generate' }, { name: 'category', label: 'Category', value: p?.category },
    { name: 'unit', label: 'Unit', value: p?.unit ?? 'pcs' }, { name: 'reorder_level', label: 'Reorder level', type: 'number', value: p?.reorder_level ?? 0, hint: 'Alert when stock falls to this' },
    { name: 'cost', label: 'Cost price (excl. VAT)', type: 'number', value: p?.cost ?? 0 }, { name: 'price', label: 'Selling price (excl. VAT)', type: 'number', value: p?.price ?? 0 },
    ...(p ? [] : [{ name: 'stock', label: 'Opening stock', type: 'number', value: 0 }])],
  onSubmit: async (v) => { await api(`/products${p ? '/' + p.id : ''}`, { method: p ? 'PUT' : 'POST', body: v }); toast('Saved'); reload(); } });
}
function adjust(p, reload) {
  formModal({ title: `Adjust stock – ${p.name}`, fields: [
    { name: 'qty', label: `Change (+ add / − remove), now ${p.stock} ${p.unit}`, type: 'number', required: true, full: true, hint: 'e.g. 20 for a recount increase, -3 for damaged goods' },
    { name: 'reason', label: 'Reason', value: 'Stock count', full: true }],
  submitText: 'Apply', onSubmit: async (v) => { await api(`/products/${p.id}/adjust`, { method: 'POST', body: v }); toast('Stock updated'); reload(); } });
}

/* ============ CASHBOOK ============ */
export async function cashbookPage(root) {
  const f = { q: '', category: '', mode: '', from: '', to: '' };
  const holder = h('div'), kpis = h('div', { class: 'grid g4', style: 'margin-bottom:16px' });
  const canEdit = can('cashbook');
  async function load() {
    const { rows, position: p } = await api('/cashbook?' + new URLSearchParams(f));
    kpis.replaceChildren(kpi('Closing balance', sar(p.total), 'Cash + bank', 'wallet'), kpi('Cash in hand', sar(p.cash), '', 'wallet', p.cash < 0 ? 'red' : 'teal'), kpi('At bank / card', sar(p.bank), '', 'book', 'amber'), kpi('Receipts vs payments', `${money(p.receipts, 0)} / ${money(p.payments, 0)}`, 'All time', 'trend'));
    holder.replaceChildren(table([
      { label: 'Date', render: (r) => fmtDate(r.date) }, { label: 'Ref', key: 'ref' },
      { label: 'Description', render: (r) => h('div', null, r.description, r.party ? h('div', { class: 'muted' }, r.party) : null) },
      { label: 'Category', render: (r) => badge(r.category) }, { label: 'Mode', key: 'mode' },
      { label: 'In', num: true, render: (r) => (r.receipt ? h('span', { class: 'pos' }, money(r.receipt)) : '') }, { label: 'Out', num: true, render: (r) => (r.payment ? h('span', { class: 'neg' }, money(r.payment)) : '') },
      { label: 'Balance', num: true, render: (r) => money(r.balance) },
      ...(canEdit ? [{ label: '', render: (r) => (r.sale_id || r.purchase_id ? h('span', { class: 'muted' }, 'linked') : h('div', { class: 'row-act' }, btn('Edit', () => editEntry(r, load), 'sm'), btn('×', async () => { if (await confirmDialog('Delete this entry?', 'Delete')) { await api('/cashbook/' + r.id, { method: 'DELETE' }); toast('Deleted'); load(); } }, 'sm danger'))) }] : []),
    ], rows, { empty: 'No entries match.' }));
  }
  const cats = state.meta.categories;
  root.append(pageHead('Cashbook', 'Every rial in and out, with running balance', btn('Export', () => download('/export/cashbook'), '', 'down'), btn('New entry', () => editEntry(null, load), 'primary', 'plus')), kpis,
    h('div', { class: 'toolbar' },
      h('input', { class: 'search', type: 'search', placeholder: 'Search…', 'aria-label': 'Search', oninput: debounce((e) => { f.q = e.target.value; load(); }) }),
      h('select', { 'aria-label': 'Category', onchange: (e) => { f.category = e.target.value; load(); } }, h('option', { value: '' }, 'All categories'), cats.map((c) => h('option', null, c.name))),
      h('select', { 'aria-label': 'Mode', onchange: (e) => { f.mode = e.target.value; load(); } }, h('option', { value: '' }, 'All modes'), state.meta.modes.map((m) => h('option', null, m))),
      h('input', { type: 'date', 'aria-label': 'From', onchange: (e) => { f.from = e.target.value; load(); } }), h('input', { type: 'date', 'aria-label': 'To', onchange: (e) => { f.to = e.target.value; load(); } })), holder);
  await load();
}

async function editEntry(r, reload) {
  const [custs, sups] = await Promise.all([api('/customers'), api('/suppliers')]);
  const cats = state.meta.categories;
  const m = formModal({ title: r ? 'Edit entry' : 'New cashbook entry', fields: [
    { name: 'date', label: 'Date', type: 'date', value: r?.date ?? today(), required: true },
    { name: 'category', label: 'Category', type: 'select', value: r?.category ?? 'Sales (Counter)', options: ['Receipt', 'Payment'].flatMap((t) => cats.filter((c) => c.type === t).map((c) => ({ value: c.name, label: `${t === 'Receipt' ? '⬇ In' : '⬆ Out'} · ${c.name}` }))) },
    { name: 'amount', label: 'Amount (SAR, incl. VAT)', type: 'number', value: r ? (r.receipt || r.payment) : '', required: true, min: 0.01 },
    { name: 'mode', label: 'Payment mode', type: 'select', value: r?.mode ?? 'Cash', options: state.meta.modes.map((x) => ({ value: x, label: x })) },
    { name: 'customer_id', label: 'Customer who paid', type: 'select', value: r?.customer_id ?? '', options: opts(custs, (c) => c.name, 'Choose…') },
    { name: 'supplier_id', label: 'Supplier paid', type: 'select', value: r?.supplier_id ?? '', options: opts(sups, (c) => c.name, 'Choose…') },
    { name: 'description', label: 'Description', value: r?.description, full: true }, { name: 'party', label: 'Party (free text)', value: r?.party }, { name: 'ref', label: 'Voucher / ref no.', value: r?.ref },
    { name: 'notes', label: 'Notes', full: true, value: r?.notes }],
  onSubmit: async (v) => {
    const cat = cats.find((c) => c.name === v.category), amt = Number(v.amount);
    const body = { ...v, receipt: cat.type === 'Receipt' ? amt : 0, payment: cat.type === 'Payment' ? amt : 0 }; delete body.amount;
    await api('/cashbook' + (r ? '/' + r.id : ''), { method: r ? 'PUT' : 'POST', body }); toast('Saved'); reload();
  } });
  const sel = m.el.querySelector('[name=category]');
  const lab = (n) => m.el.querySelector(`[name=${n}]`).closest('label');
  const sync = () => { lab('customer_id').classList.toggle('hide', sel.value !== 'Customer Payment (Credit Invoice)'); lab('supplier_id').classList.toggle('hide', sel.value !== 'Supplier Payment (Credit Invoices)'); };
  sel.addEventListener('change', sync); sync();
}

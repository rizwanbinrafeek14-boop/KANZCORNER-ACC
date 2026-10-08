// Quick counter sale: tap products, take payment, done. Built for a phone or tablet at the counter.
import { h, api, state, money, sar, today, toast, badge, icon, openModal, confirmDialog, debounce } from './lib.js';
import { pageHead } from './pages.js';

export async function posPage(root) {
  const [products, customers] = await Promise.all([api('/products'), api('/customers')]);
  const rate = Number(state.meta.settings.vat_rate);
  const cart = []; // { productId, description, qty, price }
  let payMode = 'Cash', credit = false, q = '';

  const grid = h('div', { class: 'pos-grid' });
  const bar = h('div', { class: 'pos-bar' });
  const cartBox = h('div', { class: 'card pos-cart' });
  const search = h('input', { type: 'search', placeholder: 'Search or scan a code…', 'aria-label': 'Search products', autocomplete: 'off', autofocus: true,
    oninput: debounce((e) => { q = e.target.value.trim().toLowerCase(); drawGrid(); }, 120),
    onkeydown: (e) => {
      if (e.key !== 'Enter') return;
      const v = e.target.value.trim().toLowerCase(); if (!v) return;
      const hit = products.find((p) => (p.sku || '').toLowerCase() === v) || products.filter((p) => p.name.toLowerCase().includes(v))[0];
      if (hit) { add(hit); e.target.value = ''; q = ''; drawGrid(); } else toast('No product found', true);
    } });

  function add(p) {
    const line = cart.find((l) => l.productId === p.id);
    if (line) line.qty += 1; else cart.push({ productId: p.id, description: p.name, qty: 1, price: p.price });
    drawCart();
  }
  function drawGrid() {
    const list = products.filter((p) => !q || (p.name + (p.sku || '') + (p.category || '')).toLowerCase().includes(q)).slice(0, 60);
    grid.replaceChildren(...(list.length ? list.map((p) => h('button', { class: 'pos-tile', onclick: () => add(p), 'aria-label': `Add ${p.name}` },
      h('b', null, p.name), h('span', { class: 'muted' }, sar(p.price)), p.stock <= 0 ? badge('No stock', 'bad') : p.low ? badge(`${p.stock} left`, 'warn') : h('span', { class: 'muted' }, `${p.stock} ${p.unit}`)))
      : [h('div', { class: 'empty' }, 'No products match. Use "Custom item" below.')]));
  }

  const totalOf = () => { const sub = cart.reduce((s, l) => s + l.qty * l.price, 0); const vat = Math.round(sub * rate * 100) / 100; return { sub, vat, total: Math.round((sub + vat) * 100) / 100 }; };

  function drawCart() {
    const t = totalOf();
    bar.replaceChildren(h('div', null, h('div', { class: 'muted' }, `${cart.reduce((n, l) => n + l.qty, 0)} items`), h('b', null, sar(t.total))), h('button', { class: 'btn primary', disabled: !cart.length, onclick: () => cartBox.scrollIntoView({ behavior: 'smooth', block: 'start' }) }, 'Review & charge'));
    const custSel = h('select', { name: 'customer', 'aria-label': 'Customer' }, h('option', { value: '' }, credit ? 'Choose customer…' : 'Walk-in customer'), customers.map((c) => h('option', { value: c.id }, c.name)));
    custSel.value = state.posCustomer ?? ''; custSel.onchange = () => { state.posCustomer = custSel.value; };
    const received = h('input', { type: 'number', min: 0, step: 'any', placeholder: 'Cash received', 'aria-label': 'Cash received', inputmode: 'decimal' });
    const change = h('b', { class: 'pos' }, '');
    received.oninput = () => { const r = Number(received.value) || 0; change.textContent = r >= t.total && r ? `Change ${sar(r - t.total)}` : ''; };
    const modes = [['Cash', 'Cash'], ['Mada / Card', 'Card'], ['Bank Transfer', 'Transfer']];
    cartBox.replaceChildren(
      h('h3', null, 'Current sale', cart.length ? h('button', { class: 'btn ghost sm', onclick: () => { cart.length = 0; drawCart(); } }, 'Clear') : null),
      cart.length ? h('div', { class: 'list' }, cart.map((l, n) => h('div', { class: 'it pos-line' },
        h('div', { style: 'min-width:0' }, h('b', null, l.description), h('div', { class: 'muted' }, `${sar(l.price)} each`)),
        h('div', { class: 'row-act' },
          h('button', { class: 'btn sm', 'aria-label': 'Less', onclick: () => { l.qty -= 1; if (l.qty <= 0) cart.splice(n, 1); drawCart(); } }, '−'),
          h('b', { style: 'min-width:24px;text-align:center' }, l.qty),
          h('button', { class: 'btn sm', 'aria-label': 'More', onclick: () => { l.qty += 1; drawCart(); } }, '+'),
          h('b', { class: 'num', style: 'min-width:70px' }, money(l.qty * l.price)))))) : h('div', { class: 'empty' }, 'Tap a product to start.'),
      h('div', { style: 'margin-top:10px' }, h('button', { class: 'btn sm', onclick: customItem }, icon('plus'), 'Custom item')),
      h('div', { class: 'totals' }, h('div', null, h('span', null, 'Subtotal'), money(t.sub)), h('div', null, h('span', null, `VAT ${Math.round(rate * 100)}%`), money(t.vat)), h('div', { class: 'g' }, h('span', null, 'Total'), sar(t.total))),
      h('div', { class: 'pos-pay' }, ...modes.map(([m, label]) => h('button', { class: 'btn' + (!credit && payMode === m ? ' primary' : ''), onclick: () => { credit = false; payMode = m; drawCart(); } }, label)),
        h('button', { class: 'btn' + (credit ? ' primary' : ''), onclick: () => { credit = true; drawCart(); } }, 'On credit')),
      h('div', { class: 'fields', style: 'margin-top:12px' }, h('label', { class: 'f full' }, credit ? 'Customer (required)' : 'Customer (optional)', custSel),
        !credit && payMode === 'Cash' ? h('label', { class: 'f' }, 'Cash received', received) : null, !credit && payMode === 'Cash' ? h('div', { style: 'align-self:end;padding-bottom:8px' }, change) : null),
      h('button', { class: 'btn primary pos-charge', disabled: !cart.length, onclick: () => charge({}) }, cart.length ? `${credit ? 'Save credit sale' : 'Charge'} ${sar(t.total)}` : 'Charge'));
  }

  function customItem() {
    const d = h('input', { placeholder: 'Description', required: true, 'aria-label': 'Description' }), p = h('input', { type: 'number', min: 0, step: 'any', placeholder: 'Price excl. VAT', 'aria-label': 'Price excl. VAT', inputmode: 'decimal' });
    openModal({ title: 'Custom item', body: h('div', { class: 'fields' }, h('label', { class: 'f full' }, 'Description', d), h('label', { class: 'f full' }, 'Price excl. VAT', p)),
      footer: (close) => [h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', onclick: () => { if (!d.value.trim() || !(Number(p.value) >= 0)) return; cart.push({ productId: null, description: d.value.trim(), qty: 1, price: Number(p.value) }); close(); drawCart(); } }, 'Add')] });
  }

  async function charge(extra) {
    if (credit && !state.posCustomer) { toast('Choose a customer for a credit sale', true); return; }
    const body = { type: credit ? 'credit' : 'cash', date: today(), payment_mode: payMode, customer_id: state.posCustomer || null, credit_days: state.meta.settings.default_credit_days || 30,
      items: cart.map((l) => ({ product_id: l.productId, description: l.description, qty: l.qty, unit_price: l.price })), ...extra };
    try {
      const r = await api('/sales', { method: 'POST', body });
      const t = totalOf();
      cart.length = 0; state.posCustomer = ''; drawCart();
      products.splice(0, products.length, ...(await api('/products'))); drawGrid();
      openModal({ title: 'Sale complete ✓', body: h('div', { style: 'text-align:center;padding:10px 0' }, h('div', { class: 'muted' }, r.inv_no), h('div', { style: 'font-size:34px;font-weight:800;margin:6px 0' }, sar(t.total)), h('div', { class: 'muted' }, credit ? 'Added to the customer account' : `Paid by ${payMode}`)),
        footer: (close) => [h('a', { class: 'btn', href: `/invoice/${r.id}`, target: '_blank', rel: 'noopener' }, icon('print'), 'Print invoice'), h('button', { class: 'btn primary', onclick: () => { close(); search.focus(); } }, 'New sale')] });
    } catch (ex) {
      if (ex.status === 409 && /stock/i.test(ex.message) && await confirmDialog(ex.message + ' Sell anyway?', 'Sell anyway')) return charge({ ...extra, allow_negative: true });
      if (ex.status === 409 && /Credit limit/.test(ex.message) && await confirmDialog(ex.message + ' Continue anyway?', 'Override')) return charge({ ...extra, override_limit: true });
      toast(ex.message, true);
    }
  }

  root.append(pageHead('Quick sale', 'Tap products, take payment, print the invoice'), h('div', { class: 'pos-wrap' }, h('div', null, h('div', { class: 'toolbar' }, search), grid), cartBox), bar);
  drawGrid(); drawCart();
}

import { h, api, state, money, sar, fmtDate, toast, badge, statusBadge, can, icon, table, kpi, formModal, openModal, confirmDialog, chart, palette, download, waLink } from './js/lib.js';
import { posPage } from './js/pos.js';
import { pageHead, salesPage, customersPage, suppliersPage, purchasesPage, productsPage, cashbookPage } from './js/pages.js';

const app = document.getElementById('app');
const theme = (() => { try { return localStorage.getItem('kanz-theme'); } catch { return null; } })();
if (theme) document.documentElement.dataset.theme = theme;
const toggleTheme = () => {
  const dark = (document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')) === 'dark';
  document.documentElement.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem('kanz-theme', dark ? 'light' : 'dark'); } catch { /* storage unavailable */ }
  route();
};

const ROUTES = [
  { path: 'dashboard', label: 'Dashboard', icon: 'home', page: dashboardPage },
  { section: 'Sell' },
  { path: 'pos', label: 'Quick sale', icon: 'bolt', page: posPage, perm: 'sales' },
  { path: 'sales', label: 'Sales', icon: 'cart', page: salesPage, perm: 'sales' },
  { path: 'customers', label: 'Customers', icon: 'users', page: customersPage },
  { section: 'Buy' },
  { path: 'purchases', label: 'Purchases', icon: 'bag', page: purchasesPage, perm: 'purchases' },
  { path: 'suppliers', label: 'Suppliers', icon: 'truck', page: suppliersPage },
  { path: 'products', label: 'Products & stock', icon: 'box', page: productsPage, perm: 'products_view' },
  { section: 'Money' },
  { path: 'cashbook', label: 'Cashbook', icon: 'wallet', page: cashbookPage },
  { path: 'reports', label: 'Reports', icon: 'chart', page: reportsPage, perm: 'reports' },
  { section: 'System' },
  { path: 'issues', label: 'Import check', icon: 'alert', page: issuesPage },
  { path: 'settings', label: 'Settings & users', icon: 'gear', page: settingsPage, perm: 'owner' },
];

async function boot() {
  try { state.user = await api('/auth/me'); } catch { state.user = null; }
  if (state.user) state.meta = await api('/meta');
  addEventListener('hashchange', route);
  route();
}

async function route() {
  const name = location.hash.replace(/^#\/?/, '') || 'dashboard';
  if (!state.user) return loginView();
  if (name === 'login') { location.hash = '#/dashboard'; return; }
  const r = ROUTES.find((x) => x.path === name) || ROUTES[0];
  if (r.perm && !(r.perm === 'owner' ? state.user.role === 'owner' : can(r.perm))) { location.hash = '#/dashboard'; return; }
  const main = h('main', { class: 'main', id: 'main' });
  app.replaceChildren(h('div', { class: 'shell' }, sidebar(r.path), main));
  document.title = `${r.label} · Kanz Corner`;
  try { await r.page(main); } catch (e) { main.append(h('div', { class: 'card err' }, e.message)); }
}

function sidebar(active) {
  const allowed = (r) => !r.perm || (r.perm === 'owner' ? state.user.role === 'owner' : can(r.perm));
  return h('aside', { class: 'side' },
    h('div', { class: 'brand' }, h('div', { class: 'logo' }, 'K'), h('div', null, h('b', null, state.meta.settings.company_name), h('small', null, 'Accounting'))),
    h('nav', { class: 'nav', 'aria-label': 'Main' }, ROUTES.filter((r) => r.section || allowed(r)).map((r) => (r.section ? h('div', { class: 'sec' }, r.section) : h('a', { href: `#/${r.path}`, class: r.path === active ? 'on' : '', 'aria-current': r.path === active ? 'page' : null, onclick: () => document.querySelector('.side')?.classList.remove('open') }, icon(r.icon), r.label)))),
    h('div', { class: 'foot' },
      h('div', { class: 'who' }, h('div', { class: 'avatar' }, state.user.name[0].toUpperCase()), h('div', null, h('b', null, state.user.name), h('div', { class: 'muted' }, state.user.role))),
      h('button', { class: 'btn sm', onclick: toggleTheme }, icon('moon'), 'Dark / light'),
      h('button', { class: 'btn sm', onclick: changePassword }, 'Change password'),
      h('button', { class: 'btn sm', onclick: async () => { await api('/auth/logout', { method: 'POST', body: {} }); state.user = null; location.hash = '#/login'; route(); } }, icon('out'), 'Sign out')));
}

function changePassword() {
  formModal({ title: 'Change password', fields: [{ name: 'current', label: 'Current password', type: 'password', required: true, full: true }, { name: 'next', label: 'New password (min 8 characters)', type: 'password', required: true, full: true }],
    onSubmit: async (v) => { await api('/auth/password', { method: 'POST', body: v }); toast('Password changed'); } });
}

/* ---------- login / first-time setup ---------- */
async function loginView() {
  let setup = { open: false, needsCode: false };
  try { setup = await api('/auth/setup'); } catch { /* fall back to plain sign-in */ }
  const err = h('div', { class: 'err hide', role: 'alert' });
  const fail = (ex) => { err.textContent = ex.message; err.classList.remove('hide'); };
  const input = (name, label, type = 'text', extra = {}) => h('label', { class: 'f' }, label, h('input', { name, type, required: true, autocomplete: 'off', ...extra }));
  const enter = async (user) => { state.user = user; state.meta = await api('/meta'); location.hash = '#/dashboard'; route(); };
  let form;
  if (setup.open) {
    form = h('form', { onsubmit: async (e) => {
      e.preventDefault(); err.classList.add('hide');
      const v = Object.fromEntries(new FormData(form));
      if (v.password !== v.confirm) return fail(new Error('The two passwords do not match'));
      try { await enter(await api('/auth/setup', { method: 'POST', body: v })); toast('Welcome! Your admin account is ready.'); } catch (ex) { fail(ex); }
    } }, h('h2', null, 'Create your admin account'),
    h('p', { class: 'muted' }, 'First time here. The account you create now becomes the owner (admin) with full access.'), err,
    input('name', 'Your name', 'text', { autofocus: true }), input('username', 'Username'), input('password', 'Password (min 8 characters)', 'password', { autocomplete: 'new-password' }),
    input('confirm', 'Confirm password', 'password', { autocomplete: 'new-password' }),
    setup.needsCode ? input('code', 'Setup code (from your host settings)') : null,
    h('button', { class: 'btn primary', style: 'justify-content:center;padding:11px' }, 'Create admin account'));
  } else {
    form = h('form', { onsubmit: async (e) => {
      e.preventDefault(); err.classList.add('hide');
      try { await enter(await api('/auth/login', { method: 'POST', body: Object.fromEntries(new FormData(form)) })); } catch (ex) { fail(ex); }
    } }, h('h2', null, 'Welcome back'), h('p', { class: 'muted' }, 'Sign in to your accounts'), err,
    h('label', { class: 'f' }, 'Username', h('input', { name: 'username', required: true, autocomplete: 'username', autofocus: true })),
    h('label', { class: 'f' }, 'Password', h('input', { name: 'password', type: 'password', required: true, autocomplete: 'current-password' })),
    h('button', { class: 'btn primary', style: 'justify-content:center;padding:11px' }, 'Sign in'),
    h('p', { class: 'muted', style: 'font-size:12.5px' }, 'New staff accounts are created by the admin under Settings & users.'));
  }
  app.replaceChildren(h('div', { class: 'login' },
    h('div', { class: 'hero' }, h('div', { class: 'brand' }, h('div', { class: 'logo' }, 'K'), h('b', null, 'Kanz Corner Trading')),
      h('div', null, h('h1', null, 'Know your cash, customers and stock — at a glance.'), h('p', null, 'Everything from your Excel cashbook, now with live balances, overdue alerts and real profit per product.')),
      h('ul', null, h('li', null, 'Customer & supplier ledgers with ageing'), h('li', null, 'Products, stock and margins'), h('li', null, 'VAT summary ready for ZATCA'))),
    h('div', { class: 'panel' }, form)));
}

/* ---------- dashboard ---------- */
async function dashboardPage(root) {
  const d = await api('/dashboard');
  const c = palette();
  const cashCanvas = h('canvas', { 'aria-label': 'Monthly receipts and payments' }), trendCanvas = h('canvas', { 'aria-label': 'Closing balance by month' });
  const nowM = new Date().getMonth();
  root.append(pageHead('Dashboard', `Financial year ${d.year} · as of ${fmtDate(d.asOf)}`,
    can('sales') ? h('button', { class: 'btn primary', onclick: () => { location.hash = '#/sales'; } }, icon('plus'), 'New sale') : null),
    h('div', { class: 'grid g4' },
      kpi('Cash + bank', sar(d.cash.total), `Cash ${money(d.cash.cash, 0)} · Bank ${money(d.cash.bank, 0)}`, 'wallet'),
      kpi('Customers owe you', sar(d.receivable), d.receivableOverdue ? `${money(d.receivableOverdue)} overdue` : 'Nothing overdue', 'users', d.receivableOverdue ? 'amber' : 'teal'),
      kpi('You owe suppliers', sar(d.payable), d.payableOverdue ? `${money(d.payableOverdue)} overdue` : 'Nothing overdue', 'truck', d.payableOverdue ? 'red' : 'teal'),
      kpi(`${d.month.name} profit (cash basis)`, sar(d.month.profit), `Net sales ${money(d.month.netSales, 0)}`, 'trend', d.month.profit < 0 ? 'red' : 'teal')),
    h('div', { class: 'grid g21', style: 'margin-top:16px' },
      h('div', { class: 'card' }, h('h3', null, 'Money in vs money out'), h('div', { class: 'chart' }, cashCanvas)),
      h('div', { class: 'card' }, h('h3', null, 'Closing balance'), h('div', { class: 'chart' }, trendCanvas))),
    h('div', { class: 'grid g3', style: 'margin-top:16px' },
      h('div', { class: 'card' }, h('h3', null, 'Customers to chase', badge(d.overdueCustomers.length, 'warn')),
        d.overdueCustomers.length ? h('div', { class: 'list' }, d.overdueCustomers.map((x) => { const wa = waLink(x.phone, `Assalamu alaikum, friendly reminder from ${state.meta.settings.company_name}: SAR ${money(x.balance)} is outstanding (SAR ${money(x.overdue)} overdue). Kindly arrange payment. Thank you.`); return h('div', { class: 'it' }, h('div', null, h('b', null, x.name), h('div', { class: 'muted' }, `Overdue ${money(x.overdue)}`)), wa ? h('a', { class: 'btn sm', href: wa, target: '_blank', rel: 'noopener', 'aria-label': `WhatsApp ${x.name}` }, icon('wa'), 'Remind') : badge('no phone')); })) : h('div', { class: 'empty' }, 'All customers are current 🎉')),
      h('div', { class: 'card' }, h('h3', null, 'Suppliers to pay', badge(d.overdueSuppliers.length, 'bad')),
        d.overdueSuppliers.length ? h('div', { class: 'list' }, d.overdueSuppliers.map((x) => h('div', { class: 'it' }, h('div', null, h('b', null, x.name), h('div', { class: 'muted' }, x.phone || 'no phone')), h('b', { class: 'neg' }, money(x.overdue))))) : h('div', { class: 'empty' }, 'Nothing overdue')),
      h('div', { class: 'card' }, h('h3', null, 'Low stock', badge(d.lowStock.length, d.lowStock.length ? 'bad' : 'ok')),
        d.lowStock.length ? h('div', { class: 'list' }, d.lowStock.map((x) => h('div', { class: 'it' }, h('b', null, x.name), badge(`${x.stock} / ${x.reorder_level} ${x.unit}`, 'bad')))) : h('div', { class: 'empty' }, 'Set reorder levels on the Products page to get alerts.'))),
    h('div', { class: 'grid g2', style: 'margin-top:16px' },
      h('div', { class: 'card' }, h('h3', null, 'Top customers by sales'), d.topCustomers.length ? h('div', { class: 'list' }, d.topCustomers.map((x) => h('div', { class: 'it' }, x.name, h('b', null, money(x.total))))) : h('div', { class: 'empty' }, 'No credit sales yet')),
      h('div', { class: 'card' }, h('h3', null, 'Latest cashbook entries'), h('div', { class: 'list' }, d.recent.map((x) => h('div', { class: 'it' }, h('div', null, h('b', null, x.description || x.category), h('div', { class: 'muted' }, `${fmtDate(x.date)} · ${x.mode}`)), x.receipt ? h('b', { class: 'pos' }, '+' + money(x.receipt)) : h('b', { class: 'neg' }, '−' + money(x.payment))))))));
  const upto = d.series.months.map((m, i) => i);
  chart(cashCanvas, { type: 'bar', data: { labels: d.series.months, datasets: [{ label: 'Money in', data: d.series.receipts, backgroundColor: c.teal, borderRadius: 6 }, { label: 'Money out', data: d.series.payments, backgroundColor: c.amber, borderRadius: 6 }] } });
  chart(trendCanvas, { type: 'line', data: { labels: d.series.months, datasets: [{ label: 'Closing balance', data: d.series.closing.map((v, i) => (i <= nowM ? v : null)), borderColor: c.brand, backgroundColor: c.brand + '22', fill: true, tension: .3, pointRadius: 3 }] } });
}

/* ---------- reports ---------- */
async function reportsPage(root) {
  const y = await api('/reports/year');
  const ag = await api('/reports/ageing');
  const acc = await api('/reports/accrual');
  const body = h('div');
  const tabs = [['monthly', 'Monthly summary'], ['pnl', 'Profit & loss (cash)'], ['accrual', 'Profit & loss (accrual)'], ['vat', 'VAT (ZATCA)'], ['ageing', 'Ageing']];
  let cur = 'monthly';
  const grid = (head, lines, { total } = {}) => h('div', { class: 'tablewrap' }, h('table', { class: 'rep' },
    h('thead', null, h('tr', null, ['SAR', ...y.months, 'Year'].map((m, i) => h('th', { class: i ? 'num' : '' }, m)))),
    h('tbody', null, lines.map(([label, arr, opt = {}]) => h('tr', { style: opt.bold ? 'font-weight:700;background:var(--surface2)' : '' }, h('td', null, label), arr.map((v) => h('td', { class: 'num' }, v ? money(v) : h('span', { class: 'muted' }, '–'))), h('td', { class: 'num' }, h('b', null, money(opt.year ?? arr.reduce((a, b) => a + b, 0)))))))));
  const sum = (a) => Math.round(a.reduce((s, v) => s + v, 0) * 100) / 100;
  function show() {
    const m = y.monthly, p = y.pnl, v = y.vat;
    body.replaceChildren(...({
      monthly: () => [grid(null, [['Opening balance', m.opening, { year: m.opening[0] }], ['Total receipts', m.receipts], ['Total payments', m.payments], ['Net movement', m.net, { bold: true }], ['Closing balance', m.closing, { bold: true, year: m.closing[11] }]])],
      pnl: () => [h('p', { class: 'muted' }, 'Cash-basis estimate from your cashbook plus credit sales/purchases. Not a substitute for accountant-prepared statements.'), grid(null, [
        ['Sales – counter (excl. VAT)', p.salesCash], ['Sales – credit (excl. VAT)', p.salesCredit], ['Less: sales returns', p.returns.map((x) => -x)], ['Net sales', p.netSales, { bold: true }],
        ['Cost of goods – cash purchases', p.cogsCash], ['Cost of goods – credit purchases', p.cogsCredit], ['Gross profit', p.gross, { bold: true }], ['Other income', p.other],
        ...Object.entries(p.expenses).map(([k, a]) => [k, a]), ['Total expenses', p.totalExpenses], ['NET PROFIT / (LOSS)', p.net, { bold: true }]])],
      accrual: () => [h('p', { class: 'muted' }, 'Revenue is counted when you invoice (not when money arrives). Cost of goods is what the products you sold actually cost, from the cost price on each product at the time of sale.'),
        acc.costCoverage !== null && acc.costCoverage < 100 ? h('div', { class: 'err' }, `Only ${acc.costCoverage}% of invoiced sales have a product cost, so profit is overstated. Add cost prices on the Products page and link sales to products for exact figures.`) : null,
        grid(null, [['Revenue invoiced (excl. VAT)', acc.revenue], ['Less: returns / credit notes', acc.returns.map((x) => -x)], ['Net revenue', acc.netRevenue, { bold: true }], ['Cost of goods sold', acc.cogs], ['Gross profit', acc.gross, { bold: true }], ['Other income', acc.other],
          ...Object.entries(acc.expenses).map(([k, v]) => [k, v]), ['Total expenses', acc.totalExpenses], ['NET PROFIT / (LOSS)', acc.net, { bold: true }]]),
        h('h3', { style: 'margin:22px 0 8px' }, 'Profit by product'), profitTable(acc.byProduct, true), h('h3', { style: 'margin:22px 0 8px' }, 'Profit by customer'), profitTable(acc.byCustomer, false)],
      vat: () => [h('p', { class: 'muted' }, 'Working estimate for ZATCA filing — confirm VAT treatment of each category with your accountant before filing.'), grid(null, [
        ['Output VAT – cash sales', v.outputCash], ['Output VAT – credit sales', v.outputCredit], ['Less: returns VAT', v.returns.map((x) => -x)], ['TOTAL OUTPUT VAT', v.outputTotal, { bold: true }],
        ['Input VAT – cash purchases & expenses', v.inputCash], ['Input VAT – credit purchases', v.inputCredit], ['TOTAL INPUT VAT', v.inputTotal, { bold: true }], ['VAT PAYABLE / (REFUNDABLE)', v.payable, { bold: true }]])],
      ageing: () => [h('h3', { style: 'margin-bottom:8px' }, 'Customers (receivables)'), ageTable(ag.customers), h('h3', { style: 'margin:20px 0 8px' }, 'Suppliers (payables)'), ageTable(ag.suppliers)],
    })[cur]());
  }
  const profitTable = (rows, withQty) => table([{ label: 'Name', key: 'name' }, ...(withQty ? [{ label: 'Qty sold', num: true, render: (r) => money(r.qty, 0) }] : []), { label: 'Revenue', num: true, render: (r) => money(r.revenue) },
    { label: 'Cost', num: true, render: (r) => (r.cost ? money(r.cost) : h('span', { class: 'muted' }, 'no cost')) }, { label: 'Profit', num: true, render: (r) => (r.cost ? h('b', { class: r.profit < 0 ? 'neg' : '' }, money(r.profit)) : '–') },
    { label: 'Margin', num: true, render: (r) => (r.margin === null ? '–' : h('span', { class: r.margin >= 20 ? 'pos' : r.margin < 10 ? 'neg' : '' }, r.margin + '%')) }], rows, { empty: 'No sales this year yet.' });
  const ageTable = (rows) => table([{ label: 'Name', key: 'name' }, { label: 'Balance', num: true, render: (r) => money(r.balance) }, { label: 'Overdue', num: true, render: (r) => money(r.overdue) }, { label: '0–30', num: true, render: (r) => money(r.b0_30) }, { label: '31–60', num: true, render: (r) => money(r.b31_60) }, { label: '61–90', num: true, render: (r) => money(r.b61_90) }, { label: '90+', num: true, render: (r) => money(r.b90) }], rows,
    { empty: 'Nothing outstanding', footer: (c, i) => (i === 0 ? 'Total' : c.num ? money(sum(rows.map((r) => r[({ 1: 'balance', 2: 'overdue', 3: 'b0_30', 4: 'b31_60', 5: 'b61_90', 6: 'b90' })[i]]))) : '') });
  const tabBar = h('div', { class: 'tabs', role: 'tablist' }, tabs.map(([k, l]) => h('button', { role: 'tab', class: k === cur ? 'on' : '', onclick: (e) => { cur = k; tabBar.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.currentTarget)); show(); } }, l)));
  root.append(pageHead('Reports', `Financial year ${y.year} · ageing as of ${fmtDate(ag.asOf)}`, h('button', { class: 'btn', onclick: () => window.print() }, icon('print'), 'Print')), tabBar, body);
  show();
}

/* ---------- import check ---------- */
async function issuesPage(root) {
  const rows = await api('/issues');
  const open = rows.filter((r) => !r.resolved);
  const sev = { error: ['Fix', 'bad'], warn: ['Check', 'warn'], info: ['Note', 'info'] };
  root.append(pageHead('Import check', 'Things found while moving your Excel data — review and tick off', h('span', { class: 'badge warn' }, `${open.length} open`)),
    table([
      { label: '', render: (r) => h('input', { type: 'checkbox', checked: !!r.resolved, 'aria-label': 'Resolved', onchange: async (e) => { await api(`/issues/${r.id}/resolve`, { method: 'POST', body: { resolved: e.target.checked } }); } }) },
      { label: 'Level', render: (r) => badge(...sev[r.severity]) }, { label: 'Where', render: (r) => h('div', null, h('b', null, r.sheet), h('div', { class: 'muted' }, r.row_ref)) }, { label: 'What to do', key: 'message' }], rows, { empty: 'Nothing to review.' }));
}

/* ---------- settings & users ---------- */
async function settingsPage(root) {
  const [users, audit] = await Promise.all([api('/users'), api('/audit')]);
  const s = state.meta.settings;
  const refresh = () => { document.getElementById('main').replaceChildren(); settingsPage(document.getElementById('main')); };
  const sf = (name, label, type = 'text', hint) => ({ name, label, type, value: s[name], hint });
  root.append(pageHead('Settings & users', 'Business details, VAT and who can sign in'),
    h('div', { class: 'grid g2' },
      h('div', { class: 'card' }, h('h3', null, 'Business', h('button', { class: 'btn sm', onclick: () => formModal({ title: 'Business settings', fields: [sf('company_name', 'Business name'), sf('company_vat_no', 'VAT registration no.', 'text', 'Printed on invoices and the ZATCA QR'), sf('company_address', 'Address'), sf('vat_rate', 'VAT rate', 'number', '0.15 = 15%'), sf('financial_year', 'Financial year', 'number'), sf('opening_cash', 'Opening cash in hand', 'number'), sf('opening_bank', 'Opening cash at bank', 'number'), sf('default_credit_days', 'Default credit days', 'number')],
        onSubmit: async (v) => { await api('/settings', { method: 'PUT', body: v }); state.meta = await api('/meta'); toast('Settings saved'); route(); } }) }, 'Edit')),
        h('div', { class: 'list' }, [['Business', s.company_name], ['VAT no.', s.company_vat_no || 'not set'], ['VAT rate', `${Math.round(s.vat_rate * 100)}%`], ['Financial year', s.financial_year], ['Opening cash / bank', `${money(s.opening_cash)} / ${money(s.opening_bank)}`]].map(([k, v]) => h('div', { class: 'it' }, h('span', { class: 'muted' }, k), h('b', null, v))))),
      h('div', { class: 'card' }, h('h3', null, 'Users', h('button', { class: 'btn sm primary', onclick: () => formModal({ title: 'New user', fields: [{ name: 'name', label: 'Full name', required: true }, { name: 'username', label: 'Username', required: true }, { name: 'password', label: 'Password (min 8)', type: 'password', required: true }, { name: 'role', label: 'Role', type: 'select', options: [{ value: 'cashier', label: 'Cashier – sell & add cash entries' }, { value: 'accountant', label: 'Accountant – everything except users/settings' }, { value: 'owner', label: 'Owner – full access' }] }],
        onSubmit: async (v) => { await api('/users', { method: 'POST', body: v }); toast('User created'); refresh(); } }) }, 'Add user')),
        h('div', { class: 'list' }, users.map((u) => h('div', { class: 'it' }, h('div', null, h('b', null, u.name), h('div', { class: 'muted' }, `${u.username} · ${u.role}`)), h('div', { class: 'row-act' }, u.active ? null : badge('disabled', 'bad'),
          h('button', { class: 'btn sm', onclick: () => formModal({ title: `Reset password – ${u.username}`, fields: [{ name: 'password', label: 'New password (min 8)', type: 'password', required: true, full: true }], onSubmit: async (v) => { await api('/users/' + u.id, { method: 'PUT', body: v }); toast('Password reset'); } }) }, 'Reset'),
          u.id !== state.user.id ? h('button', { class: 'btn sm', onclick: async () => { await api('/users/' + u.id, { method: 'PUT', body: { active: !u.active } }); refresh(); } }, u.active ? 'Disable' : 'Enable') : null)))))),
    h('h3', { style: 'margin:22px 0 10px' }, 'Activity log'),
    table([{ label: 'When', render: (r) => String(r.ts).replace('T', ' ').slice(0, 16) }, { label: 'Who', key: 'user_name' }, { label: 'Action', render: (r) => badge(r.action) }, { label: 'What', render: (r) => `${r.entity ?? ''} ${r.detail ?? ''}`.slice(0, 120) }], audit));
}

if ('serviceWorker' in navigator) addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
boot();

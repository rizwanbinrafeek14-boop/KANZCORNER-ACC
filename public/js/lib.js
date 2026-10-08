// Small UI toolkit: DOM builder, API client, modals, formatters.
export const state = { user: null, meta: null };

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'required') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  const add = (c) => {
    if (c == null || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else el.append(c.nodeType ? c : document.createTextNode(String(c)));
  };
  kids.forEach(add);
  return el;
}

const ICONS = {
  home: 'M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  cart: 'M3 4h2l2.4 11.2a1 1 0 0 0 1 .8h9.3a1 1 0 0 0 1-.8L20 8H6M9 20.5a1 1 0 1 0 0 .01M17 20.5a1 1 0 1 0 0 .01',
  users: 'M16 20v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7M21 20v-1a4 4 0 0 0-3-3.9M16 4.2a3.5 3.5 0 0 1 0 6.6',
  truck: 'M2 6h11v10H2zM13 9h4l4 4v3h-8M6.5 19a1.8 1.8 0 1 0 0 .01M17.5 19a1.8 1.8 0 1 0 0 .01',
  box: 'M21 8l-9-5-9 5 9 5zM3 8v8l9 5 9-5V8M12 13v8',
  book: 'M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2zM4 19V5M9 7h6M9 11h6',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  bag: 'M6 7h12l1 13H5zM9 7a3 3 0 0 1 6 0',
  alert: 'M12 3l10 18H2zM12 10v5M12 18v.01',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  wallet: 'M3 7a2 2 0 0 1 2-2h13v4M3 7v11a2 2 0 0 0 2 2h15V9H5a2 2 0 0 1-2-2M16 14.5h.01',
  trend: 'M3 17l6-6 4 4 8-8M15 7h6v6',
  moon: 'M21 13a9 9 0 1 1-10-10 7 7 0 0 0 10 10z',
  plus: 'M12 5v14M5 12h14', x: 'M6 6l12 12M18 6L6 18', menu: 'M4 6h16M4 12h16M4 18h16',
  out: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  wa: 'M3 21l1.6-5A8.5 8.5 0 1 1 8 19.4zM9 9c0 3 3 6 6 6l1.2-1.4-2-1-1 .6a4 4 0 0 1-2-2l.6-1-1-2z',
  print: 'M7 9V3h10v6M7 17H4v-6h16v6h-3M7 14h10v7H7z', down: 'M12 3v12M7 10l5 5 5-5M4 21h16',
};
export function icon(name) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.8'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', ICONS[name] || ICONS.box); s.append(p);
  return s;
}

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api' + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 401 && !path.startsWith('/auth/login')) { state.user = null; location.hash = '#/login'; throw new Error('Please sign in'); }
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) { const e = new Error(data?.error || 'Request failed'); e.status = res.status; throw e; }
  return data;
}

export const money = (n, dp = 2) => (n == null || n === '' ? '' : Number(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp }));
export const sar = (n) => `SAR ${money(n)}`;
export const today = () => new Date().toISOString().slice(0, 10);
export const monthStart = () => today().slice(0, 8) + '01';
export const fmtDate = (d) => (d ? new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '');
export const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

export function toast(msg, bad = false) {
  const t = h('div', { class: 'toast' + (bad ? ' bad' : ''), role: 'status' }, msg);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), bad ? 6000 : 3200);
}

export const badge = (text, kind = '') => h('span', { class: `badge ${kind}` }, text);
export const statusBadge = (s) => badge(s, { Overdue: 'bad', Current: 'info', Settled: 'ok', Advance: 'warn', Overpaid: 'warn', void: 'bad', active: 'ok' }[s] || '');
export const can = (perm) => {
  const role = state.user?.role;
  if (role === 'owner') return true;
  const map = { accountant: ['sales', 'purchases', 'cashbook', 'parties', 'products', 'reports'], cashier: ['sales', 'cashbook_add', 'products_view'] };
  return (map[role] || []).includes(perm);
};

// ---- modal
export function openModal({ title, body, footer, wide }) {
  const prevFocus = document.activeElement;
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); prevFocus?.focus?.(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const overlay = h('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay) close(); } },
    h('div', { class: 'modal' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('header', null, h('h2', null, title), h('button', { class: 'btn ghost sm', 'aria-label': 'Close', onclick: close }, icon('x'))),
      h('div', { class: 'body' }, body), footer ? h('footer', null, footer(close)) : null));
  document.body.append(overlay);
  overlay.querySelector('input,select,textarea,button.primary')?.focus();
  document.addEventListener('keydown', onKey);
  return { close, el: overlay };
}

export function field(f) {
  let input;
  if (f.type === 'select') {
    input = h('select', { name: f.name, required: f.required }, (f.options || []).map((o) => h('option', { value: o.value, selected: String(o.value) === String(f.value ?? '') }, o.label)));
  } else if (f.type === 'textarea') input = h('textarea', { name: f.name, rows: 3 }, f.value ?? '');
  else input = h('input', { name: f.name, type: f.type || 'text', value: f.value ?? '', required: f.required, step: f.type === 'number' ? (f.step || 'any') : null, min: f.min, placeholder: f.placeholder, autocomplete: 'off' });
  return h('label', { class: 'f' + (f.full ? ' full' : '') }, f.label, input, f.hint ? h('small', null, f.hint) : null);
}

export function formModal({ title, fields, submitText = 'Save', onSubmit, wide, extra }) {
  const err = h('div', { class: 'err hide', role: 'alert' });
  const form = h('form', { novalidate: true }, err, h('div', { class: 'fields' }, fields.map(field)), extra || null);
  return openModal({
    title, wide, body: form,
    footer: (close) => [
      h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'),
      h('button', { class: 'btn primary', type: 'button', onclick: async (e) => {
        const btn = e.currentTarget;
        if (!form.reportValidity()) return;
        const values = Object.fromEntries(new FormData(form).entries());
        btn.disabled = true; err.classList.add('hide');
        try { await onSubmit(values, form); close(); }
        catch (ex) { err.textContent = ex.message; err.classList.remove('hide'); btn.disabled = false; err.scrollIntoView({ block: 'nearest' }); }
      } }, submitText)],
  });
}

export function confirmDialog(message, okText = 'Confirm') {
  return new Promise((resolve) => {
    let done = false;
    const m = openModal({ title: 'Please confirm', body: h('p', null, message), footer: (close) => [
      h('button', { class: 'btn', onclick: () => { done = true; close(); resolve(false); } }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: () => { done = true; close(); resolve(true); } }, okText)] });
    new MutationObserver(() => { if (!document.body.contains(m.el) && !done) resolve(false); }).observe(document.body, { childList: true });
  });
}

export function table(cols, rows, { onRow, footer, empty = 'Nothing here yet.' } = {}) {
  if (!rows.length) return h('div', { class: 'tablewrap' }, h('div', { class: 'empty' }, empty));
  return h('div', { class: 'tablewrap' }, h('table', null,
    h('thead', null, h('tr', null, cols.map((c) => h('th', { class: c.num ? 'num' : '' }, c.label)))),
    h('tbody', null, rows.map((r) => h('tr', { class: onRow ? 'click' : '', onclick: onRow ? () => onRow(r) : null },
      cols.map((c) => h('td', { class: c.num ? 'num' : '' }, c.render ? c.render(r) : r[c.key] ?? ''))))),
    footer ? h('tfoot', null, h('tr', null, cols.map((c, i) => h('td', { class: c.num ? 'num' : '' }, footer(c, i))))) : null));
}

export function kpi(label, value, sub, ic, tone = '') {
  return h('div', { class: `card kpi ${tone}` }, h('div', { class: 'ic' }, icon(ic)), h('div', { class: 'l' }, label), h('div', { class: 'v' }, value), sub ? h('div', { class: 's' }, sub) : null);
}

// Saudi-friendly WhatsApp link from free-text contact ("JASIM - 056 576 6401")
export function waLink(contact, text) {
  const m = String(contact || '').match(/(\+?\d[\d\s-]{7,})\s*$/);
  if (!m) return null;
  let d = m[1].replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0')) d = '966' + d.slice(1);
  else if (d.length === 9) d = '966' + d;
  return `https://wa.me/${d}?text=${encodeURIComponent(text)}`;
}

export function download(path) { location.href = '/api' + path; }

const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
export function chart(canvas, config) {
  const text = cssVar('--muted'), line = cssVar('--line');
  Chart.defaults.color = text; Chart.defaults.font.family = 'Inter, system-ui, sans-serif';
  config.options = { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
    plugins: { legend: { position: 'bottom', labels: { usePointStyle: true, boxWidth: 8 } }, tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: SAR ${money(c.parsed.y)}` } } },
    scales: { x: { grid: { display: false } }, y: { grid: { color: line }, ticks: { callback: (v) => money(v, 0) } } }, ...config.options };
  return new Chart(canvas, config);
}
export const palette = () => ({ brand: cssVar('--brand'), teal: cssVar('--teal'), amber: cssVar('--amber'), red: cssVar('--red') });

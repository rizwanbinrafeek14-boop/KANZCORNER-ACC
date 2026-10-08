// Printable documents (credit note, statement) – same look as the invoice page.
import QRCode from 'qrcode';
import { allSettings } from './db.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const money = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const tlv = (tag, value) => { const v = Buffer.from(value, 'utf8'); return Buffer.concat([Buffer.from([tag, v.length]), v]); };

export async function qrFor(date, total, vat) {
  const st = allSettings();
  const payload = Buffer.concat([tlv(1, st.company_name || ''), tlv(2, st.company_vat_no || ''), tlv(3, `${date}T00:00:00Z`), tlv(4, Number(total).toFixed(2)), tlv(5, Number(vat).toFixed(2))]).toString('base64');
  return QRCode.toDataURL(payload, { margin: 1, width: 180 });
}

export function header(title, metaHtml) {
  const st = allSettings();
  return `<header><div><h1>${esc(st.company_name)}</h1><p>${esc(st.company_address)}</p><p>VAT No: ${esc(st.company_vat_no) || '<b class="warn">not set (Settings)</b>'}</p></div>
<div class="meta"><h2>${esc(title)}</h2>${metaHtml}</div></header>`;
}

export function docPage(title, inner, { extraBar = '' } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><link rel="stylesheet" href="/invoice.css"></head><body>
<div class="bar"><button id="print">Print / Save as PDF</button>${extraBar}<a href="/">Back to app</a></div>
<main class="sheet">${inner}</main><script src="/invoice.js"></script></body></html>`;
}

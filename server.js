// Entry point for hosts that expect a root-level server.js.
// It starts listening immediately and shows a readable status page while the database connects
// (or why it could not), instead of crashing with a bare 503.
import http from 'node:http';

const port = Number(process.env.PORT) || 3000;
const state = { error: null };
let handler = (req, res) => {
  const body = state.error
    ? `<h1>Kanz Corner Accounting could not start</h1><pre style="white-space:pre-wrap;background:#fde6ea;padding:14px;border-radius:8px">${esc(state.error)}</pre>`
    : '<h1>Starting…</h1><p>Connecting to the database. This page refreshes by itself.</p><meta http-equiv="refresh" content="4">';
  res.writeHead(state.error ? 503 : 200, { 'content-type': 'text/html; charset=utf-8', 'retry-after': '5' });
  res.end(`<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;max-width:640px;margin:60px auto;padding:0 16px">${body}</body>`);
};
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
http.createServer((req, res) => handler(req, res)).listen(port, '0.0.0.0', () => console.log(`Listening on port ${port}`));

function explain(e) {
  const url = process.env.DATABASE_URL || '';
  let msg = String(e?.message || e);
  if (url) msg = msg.split(url).join('<DATABASE_URL>');
  const hints = [];
  if (url.includes('[YOUR-PASSWORD]') || url.includes('YOUR-PASSWORD')) hints.push('DATABASE_URL still contains [YOUR-PASSWORD]. Replace that whole part (including the brackets) with your real database password.');
  try { new URL(url); } catch { if (url) hints.push('DATABASE_URL is not a valid address. If your database password contains characters like @ : / # ? %, replace them with %40 %3A %2F %23 %3F %25 – or reset the Supabase database password to letters and numbers only.'); }
  if (/ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH/.test(msg)) hints.push('The database host could not be reached. In Supabase use Connect → "Session pooler" (not "Direct connection").');
  if (/password authentication failed/i.test(msg)) hints.push('The database password is wrong. In Supabase: Project Settings → Database → Reset database password, then update DATABASE_URL.');
  if (/timeout|ETIMEDOUT/i.test(msg)) hints.push('Connecting timed out. Check the host and port in DATABASE_URL (Session pooler uses port 5432).');
  if (/Tenant or user not found/i.test(msg)) hints.push('Supabase did not recognise the user. The pooler username must look like postgres.<project-ref>; copy the string exactly from Connect → Session pooler.');
  return `${msg}${hints.length ? '\n\nWhat to check:\n- ' + hints.join('\n- ') : ''}`;
}

try {
  const { db } = await import('./server/db.js');
  const { importExcel } = await import('./server/seed.js');
  const { app } = await import('./server/index.js');
  const { hashPassword } = await import('./server/auth.js');

  if ((await db.prepare('SELECT COUNT(*) c FROM users').get()).c === 0) {
    const out = await importExcel();
    console.log('First start: imported Excel data', out.counts);
    if (out.password) console.log(`OWNER LOGIN -> username: owner  password: ${out.password}  (set KANZ_ADMIN_PASSWORD to choose your own)`);
  }

  // If KANZ_ADMIN_USERNAME + KANZ_ADMIN_PASSWORD are set, make sure that owner login exists with that password
  // (lets you pick your own login, or reset a forgotten password by changing the variable and restarting).
  const adminUser = (process.env.KANZ_ADMIN_USERNAME || '').trim(), adminPass = process.env.KANZ_ADMIN_PASSWORD || '';
  if (adminUser && adminPass.length >= 8 && /^[a-z0-9._-]{3,30}$/i.test(adminUser)) {
    const hash = hashPassword(adminPass);
    const row = await db.prepare('SELECT id FROM users WHERE lower(username) = lower(?)').get(adminUser);
    if (row) await db.prepare("UPDATE users SET pass_hash=?, role='owner', active=1 WHERE id=?").run(hash, row.id);
    else await db.prepare("INSERT INTO users(name,username,pass_hash,role) VALUES(?,?,?, 'owner')").run(adminUser, adminUser, hash);
    console.log(`Owner login ready for user "${adminUser}"`);
  } else if (process.env.KANZ_ADMIN_USERNAME || adminPass) {
    console.log('KANZ_ADMIN_USERNAME ignored: needs a 3-30 char username (letters, numbers . _ -) and a KANZ_ADMIN_PASSWORD of 8+ characters.');
  }

  handler = app;
  console.log('Kanz Corner Accounting is ready');
} catch (e) {
  console.error('STARTUP FAILED:', e);
  state.error = explain(e);
}

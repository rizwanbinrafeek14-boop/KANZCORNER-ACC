// Entry point for hosts that expect a root-level server.js.
// On first start (empty database) it imports the Excel data and creates the owner login.
import { db } from './server/db.js';
import { importExcel } from './server/seed.js';
import { app } from './server/index.js';
import { hashPassword } from './server/auth.js';

if (db.prepare('SELECT COUNT(*) c FROM users').get().c === 0) {
  const out = importExcel();
  console.log('First start: imported Excel data', out.counts);
  if (out.password) console.log(`OWNER LOGIN -> username: owner  password: ${out.password}  (set KANZ_ADMIN_PASSWORD to choose your own)`);
  else console.log('OWNER LOGIN -> username: owner, password from KANZ_ADMIN_PASSWORD');
}

// If KANZ_ADMIN_USERNAME + KANZ_ADMIN_PASSWORD are set, make sure that owner login exists with that password.
// (Lets you pick your own login on a host, or reset a forgotten password by changing the variable and restarting.)
const adminUser = (process.env.KANZ_ADMIN_USERNAME || '').trim(), adminPass = process.env.KANZ_ADMIN_PASSWORD || '';
if (adminUser && adminPass.length >= 8 && /^[a-z0-9._-]{3,30}$/i.test(adminUser)) {
  const hash = hashPassword(adminPass);
  const row = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(adminUser);
  if (row) db.prepare("UPDATE users SET pass_hash=?, role='owner', active=1 WHERE id=?").run(hash, row.id);
  else db.prepare("INSERT INTO users(name,username,pass_hash,role) VALUES(?,?,?, 'owner')").run(adminUser, adminUser, hash);
  console.log(`Owner login ready for user "${adminUser}"`);
} else if (adminUser || process.env.KANZ_ADMIN_USERNAME) {
  console.log('KANZ_ADMIN_USERNAME ignored: needs a 3-30 char username (letters, numbers . _ -) and a KANZ_ADMIN_PASSWORD of 8+ characters.');
}

const port = Number(process.env.PORT) || 3000;
app.listen(port, '0.0.0.0', () => console.log(`Kanz Corner Accounting listening on port ${port}`));

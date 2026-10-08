// Entry point for hosts that expect a root-level server.js.
// On first start (empty database) it imports the Excel data and creates the owner login.
import { db } from './server/db.js';
import { importExcel } from './server/seed.js';
import { app } from './server/index.js';

if (db.prepare('SELECT COUNT(*) c FROM users').get().c === 0) {
  const out = importExcel();
  console.log('First start: imported Excel data', out.counts);
  if (out.password) console.log(`OWNER LOGIN -> username: owner  password: ${out.password}  (set KANZ_ADMIN_PASSWORD to choose your own)`);
  else console.log('OWNER LOGIN -> username: owner, password from KANZ_ADMIN_PASSWORD');
}

const port = Number(process.env.PORT) || 3000;
app.listen(port, '0.0.0.0', () => console.log(`Kanz Corner Accounting listening on port ${port}`));

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'kanz-setup-'));
process.env.KANZ_DATA_DIR = join(dir, 'pg');
process.env.KANZ_SETUP_CODE = 'letmein-123';
const { app } = await import('../server/index.js');
const { importExcel } = await import('../server/seed.js');

let server, base;
const call = (method, path, body) => fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  .then(async (r) => ({ status: r.status, cookie: r.headers.get('set-cookie'), body: await r.json().catch(() => null) }));

before(async () => { await importExcel(); server = app.listen(0); base = `http://127.0.0.1:${server.address().port}`; });
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

test('first-run setup: open, needs code, creates the admin once, then closes', async () => {
  assert.deepEqual((await call('GET', '/api/auth/setup')).body, { open: true, needsCode: true });
  const body = { name: 'Rizwan', username: 'Rizwan14', password: 'Str0ng-pass!' };
  assert.equal((await call('POST', '/api/auth/setup', { ...body, code: 'nope' })).status, 403);
  assert.equal((await call('POST', '/api/auth/setup', { ...body, code: 'letmein-123', password: 'short' })).status, 400);
  const ok = await call('POST', '/api/auth/setup', { ...body, code: 'letmein-123' });
  assert.equal(ok.status, 201); assert.equal(ok.body.role, 'owner'); assert.ok(ok.cookie);
  // closed afterwards
  assert.equal((await call('GET', '/api/auth/setup')).body.open, false);
  assert.equal((await call('POST', '/api/auth/setup', { ...body, username: 'hacker', code: 'letmein-123' })).status, 403);
  // login works, case-insensitively
  assert.equal((await call('POST', '/api/auth/login', { username: 'rizwan14', password: 'Str0ng-pass!' })).status, 200);
  assert.equal((await call('POST', '/api/auth/login', { username: 'Rizwan14', password: 'wrong' })).status, 401);
});

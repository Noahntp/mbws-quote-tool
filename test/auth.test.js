// Đăng nhập bằng APP_PASSWORD: chưa đăng nhập thì không đọc được dữ liệu; sai mật khẩu bị chặn.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbws-auth-'));
process.env.DATA_DIR = dir;
process.env.APP_PASSWORD = 'mat-khau-thu';
const { app } = await import('../server/app.js');
const { closeDb } = await import('../server/db.js');
let server; let base;
before(async () => { await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); }); base = `http://127.0.0.1:${server.address().port}`; });
after(async () => { server?.close(); await closeDb(); delete process.env.APP_PASSWORD; try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

test('chưa đăng nhập → 401; sai mật khẩu → 401; đúng → có cookie và đọc được dữ liệu', async () => {
  assert.deepEqual(await (await fetch(base + '/auth/status')).json(), { required: true, ok: false });
  assert.equal((await fetch(base + '/api/users')).status, 401);
  assert.equal((await fetch(base + '/quote/project/1')).status, 401);
  assert.equal((await fetch(base + '/storage/runs/1/a.jpg')).status, 401);
  const bad = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'sai' }) });
  assert.equal(bad.status, 401);
  const ok = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'mat-khau-thu' }) });
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get('set-cookie').split(';')[0];
  assert.match(ok.headers.get('set-cookie'), /HttpOnly/);
  const users = await fetch(base + '/api/users', { headers: { cookie } });
  assert.equal(users.status, 200);
  assert.equal((await users.json()).length, 4);
  // cookie giả mạo không dùng được
  assert.equal((await fetch(base + '/api/users', { headers: { cookie: 'mbws_auth=9999999999999.abc' } })).status, 401);
});

// Kiểm thử tích hợp luồng "nhập tên miền → giá sơ bộ → chọn thêm → phát sinh" (CSDL tạm, không cần mạng).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbws-quick-'));
process.env.DATA_DIR = dir; // phải đặt trước khi nạp db.js
const { app } = await import('../server/app.js');
const { ingest } = await import('../server/jobs.js');
const { run, one } = await import('../server/db.js');

let server; let base;
before(async () => { await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); }); base = `http://127.0.0.1:${server.address().port}`; });
after(async () => { server?.close(); const { closeDb } = await import('../server/db.js'); await closeDb(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

const api = async (url, method = 'GET', body) => {
  const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', 'x-user-id': '1' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json() };
};

test('tên miền sai bị từ chối, tên miền đúng tạo báo giá đặt tên theo tên miền', async () => {
  assert.equal((await api('/api/projects', 'POST', { ref_urls: ['abc'] })).status, 400);
  const r = await api('/api/projects', 'POST', { ref_urls: ['https://www.nhahang-mau.vn/thuc-don'] });
  assert.equal(r.status, 200);
  const p = await api(`/api/projects/${r.json.id}`);
  assert.equal(p.json.project.name, 'nhahang-mau.vn');
  assert.equal(p.json.refs[0].url, 'https://www.nhahang-mau.vn/');
  assert.equal(p.json.runs[0].status, 'running'); // hiện "đang quét" ngay
  // việc quét nằm trong hàng đợi mới; tiến trình chạy code cũ (tìm analysis_runs.status='queued') không giành được
  assert.equal((await one('SELECT status FROM job_queue WHERE run_id=?', p.json.runs[0].id)).status, 'queued');
  assert.equal(Number((await one("SELECT COUNT(*) n FROM analysis_runs WHERE status='queued'")).n), 0);
});

test('giá sơ bộ theo web mẫu, rồi phát sinh khi chọn thêm', async () => {
  const { json: { id } } = await api('/api/projects', 'POST', { ref_urls: ['nhahang-test.vn'] });
  const runId = (await api(`/api/projects/${id}`)).json.runs[0].id;
  await run("UPDATE job_queue SET status='done' WHERE run_id=?", runId); // không để vòng lặp quét thật nhận job // không để vòng lặp quét thật nhận job
  // Giả lập kết quả quét: Zalo & đặt bàn thấy rõ; tích điểm chỉ nhắc trong nội dung
  await ingest({ id: runId, project_id: id, url: 'https://nhahang-test.vn/' }, {
    ok: true, input: 'https://nhahang-test.vn/', sitemap: {}, coverage: { discovered: 3 },
    templates: [{ template: 'home', kind: 'home', url_count: 1 }, { template: 'contact', kind: 'contact', url_count: 1 }, { template: 'blog:list', kind: 'blog', url_count: 1 }],
    pages: [{ url: 'https://nhahang-test.vn/', template: 'home', captured_at: new Date().toISOString(), desktop: { file: 'a.jpg', hash: 'h', viewport: '1366x900' },
      features: [
        { feature: 'CHAT_ZALO', detail: 'https://zalo.me/1', verification: 'observed' },
        { feature: 'BOOKING', detail: 'Hệ thống đặt chỗ booking.nhahang-test.vn', verification: 'observed' },
        { feature: 'LOYALTY', detail: 'Nội dung nhắc tới tích điểm', verification: 'inferred' },
      ] }],
  });
  let q = (await api(`/api/projects/${id}/quick`)).json;
  assert.ok(q.baseline, 'phải có giá gốc sau khi quét');
  assert.deepEqual(Object.keys(q.baseline.features).sort(), ['BOOKING', 'CHAT_ZALO', 'PAGES']); // tích điểm (suy luận) không vào giá gốc
  assert.ok(q.baseline.price > 0 && q.baseline.package, 'phải có giá sơ bộ và gói đề xuất');
  assert.equal(q.extra, 0);
  const addLogin = q.marginal.MEMBER_LOGIN.delta;
  assert.ok(addLogin > 0, 'mục chưa chọn phải ghi giá cộng thêm');
  assert.equal(q.marginal.CHAT_ZALO.delta, 0); // bỏ Zalo không đổi giá (gói nào cũng có)

  await api(`/api/projects/${id}/quick-feature`, 'POST', { feature: 'MEMBER_LOGIN', include: true });
  q = (await api(`/api/projects/${id}/quick`)).json;
  assert.equal(q.extra, q.current.price - q.baseline.price);
  assert.equal(q.extra, addLogin); // phát sinh đúng bằng giá cộng thêm đã báo trước khi tick
  assert.deepEqual(q.changes.map((c) => c.kind + ':' + c.code), ['added:MEMBER_LOGIN']);

  await api(`/api/projects/${id}/quick-feature`, 'POST', { feature: 'BOOKING', include: false });
  q = (await api(`/api/projects/${id}/quick`)).json;
  assert.ok(q.changes.some((c) => c.kind === 'removed' && c.code === 'BOOKING'));

  // Chốt lựa chọn hiện tại làm giá gốc mới → phát sinh về 0
  await api(`/api/projects/${id}/baseline`, 'POST', {});
  q = (await api(`/api/projects/${id}/quick`)).json;
  assert.equal(q.extra, 0);
  assert.equal(q.changes.length, 0);
});

test('quét không nhận ra tính năng nào: không có giá gốc ảo, mục chọn thêm không bị âm', async () => {
  const { json: { id } } = await api('/api/projects', 'POST', { ref_urls: ['web-trong.vn'] });
  const runId = (await api(`/api/projects/${id}`)).json.runs[0].id;
  await run("UPDATE job_queue SET status='done' WHERE run_id=?", runId);
  await ingest({ id: runId, project_id: id, url: 'https://web-trong.vn/' }, { ok: true, input: 'https://web-trong.vn/', sitemap: {}, coverage: { discovered: 0 }, templates: [], pages: [] });
  const q = (await api(`/api/projects/${id}/quick`)).json;
  assert.equal(q.baseline.count, 0);
  assert.equal(q.baseline.price, 0);
  assert.equal(q.current.price, 0);
  assert.equal(q.extra, 0);
  for (const [code, m] of Object.entries(q.marginal)) assert.ok(m.delta >= 0, `${code}: ${m.delta}`);
  assert.ok(q.marginal.SEARCH.delta > 0);
});

test('dung lượng hosting vượt gói → cộng phí mua thêm GB (giá theo chính sách)', async () => {
  const { json: { id } } = await api('/api/projects', 'POST', { brief: 'web giới thiệu, form liên hệ' });
  const meta = (await api('/api/meta')).json;
  assert.equal(meta.packages.addons.find((a) => a.code === 'ADD_HOSTING_1GB')?.price, 500000);
  await api(`/api/projects/${id}/quick-feature`, 'POST', { feature: 'CONTACT_FORM', include: true });
  const before = (await api(`/api/projects/${id}`)).json.preview;
  await api(`/api/projects/${id}/quick-feature`, 'POST', { feature: 'HOSTING_STORAGE', include: true, quantity: 20 });
  const after = (await api(`/api/projects/${id}`)).json.preview;
  const ad = (after.addons || []).find((a) => a.code === 'ADD_HOSTING_1GB');
  assert.ok(ad && ad.qty > 0, 'phải có add-on hosting');
  assert.ok(Number(after.price_net) > Number(before.price_net));
});

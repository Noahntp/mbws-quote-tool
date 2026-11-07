// Chạy qua gần như mọi API (hồ sơ → yêu cầu → dự toán → phiên bản → duyệt → xuất → giờ thực tế → chỉ số).
// Chạy được với SQLite (mặc định) và Postgres (DB_DRIVER=pglite) để bắt lỗi khác biệt SQL.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbws-api-'));
process.env.DATA_DIR = dir;
const { app } = await import('../server/app.js');
const { run, closeDb } = await import('../server/db.js');

let server; let base;
before(async () => { await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); }); base = `http://127.0.0.1:${server.address().port}`; });
after(async () => { server?.close(); await closeDb(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

async function api(url, method = 'GET', body, user = 1, expect = 200) {
  const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', 'x-user-id': String(user) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  assert.equal(r.status, expect, `${method} ${url} → ${r.status}: ${typeof json === 'string' ? json.slice(0, 200) : JSON.stringify(json).slice(0, 300)}`);
  return json;
}

test('luồng đầy đủ qua API', async () => {
  // danh mục, người dùng, cấu hình
  assert.equal((await api('/api/users')).length, 4);
  const meta = await api('/api/meta');
  assert.ok(meta.catalog.features.length > 20 && meta.packages.lines.length === 4 && meta.feature_tiers.BLOG);
  await api('/api/settings', 'POST', { kind: 'policy', version: 'POL-T', effective_from: '2026-02-01', data: { ...meta.policy.data, vat_pct: 8 } }, 3);
  await api('/api/settings', 'POST', { kind: 'policy', version: 'POL-T2', effective_from: '2026-03-01', data: { ...meta.policy.data, target_margin_pct: 10, min_margin_pct: 20 } }, 3, 400);
  await api('/api/settings', 'POST', { kind: 'rate_card', version: 'RC-T', effective_from: '2026-02-01', data: meta.rate_card.data }, 1, 403); // sales không sửa đơn giá

  // hồ sơ từ mô tả (không tên miền)
  const { id } = await api('/api/projects', 'POST', { customer_name: 'Cty Gạo', brief: 'Web bán gạo 7 mẫu trang, 50 sản phẩm, bộ lọc, form liên hệ, chat zalo, không cần giỏ hàng' });
  let P = await api(`/api/projects/${id}`);
  assert.ok(P.requirements.length >= 5);
  assert.equal(P.requirements.find((r) => r.feature === 'CART')?.decision, 'exclude');
  await api(`/api/projects/${id}/brief-suggest`, 'POST', { brief: 'đặt lịch online' });
  await api(`/api/projects/${id}/brief-apply`, 'POST', { brief: 'đặt lịch online, 2 ngôn ngữ' });
  await api(`/api/projects/${id}/requirements`, 'POST', { feature: 'REVIEW_ROUNDS', quantity: 2 });
  await api(`/api/projects/${id}/requirements/bulk-decision`, 'POST', { decision: 'include' });
  P = await api(`/api/projects/${id}`);
  for (const r of P.requirements.filter((x) => x.decision === 'include')) await api(`/api/requirements/${r.id}`, 'PUT', { acceptance: 'Theo mô tả', quantity: r.quantity ?? 1 });
  for (const q of P.questions.filter((x) => x.blocking)) await api(`/api/questions/${q.id}`, 'PUT', { answer: 'Đã xác nhận' });
  await api(`/api/projects/${id}/questions`, 'POST', { text: 'Câu hỏi thêm?', blocking: false });

  // web tham khảo, quét (không chạy thật trong kiểm thử)
  const ref = await api(`/api/projects/${id}/refs`, 'POST', { url: 'gao-mau.vn' });
  await api(`/api/projects/${id}/refs`, 'POST', { url: 'www.gao-mau.vn' }, 1, 409);
  await api(`/api/refs/${ref.id}`, 'PUT', { learn_notes: 'giao diện' });
  await run("UPDATE job_queue SET status='done'"); // không để vòng lặp quét thật chạy
  await api(`/api/projects/${id}/survey-all`, 'POST', {});
  await run("UPDATE job_queue SET status='done'");

  // dự toán, rủi ro, chi phí ngoài
  await api(`/api/projects/${id}/estimate/generate`, 'POST', {}, 2);
  P = await api(`/api/projects/${id}`);
  assert.ok(P.lines.length > 5);
  const line = P.lines[0];
  await api(`/api/lines/${line.id}`, 'PUT', { m: line.m + 1 }, 2, 400); // thiếu lý do
  await api(`/api/lines/${line.id}`, 'PUT', { m: line.m + 1, reason: 'khách yêu cầu thêm' }, 2);
  await api(`/api/projects/${id}/lines`, 'POST', { title: 'Việc thêm', grp: 'FE', role: 'FE', qty: 1, o: 1, m: 2, p: 3, manual_reason: 'test' }, 2);
  await api(`/api/projects/${id}/risks`, 'POST', { title: 'Rủi ro thử', prob_pct: 10, impact: 1000000 }, 2);
  await api(`/api/projects/${id}/external`, 'POST', { title: 'Plugin', amount: 500000 }, 2);
  P = await api(`/api/projects/${id}`);
  await api(`/api/risks/${P.risks.at(-1).id}`, 'PUT', { include: false }, 2);
  await api(`/api/external/${P.external[0].id}`, 'DELETE', null, 2);

  // tính giá, chọn gói
  const rec = await api(`/api/projects/${id}/recommend`);
  assert.ok(rec.best);
  await api(`/api/projects/${id}`, 'PUT', { pricing: { package_code: rec.best.code, discount_pct: 2 }, rev: P.project.rev });
  await api(`/api/projects/${id}`, 'PUT', { pricing: { discount_pct: 1 }, rev: 1 }, 1, 409); // xung đột phiên bản
  const quick = await api(`/api/projects/${id}/quick`);
  assert.ok(quick.current.price > 0);
  await api(`/api/projects/${id}/baseline`, 'POST', {});
  await api(`/api/projects/${id}/quick-feature`, 'POST', { feature: 'PAGES', include: true, quantity: 8 });
  P = await api(`/api/projects/${id}`);

  // phiên bản → gửi duyệt → duyệt → xuất
  const v = await api(`/api/projects/${id}/versions`, 'POST', {});
  const again = await api(`/api/projects/${id}/versions`, 'POST', {});
  assert.equal(again.id, v.id);
  const V = await api(`/api/versions/${v.id}`);
  const errs = V.snapshot.release_checks.filter((c) => c.level === 'error');
  if (errs.length) {
    await api(`/api/versions/${v.id}/submit`, 'POST', {}, 1, 422);
  } else {
    await api(`/api/versions/${v.id}/submit`, 'POST', {});
    await api(`/api/versions/${v.id}/approve`, 'POST', { note: 'ok' }, 1, 403);
    await api(`/api/versions/${v.id}/approve`, 'POST', { note: 'ok' }, 3);
    const html = await (await fetch(`${base}/quote/${v.id}`)).text();
    assert.match(html, /Báo giá thiết kế website/);
    assert.doesNotMatch(html, /giờ công|biên lợi nhuận|chi phí dự toán/i);
  }
  const prelim = await (await fetch(`${base}/quote/project/${id}`)).text();
  assert.match(prelim, /BÁO GIÁ SƠ BỘ/);

  // sau bàn giao, chỉ số, lịch sử, danh sách
  await api(`/api/projects/${id}/actuals`, 'POST', { quote_version_id: v.id, rows: [{ code: 'FE_TEMPLATE', title: 'FE', grp: 'FE', hours_estimated: 28, hours_actual: 35, scope: 'original' }, { title: 'Phát sinh', hours_estimated: 0, hours_actual: 5, scope: 'change' }] }, 2);
  const mt = await api('/api/metrics');
  assert.equal(mt.n, 1);
  assert.equal(mt.wape_pct, 20);
  assert.ok((await api(`/api/projects/${id}/audit`)).length > 5);
  const list = await api('/api/projects');
  assert.equal(list[0].id, id);
  assert.equal((await fetch(`${base}/storage/runs/1/khong-co.jpg`)).status, 404);
  await api(`/api/requirements/${P.requirements[0].id}`, 'DELETE');
});

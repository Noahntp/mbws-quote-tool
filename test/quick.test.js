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
  const addLogin = q.marginal.LOYALTY.delta;
  assert.ok(addLogin > 0, 'mục chưa chọn phải ghi giá cộng thêm');
  assert.equal(q.marginal.CHAT_ZALO.delta, 0); // bỏ Zalo không đổi giá (gói nào cũng có)

  await api(`/api/projects/${id}/quick-feature`, 'POST', { feature: 'LOYALTY', include: true });
  q = (await api(`/api/projects/${id}/quick`)).json;
  assert.equal(q.extra, q.current.price - q.baseline.price);
  assert.equal(q.extra, addLogin); // phát sinh đúng bằng giá cộng thêm đã báo trước khi tick
  assert.deepEqual(q.changes.map((c) => c.kind + ':' + c.code), ['added:LOYALTY']);

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

test('đo lường minh bạch: bảng tiêu chí, sale chỉnh được, hai phương án giá, in kèm báo giá', async () => {
  const { json: { id } } = await api('/api/projects', 'POST', { ref_urls: ['web-lon.vn'] });
  const runId = (await api(`/api/projects/${id}`)).json.runs[0].id;
  await run("UPDATE job_queue SET status='done' WHERE run_id=?", runId);
  await ingest({ id: runId, project_id: id, url: 'https://web-lon.vn/' }, {
    ok: true, input: 'https://web-lon.vn/', sitemap: { status: 'not_found' }, coverage: { discovered: 197 },
    templates: [{ template: 'home', kind: 'home', url_count: 1 }],
    metrics: { pages: 3, max_elements: 2388, max_nav_links: 27, max_languages: 0, framework: 'Next.js' },
    pages: [{ url: 'https://web-lon.vn/', template: 'home', captured_at: new Date().toISOString(), features: [
      { feature: 'CART', detail: 'Nút thêm vào giỏ', verification: 'observed' }, { feature: 'SEARCH', detail: 'Ô tìm kiếm', verification: 'observed' }] }],
  });
  let q = (await api(`/api/projects/${id}/quick`)).json;
  // khối lượng web mẫu tự điền: dung lượng dự đoán, số trang
  assert.equal(q.volumes.urls, 197);
  assert.ok(q.volumes.storage.gb >= 0.5 && q.baseline.features.HOSTING_STORAGE === q.volumes.storage.gb);
  assert.equal(q.complexity.rows.length, 5);
  assert.equal(q.complexity.level, 4); // 197 trang (không đọc được sitemap) + Next.js + giao diện vừa
  assert.equal(q.options.mode, 'match');
  assert.ok(q.options.economy.price < q.options.match.price, 'phương án tiết kiệm phải rẻ hơn');
  const base0 = q.baseline.price;

  // sale chỉnh quy mô (sitemap không đọc được, thực tế ~20.000 trang) → mức tăng, giá gốc theo mức mới (không tính là phát sinh)
  assert.equal((await api(`/api/projects/${id}/measure`, 'POST', { key: 'scale', band: 99 })).status, 400);
  assert.equal((await api(`/api/projects/${id}/measure`, 'POST', { key: 'scale', band: 4 })).status, 200);
  q = (await api(`/api/projects/${id}/quick`)).json;
  assert.equal(q.complexity.level, 6);
  assert.equal(q.complexity.rows[0].overridden, true);
  assert.ok(q.baseline.price > base0);
  assert.equal(q.extra, 0);
  // quay về số đo tự động
  await api(`/api/projects/${id}/measure`, 'POST', { key: 'scale', band: null });
  assert.equal((await api(`/api/projects/${id}/quick`)).json.complexity.level, 4);

  // khách chọn "Tiết kiệm" → giá hiện tại = giá phương án tiết kiệm; quét lại không tự bật lại
  await api(`/api/projects/${id}/quick-feature`, 'POST', { feature: 'DESIGN_LEVEL', include: false });
  q = (await api(`/api/projects/${id}/quick`)).json;
  assert.equal(q.options.mode, 'economy');
  assert.equal(q.current.price, q.options.economy.price);
  await api(`/api/projects/${id}/quick-feature`, 'POST', { feature: 'DESIGN_LEVEL', include: true });

  // báo giá sơ bộ gửi khách có bảng đo lường + phương án tiết kiệm
  const html = await (await fetch(base + `/quote/project/${id}`, { headers: { 'x-user-id': '1' } })).text();
  assert.match(html, /Cơ sở xác định mức thiết kế/);
  assert.match(html, /Quy mô web/);
  assert.match(html, /Phương án tiết kiệm/);
});

test('ngân sách khách lưu dạng số; tự điền số sản phẩm / bài viết từ web mẫu, số sale sửa không bị quét lại ghi đè', async () => {
  const { json: { id } } = await api('/api/projects', 'POST', { ref_urls: ['shop-mau.vn'] });
  assert.equal((await api(`/api/projects/${id}`, 'PUT', { budget: 10000000 })).status, 200);
  assert.equal((await api(`/api/projects/${id}`)).json.project.budget, 10000000);
  const runId = (await api(`/api/projects/${id}`)).json.runs[0].id;
  await run("UPDATE job_queue SET status='done' WHERE run_id=?", runId);
  const scan = { ok: true, input: 'https://shop-mau.vn/', sitemap: { status: 'found', product_urls: 120, post_urls: 30 }, coverage: { discovered: 180 },
    templates: [{ template: 'home', kind: 'home', url_count: 1 }, { template: 'product:detail', kind: 'product', url_count: 120 }, { template: 'blog:detail', kind: 'blog', url_count: 30 }],
    metrics: { pages: 3, max_elements: 900, max_nav_links: 20, max_languages: 0, framework: null }, pages: [] };
  await ingest({ id: runId, project_id: id, url: 'https://shop-mau.vn/' }, scan);
  let reqs = (await api(`/api/projects/${id}`)).json.requirements;
  const by = (f) => reqs.find((r) => r.feature === f);
  assert.equal(by('DATA_PRODUCTS').decision, 'include'); assert.equal(by('DATA_PRODUCTS').quantity, 120);
  assert.equal(by('DATA_POSTS').quantity, 30);
  assert.equal(by('HOSTING_STORAGE').decision, 'include');
  // sale sửa số sản phẩm → quét lại không ghi đè
  await api(`/api/projects/${id}/quick-feature`, 'POST', { feature: 'DATA_PRODUCTS', include: true, quantity: 50 });
  await ingest({ id: runId, project_id: id, url: 'https://shop-mau.vn/' }, scan);
  reqs = (await api(`/api/projects/${id}`)).json.requirements;
  assert.equal(by('DATA_PRODUCTS').quantity, 50);
  assert.equal(by('DATA_POSTS').quantity, 30);
});

test('vượt ngân sách → đề xuất phương án vừa ngân sách, áp dụng được; gói chọn tay tách riêng khỏi phát sinh', async () => {
  const { json: { id } } = await api('/api/projects', 'POST', { ref_urls: ['brand-mau.vn'] });
  const runId = (await api(`/api/projects/${id}`)).json.runs[0].id;
  await run("UPDATE job_queue SET status='done' WHERE run_id=?", runId);
  await ingest({ id: runId, project_id: id, url: 'https://brand-mau.vn/' }, {
    ok: true, input: 'https://brand-mau.vn/', sitemap: { status: 'found' }, coverage: { discovered: 90 },
    templates: [{ template: 'home', kind: 'home', url_count: 1 }, { template: 'about', kind: 'about', url_count: 1 }],
    metrics: { pages: 3, max_elements: 3500, max_nav_links: 70, max_languages: 2, framework: null },
    pages: [{ url: 'https://brand-mau.vn/', template: 'home', captured_at: new Date().toISOString(), features: [
      { feature: 'MULTILANG', detail: 'VI | EN', verification: 'observed' }, { feature: 'BOOKING', detail: 'Đặt lịch', verification: 'observed' },
      { feature: 'LOYALTY', detail: 'Tích điểm', verification: 'observed' }, { feature: 'SEARCH', detail: 'Tìm kiếm', verification: 'observed' }] }],
  });
  // sale chọn tay gói đắt hơn → hiện riêng "gói chọn tay", không tính là phát sinh tính năng
  await api(`/api/projects/${id}`, 'PUT', { pricing: { package_code: 'HERO 8', package_price: null } });
  let q = (await api(`/api/projects/${id}/quick`)).json;
  assert.equal(q.package_choice.manual, 'HERO 8');
  assert.ok(q.package_choice.diff > 0);
  assert.equal(q.changes.length, 0);
  // ngân sách thấp → có phương án vừa ngân sách
  await api(`/api/projects/${id}`, 'PUT', { budget: 12000000 });
  q = (await api(`/api/projects/${id}/quick`)).json;
  const plan = q.budget_plan.plans.find((p) => p.fits);
  assert.ok(plan, JSON.stringify(q.budget_plan));
  assert.ok(plan.price <= q.budget_plan.target);
  assert.equal((await api(`/api/projects/${id}/apply-plan`, 'POST', plan.apply)).status, 200);
  const after = (await api(`/api/projects/${id}`)).json;
  assert.ok(Number(after.preview.total_incl_vat) <= 12000000, `sau khi áp dụng: ${after.preview.total_incl_vat}`);
  assert.equal(after.project.pricing.package_code, null); // bỏ gói chọn tay
  assert.equal((await api(`/api/projects/${id}/quick`)).json.budget_plan, null); // đã vừa ngân sách
});

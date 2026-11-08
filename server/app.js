import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { one, all, run, tx, audit, loadJson, activeSetting, ready, ROOT, DATA_DIR, IS_SERVERLESS, PERSISTENT, DRIVER } from './db.js';
import { computeQuote, toJSONSafe } from './pricing.js';
import { buildAutoLines, applyPackage, findPackage, recommendPackages, featureByCode, featureTiers, packagePrice } from './estimate.js';
import { normalizeDomain, domainOf } from './crawler/urls.js';
import { renderCustomerQuote } from './quote-html.js';
import { suggestFromBrief } from './brief.js';
import { refreshAssessment, assessComplexity, RUBRIC } from './complexity.js';
import { mountAuth } from './auth.js';
import { captureBaseline, enqueueRun, kickQueue } from './jobs.js';

export const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(ROOT, 'public')));
app.set('trust proxy', true);
mountAuth(app); // APP_PASSWORD → mọi API / báo giá / ảnh cần đăng nhập
const h0 = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
app.get('/storage/runs/:run/:file', h0(async (req, res) => {
  const rel = `runs/${Number(req.params.run)}/${path.basename(req.params.file)}`;
  const a = await one('SELECT content_type, data FROM assets WHERE path=?', rel);
  if (a) return res.type(a.content_type).set('Cache-Control', 'private, max-age=86400').send(Buffer.from(a.data));
  const file = path.join(DATA_DIR, rel);
  if (fs.existsSync(file)) return res.sendFile(file);
  res.status(404).end();
}));

const catalog = () => loadJson('data/catalog.json');
let PKG = { data: null, at: 0 };
async function refreshPackages(force = false) {
  if (!force && PKG.data && Date.now() - PKG.at < 60000) return;
  const row = await one("SELECT value FROM app_kv WHERE key='packages'");
  PKG = { data: row ? JSON.parse(row.value) : loadJson('data/packages.json'), at: Date.now() };
}
const packagesData = () => PKG.data || loadJson('data/packages.json');
app.use((req, res, next) => (/^\/(api|quote)\//.test(req.path) ? refreshPackages().then(() => next(), next) : next()));

// ---------- Người dùng & phân quyền ----------
// Phiên bản thử nghiệm: chọn người dùng qua header X-User-Id. Khi đưa vào core admin, thay bằng đăng nhập của core.
const PERMS = {
  'project.edit': ['sales', 'tech', 'admin'],
  'survey.run': ['sales', 'tech', 'admin'],
  'requirement.decide': ['sales', 'admin'],
  'requirement.edit': ['sales', 'tech', 'admin'],
  'estimate.edit': ['tech', 'admin'],
  'pricing.edit': ['sales', 'pricing_manager', 'admin'],
  'settings.edit': ['pricing_manager', 'admin'],
  'version.create': ['sales', 'tech', 'pricing_manager', 'admin'],
  'version.approve': ['pricing_manager', 'admin'],
  'actuals.edit': ['tech', 'pricing_manager', 'admin'],
  'packages.sync': ['pricing_manager', 'admin'],
  'internal.view': ['sales', 'tech', 'pricing_manager', 'admin'],
};
class HttpError extends Error { constructor(status, msg, extra) { super(msg); this.status = status; this.extra = extra; } }
const need = (req, perm) => { if (!PERMS[perm].includes(req.user.role)) throw new HttpError(403, `Vai trò "${req.user.role}" không có quyền ${perm}`); };
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.get('/api/users', h(async (req, res) => res.json(await all('SELECT * FROM users ORDER BY id'))));
app.use('/api', h(async (req, res, next) => {
  const u = await one('SELECT * FROM users WHERE id=?', Number(req.get('x-user-id') || 0));
  if (!u) return res.status(401).json({ error: 'Chọn người dùng (X-User-Id).' });
  req.user = u; next();
}));

// ---------- Danh mục, gói, cấu hình ----------
app.get('/api/meta', h(async (req, res) => {
  const pkgs = pkgDataWith(parseSetting(await activeSetting('policy'))?.data);
  res.json({
    catalog: catalog(), packages: pkgs, feature_tiers: featureTiers(catalog(), pkgs),
    rate_card: parseSetting(await activeSetting('rate_card')), policy: parseSetting(await activeSetting('policy')),
    settings: (await all('SELECT s.*, u.name approved_by_name FROM settings_versions s LEFT JOIN users u ON u.id=s.approved_by ORDER BY kind, effective_from DESC, id DESC')).map(parseSetting),
    perms: Object.fromEntries(Object.entries(PERMS).map(([k, roles]) => [k, roles.includes(req.user.role)])),
    storage: { persistent: PERSISTENT, driver: DRIVER },
    measure_rubric: RUBRIC.map((r) => ({ key: r.key, title: r.title, how: r.how, bands: r.bands.map((b) => ({ label: b.label, pts: b.pts })) })),
  });
}));
const parseSetting = (s) => (s ? { ...s, data: JSON.parse(s.data_json), data_json: undefined } : null);
// Giá thêm 1 GB hosting/năm: matbao.ws chưa niêm yết → lấy từ chính sách giá (giả định, quản lý giá sửa được).
const HOSTING_GB_PRICE_DEFAULT = 500000;
function pkgDataWith(policy) {
  const d = packagesData();
  const price = Number(policy?.hosting_gb_price_year ?? HOSTING_GB_PRICE_DEFAULT);
  const ad = { code: 'ADD_HOSTING_1GB', name: 'Thêm 1 GB dung lượng hosting (gia hạn hằng năm)', price, unit: '1 GB', recurring: 'yearly', source: 'Giả định nội bộ (matbao.ws chưa niêm yết) — sửa ở Đơn giá & chính sách' };
  const lang = { code: 'ADD_LANGUAGE', name: 'Dựng nội dung ngôn ngữ bổ sung (dịch, dàn trang, nhập liệu)', pct: Number(policy?.extra_language_pct ?? 30), price: 0, unit: '% giá gói', recurring: null, source: 'Giả định nội bộ — sửa ở Đơn giá & chính sách; bỏ nếu khách tự cung cấp bản dịch' };
  return { ...d, addons: [...(d.addons || []).filter((a) => a.code !== ad.code && a.code !== lang.code), ad, lang] };
}

app.post('/api/settings', h(async (req, res) => {
  need(req, 'settings.edit');
  const { kind, version, data, effective_from, note } = req.body;
  if (!['rate_card', 'policy'].includes(kind) || !version || !effective_from || typeof data !== 'object') throw new HttpError(400, 'Thiếu kind/version/effective_from/data');
  if (kind === 'policy') {
    const g = Number(data.target_margin_pct), gm = Number(data.min_margin_pct);
    if (!(g >= 0 && g < 100 && gm >= 0 && gm < 100 && gm <= g)) throw new HttpError(400, 'Biên phải trong [0,100) và biên tối thiểu ≤ biên mục tiêu');
  } else if (Object.values(data).some((v) => !(Number(v) > 0))) throw new HttpError(400, 'Đơn giá vai trò phải > 0');
  await tx(async () => {
    // kết thúc hiệu lực bản trước khi bản mới bắt đầu (bản cũ vẫn giữ để tái hiện báo giá đã duyệt)
    const prev = new Date(new Date(effective_from).getTime() - 86400000).toISOString().slice(0, 10);
    await run('UPDATE settings_versions SET effective_to=? WHERE kind=? AND effective_to IS NULL AND effective_from<?', prev, kind, effective_from);
    const r = await run('INSERT INTO settings_versions (kind, version, data_json, effective_from, approved_by, note) VALUES (?,?,?,?,?,?)', kind, version, JSON.stringify(data), effective_from, req.user.id, note || null);
    await audit({ entity: 'settings', entity_id: Number(r.lastInsertRowid), user_id: req.user.id, action: 'create', after: { kind, version, data, effective_from } });
  });
  res.json({ ok: true });
}));

app.post('/api/packages/sync', h(async (req, res) => {
  need(req, 'packages.sync');
  const { syncPackages } = await import('../scripts/sync-packages.js');
  const before = packagesData();
  const data = await syncPackages({ log: () => {} });
  await run("INSERT INTO app_kv (key, value, updated_at) VALUES ('packages', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at", JSON.stringify(data));
  if (!IS_SERVERLESS) fs.writeFileSync(path.join(ROOT, 'data/packages.json'), JSON.stringify(data, null, 2));
  await refreshPackages(true);
  const changes = [];
  for (const l of data.lines) for (const p of l.packages) {
    const old = before.lines.find((x) => x.id === l.id)?.packages.find((x) => x.code === p.code);
    if (!old) changes.push(`${p.code}: mới`);
    else if (old.price.min !== p.price.min || old.price.max !== p.price.max) changes.push(`${p.code}: ${old.price.min}→${p.price.min}`);
  }
  await audit({ entity: 'packages', user_id: req.user.id, action: 'sync', after: { captured_at: data.captured_at, changes } });
  res.json({ ok: true, captured_at: data.captured_at, changes });
}));

// ---------- Hồ sơ ----------
const STATUS_LABEL = { draft: 'Nháp', clarify: 'Cần làm rõ', estimating: 'Dự toán', pending: 'Chờ duyệt', approved: 'Đã duyệt' };

app.get('/api/projects', h(async (req, res) => {
  const rows = await all('SELECT p.*, u.name owner_name FROM projects p LEFT JOIN users u ON u.id=p.owner_id ORDER BY p.updated_at DESC');
  const out = [];
  for (const p of rows) { const st = await projectState(p.id); out.push({ ...p, pricing_json: undefined, status: st.status, status_label: STATUS_LABEL[st.status], price_net: st.preview?.price_net ?? null }); }
  res.json(out);
}));

app.post('/api/projects', h(async (req, res) => {
  need(req, 'project.edit');
  const b = req.body;
  const rawDomains = [].concat(b.ref_urls || []).map((x) => String(x || '').trim()).filter(Boolean);
  const bad = rawDomains.find((x) => !normalizeDomain(x));
  if (bad) throw new HttpError(400, `"${bad}" không phải tên miền hợp lệ — ví dụ: bachhoaxanh.com`);
  if (!rawDomains.length && !String(b.brief || '').trim() && !String(b.customer_name || '').trim()) throw new HttpError(400, 'Nhập tên miền web mẫu (ví dụ: bachhoaxanh.com)');
  const firstUrl = rawDomains.map(normalizeDomain)[0];
  b.name = (b.name || '').trim() || (firstUrl ? domainOf(firstUrl) : '') || (b.customer_name || '').trim() || 'Báo giá mới';
  const pol = parseSetting(await activeSetting('policy'));
  const id = await tx(async () => {
    const n = Number((await one('SELECT COUNT(*) n FROM projects')).n) + 1;
    const code = `HS${new Date().toISOString().slice(2, 7).replace('-', '')}-${String(n).padStart(3, '0')}`;
    const r = await run(`INSERT INTO projects (code, name, customer_name, customer_contact, project_type, site_kind, brief, budget, owner_id, pricing_json) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      code, b.name, b.customer_name || null, b.customer_contact || null, b.project_type || 'new', b.site_kind || 'catalog', b.brief || null, b.budget ? Number(b.budget) : null, req.user.id,
      JSON.stringify({ mode: 'package', package_code: null, package_price: null, discount_pct: 0, extra_addons: [], recurring: [], risk_override: {}, valid_days: pol?.data.quote_valid_days ?? 30, payment_terms: pol?.data.default_payment_terms || '' }));
    const pid = Number(r.lastInsertRowid);
    const seen = new Set();
    for (const u of rawDomains) {
      const url = normalizeDomain(u);
      if (!url || seen.has(domainOf(url))) continue;
      seen.add(domainOf(url));
      const rr = await run('INSERT INTO refs (project_id, url, learn_notes) VALUES (?,?,?)', pid, url, null);
      if (PERMS['survey.run'].includes(req.user.role)) await queueSurvey(pid, Number(rr.lastInsertRowid), url, 20, req.user.id);
    }
    for (const rk of catalog().default_risks) await run('INSERT INTO risks (project_id, title, prob_pct, impact) VALUES (?,?,?,?)', pid, rk.title, rk.prob_pct, rk.impact);
    for (const [i, q] of catalog().general_questions.entries()) await run('INSERT INTO questions (project_id, code, text, blocking) VALUES (?,?,?,?)', pid, `Q${String(i + 1).padStart(3, '0')}`, q.text, q.blocking ? 1 : 0);
    await audit({ project_id: pid, entity: 'project', entity_id: pid, user_id: req.user.id, action: 'create', after: b });
    return pid;
  });
  if (b.brief && String(b.brief).trim()) await applyBrief(id, req.user, b.brief);
  kickQueue();
  res.json({ id });
}));

// ---------- Báo giá nhanh ----------
// Phân tích mô tả và áp dụng: khách muốn → Làm, khách nói không → Bỏ (không ghi đè quyết định đã có).
async function applyBrief(pid, user, brief) {
  const sug = await suggestFromBrief(catalog(), brief);
  await tx(async () => {
    for (const it of sug.items) {
      const ex = await one('SELECT * FROM requirements WHERE project_id=? AND feature=?', pid, it.feature);
      if (ex && ex.decision !== 'pending') continue;
      if (ex) await run("UPDATE requirements SET decision=?, source_kind='client', quantity=COALESCE(?, quantity), updated_at=datetime('now') WHERE id=?", it.wanted ? 'include' : 'exclude', it.quantity ?? null, ex.id);
      else await addRequirement(pid, user, { feature: it.feature, quantity: it.quantity ?? undefined, acceptance: it.acceptance, notes: 'Từ mô tả: ' + it.evidence, decision: it.wanted ? 'include' : 'exclude' });
    }
    await syncAutoLines(pid);
  });
  return sug;
}

// Nếu đã từng "Sinh dự toán" thì sinh lại dòng tự động để giá luôn theo yêu cầu mới (giữ dòng thêm tay).
async function syncAutoLines(pid, force = false) {
  if (!force && !await one("SELECT 1 FROM estimate_lines WHERE project_id=? AND source='auto' LIMIT 1", pid)) return 0;
  const lines = buildAutoLines(catalog(), await all('SELECT * FROM requirements WHERE project_id=?', pid));
  await run("DELETE FROM estimate_lines WHERE project_id=? AND source='auto'", pid);
  for (const [i, l] of lines.entries()) await run('INSERT INTO estimate_lines (project_id, code, title, grp, role, unit, qty, o, m, p, feature, requirement_id, source, sort) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    pid, l.code, l.title, l.group, l.role, l.unit, l.qty, l.o, l.m, l.p, l.feature, l.requirement_id, 'auto', i);
  return lines.length;
}

app.post('/api/projects/:id/brief-apply', h(async (req, res) => {
  need(req, 'requirement.edit');
  const pid = Number(req.params.id);
  await run("UPDATE projects SET brief=?, rev=rev+1, updated_at=datetime('now') WHERE id=?", req.body.brief || null, pid);
  const sug = await applyBrief(pid, req.user, req.body.brief || '');
  res.json({ ok: true, engine: sug.engine, found: sug.items.length, warning: sug.warning });
}));

// Tick / bỏ tick một tính năng, hoặc đổi khối lượng
app.post('/api/projects/:id/quick-feature', h(async (req, res) => {
  need(req, 'requirement.decide');
  const pid = Number(req.params.id);
  const { feature, include } = req.body;
  const quantity = req.body.quantity === '' || req.body.quantity == null ? null : Number(req.body.quantity);
  if (!featureByCode(catalog(), feature)) throw new HttpError(400, 'Tính năng không có trong danh mục');
  await tx(async () => {
    const ex = await one('SELECT * FROM requirements WHERE project_id=? AND feature=?', pid, feature);
    const decision = include ? 'include' : 'exclude';
    let rid = ex?.id;
    if (ex) {
      await run("UPDATE requirements SET decision=?, quantity=COALESCE(?, quantity), updated_at=datetime('now') WHERE id=?", decision, quantity, ex.id);
      await run(`UPDATE questions SET status=? WHERE requirement_id=? AND status=?`, include ? 'open' : 'dropped', ex.id, include ? 'dropped' : 'open');
      await audit({ project_id: pid, entity: 'requirement', entity_id: ex.id, user_id: req.user.id, action: 'quick_update', before: { decision: ex.decision, quantity: ex.quantity }, after: { decision, quantity } });
    } else if (include) {
      rid = await addRequirement(pid, req.user, { feature, quantity: quantity ?? undefined, decision: 'include' });
    }
    // Nhập số lượng = đã trả lời câu hỏi "bao nhiêu" của mục đó
    // số do sale/khách nhập → đánh dấu 'client' để lần quét lại không ghi đè
    if (['DESIGN_LEVEL', 'PAGES', 'DATA_PRODUCTS', 'DATA_POSTS', 'HOSTING_STORAGE'].includes(feature) && quantity != null && rid) await run("UPDATE requirements SET source_kind='client' WHERE id=?", rid);
    if (include && quantity != null && rid && ['PAGES', 'DATA_PRODUCTS', 'DATA_POSTS', 'HOSTING_STORAGE'].includes(feature)) {
      await run("UPDATE questions SET answer=?, status='answered' WHERE requirement_id=? AND status='open' AND blocking=1", `Số lượng: ${quantity} (nhập ở báo giá nhanh)`, rid);
    }
    await syncAutoLines(pid);
  });
  res.json({ ok: true });
}));

app.get('/api/projects/:id', h(async (req, res) => {
  const id = Number(req.params.id);
  const p = await one('SELECT p.*, u.name owner_name FROM projects p LEFT JOIN users u ON u.id=p.owner_id WHERE p.id=?', id);
  if (!p) await projectOr404(id);
  const st = await projectState(id);
  kickQueue(); // serverless: tiếp tục lượt quét đang chờ (nếu có)
  res.json({
    project: { ...p, pricing: JSON.parse(p.pricing_json), pricing_json: undefined },
    status: st.status, status_label: STATUS_LABEL[st.status],
    refs: await all('SELECT * FROM refs WHERE project_id=? ORDER BY id', id),
    runs: (await all('SELECT * FROM analysis_runs WHERE project_id=? ORDER BY id DESC', id)).map((r) => ({ ...r, coverage: JSON.parse(r.coverage_json || 'null'), robots: JSON.parse(r.robots_json || 'null'), templates: JSON.parse(r.templates_json || '[]'), coverage_json: undefined, robots_json: undefined, templates_json: undefined })),
    evidence: await all('SELECT * FROM evidence WHERE project_id=? ORDER BY id', id),
    requirements: (await all('SELECT * FROM requirements WHERE project_id=? ORDER BY id', id)).map((r) => ({ ...r, evidence_codes: JSON.parse(r.evidence_codes) })),
    questions: await all('SELECT * FROM questions WHERE project_id=? ORDER BY id', id),
    lines: await all('SELECT * FROM estimate_lines WHERE project_id=? ORDER BY sort, id', id),
    risks: await all('SELECT * FROM risks WHERE project_id=? ORDER BY id', id),
    external: await all('SELECT * FROM external_costs WHERE project_id=? ORDER BY id', id),
    versions: (await all('SELECT v.id, v.version, v.status, v.quote_code, v.valid_until, v.created_at, v.approved_at, v.review_note, v.input_hash, v.result_json, c.name created_by_name, a.name approved_by_name FROM quote_versions v LEFT JOIN users c ON c.id=v.created_by LEFT JOIN users a ON a.id=v.approved_by WHERE v.project_id=? ORDER BY v.version DESC', id))
      .map(({ result_json, ...v }) => ({ ...v, price_net: JSON.parse(result_json || '{}').price_net ?? null })),
    preview: st.preview, applied: st.applied, release_checks: st.release, input_hash: st.hash, meta: st.meta,
    actuals: await all('SELECT * FROM actuals WHERE project_id=? ORDER BY id', id),
  });
}));

app.put('/api/projects/:id', h(async (req, res) => {
  const id = Number(req.params.id);
  const p = await one('SELECT * FROM projects WHERE id=?', id);
  if (!p) throw new HttpError(404, 'Không có hồ sơ');
  if (req.body.rev != null && Number(req.body.rev) !== p.rev) throw new HttpError(409, 'Hồ sơ vừa được người khác sửa — tải lại để xem thay đổi.');
  const fields = ['name', 'customer_name', 'customer_contact', 'project_type', 'site_kind', 'brief', 'budget'];
  const sets = []; const vals = [];
  if (fields.some((f) => f in req.body)) {
    need(req, 'project.edit');
    for (const f of fields) if (f in req.body) { sets.push(`${f}=?`); vals.push(req.body[f] === '' ? null : req.body[f]); }
  }
  if (req.body.pricing) {
    need(req, 'pricing.edit');
    const cur = JSON.parse(p.pricing_json);
    const next = { ...cur, ...req.body.pricing };
    const d = Number(next.discount_pct || 0);
    if (!(d >= 0 && d < 100)) throw new HttpError(400, 'Giảm giá không hợp lệ');
    sets.push('pricing_json=?'); vals.push(JSON.stringify(next));
  }
  if (!sets.length) return res.json({ ok: true });
  await run(`UPDATE projects SET ${sets.join(', ')}, rev=rev+1, updated_at=datetime('now') WHERE id=?`, ...vals, id);
  await audit({ project_id: id, entity: 'project', entity_id: id, user_id: req.user.id, action: 'update', before: pick(p, Object.keys(req.body)), after: req.body, reason: req.body.reason });
  res.json({ ok: true });
}));
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]));

// ---------- Web tham khảo & khảo sát ----------
app.post('/api/projects/:id/refs', h(async (req, res) => {
  need(req, 'project.edit');
  const url = normalizeDomain(req.body.url);
  if (!url) throw new HttpError(400, `"${String(req.body.url || '').trim()}" không phải tên miền hợp lệ — ví dụ: bachhoaxanh.com`);
  const pid = Number(req.params.id);
  if ((await all('SELECT url FROM refs WHERE project_id=?', pid)).some((r) => { try { return domainOf(r.url) === domainOf(url); } catch { return false; } })) throw new HttpError(409, `Tên miền ${domainOf(url)} đã có trong báo giá này.`);
  const r = await run('INSERT INTO refs (project_id, url, learn_notes) VALUES (?,?,?)', pid, url, req.body.learn_notes || null);
  const refId = Number(r.lastInsertRowid);
  const queued = PERMS['survey.run'].includes(req.user.role) ? await queueSurvey(pid, refId, url, 20, req.user.id) : null;
  kickQueue();
  res.json({ id: refId, survey_run_id: queued });
}));
app.put('/api/refs/:id', h(async (req, res) => { need(req, 'project.edit'); await run('UPDATE refs SET learn_notes=? WHERE id=?', req.body.learn_notes || null, Number(req.params.id)); res.json({ ok: true }); }));
app.delete('/api/refs/:id', h(async (req, res) => { need(req, 'project.edit'); await run('DELETE FROM refs WHERE id=?', Number(req.params.id)); res.json({ ok: true }); }));

app.post('/api/projects/:id/survey', h(async (req, res) => {
  need(req, 'survey.run');
  const pid = Number(req.params.id);
  const ref = await one('SELECT * FROM refs WHERE id=? AND project_id=?', Number(req.body.ref_id), pid);
  if (!ref) throw new HttpError(400, 'Chọn web tham khảo');
  const active = await one("SELECT id FROM analysis_runs WHERE ref_id=? AND status IN ('queued','running')", ref.id);
  if (active) throw new HttpError(409, 'Web này đang được khảo sát');
  const id = await queueSurvey(pid, ref.id, ref.url, req.body.max_urls, req.user.id);
  kickQueue();
  res.json({ id });
}));

async function queueSurvey(pid, refId, url, maxUrlsRaw, userId) {
  const maxUrls = Math.min(Math.max(Number(maxUrlsRaw) || 20, 1), 40);
  const r = await run("INSERT INTO analysis_runs (project_id, ref_id, url, status, max_urls, created_by, input_hash) VALUES (?,?,?,'running',?,?,?)", pid, refId, url, maxUrls, userId, sha({ url, maxUrls }));
  const runId = Number(r.lastInsertRowid);
  await enqueueRun(runId);
  await audit({ project_id: pid, entity: 'analysis_run', entity_id: runId, user_id: userId, action: 'queue', after: { url, maxUrls } });
  return runId;
}

// Khảo sát mọi web tham khảo chưa từng quét (mỗi URL một lần)
app.post('/api/projects/:id/survey-all', h(async (req, res) => {
  need(req, 'survey.run');
  const pid = Number(req.params.id);
  const refs = await all(`SELECT r.* FROM refs r WHERE r.project_id=? AND NOT EXISTS (SELECT 1 FROM analysis_runs a WHERE a.project_id=r.project_id AND a.url=r.url) ORDER BY r.id`, pid);
  const seen = new Set(); const ids = [];
  for (const r of refs) { if (seen.has(r.url)) continue; seen.add(r.url); ids.push(await queueSurvey(pid, r.id, r.url, req.body.max_urls, req.user.id)); }
  kickQueue();
  res.json({ ok: true, queued: ids.length });
}));

// Chốt nhanh: mọi yêu cầu đang chờ / hỏi lại → Làm (hoặc Bỏ)
app.post('/api/projects/:id/requirements/bulk-decision', h(async (req, res) => {
  need(req, 'requirement.decide');
  const pid = Number(req.params.id);
  const decision = req.body.decision === 'exclude' ? 'exclude' : 'include';
  const rows = await all("SELECT id, code FROM requirements WHERE project_id=? AND decision IN ('pending','ask')", pid);
  await tx(async () => {
    for (const r of rows) await run("UPDATE requirements SET decision=?, updated_at=datetime('now') WHERE id=?", decision, r.id);
    if (decision === 'exclude') await run("UPDATE questions SET status='dropped' WHERE status='open' AND requirement_id IN (SELECT id FROM requirements WHERE project_id=? AND decision='exclude')", pid);
    await audit({ project_id: pid, entity: 'requirement', user_id: req.user.id, action: 'bulk_decision', after: { decision, codes: rows.map((r) => r.code) } });
  });
  res.json({ ok: true, n: rows.length });
}));

// ---------- Yêu cầu & câu hỏi ----------
async function nextCode(table, pid, prefix) {
  const max = (await all(`SELECT code FROM ${table} WHERE project_id=? AND code LIKE ?`, pid, prefix + '%')).reduce((m, r) => Math.max(m, Number(r.code.slice(prefix.length)) || 0), 0);
  return prefix + String(max + 1).padStart(3, '0');
}

async function addRequirement(pid, user, { feature, title, quantity, acceptance, notes, source_kind = 'client', decision = 'pending' }) {
  const f = feature ? featureByCode(catalog(), feature) : null;
  if (feature && !f) throw new HttpError(400, `Mã tính năng không có trong danh mục: ${feature}`);
  const existing = feature && await one('SELECT * FROM requirements WHERE project_id=? AND feature=?', pid, feature);
  if (existing) {
    // khách xác nhận yêu cầu đã quan sát được → nâng nguồn lên "client", giữ dẫn chứng
    await run("UPDATE requirements SET source_kind='client', quantity=COALESCE(?, quantity), acceptance=COALESCE(?, acceptance), notes=COALESCE(?, notes), updated_at=datetime('now') WHERE id=?", quantity ?? null, acceptance || null, notes || null, existing.id);
    return existing.id;
  }
  const code = await nextCode('requirements', pid, 'R');
  const r = await run('INSERT INTO requirements (project_id, code, feature, title, source_kind, decision, quantity, unit, acceptance, notes) VALUES (?,?,?,?,?,?,?,?,?,?)',
    pid, code, feature || null, title || f?.title || 'Yêu cầu', source_kind, decision, quantity ?? f?.default_qty ?? null, f?.unit || null, acceptance || null, notes || null);
  const rid = Number(r.lastInsertRowid);
  for (const q of f?.questions || []) await run('INSERT INTO questions (project_id, code, requirement_id, text, blocking) VALUES (?,?,?,?,?)', pid, await nextCode('questions', pid, 'Q'), rid, q.text, q.blocking ? 1 : 0);
  await audit({ project_id: pid, entity: 'requirement', entity_id: rid, user_id: user.id, action: 'create', after: { code, feature, title, quantity } });
  return rid;
}

app.post('/api/projects/:id/requirements', h(async (req, res) => {
  need(req, 'requirement.edit');
  const pid = Number(req.params.id);
  const id = await tx(async () => await addRequirement(pid, req.user, req.body));
  res.json({ id });
}));

app.post('/api/projects/:id/brief-suggest', h(async (req, res) => {
  need(req, 'requirement.edit');
  const p = await projectOr404(Number(req.params.id));
  const out = await suggestFromBrief(catalog(), req.body.brief ?? p.brief ?? '');
  res.json(out);
}));

app.put('/api/requirements/:id', h(async (req, res) => {
  const r = await one('SELECT * FROM requirements WHERE id=?', Number(req.params.id));
  if (!r) throw new HttpError(404, 'Không có yêu cầu');
  const b = req.body;
  if ('decision' in b) {
    need(req, 'requirement.decide');
    if (!['pending', 'include', 'exclude', 'ask'].includes(b.decision)) throw new HttpError(400, 'Quyết định không hợp lệ');
  }
  if (['quantity', 'acceptance', 'notes', 'title', 'priority'].some((k) => k in b)) need(req, 'requirement.edit');
  const keys = ['decision', 'quantity', 'acceptance', 'notes', 'title', 'priority'].filter((k) => k in b);
  if (!keys.length) return res.json({ ok: true });
  await tx(async () => {
    await run(`UPDATE requirements SET ${keys.map((k) => `${k}=?`).join(', ')}, updated_at=datetime('now') WHERE id=?`, ...keys.map((k) => (b[k] === '' ? null : b[k])), r.id);
    // bỏ yêu cầu → các câu hỏi của nó không còn chặn
    if (b.decision === 'exclude') await run("UPDATE questions SET status='dropped' WHERE requirement_id=? AND status='open'", r.id);
    if (b.decision && b.decision !== 'exclude') await run("UPDATE questions SET status='open' WHERE requirement_id=? AND status='dropped'", r.id);
    await audit({ project_id: r.project_id, entity: 'requirement', entity_id: r.id, user_id: req.user.id, action: 'update', before: pick(r, keys), after: pick(b, keys), reason: b.reason });
  });
  res.json({ ok: true });
}));
app.delete('/api/requirements/:id', h(async (req, res) => { need(req, 'requirement.edit'); const r = await one('SELECT * FROM requirements WHERE id=?', Number(req.params.id)); await run('DELETE FROM requirements WHERE id=?', r.id); await audit({ project_id: r.project_id, entity: 'requirement', entity_id: r.id, user_id: req.user.id, action: 'delete', before: r }); res.json({ ok: true }); }));

app.post('/api/projects/:id/questions', h(async (req, res) => {
  need(req, 'requirement.edit');
  const pid = Number(req.params.id);
  if (!req.body.text) throw new HttpError(400, 'Nhập câu hỏi');
  await run('INSERT INTO questions (project_id, code, requirement_id, text, blocking) VALUES (?,?,?,?,?)', pid, await nextCode('questions', pid, 'Q'), req.body.requirement_id || null, req.body.text, req.body.blocking ? 1 : 0);
  res.json({ ok: true });
}));
app.put('/api/questions/:id', h(async (req, res) => {
  need(req, 'requirement.edit');
  const q = await one('SELECT * FROM questions WHERE id=?', Number(req.params.id));
  const answer = 'answer' in req.body ? req.body.answer : q.answer;
  const status = req.body.status || (answer ? 'answered' : q.status);
  const blocking = 'blocking' in req.body ? (req.body.blocking ? 1 : 0) : q.blocking;
  await run('UPDATE questions SET answer=?, status=?, blocking=? WHERE id=?', answer || null, status, blocking, q.id);
  await audit({ project_id: q.project_id, entity: 'question', entity_id: q.id, user_id: req.user.id, action: 'update', before: pick(q, ['answer', 'status', 'blocking']), after: { answer, status, blocking } });
  res.json({ ok: true });
}));

// ---------- Bóc tách công việc ----------
app.post('/api/projects/:id/estimate/generate', h(async (req, res) => {
  need(req, 'estimate.edit');
  const pid = Number(req.params.id);
  const reqs = await all('SELECT * FROM requirements WHERE project_id=?', pid);
  const lines = buildAutoLines(catalog(), reqs);
  await tx(async () => {
    await run("DELETE FROM estimate_lines WHERE project_id=? AND source='auto'", pid);
    for (const [i, l] of lines.entries()) await run('INSERT INTO estimate_lines (project_id, code, title, grp, role, unit, qty, o, m, p, feature, requirement_id, source, sort) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      pid, l.code, l.title, l.group, l.role, l.unit, l.qty, l.o, l.m, l.p, l.feature, l.requirement_id, 'auto', i);
    await audit({ project_id: pid, entity: 'estimate', entity_id: pid, user_id: req.user.id, action: 'generate', after: { lines: lines.length } });
  });
  res.json({ ok: true, lines: lines.length });
}));

const LINE_FIELDS = ['title', 'grp', 'role', 'unit', 'qty', 'o', 'm', 'p', 'billing_override', 'manual_reason', 'include', 'code'];
app.post('/api/projects/:id/lines', h(async (req, res) => {
  need(req, 'estimate.edit');
  const b = req.body; const pid = Number(req.params.id);
  if (!b.title || !b.role || !b.grp) throw new HttpError(400, 'Cần tên, nhóm, vai trò');
  if (!b.manual_reason) throw new HttpError(400, 'Dòng thêm tay cần lý do');
  const r = await run("INSERT INTO estimate_lines (project_id, code, title, grp, role, unit, qty, o, m, p, source, manual_reason, billing_override, sort) VALUES (?,?,?,?,?,?,?,?,?,?,'manual',?,?,999)",
    pid, b.code || null, b.title, b.grp, b.role, b.unit || null, Number(b.qty || 1), Number(b.o || 0), Number(b.m || 0), Number(b.p || 0), b.manual_reason, b.billing_override || null);
  await audit({ project_id: pid, entity: 'estimate_line', entity_id: Number(r.lastInsertRowid), user_id: req.user.id, action: 'create', after: b, reason: b.manual_reason });
  res.json({ ok: true });
}));
app.put('/api/lines/:id', h(async (req, res) => {
  need(req, 'estimate.edit');
  const l = await one('SELECT * FROM estimate_lines WHERE id=?', Number(req.params.id));
  const keys = LINE_FIELDS.filter((k) => k in req.body);
  if (!keys.length) return res.json({ ok: true });
  if (!req.body.reason && keys.some((k) => ['qty', 'o', 'm', 'p', 'billing_override', 'include'].includes(k))) throw new HttpError(400, 'Sửa định mức/khối lượng cần ghi lý do');
  await run(`UPDATE estimate_lines SET ${keys.map((k) => `${k}=?`).join(', ')}${req.body.reason ? ', manual_reason=?' : ''} WHERE id=?`, ...keys.map((k) => (req.body[k] === '' ? null : req.body[k])), ...(req.body.reason ? [req.body.reason] : []), l.id);
  await audit({ project_id: l.project_id, entity: 'estimate_line', entity_id: l.id, user_id: req.user.id, action: 'update', before: pick(l, keys), after: pick(req.body, keys), reason: req.body.reason });
  res.json({ ok: true });
}));
app.delete('/api/lines/:id', h(async (req, res) => { need(req, 'estimate.edit'); const l = await one('SELECT * FROM estimate_lines WHERE id=?', Number(req.params.id)); await run('DELETE FROM estimate_lines WHERE id=?', l.id); await audit({ project_id: l.project_id, entity: 'estimate_line', entity_id: l.id, user_id: req.user.id, action: 'delete', before: l }); res.json({ ok: true }); }));

for (const [route, table, fields] of [['risks', 'risks', ['title', 'prob_pct', 'impact', 'include']], ['external', 'external_costs', ['title', 'amount', 'include']]]) {
  app.post(`/api/projects/:id/${route}`, h(async (req, res) => {
    need(req, 'estimate.edit');
    const f = fields.filter((k) => k in req.body);
    await run(`INSERT INTO ${table} (project_id, ${f.join(', ')}) VALUES (?, ${f.map(() => '?').join(', ')})`, Number(req.params.id), ...f.map((k) => req.body[k]));
    res.json({ ok: true });
  }));
  app.put(`/api/${route}/:id`, h(async (req, res) => {
    need(req, 'estimate.edit');
    const row = await one(`SELECT * FROM ${table} WHERE id=?`, Number(req.params.id));
    const f = fields.filter((k) => k in req.body);
    if (f.length) await run(`UPDATE ${table} SET ${f.map((k) => `${k}=?`).join(', ')} WHERE id=?`, ...f.map((k) => req.body[k]), row.id);
    await audit({ project_id: row.project_id, entity: table, entity_id: row.id, user_id: req.user.id, action: 'update', before: pick(row, f), after: pick(req.body, f) });
    res.json({ ok: true });
  }));
  app.delete(`/api/${route}/:id`, h(async (req, res) => { need(req, 'estimate.edit'); await run(`DELETE FROM ${table} WHERE id=?`, Number(req.params.id)); res.json({ ok: true }); }));
}

// ---------- Tính giá ----------
// Gợi ý đặt giá trong khoảng của gói (HERO 6/7/8) theo độ phức tạp web mẫu đã đánh giá.
function complexityHint(pricing, reqs) {
  const c = refreshAssessment(pricing?.complexity);
  const dl = reqs.find((r) => r.feature === 'DESIGN_LEVEL' && r.decision === 'include');
  if (!c || !dl) return null;
  const level = Number(dl.quantity || c.level);
  return level === c.level ? { level, fraction: c.fraction, enterprise: c.enterprise } : { level, fraction: 0, enterprise: false };
}
// Hồ sơ không tồn tại → 404 rõ ràng (trước đây đọc p.pricing_json của undefined → 500)
async function projectOr404(pid, cols = '*') {
  const p = await one(`SELECT ${cols} FROM projects WHERE id=?`, pid);
  if (!p) throw new HttpError(404, PERSISTENT ? 'Không có hồ sơ' : 'Không có hồ sơ — máy chủ chưa nối CSDL bền vững nên dữ liệu đã mất khi đổi phiên chạy.');
  return p;
}
async function buildInput(pid) {
  const p = await projectOr404(pid);
  const pricing = JSON.parse(p.pricing_json);
  const rc = parseSetting(await activeSetting('rate_card'));
  const pol = parseSetting(await activeSetting('policy'));
  const reqs = await all('SELECT * FROM requirements WHERE project_id=?', pid);
  const dbLines = await all('SELECT * FROM estimate_lines WHERE project_id=? ORDER BY sort, id', pid);
  let lines = dbLines.map((l) => ({ id: l.id, code: l.code, title: l.title, group: l.grp, role: l.role, unit: l.unit, qty: l.qty, o: l.o, m: l.m, p: l.p, feature: l.feature, requirement_id: l.requirement_id, source: l.source, billing_override: l.billing_override, include: !!l.include }));
  // Chưa bấm "Sinh dự toán" → dùng định mức chuẩn tạm thời để luôn có giá xem trước.
  const provisionalLines = !dbLines.length && reqs.some((r) => r.decision === 'include');
  if (provisionalLines) lines = buildAutoLines(catalog(), reqs).map((l) => ({ ...l, provisional: true }));
  const pkgData = pkgDataWith(pol?.data);
  let pkg = null; let addons = []; let applied = null;
  const mode = pricing.mode === 'cost' ? 'cost' : 'package';
  const rates = rc?.data || {}; const policy = pol?.data || {};
  const external = (await all('SELECT title, amount, include FROM external_costs WHERE project_id=?', pid)).map((e) => ({ ...e, include: !!e.include }));
  const risks = (await all('SELECT title, prob_pct, impact, include FROM risks WHERE project_id=?', pid)).map((r) => ({ ...r, include: !!r.include }));
  // Chưa chọn gói → tạm dùng gói đề xuất rẻ nhất (vẫn phải bấm "Chọn" để chốt trước khi phát hành).
  let packageCode = pricing.package_code; let autoPackage = false;
  if (mode === 'package' && !packageCode && reqs.some((r) => r.decision === 'include')) {
    const rec = recommendPackages(catalog(), pkgData, { requirements: reqs, lines, rates, policy, external, risks, priceHint: complexityHint(pricing, reqs) });
    if (rec.best) { packageCode = rec.best.code; autoPackage = true; }
  }
  if (mode === 'package' && packageCode) {
    const ctx = findPackage(pkgData, packageCode);
    if (ctx) {
      applied = applyPackage(catalog(), pkgData, ctx, lines, reqs);
      lines = applied.lines;
      addons = applied.addons;
      const price = !autoPackage && pricing.package_price != null && pricing.package_price !== '' ? Number(pricing.package_price) : packagePrice(ctx, complexityHint(pricing, reqs));
      pkg = { code: ctx.pkg.code, name: ctx.pkg.name, line: ctx.line.id, price, price_min: ctx.pkg.price.min, price_max: ctx.pkg.price.max, renewal_per_year: ctx.pkg.renewal_per_year, highlights: ctx.pkg.highlights, source_url: ctx.line.source_url, auto: autoPackage };
    }
  }
  for (const a of pricing.extra_addons || []) addons.push(a);
  const input = {
    mode, rates, policy, lines, external, risks,
    risk_override: pricing.risk_override || {}, package: pkg, addons, recurring: pricing.recurring || [], discount_pct: Number(pricing.discount_pct || 0),
  };
  const meta = { rate_card: rc && { id: rc.id, version: rc.version, effective_to: rc.effective_to }, policy: pol && { id: pol.id, version: pol.version }, catalog_version: catalog().version, packages_captured_at: pkgData.captured_at, provisional_lines: provisionalLines, auto_package: autoPackage ? packageCode : null };
  return { p, pricing, input, meta, reqs, applied };
}

async function releaseChecks(pid, b, result) {
  const out = [];
  const add = (level, code, message) => out.push({ level, code, message });
  for (const c of result.checks || []) if (!out.some((x) => x.code === c.code)) out.push(c);
  if (!b.meta.rate_card) add('error', 'NO_RATE_CARD', 'Không có bảng đơn giá còn hiệu lực.');
  if (!b.meta.policy) add('error', 'NO_POLICY', 'Không có chính sách giá còn hiệu lực.');
  const undecided = b.reqs.filter((r) => r.decision === 'pending' || r.decision === 'ask');
  if (!b.reqs.some((r) => r.decision === 'include')) add('error', 'NO_SCOPE', 'Chưa có yêu cầu nào được chọn làm.');
  if (undecided.length) add('error', 'UNDECIDED', `${undecided.length} yêu cầu chưa có quyết định rõ (làm/bỏ): ${undecided.map((r) => r.code).join(', ')}`);
  const blocking = await all(`SELECT q.code FROM questions q LEFT JOIN requirements r ON r.id=q.requirement_id WHERE q.project_id=? AND q.blocking=1 AND q.status='open' AND (r.id IS NULL OR r.decision!='exclude')`, pid);
  if (blocking.length) add('error', 'BLOCKING_QUESTIONS', `Còn câu hỏi chặn chưa trả lời: ${blocking.map((q) => q.code).join(', ')}`);
  const noQty = b.reqs.filter((r) => r.decision === 'include' && (r.quantity == null || r.quantity === ''));
  if (noQty.length) add('error', 'NO_QUANTITY', `Yêu cầu chưa có khối lượng: ${noQty.map((r) => r.code).join(', ')}`);
  const noAcc = b.reqs.filter((r) => r.decision === 'include' && !r.acceptance && featureByCode(catalog(), r.feature)?.questions?.some((q) => q.blocking));
  if (noAcc.length) add('warn', 'NO_ACCEPTANCE', `Yêu cầu nghiệp vụ nên có tiêu chí nghiệm thu: ${noAcc.map((r) => r.code).join(', ')}`);
  const includedNoLines = b.reqs.filter((r) => r.decision === 'include' && r.feature && featureByCode(catalog(), r.feature)?.items.length && !b.input.lines.some((l) => l.requirement_id === r.id));
  if (includedNoLines.length && !b.meta.provisional_lines) add('error', 'REQ_NOT_ESTIMATED', `Yêu cầu đã chọn nhưng chưa có dòng dự toán (bấm "Sinh dự toán"): ${includedNoLines.map((r) => r.code).join(', ')}`);
  const orphan = b.input.lines.filter((l) => l.requirement_id && b.reqs.find((r) => r.id === l.requirement_id)?.decision === 'exclude');
  if (orphan.length) add('error', 'EXCLUDED_IN_ESTIMATE', 'Có dòng dự toán thuộc yêu cầu đã bỏ — sinh lại dự toán.');
  if (b.input.mode === 'package' && !b.input.package && !out.some((c) => c.code === 'PACKAGE_MISSING')) add('error', 'PACKAGE_MISSING', 'Chưa chọn gói matbao.ws.');
  if (b.meta.auto_package) add('error', 'PACKAGE_NOT_CONFIRMED', `Đang tạm dùng gói đề xuất ${b.meta.auto_package} — bấm "Chọn" ở bảng đề xuất (tab Tính giá) để chốt gói.`);
  if (b.meta.provisional_lines) add('error', 'ESTIMATE_NOT_SAVED', 'Giá đang tính theo định mức chuẩn tạm thời — bấm "Sinh dự toán" ở tab Bóc tách công việc để kỹ thuật rà soát và lưu.');
  const maxSales = Number(b.input.policy.sales_max_discount_pct ?? 0);
  if (b.input.discount_pct > maxSales) add('warn', 'DISCOUNT_NEEDS_MANAGER', `Giảm ${b.input.discount_pct}% vượt hạn mức sales (${maxSales}%) — cần quản lý giá duyệt ngoại lệ.`);
  if (!b.pricing.payment_terms) add('error', 'NO_PAYMENT_TERMS', 'Thiếu điều kiện thanh toán.');
  if (!(Number(b.pricing.valid_days) > 0)) add('error', 'NO_VALIDITY', 'Thiếu thời hạn hiệu lực báo giá.');
  return out;
}

async function projectState(pid) {
  const b = await buildInput(pid);
  const result = toJSONSafe(computeQuote(b.input));
  const release = await releaseChecks(pid, b, result);
  const decisions = b.reqs.map((r) => [r.code, r.decision, r.quantity, r.acceptance]);
  const questions = await all('SELECT code, status, blocking, answer FROM questions WHERE project_id=? ORDER BY id', pid);
  const hash = sha({ input: b.input, decisions, questions, pricing: b.pricing });
  const latest = await one('SELECT status, input_hash FROM quote_versions WHERE project_id=? ORDER BY version DESC LIMIT 1', pid);
  let status;
  if (latest && latest.input_hash === hash && latest.status === 'approved') status = 'approved';
  else if (latest && latest.input_hash === hash && latest.status === 'pending') status = 'pending';
  else if (release.some((c) => c.code === 'BLOCKING_QUESTIONS' || c.code === 'UNDECIDED') && b.reqs.length) status = 'clarify';
  else if (b.reqs.length || b.input.lines.length) status = 'estimating';
  else status = 'draft';
  return { status, preview: result, release, hash, meta: b.meta, applied: b.applied && { coverage: b.applied.coverage, addons: b.applied.addons }, build: b };
}

// ---------- Giá sơ bộ theo web mẫu + phát sinh ----------
// Tính giá cho một tập yêu cầu giả định (không ghi CSDL). autoPackage=true: luôn chọn gói rẻ nhất phù hợp.
async function simulatePrice(pid, b, reqs, { autoPackage = false } = {}) {
  const cat = catalog(); const pkgData = pkgDataWith(b.input.policy);
  const manual = (await all("SELECT * FROM estimate_lines WHERE project_id=? AND source='manual'", pid))
    .map((l) => ({ id: l.id, code: l.code, title: l.title, group: l.grp, role: l.role, unit: l.unit, qty: l.qty, o: l.o, m: l.m, p: l.p, source: 'manual', billing_override: l.billing_override, include: !!l.include }));
  // Chưa chọn tính năng nào → không tính đầu việc nền (giống giá chính thức = 0), tránh giá gốc ảo và "−12 tr" ở mọi mục
  let lines = [...(reqs.some((r) => r.decision === 'include') ? buildAutoLines(cat, reqs) : []), ...manual];
  const common = { rates: b.input.rates, policy: b.input.policy, external: b.input.external, risks: b.input.risks };
  const mode = b.input.mode;
  let code = mode === 'package' && !autoPackage ? b.pricing.package_code : null;
  const hint = complexityHint(b.pricing, reqs);
  if (mode === 'package' && !code && reqs.some((r) => r.decision === 'include')) code = recommendPackages(cat, pkgData, { requirements: reqs, lines, ...common, priceHint: hint }).best?.code;
  let pkg = null; let addons = [];
  if (mode === 'package' && code) {
    const ctx = findPackage(pkgData, code);
    const ap = applyPackage(cat, pkgData, ctx, lines, reqs);
    lines = ap.lines; addons = ap.addons;
    const chosen = !autoPackage && b.pricing.package_code === code && b.pricing.package_price != null && b.pricing.package_price !== '';
    pkg = { code, name: ctx.pkg.name, price: chosen ? Number(b.pricing.package_price) : packagePrice(ctx, hint), price_min: ctx.pkg.price.min, price_max: ctx.pkg.price.max, renewal_per_year: ctx.pkg.renewal_per_year };
  }
  const r = computeQuote({ mode, ...common, lines, package: pkg, addons: [...addons, ...(b.pricing.extra_addons || [])], recurring: [], discount_pct: b.input.discount_pct, risk_override: b.input.risk_override });
  return { price: Number(r.price_net ?? 0), package: code, package_name: pkg?.name || null, ok: r.ok !== false };
}

// Hai phương án để sale đưa khách chọn (tránh bị cho là ép giá):
//  - "Giống web mẫu": giữ mức may đo theo bảng đo lường;  - "Tiết kiệm": đủ tính năng, giao diện mẫu dựng sẵn (bỏ mức may đo).
async function designOptions(pid, b, current) {
  const cx = refreshAssessment(b.pricing.complexity);
  const dl = current.find((r) => r.feature === 'DESIGN_LEVEL');
  if (!cx || !dl) return null;
  const level = Number(dl.quantity || cx.level);
  const set = (decision) => current.map((r) => (r.feature === 'DESIGN_LEVEL' ? { ...r, decision, quantity: level } : r));
  const m = await simulatePrice(pid, b, set('include'), { autoPackage: true });
  const e = await simulatePrice(pid, b, set('exclude'), { autoPackage: true });
  return { mode: dl.decision === 'include' ? 'match' : 'economy', level, match: { price: m.price, package: m.package, package_name: m.package_name }, economy: { price: e.price, package: e.package, package_name: e.package_name } };
}

// Đề xuất vừa ngân sách khách (giá trước VAT ≤ target). Thứ tự ưu tiên giữ cho khách:
//  A. giữ đủ tính năng — hạ mức thiết kế (rồi tới "Tiết kiệm") tới khi vừa;
//  B. giữ mức thiết kế hiện tại — bỏ bớt tính năng, mỗi bước bỏ mục giảm giá nhiều nhất;
//  C. không cách nào vừa → phương án thấp nhất (tiết kiệm + bỏ tính năng) và số còn vượt.
const KEEP_FEATURES = new Set(['PAGES', 'DATA_PRODUCTS', 'DATA_POSTS', 'HOSTING_STORAGE', 'DESIGN_LEVEL']);
async function planForBudget(pid, b, current, target) {
  const cat = catalog();
  const title = (code) => cat.features.find((f) => f.code === code)?.title || code;
  const dl = current.find((r) => r.feature === 'DESIGN_LEVEL');
  const curLevel = dl?.decision === 'include' ? Number(dl.quantity || 1) : 0;
  const withDesign = (reqs, lv) => reqs.map((r) => (r.feature === 'DESIGN_LEVEL' ? { ...r, decision: lv ? 'include' : 'exclude', quantity: lv || r.quantity } : r));
  const sim = async (reqs) => (await simulatePrice(pid, b, reqs, { autoPackage: true }));
  const plans = [];
  const maxDisc = Number(b.input.policy?.sales_max_discount_pct ?? 0);
  // giá vượt mục tiêu ít (≤ hạn mức giảm giá của sale) → giảm giá thay vì cắt tính năng
  const discountFor = (price) => { if (price <= target) return 0; const d = Math.ceil((1 - target / price) * 100); return d <= maxDisc ? d : null; };
  // A: giữ đủ tính năng — hạ mức thiết kế (cả mức hiện tại nếu chỉ cần giảm giá)
  if (dl) {
    for (let lv = curLevel; lv >= 0; lv--) {
      const s = await sim(withDesign(current, lv));
      const d = discountFor(s.price);
      if (d === null || (lv === curLevel && d === 0)) continue; // mức hiện tại không giảm giá mà vừa thì đã không vượt ngân sách
      const name = lv ? `Giữ đủ tính năng, giao diện mức M${lv}` : 'Giữ đủ tính năng, giao diện mẫu dựng sẵn (Tiết kiệm)';
      plans.push({ kind: 'design', label: name + (d ? ` + giảm ${d}%` : ''), price: Math.round(s.price * (1 - d / 100)), package: s.package, apply: { level: lv, exclude: [], discount_pct: d }, removed: [] });
      break;
    }
  }
  // B/C: bỏ bớt tính năng (tham lam: mỗi bước bỏ mục giảm nhiều nhất)
  const greedy = async (startLevel) => {
    let reqs = withDesign(current, startLevel); let s = await sim(reqs); const removed = [];
    for (let step = 0; step < 8 && s.price > target; step++) {
      let best = null; let fit = null;
      for (const r of reqs.filter((x) => x.decision === 'include' && x.feature && !KEEP_FEATURES.has(x.feature))) {
        const alt = reqs.map((x) => (x === r ? { ...x, decision: 'exclude' } : x));
        const t = await sim(alt);
        if (t.price >= s.price) continue;
        if (t.price <= target && (!fit || t.price > fit.s.price)) fit = { r, s: t, alt }; // vừa ngân sách mà giữ được nhiều nhất
        if (!best || t.price < best.s.price) best = { r, s: t, alt };
      }
      if (fit) best = fit;
      if (!best) break;
      removed.push({ code: best.r.feature, title: title(best.r.feature), saving: s.price - best.s.price });
      reqs = best.alt; s = best.s;
    }
    return { price: s.price, package: s.package, removed };
  };
  if (curLevel) {
    const g = await greedy(curLevel);
    if (g.price <= target && g.removed.length) plans.push({ kind: 'features', label: `Giữ giao diện M${curLevel}, bỏ ${g.removed.length} tính năng`, ...g, apply: { level: curLevel, exclude: g.removed.map((x) => x.code) } });
  }
  if (!plans.length) {
    const g = await greedy(0);
    const fits = g.price <= target;
    plans.push({ kind: fits ? 'features' : 'minimum', label: fits ? `Giao diện mẫu dựng sẵn, bỏ ${g.removed.length} tính năng` : 'Thấp nhất có thể (giao diện dựng sẵn, bỏ bớt tính năng)', ...g, fits, apply: { level: 0, exclude: g.removed.map((x) => x.code) } });
  }
  for (const p of plans) if (p.fits === undefined) p.fits = true;
  return { target, plans };
}

// Áp dụng phương án vừa ngân sách: đặt mức thiết kế (0 = Tiết kiệm), bỏ các tính năng đã chọn, bỏ gói chọn tay
app.post('/api/projects/:id/apply-plan', h(async (req, res) => {
  need(req, 'requirement.decide');
  const pid = Number(req.params.id);
  const level = Number(req.body.level || 0);
  const exclude = Array.isArray(req.body.exclude) ? req.body.exclude.filter((x) => typeof x === 'string' && !KEEP_FEATURES.has(x)) : [];
  if (!(level >= 0 && level <= 8)) throw new HttpError(400, 'Mức thiết kế không hợp lệ');
  await tx(async () => {
    const p = await projectOr404(pid, 'pricing_json');
    const pricing = JSON.parse(p.pricing_json || '{}');
    const dl = await one("SELECT * FROM requirements WHERE project_id=? AND feature='DESIGN_LEVEL'", pid);
    if (dl) await run("UPDATE requirements SET decision=?, quantity=?, updated_at=datetime('now') WHERE id=?", level ? 'include' : 'exclude', level || dl.quantity, dl.id);
    for (const f of exclude) {
      const r = await one("SELECT id FROM requirements WHERE project_id=? AND feature=? AND decision='include'", pid, f);
      if (r) { await run("UPDATE requirements SET decision='exclude', updated_at=datetime('now') WHERE id=?", r.id); await run("UPDATE questions SET status='dropped' WHERE requirement_id=? AND status='open'", r.id); }
    }
    pricing.package_code = null; pricing.package_price = null;
    const disc = Number(req.body.discount_pct || 0);
    if (disc > 0) pricing.discount_pct = disc;
    await run("UPDATE projects SET pricing_json=?, rev=rev+1, updated_at=datetime('now') WHERE id=?", JSON.stringify(pricing), pid);
    await audit({ project_id: pid, entity: 'project', entity_id: pid, user_id: req.user.id, action: 'apply_budget_plan', after: { level, exclude, discount_pct: disc || null } });
    await syncAutoLines(pid);
  });
  res.json({ ok: true });
}));

// Sale chỉnh một tiêu chí đo lường (vd. sitemap không đọc được → chọn đúng quy mô). band=null → quay về số đo tự động.
app.post('/api/projects/:id/measure', h(async (req, res) => {
  need(req, 'requirement.decide');
  const pid = Number(req.params.id);
  const rub = RUBRIC.find((r) => r.key === req.body.key);
  if (!rub) throw new HttpError(400, 'Tiêu chí không hợp lệ');
  const band = req.body.band === null || req.body.band === '' || req.body.band === undefined ? null : Number(req.body.band);
  if (band !== null && !(Number.isInteger(band) && band >= 0 && band < rub.bands.length)) throw new HttpError(400, 'Mức không hợp lệ');
  let out;
  await tx(async () => {
    const p = await projectOr404(pid, 'pricing_json');
    const pricing = JSON.parse(p.pricing_json || '{}');
    const c = pricing.complexity;
    if (!c?.measured) throw new HttpError(409, 'Hồ sơ đo theo cách cũ — bấm "Quét lại" để đo theo bảng tiêu chí mới.');
    const overrides = { ...(c.overrides || {}) };
    const before = overrides[rub.key] ?? null;
    if (band === null || band === assessComplexity(c.measured, {}).rows.find((r) => r.key === rub.key).auto_band) delete overrides[rub.key];
    else overrides[rub.key] = band;
    const a = assessComplexity(c.measured, overrides);
    pricing.complexity = { ...c, ...a, overrides };
    // chỉnh số đo là sửa ĐÁNH GIÁ web mẫu, không phải phát sinh → giá gốc theo mức mới
    if (pricing.baseline?.features && 'DESIGN_LEVEL' in pricing.baseline.features && !pricing.baseline.manual) pricing.baseline.features.DESIGN_LEVEL = a.level;
    await run("UPDATE projects SET pricing_json=?, rev=rev+1, updated_at=datetime('now') WHERE id=?", JSON.stringify(pricing), pid);
    const dl = await one("SELECT * FROM requirements WHERE project_id=? AND feature='DESIGN_LEVEL'", pid);
    if (dl) await run("UPDATE requirements SET quantity=?, source_kind='inferred', updated_at=datetime('now') WHERE id=?", a.level, dl.id);
    await audit({ project_id: pid, entity: 'project', entity_id: pid, user_id: req.user.id, action: 'measure_override', before: { [rub.key]: before }, after: { [rub.key]: overrides[rub.key] ?? null, level: a.level, score: a.score } });
    out = { level: a.level, score: a.score };
  });
  res.json({ ok: true, ...out });
}));

const QTY_FEATURES = new Set(['PAGES', 'DATA_PRODUCTS', 'DATA_POSTS', 'HOSTING_STORAGE', 'DESIGN_LEVEL']);
app.get('/api/projects/:id/quick', h(async (req, res) => {
  const pid = Number(req.params.id);
  const b = await buildInput(pid);
  const cat = catalog();
  const title = (code) => cat.features.find((f) => f.code === code)?.title || code;
  let baseline = b.pricing.baseline || null;
  if (!baseline) { // hồ sơ tạo trước khi có tính năng này: dựng lại từ dẫn chứng quét
    const run1 = await one("SELECT url FROM analysis_runs WHERE project_id=? AND status='done' ORDER BY id LIMIT 1", pid);
    if (run1) baseline = await captureBaseline(pid, run1.url);
  }
  const current = b.reqs.map((r) => ({ ...r }));
  const cur = await simulatePrice(pid, b, current);
  let base = null; const changes = [];
  if (baseline) {
    const bf = baseline.features || {};
    const baseReqs = Object.entries(bf).map(([feature, quantity], i) => ({ id: -1 - i, feature, decision: 'include', quantity }));
    base = await simulatePrice(pid, b, baseReqs, { autoPackage: true });
    const now = Object.fromEntries(current.filter((r) => r.decision === 'include' && r.feature).map((r) => [r.feature, r.quantity]));
    for (const [f, q] of Object.entries(now)) {
      if (!(f in bf)) changes.push({ code: f, title: title(f), kind: 'added', to: q });
      else if (QTY_FEATURES.has(f) && Number(q) !== Number(bf[f])) changes.push({ code: f, title: title(f), kind: 'qty', from: bf[f], to: q });
    }
    for (const f of Object.keys(bf)) if (!(f in now)) changes.push({ code: f, title: title(f), kind: 'removed', from: bf[f] });
  }
  // Giá thay đổi nếu bật/tắt riêng từng tính năng (so với lựa chọn hiện tại)
  const marginal = {};
  for (const f of cat.features) {
    if (QTY_FEATURES.has(f.code) || ['DESIGN_LEVEL', 'REVIEW_ROUNDS'].includes(f.code)) continue;
    const ex = current.find((r) => r.feature === f.code);
    const on = ex?.decision === 'include';
    const alt = on ? current.map((r) => (r.feature === f.code ? { ...r, decision: 'exclude' } : r))
      : ex ? current.map((r) => (r.feature === f.code ? { ...r, decision: 'include', quantity: r.quantity ?? f.default_qty ?? 1 } : r))
        : [...current, { id: -999, feature: f.code, decision: 'include', quantity: f.default_qty ?? 1 }];
    const sim = await simulatePrice(pid, b, alt);
    marginal[f.code] = { delta: sim.price - cur.price, package: sim.package };
  }
  const options = await designOptions(pid, b, current);
  const officialNow = Number((await projectState(pid)).preview.price_net ?? 0);
  // Gói chọn tay khác gói đề xuất → tách riêng khỏi "phát sinh theo tính năng"
  let packageChoice = null;
  if (b.pricing.package_code) {
    const auto = await simulatePrice(pid, b, current, { autoPackage: true });
    if (auto.package && auto.package !== b.pricing.package_code) packageChoice = { manual: b.pricing.package_code, auto: auto.package, auto_price: auto.price, diff: officialNow - auto.price };
  }
  const vatPct = Number(b.input.policy?.vat_pct ?? 10);
  const budgetPlan = b.p.budget && officialNow * (1 + vatPct / 100) > Number(b.p.budget) ? await planForBudget(pid, b, current, Math.floor(Number(b.p.budget) / (1 + vatPct / 100))) : null;
  res.json({
    options, volumes: b.pricing.volumes || null, budget: b.p.budget ?? null, package_choice: packageChoice, budget_plan: budgetPlan,
    baseline: baseline ? { ...baseline, price: base.price, package: base.package, package_name: base.package_name, count: Object.keys(baseline.features || {}).filter((f) => !QTY_FEATURES.has(f)).length } : null,
    complexity: refreshAssessment(b.pricing.complexity),
    design_level: Number(b.reqs.find((r) => r.feature === 'DESIGN_LEVEL' && r.decision === 'include')?.quantity || 0) || null,
    current: { price: officialNow, package: cur.package },
    extra: base ? officialNow - base.price : null,
    changes, marginal,
  });
}));

app.post('/api/projects/:id/baseline', h(async (req, res) => {
  need(req, 'pricing.edit');
  const pid = Number(req.params.id);
  const p = await projectOr404(pid, 'pricing_json');
  const pricing = JSON.parse(p.pricing_json || '{}');
  const features = Object.fromEntries((await all("SELECT feature, quantity FROM requirements WHERE project_id=? AND decision='include' AND feature IS NOT NULL", pid)).map((r) => [r.feature, r.quantity ?? 1]));
  pricing.baseline = { features, domain: pricing.baseline?.domain || null, captured_at: new Date().toISOString(), manual: true };
  await run("UPDATE projects SET pricing_json=?, rev=rev+1, updated_at=datetime('now') WHERE id=?", JSON.stringify(pricing), pid);
  await audit({ project_id: pid, entity: 'project', entity_id: pid, user_id: req.user.id, action: 'set_baseline', after: features });
  res.json({ ok: true });
}));

app.get('/api/projects/:id/recommend', h(async (req, res) => {
  const pid = Number(req.params.id);
  const b = await buildInput(pid);
  const reqs = b.reqs;
  let lines = (await all('SELECT * FROM estimate_lines WHERE project_id=?', pid)).map((l) => ({ ...l, group: l.grp, include: !!l.include }));
  if (!lines.length) lines = buildAutoLines(catalog(), reqs); // chưa sinh dự toán thì dùng định mức chuẩn để so sánh
  res.json(recommendPackages(catalog(), pkgDataWith(b.input.policy), { requirements: reqs, lines, rates: b.input.rates, policy: b.input.policy, external: b.input.external, risks: b.input.risks, priceHint: complexityHint(b.pricing, reqs) }));
}));

// ---------- Phiên bản, duyệt, xuất ----------
const sha = (o) => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex');

app.post('/api/projects/:id/versions', h(async (req, res) => {
  need(req, 'version.create');
  const pid = Number(req.params.id);
  const st = await projectState(pid);
  const b = st.build;
  const latest = await one('SELECT * FROM quote_versions WHERE project_id=? ORDER BY version DESC LIMIT 1', pid);
  if (latest && latest.input_hash === st.hash && latest.status !== 'rejected') return res.json({ id: latest.id, reused: true }); // chống tạo trùng khi bấm/gửi lại
  const id = await tx(async () => {
    const version = (latest?.version || 0) + 1;
    const validUntil = new Date(Date.now() + Number(b.pricing.valid_days || 30) * 86400000).toISOString().slice(0, 10);
    const snapshot = {
      project: pick(b.p, ['id', 'code', 'name', 'customer_name', 'customer_contact', 'project_type', 'site_kind', 'brief']),
      pricing: b.pricing, input: b.input, meta: b.meta,
      requirements: b.reqs.map((r) => pick(r, ['id', 'code', 'feature', 'title', 'source_kind', 'decision', 'quantity', 'unit', 'acceptance', 'evidence_codes'])),
      questions: await all('SELECT code, text, blocking, status, answer, requirement_id FROM questions WHERE project_id=?', pid),
      exclusions_standard: catalog().standard_exclusions,
      release_checks: st.release,
    };
    const r = await run(`INSERT INTO quote_versions (project_id, version, status, quote_code, valid_until, payment_terms, snapshot_json, result_json, input_hash, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      pid, version, 'draft', `BG-${b.p.code}-V${version}`, validUntil, b.pricing.payment_terms || '', JSON.stringify(snapshot), JSON.stringify(st.preview), st.hash, req.user.id);
    await audit({ project_id: pid, entity: 'quote_version', entity_id: Number(r.lastInsertRowid), user_id: req.user.id, action: 'create', after: { version, price_net: st.preview.price_net } });
    return Number(r.lastInsertRowid);
  });
  res.json({ id });
}));

async function getVersion(id) {
  const v = await one('SELECT v.*, c.name created_by_name, a.name approved_by_name, s.name submitted_by_name FROM quote_versions v LEFT JOIN users c ON c.id=v.created_by LEFT JOIN users a ON a.id=v.approved_by LEFT JOIN users s ON s.id=v.submitted_by WHERE v.id=?', id);
  if (!v) throw new HttpError(404, 'Không có phiên bản');
  return { ...v, snapshot: JSON.parse(v.snapshot_json), result: JSON.parse(v.result_json), snapshot_json: undefined, result_json: undefined };
}
app.get('/api/versions/:id', h(async (req, res) => res.json(await getVersion(Number(req.params.id)))));

app.post('/api/versions/:id/:action(submit|approve|reject)', h(async (req, res) => {
  const v = await getVersion(Number(req.params.id));
  const action = req.params.action;
  const st = await projectState(v.project_id);
  if (action === 'submit') {
    need(req, 'version.create');
    if (v.status !== 'draft') throw new HttpError(409, 'Chỉ gửi duyệt bản nháp');
    if (st.hash !== v.input_hash) throw new HttpError(409, 'Dữ liệu hồ sơ đã đổi sau khi tạo phiên bản — tạo phiên bản mới.');
    const errors = v.snapshot.release_checks.filter((c) => c.level === 'error');
    if (errors.length) throw new HttpError(422, 'Chưa đạt điều kiện phát hành', { checks: errors });
    await run("UPDATE quote_versions SET status='pending', submitted_by=?, submitted_at=datetime('now') WHERE id=? AND status='draft'", req.user.id, v.id);
  } else {
    need(req, 'version.approve');
    if (v.status !== 'pending') throw new HttpError(409, 'Chỉ duyệt/từ chối bản đang chờ duyệt');
    if (action === 'approve') {
      if (st.hash !== v.input_hash) throw new HttpError(409, 'Dữ liệu hồ sơ đã đổi sau khi gửi duyệt — cần tạo phiên bản mới.');
      if (v.snapshot.release_checks.some((c) => c.level === 'error')) throw new HttpError(422, 'Phiên bản còn lỗi chặn');
      if (v.submitted_by === req.user.id && req.user.role !== 'admin') throw new HttpError(403, 'Người gửi duyệt không tự duyệt bản của mình');
      await run("UPDATE quote_versions SET status='approved', approved_by=?, approved_at=datetime('now'), review_note=? WHERE id=? AND status='pending'", req.user.id, req.body.note || null, v.id);
    } else {
      if (!req.body.note) throw new HttpError(400, 'Từ chối cần ghi lý do');
      await run("UPDATE quote_versions SET status='rejected', approved_by=?, approved_at=datetime('now'), review_note=? WHERE id=? AND status='pending'", req.user.id, req.body.note, v.id);
    }
  }
  await audit({ project_id: v.project_id, entity: 'quote_version', entity_id: v.id, user_id: req.user.id, action, reason: req.body.note });
  res.json({ ok: true });
}));

// Bản gửi khách: chỉ bản đã duyệt; không chứa chi phí nội bộ, biên lợi nhuận hay đơn giá nhân sự.
app.get('/quote/project/:pid', h(async (req, res) => {
  const pid = Number(req.params.pid);
  const st = await projectState(pid);
  const b = st.build;
  const r = st.preview;
  const fatal = (r.checks || []).filter((c) => c.level === 'error');
  if (!b.reqs.some((x) => x.decision === 'include')) throw new HttpError(400, 'Chưa chọn tính năng nào để báo giá.');
  if (fatal.length) throw new HttpError(422, 'Không in được báo giá: ' + fatal.map((c) => c.message).join(' | '));
  const validDays = Number(b.pricing.valid_days || 30);
  const v = {
    quote_code: `BG-${b.p.code}`, version: 'sơ bộ', created_at: new Date().toISOString().slice(0, 10),
    valid_until: new Date(Date.now() + validDays * 86400000).toISOString().slice(0, 10), payment_terms: b.pricing.payment_terms || '',
    snapshot: { project: b.p, pricing: b.pricing, input: b.input, requirements: b.reqs, exclusions_standard: catalog().standard_exclusions }, result: r,
  };
  const opt = await designOptions(pid, b, b.reqs.map((x) => ({ ...x })));
  await audit({ project_id: pid, entity: 'quick_quote', entity_id: pid, action: 'print', after: { price_net: r.price_net, package: b.input.package?.code } });
  res.type('html').send(renderCustomerQuote(v, { preliminary: true, economy: opt && opt.mode === 'match' && opt.economy.price < opt.match.price ? opt.economy : null }));
}));

app.get('/quote/:id', h(async (req, res) => {
  const v = await getVersion(Number(req.params.id));
  if (v.status !== 'approved' && req.query.preview !== '1') throw new HttpError(403, 'Chỉ xuất bản cho khách từ phiên bản đã duyệt.');
  res.type('html').send(renderCustomerQuote(v, { draft: v.status !== 'approved' }));
}));
app.get('/quote/:id/pdf', h(async (req, res) => {
  const v = await getVersion(Number(req.params.id));
  if (v.status !== 'approved') throw new HttpError(403, 'Chỉ xuất PDF từ phiên bản đã duyệt.');
  const { launchChromium } = await import('./crawler/browser.js');
  const browser = await launchChromium();
  try {
    const page = await browser.newPage();
    await page.route('**/*', (r) => (r.request().url().startsWith('data:') ? r.continue() : r.abort())); // không tải tài nguyên ngoài
    await page.setContent(renderCustomerQuote(v, { draft: false }), { waitUntil: 'load' });
    const pdf = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '14mm', bottom: '14mm', left: '12mm', right: '12mm' } });
    res.type('pdf').set('Content-Disposition', `attachment; filename="${v.quote_code}.pdf"`).send(pdf);
  } finally { await browser.close(); }
}));

// ---------- Sau bàn giao & hiệu chỉnh ----------
app.post('/api/projects/:id/actuals', h(async (req, res) => {
  need(req, 'actuals.edit');
  const pid = Number(req.params.id);
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  await tx(async () => {
    await run('DELETE FROM actuals WHERE project_id=?', pid);
    for (const r of rows) {
      if (!r.title) continue;
      await run('INSERT INTO actuals (project_id, quote_version_id, code, title, grp, hours_estimated, hours_actual, scope, cause, note) VALUES (?,?,?,?,?,?,?,?,?,?)',
        pid, req.body.quote_version_id || null, r.code || null, r.title, r.grp || null, Number(r.hours_estimated || 0), Number(r.hours_actual || 0), ['original', 'change', 'bugfix', 'rework'].includes(r.scope) ? r.scope : 'original', r.cause || null, r.note || null);
    }
    await audit({ project_id: pid, entity: 'actuals', entity_id: pid, user_id: req.user.id, action: 'save', after: { rows: rows.length } });
  });
  res.json({ ok: true });
}));

app.get('/api/metrics', h(async (req, res) => {
  const projects = await all(`SELECT p.id, p.code, p.name, SUM(CASE WHEN a.scope='original' THEN a.hours_estimated ELSE 0 END) est,
      SUM(CASE WHEN a.scope IN ('original','bugfix','rework') THEN a.hours_actual ELSE 0 END) act,
      SUM(CASE WHEN a.scope='change' THEN a.hours_actual ELSE 0 END) change_hours
    FROM actuals a JOIN projects p ON p.id=a.project_id GROUP BY p.id, p.code, p.name HAVING SUM(CASE WHEN a.scope IN ('original','bugfix','rework') THEN a.hours_actual ELSE 0 END) > 0`);
  const sumAct = projects.reduce((s, p) => s + p.act, 0);
  const sumAbs = projects.reduce((s, p) => s + Math.abs(p.est - p.act), 0);
  const sumEst = projects.reduce((s, p) => s + p.est, 0);
  const byGroup = await all(`SELECT grp, SUM(hours_estimated) est, SUM(hours_actual) act FROM actuals WHERE scope IN ('original','bugfix','rework') GROUP BY grp`);
  res.json({
    n: projects.length,
    wape_pct: sumAct ? Math.round((sumAbs / sumAct) * 10000) / 100 : null,
    bias_pct: sumAct ? Math.round(((sumEst - sumAct) / sumAct) * 10000) / 100 : null,
    under20_pct: projects.length ? Math.round((projects.filter((p) => p.est < 0.8 * p.act).length / projects.length) * 10000) / 100 : null,
    projects, by_group: byGroup,
    note: 'Sai lệch tính trên giờ phạm vi gốc (đã tách thay đổi phạm vi). Mục tiêu thí điểm: WAPE ≤ 20% trên ≥ 30 hồ sơ đủ dữ liệu.',
  });
}));

app.get('/api/projects/:id/audit', h(async (req, res) => res.json(await all('SELECT a.*, u.name user_name FROM audit_log a LEFT JOIN users u ON u.id=a.user_id WHERE a.project_id=? ORDER BY a.id DESC LIMIT 300', Number(req.params.id)))));

app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message, ...(err.extra || {}) });
});

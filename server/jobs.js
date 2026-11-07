// Hàng đợi khảo sát dựa trên CSDL: khóa chống chạy trùng, giới hạn số lần thử, timeout,
// ghi kết quả idempotent (chạy lại không nhân đôi dẫn chứng/yêu cầu).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { db, one, all, run, tx, audit, DATA_DIR, ROOT, loadJson } from './db.js';

const MAX_ATTEMPTS = 2;
const BUDGET_MS = Number(process.env.CRAWLER_BUDGET_MS || 240000);
let busy = false;

export function runDir(runId) { return path.join(DATA_DIR, 'runs', String(runId)); }

export function startJobLoop() {
  // job đang "running" khi server tắt → trả về hàng đợi
  run("UPDATE analysis_runs SET status='queued', locked_at=NULL WHERE status='running'");
  setInterval(tick, 1500).unref();
}

async function tick() {
  if (busy) return;
  const job = one("SELECT * FROM analysis_runs WHERE status='queued' ORDER BY id LIMIT 1");
  if (!job) return;
  const claimed = run("UPDATE analysis_runs SET status='running', locked_at=datetime('now'), started_at=datetime('now'), attempts=attempts+1 WHERE id=? AND status='queued'", job.id);
  if (!claimed.changes) return; // tiến trình khác đã nhận
  busy = true;
  try { await execute(one('SELECT * FROM analysis_runs WHERE id=?', job.id)); }
  catch (e) {
    const j = one('SELECT attempts FROM analysis_runs WHERE id=?', job.id);
    run('UPDATE analysis_runs SET status=?, error=?, locked_at=NULL, finished_at=datetime(\'now\') WHERE id=?', j.attempts < MAX_ATTEMPTS ? 'queued' : 'failed', e.message, job.id);
  } finally { busy = false; }
}

function execute(job) {
  const dir = runDir(job.id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const cfgFile = path.join(dir, 'config.json');
  const outFile = path.join(dir, 'result.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ url: job.url, maxUrls: job.max_urls, budgetMs: BUDGET_MS, outFile, assetDir: dir }));
  // Worker chỉ nhận biến môi trường tối thiểu — không mang khóa API hay bí mật của ứng dụng.
  const env = {};
  for (const k of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PLAYWRIGHT_BROWSERS_PATH', 'CRAWLER_TRUST_FAKE_IP', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']) if (process.env[k]) env[k] = process.env[k];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'server/crawler/worker.js'), cfgFile], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    const killer = setTimeout(() => child.kill('SIGKILL'), BUDGET_MS + 60000);
    child.on('exit', () => {
      clearTimeout(killer);
      if (!fs.existsSync(outFile)) return reject(new Error('Worker không trả kết quả. ' + stderr.slice(-500)));
      try { ingest(job, JSON.parse(fs.readFileSync(outFile, 'utf8'))); resolve(); } catch (e) { reject(e); }
    });
  });
}

function nextCode(table, projectId, prefix) {
  const rows = all(`SELECT code FROM ${table} WHERE project_id=? AND code LIKE ?`, projectId, prefix + '%');
  const max = rows.reduce((m, r) => Math.max(m, Number(r.code.slice(prefix.length)) || 0), 0);
  return prefix + String(max + 1).padStart(3, '0');
}

const RANK = { observed: 3, client: 3, inferred: 2, unverified: 1 };

// Phạm vi của web mẫu = tính năng THẤY RÕ trên web (dẫn chứng observed) + số mẫu trang đếm được.
// Tính năng khách thêm từ mô tả hay tick tay sau đó là phần PHÁT SINH so với giá gốc này.
export function baselineFromEvidence(projectId) {
  const seen = new Set(all("SELECT DISTINCT feature FROM evidence WHERE project_id=? AND verification='observed' AND feature IS NOT NULL", projectId).map((r) => r.feature));
  if (one("SELECT 1 FROM evidence WHERE project_id=? AND feature='PAGES'", projectId)) seen.add('PAGES');
  const features = {};
  for (const r of all('SELECT feature, quantity FROM requirements WHERE project_id=? AND feature IS NOT NULL', projectId)) if (seen.has(r.feature)) features[r.feature] = r.quantity ?? 1;
  return features;
}
export function captureBaseline(projectId, url, force = false) {
  const row = one('SELECT pricing_json FROM projects WHERE id=?', projectId);
  const pricing = JSON.parse(row?.pricing_json || '{}');
  if (pricing.baseline && !force) return pricing.baseline;
  pricing.baseline = { features: baselineFromEvidence(projectId), domain: url, captured_at: new Date().toISOString() };
  run('UPDATE projects SET pricing_json=? WHERE id=?', JSON.stringify(pricing), projectId);
  return pricing.baseline;
}

export function ingest(job, res) {
  const catalog = loadJson('data/catalog.json');
  tx(() => {
    // idempotent: xóa dẫn chứng cũ của chính lần chạy này trước khi ghi
    run('DELETE FROM evidence WHERE run_id=?', job.id);
    const featureEv = {}; // feature → {codes, best}
    const addEv = (row) => {
      const code = nextCode('evidence', job.project_id, 'E');
      run(`INSERT INTO evidence (project_id, run_id, code, url, captured_at, viewport, asset_path, asset_hash, kind, feature, detail, verification) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        job.project_id, job.id, code, row.url ?? null, row.captured_at ?? null, row.viewport ?? null, row.asset_path ?? null, row.asset_hash ?? null, row.kind, row.feature ?? null, row.detail ?? null, row.verification);
      return code;
    };
    for (const p of res.pages || []) {
      const asset = p.desktop ? `runs/${job.id}/${p.desktop.file}` : null;
      if (p.error || p.blocked) {
        addEv({ url: p.url, captured_at: p.captured_at, kind: 'unreadable', detail: p.error || 'CAPTCHA / bị chặn — cần bổ sung bằng chứng thủ công, không kết luận là không có', verification: 'unverified' });
        continue;
      }
      addEv({ url: p.url, captured_at: p.captured_at, viewport: p.desktop?.viewport, asset_path: asset, asset_hash: p.desktop?.hash, kind: 'page', detail: `${p.template} — ${p.title || ''}`.slice(0, 240), verification: 'observed' });
      if (p.mobile) addEv({ url: p.url, captured_at: p.captured_at, viewport: p.mobile.viewport, asset_path: `runs/${job.id}/${p.mobile.file}`, asset_hash: p.mobile.hash, kind: 'page_mobile', detail: p.template, verification: 'observed' });
      const seen = new Set();
      for (const f of p.features || []) {
        if (!f.feature || seen.has(f.feature + f.detail)) continue;
        seen.add(f.feature + f.detail);
        const code = addEv({ url: p.url, captured_at: p.captured_at, viewport: p.desktop?.viewport, asset_path: asset, asset_hash: p.desktop?.hash, kind: 'feature', feature: f.feature, detail: f.detail, verification: f.verification });
        const fe = (featureEv[f.feature] ||= { codes: [], best: 'unverified', details: [] });
        if (fe.codes.length < 8) fe.codes.push(code);
        if (RANK[f.verification] > RANK[fe.best]) fe.best = f.verification;
      }
    }
    // Khối lượng suy luận từ nhóm URL
    const tpl = res.templates || [];
    // nhóm URL "phẳng" (không có chữ san-pham trong đường dẫn) nhưng nội dung là trang sản phẩm → coi là chi tiết sản phẩm
    const tplKey = (t) => (t.detected === 'product_detail' ? 'product:detail' : t.detected === 'product_list' && t.kind === 'other' ? 'product:list' : t.kind === 'other' ? 'other' : t.template);
    const distinct = new Set(tpl.filter((t) => !['policy', 'search', 'account', 'cart'].includes(t.kind)).map(tplKey));
    const quantities = {};
    if (distinct.size) {
      const code = addEv({ url: res.input, kind: 'templates', feature: 'PAGES', detail: `${distinct.size} nhóm mẫu trang: ${[...distinct].join(', ')} (từ ${res.coverage?.discovered ?? 0} URL phát hiện)`, verification: 'inferred' });
      featureEv.PAGES = { codes: [code], best: 'inferred' };
      quantities.PAGES = distinct.size;
    }
    const sumUrls = (pred) => tpl.filter(pred).reduce((n, t) => n + (t.url_count || 0), 0);
    const prodByTpl = sumUrls((t) => tplKey(t) === 'product:detail');
    const prodCount = Math.max(prodByTpl, res.sitemap?.product_urls || 0);
    if (prodCount) {
      const how = (res.sitemap?.product_urls || 0) >= prodByTpl ? 'sitemap sản phẩm' : 'nhóm URL có nội dung trang sản phẩm';
      const code = addEv({ url: res.input, kind: 'volume', feature: 'DATA_PRODUCTS', detail: `~${prodCount} sản phẩm trên web mẫu (theo ${how}) — chỉ để tham khảo, khách quyết định số cần nhập`, verification: 'inferred' });
      featureEv.DATA_PRODUCTS = { codes: [code], best: 'inferred' }; quantities.DATA_PRODUCTS = prodCount;
    }
    const postCount = Math.max(sumUrls((t) => t.template === 'blog:detail'), res.sitemap?.post_urls || 0);
    if (postCount) {
      const code = addEv({ url: res.input, kind: 'volume', feature: 'DATA_POSTS', detail: `~${postCount} bài viết trên web mẫu — chỉ để tham khảo, khách quyết định số cần nhập`, verification: 'inferred' });
      featureEv.DATA_POSTS = { codes: [code], best: 'inferred' }; quantities.DATA_POSTS = postCount;
    }

    // Yêu cầu: cập nhật dẫn chứng nếu đã có, tạo mới ở trạng thái chờ khách quyết định
    for (const [feature, ev] of Object.entries(featureEv)) {
      const f = catalog.features.find((x) => x.code === feature);
      if (!f) continue;
      const existing = one('SELECT * FROM requirements WHERE project_id=? AND feature=?', job.project_id, feature);
      if (existing) {
        const codes = [...new Set([...JSON.parse(existing.evidence_codes), ...ev.codes])];
        run("UPDATE requirements SET evidence_codes=?, updated_at=datetime('now') WHERE id=?", JSON.stringify(codes), existing.id);
        continue;
      }
      const code = nextCode('requirements', job.project_id, 'R');
      const qty = quantities[feature] ?? f.default_qty ?? 1;
      const autoInclude = ev.best === 'observed' || feature === 'PAGES';
      const r = run(`INSERT INTO requirements (project_id, code, feature, title, source_kind, evidence_codes, decision, quantity, unit) VALUES (?,?,?,?,?,?,?,?,?)`,
        job.project_id, code, feature, f.title, ev.best === 'observed' ? 'observed' : 'inferred', JSON.stringify(ev.codes), autoInclude ? 'include' : 'pending', qty, f.unit);
      for (const q of f.questions || []) {
        run('INSERT INTO questions (project_id, code, requirement_id, text, blocking) VALUES (?,?,?,?,?)', job.project_id, nextCode('questions', job.project_id, 'Q'), Number(r.lastInsertRowid), q.text, q.blocking ? 1 : 0);
      }
    }
    if (res.ok) captureBaseline(job.project_id, job.url);
    run(`UPDATE analysis_runs SET status=?, finished_at=datetime('now'), locked_at=NULL, coverage_json=?, robots_json=?, templates_json=?, crawler_version=?, error=? WHERE id=?`,
      res.ok ? 'done' : 'failed', JSON.stringify({ ...(res.coverage || {}), sitemap: res.sitemap, generator: res.generator, blocked_requests: res.blocked_requests, errors: (res.errors || []).slice(0, 20) }),
      JSON.stringify(res.robots || {}), JSON.stringify(tpl), res.crawler_version || null, res.fatal || null, job.id);
    audit({ project_id: job.project_id, entity: 'analysis_run', entity_id: job.id, action: res.ok ? 'survey_done' : 'survey_failed', after: { pages: (res.pages || []).length, features: Object.keys(featureEv) } });
  });
}

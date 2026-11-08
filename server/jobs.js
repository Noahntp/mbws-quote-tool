// Hàng đợi khảo sát dựa trên CSDL: khóa chống chạy trùng, giới hạn số lần thử, timeout,
// ghi kết quả idempotent (chạy lại không nhân đôi dẫn chứng/yêu cầu).
//  - Máy local: vòng lặp nền mỗi 1,5 giây, bộ quét chạy trong TIẾN TRÌNH CON.
//  - Serverless (Vercel): không có vòng lặp nền; mỗi yêu cầu liên quan sẽ "đẩy" hàng đợi bằng waitUntil,
//    bộ quét chạy ngay trong hàm (giới hạn ~300 giây/lần). Job treo quá lâu tự trả lại hàng đợi.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { waitUntil } from '@vercel/functions';
import { one, all, run, tx, audit, DATA_DIR, ROOT, loadJson, IS_SERVERLESS } from './db.js';
import { assessComplexity, measureFromScan } from './complexity.js';
import { estimateStorage } from './volume.js';
import { classify } from './crawler/urls.js';

const MAX_ATTEMPTS = 2;
const BUDGET_MS = Number(process.env.CRAWLER_BUDGET_MS || (IS_SERVERLESS ? 190000 : 240000));
const STALE_MINUTES = Number(process.env.JOB_STALE_MINUTES || (IS_SERVERLESS ? 6 : 15));
let busy = false;

export function runDir(runId) { return path.join(DATA_DIR, 'runs', String(runId)); }

// Đưa một lượt quét vào hàng đợi. analysis_runs hiển thị "đang quét" ngay (status='running')
// nhưng chỉ job_queue quyết định ai chạy — tiến trình code cũ không đọc bảng này.
export async function enqueueRun(runId) {
  await run("UPDATE analysis_runs SET status='running', error=NULL, finished_at=NULL WHERE id=?", runId);
  await run("INSERT INTO job_queue (run_id, status) VALUES (?, 'queued') ON CONFLICT(run_id) DO UPDATE SET status='queued', attempts=0, locked_at=NULL", runId);
}

export async function startJobLoop() {
  // server tắt giữa chừng → trả job về hàng đợi; lượt quét kiểu cũ chưa xong → chuyển sang hàng đợi mới
  await run("UPDATE job_queue SET status='queued', locked_at=NULL WHERE status='running'");
  for (const r of await all("SELECT id FROM analysis_runs WHERE status IN ('queued','running') AND id NOT IN (SELECT run_id FROM job_queue)")) await enqueueRun(r.id);
  setInterval(() => { processNext().catch((e) => console.error('[hàng đợi]', e.message)); }, 1500).unref();
}

/** Serverless: chạy tiếp hàng đợi sau khi trả lời yêu cầu (trong giới hạn thời gian của hàm). */
export function kickQueue() {
  if (!IS_SERVERLESS) return;
  const p = processNext().catch((e) => console.error('[hàng đợi]', e.message));
  try { waitUntil(p); } catch { /* ngoài môi trường Vercel */ }
}

const utcMinus = (min) => new Date(Date.now() - min * 60000).toISOString().replace('T', ' ').slice(0, 19);

export async function processNext() {
  if (busy) return false;
  // job "running" quá lâu (hàm bị dừng giữa chừng) → trả lại hàng đợi
  await run("UPDATE job_queue SET status='queued', locked_at=NULL WHERE status='running' AND locked_at < ?", utcMinus(STALE_MINUTES));
  const job = await one("SELECT run_id FROM job_queue WHERE status='queued' ORDER BY run_id LIMIT 1");
  if (!job) return false;
  const claimed = await run("UPDATE job_queue SET status='running', locked_at=datetime('now'), attempts=attempts+1 WHERE run_id=? AND status='queued'", job.run_id);
  if (!claimed.changes) return false; // tiến trình khác đã nhận
  await run("UPDATE analysis_runs SET status='running', started_at=datetime('now'), attempts=attempts+1, locked_at=datetime('now') WHERE id=?", job.run_id);
  busy = true;
  const t0 = Date.now();
  try {
    const r = await one('SELECT * FROM analysis_runs WHERE id=?', job.run_id);
    console.log(`[quét] bắt đầu #${r.id} ${r.url}`);
    const result = await executeRun(r);
    const h0 = result.pages?.[0];
    console.log(`[quét] xong #${r.id}: ${result.ok ? 'ok' : 'lỗi ' + (result.fatal || '')}, ${(result.pages || []).length} trang, ${(result.discovered || []).length} URL, ${Math.round((Date.now() - t0) / 1000)}s${h0 ? ` | trang chủ: ${h0.status ?? '-'} "${(h0.title || '').slice(0, 60)}" ${h0.final_url || ''}${h0.blocked ? ' [chặn: ' + h0.blocked + ']' : ''}` : ''}`);
    await ingest(r, result);
    const st = (await one('SELECT status FROM analysis_runs WHERE id=?', job.run_id))?.status;
    await run('UPDATE job_queue SET status=?, locked_at=NULL WHERE run_id=?', st === 'failed' ? 'failed' : 'done', job.run_id);
  } catch (e) {
    console.error(`[quét] lỗi #${job.run_id} sau ${Math.round((Date.now() - t0) / 1000)}s:`, e.message);
    const q = await one('SELECT attempts FROM job_queue WHERE run_id=?', job.run_id);
    const retry = (q?.attempts ?? MAX_ATTEMPTS) < MAX_ATTEMPTS;
    await run('UPDATE job_queue SET status=?, locked_at=NULL WHERE run_id=?', retry ? 'queued' : 'failed', job.run_id);
    if (retry) await run('UPDATE analysis_runs SET status=?, error=?, locked_at=NULL, finished_at=NULL WHERE id=?', 'running', e.message, job.run_id);
    else await run("UPDATE analysis_runs SET status=?, error=?, locked_at=NULL, finished_at=datetime('now') WHERE id=?", 'failed', e.message, job.run_id);
  } finally { busy = false; }
  return true;
}

async function executeRun(job) {
  const dir = runDir(job.id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const cfg = {
    url: job.url, maxUrls: IS_SERVERLESS ? Math.min(job.max_urls, 10) : job.max_urls, budgetMs: BUDGET_MS,
    assetDir: dir, outFile: path.join(dir, 'result.json'), shotMaxHeight: IS_SERVERLESS ? 2500 : 6000,
  };
  if (IS_SERVERLESS || process.env.CRAWLER_IN_PROCESS === '1') {
    const { runSurvey } = await import('./crawler/worker.js');
    let partial = null;
    const timeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), BUDGET_MS + 25000).unref?.());
    const res = await Promise.race([runSurvey(cfg, { log: () => {}, onResult: (r) => { partial = r; } }), timeout]);
    if (res !== 'timeout') return res;
    if (partial?.pages?.length) return { ...partial, ok: true, errors: [...(partial.errors || []), { error: 'Hết thời gian, dùng phần đã quét' }] };
    throw new Error('Quét quá thời gian cho phép');
  }
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg));
  // Worker chỉ nhận biến môi trường tối thiểu — không mang khóa API hay bí mật của ứng dụng.
  const env = {};
  for (const k of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PLAYWRIGHT_BROWSERS_PATH', 'CRAWLER_TRUST_FAKE_IP', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']) if (process.env[k]) env[k] = process.env[k];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'server/crawler/worker.js'), path.join(dir, 'config.json')], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    child.on('error', (e) => reject(new Error('Không chạy được bộ quét: ' + e.message)));
    const killer = setTimeout(() => child.kill('SIGKILL'), BUDGET_MS + 60000);
    child.on('exit', () => {
      clearTimeout(killer);
      if (!fs.existsSync(cfg.outFile)) return reject(new Error('Worker không trả kết quả. ' + stderr.slice(-500)));
      try { resolve(JSON.parse(fs.readFileSync(cfg.outFile, 'utf8'))); } catch (e) { reject(e); }
    });
  });
}

async function nextCode(table, projectId, prefix) {
  const rows = await all(`SELECT code FROM ${table} WHERE project_id=? AND code LIKE ?`, projectId, prefix + '%');
  const max = rows.reduce((m, r) => Math.max(m, Number(r.code.slice(prefix.length)) || 0), 0);
  return prefix + String(max + 1).padStart(3, '0');
}

const RANK = { observed: 3, client: 3, inferred: 2, unverified: 1 };
// Khối lượng tự điền từ web mẫu (sale sửa được; số sale nhập không bị lần quét sau ghi đè)
const AUTO_QTY = ['PAGES', 'DATA_PRODUCTS', 'DATA_POSTS', 'HOSTING_STORAGE'];

// Phạm vi của web mẫu = tính năng THẤY RÕ trên web (dẫn chứng observed) + số mẫu trang đếm được.
// Tính năng khách thêm từ mô tả hay tick tay sau đó là phần PHÁT SINH so với giá gốc này.
export async function baselineFromEvidence(projectId) {
  const seen = new Set((await all("SELECT DISTINCT feature FROM evidence WHERE project_id=? AND verification='observed' AND feature IS NOT NULL", projectId)).map((r) => r.feature));
  for (const f of AUTO_QTY) if (await one('SELECT 1 AS x FROM evidence WHERE project_id=? AND feature=?', projectId, f)) seen.add(f); // khối lượng web mẫu
  if (await one("SELECT 1 AS x FROM evidence WHERE project_id=? AND kind='complexity'", projectId)) seen.add('DESIGN_LEVEL'); // mức may đo theo độ phức tạp web mẫu
  const features = {};
  for (const r of await all('SELECT feature, quantity FROM requirements WHERE project_id=? AND feature IS NOT NULL', projectId)) if (seen.has(r.feature)) features[r.feature] = r.quantity ?? 1;
  return features;
}
export async function captureBaseline(projectId, url, force = false) {
  const row = await one('SELECT pricing_json FROM projects WHERE id=?', projectId);
  const pricing = JSON.parse(row?.pricing_json || '{}');
  if (pricing.baseline && !force) return pricing.baseline;
  pricing.baseline = { features: await baselineFromEvidence(projectId), domain: url, captured_at: new Date().toISOString() };
  await run('UPDATE projects SET pricing_json=? WHERE id=?', JSON.stringify(pricing), projectId);
  return pricing.baseline;
}

// Lưu ảnh chụp vào CSDL (để xem lại được trên máy chủ không có ổ đĩa cố định)
async function storeAsset(relPath, file) {
  if (!file || !fs.existsSync(file)) return;
  await run('INSERT INTO assets (path, content_type, data) VALUES (?,?,?) ON CONFLICT(path) DO UPDATE SET data=excluded.data, content_type=excluded.content_type',
    relPath, 'image/jpeg', fs.readFileSync(file));
}

export async function ingest(job, res) {
  const catalog = loadJson('data/catalog.json');
  const dir = runDir(job.id);
  await tx(async () => {
    // idempotent: xóa dẫn chứng cũ của chính lần chạy này trước khi ghi
    await run('DELETE FROM evidence WHERE run_id=?', job.id);
    const featureEv = {}; // feature → {codes, best}
    const addEv = async (row) => {
      const code = await nextCode('evidence', job.project_id, 'E');
      await run(`INSERT INTO evidence (project_id, run_id, code, url, captured_at, viewport, asset_path, asset_hash, kind, feature, detail, verification) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        job.project_id, job.id, code, row.url ?? null, row.captured_at ?? null, row.viewport ?? null, row.asset_path ?? null, row.asset_hash ?? null, row.kind, row.feature ?? null, row.detail ?? null, row.verification);
      return code;
    };
    for (const p of res.pages || []) {
      const asset = p.desktop ? `runs/${job.id}/${p.desktop.file}` : null;
      if (p.error || p.blocked) {
        if (p.blocked && p.desktop) await storeAsset(asset, path.join(dir, p.desktop.file)); // giữ ảnh trang chặn làm bằng chứng
        await addEv({ url: p.url, captured_at: p.captured_at, asset_path: p.blocked && p.desktop ? asset : null, asset_hash: p.blocked ? p.desktop?.hash : null, kind: 'unreadable', detail: p.error || `Trang chặn máy quét (${p.blocked}) — cần bổ sung bằng chứng thủ công, không kết luận là không có`, verification: 'unverified' });
        continue;
      }
      if (p.desktop) await storeAsset(asset, path.join(dir, p.desktop.file));
      if (p.mobile) await storeAsset(`runs/${job.id}/${p.mobile.file}`, path.join(dir, p.mobile.file));
      await addEv({ url: p.url, captured_at: p.captured_at, viewport: p.desktop?.viewport, asset_path: asset, asset_hash: p.desktop?.hash, kind: 'page', detail: `${p.template} — ${p.title || ''}`.slice(0, 240), verification: 'observed' });
      if (p.mobile) await addEv({ url: p.url, captured_at: p.captured_at, viewport: p.mobile.viewport, asset_path: `runs/${job.id}/${p.mobile.file}`, asset_hash: p.mobile.hash, kind: 'page_mobile', detail: p.template, verification: 'observed' });
      const seen = new Set();
      for (const f of p.features || []) {
        if (!f.feature || seen.has(f.feature + f.detail)) continue;
        seen.add(f.feature + f.detail);
        const code = await addEv({ url: p.url, captured_at: p.captured_at, viewport: p.desktop?.viewport, asset_path: asset, asset_hash: p.desktop?.hash, kind: 'feature', feature: f.feature, detail: f.detail, verification: f.verification });
        const fe = (featureEv[f.feature] ||= { codes: [], best: 'unverified', details: [] });
        if (fe.codes.length < 8) fe.codes.push(code);
        if (RANK[f.verification] > RANK[fe.best]) fe.best = f.verification;
      }
    }
    // Khối lượng suy luận từ nhóm URL
    const tpl = res.templates || [];
    // nhóm URL "phẳng" (không có chữ san-pham trong đường dẫn) nhưng nội dung là trang sản phẩm → coi là chi tiết sản phẩm
    // nhóm "khác" khác độ sâu đường dẫn là các loại trang khác nhau (vd /doi-tac và /doi-tac/sieu-thi) → đếm riêng
    const tplKey = (t) => (t.detected === 'product_detail' ? 'product:detail' : t.detected === 'product_list' && t.kind === 'other' ? 'product:list' : t.template);
    // trang lẻ không rõ loại (nhóm "other" chỉ 1 URL) dùng chung mẫu trang nội dung → không tính thành mẫu trang riêng
    const oneOff = (t) => t.kind === 'other' && !t.detected && (t.url_count || 0) < 2;
    const distinct = new Set(tpl.filter((t) => !['policy', 'search', 'account', 'cart'].includes(t.kind) && !oneOff(t)).map(tplKey));
    const quantities = {};
    // Số mẫu trang theo nhóm đường dẫn (ổn định giữa các lần quét). Số kiểu bố cục so theo cấu trúc trang chỉ để sale tham khảo:
    // đếm cấu trúc dao động ±1–2 tùy trang lấy mẫu, mà mỗi cấp gói chênh vài triệu → không dùng để tính tiền.
    const L = res.layouts;
    if (distinct.size) {
      const layoutNote = L?.count ? ` — so cấu trúc trang thấy ${L.count} kiểu bố cục (tham khảo; sửa số mẫu trang nếu khách cần đúng từng bố cục)` : '';
      const code = await addEv({ url: res.input, kind: 'templates', feature: 'PAGES', detail: `${distinct.size} nhóm mẫu trang: ${[...distinct].join(', ')} (từ ${res.coverage?.discovered ?? 0} URL phát hiện)${layoutNote}`, verification: 'inferred' });
      featureEv.PAGES = { codes: [code], best: 'inferred' };
      quantities.PAGES = distinct.size;
    }
    // Web nhiều ngôn ngữ (/vi/…, /en/…): sản phẩm, bài viết có bản ở mỗi ngôn ngữ → chỉ đếm một ngôn ngữ
    const locOf = (u) => { try { const m = new URL(u).pathname.match(/^\/([a-z]{2}(?:-[a-z]{2})?)(?:\/|$)/i); return m ? m[1].toLowerCase() : null; } catch { return null; } };
    const locCount = {}; for (const u of res.discovered || []) { const l = locOf(u); if (l) locCount[l] = (locCount[l] || 0) + 1; }
    const locales = Object.keys(locCount).filter((l) => locCount[l] >= 2);
    const mainLoc = locales.length >= 2 ? locales.sort((a, b) => locCount[b] - locCount[a])[0] : null;
    const perLang = (urls) => (mainLoc ? urls.filter((u) => locOf(u) === mainLoc) : urls).length;
    const urlsOf = (t) => (res.discovered || []).filter((u) => classify(u).template === t.template);
    if (res.static_mode) await addEv({ url: res.input, kind: 'note', detail: `Web mẫu ${res.static_mode.reason} khi chạy JavaScript — đã quét bản HTML tĩnh. Tính năng chỉ hiện khi chạy JavaScript (chat, bộ lọc động…) có thể thiếu: sale kiểm tra lại mục 2.`, verification: 'unverified' });
    const sumUrls = (pred) => tpl.filter(pred).reduce((n, t) => n + (mainLoc ? perLang(urlsOf(t)) : (t.url_count || 0)), 0);
    const prodByTpl = sumUrls((t) => tplKey(t) === 'product:detail');
    const prodCount = Math.max(prodByTpl, Math.round((res.sitemap?.product_urls || 0) / Math.max(1, locales.length >= 2 ? locales.length : 1)));
    if (prodCount) {
      const how = (res.sitemap?.product_urls || 0) >= prodByTpl ? 'sitemap sản phẩm' : 'nhóm URL có nội dung trang sản phẩm';
      const code = await addEv({ url: res.input, kind: 'volume', feature: 'DATA_PRODUCTS', detail: `~${prodCount} sản phẩm trên web mẫu (theo ${how}) — tự điền, sale sửa nếu khách cần số khác`, verification: 'inferred' });
      featureEv.DATA_PRODUCTS = { codes: [code], best: 'inferred' }; quantities.DATA_PRODUCTS = prodCount;
    }
    const postCount = Math.max(sumUrls((t) => t.template === 'blog:detail'), Math.round((res.sitemap?.post_urls || 0) / Math.max(1, locales.length >= 2 ? locales.length : 1)));
    if (postCount) {
      const code = await addEv({ url: res.input, kind: 'volume', feature: 'DATA_POSTS', detail: `~${postCount} bài viết trên web mẫu — tự điền, sale sửa nếu khách cần số khác`, verification: 'inferred' });
      featureEv.DATA_POSTS = { codes: [code], best: 'inferred' }; quantities.DATA_POSTS = postCount;
    }
    // Dự đoán dung lượng lưu trữ theo khối lượng web mẫu (công thức công khai ở volume.js)
    const totalUrls = Math.max(res.coverage?.discovered || 0, res.coverage?.estimated_urls || 0);
    let storage = null;
    if (res.metrics) {
      storage = estimateStorage({ pages: totalUrls, products: prodCount, posts: postCount, imgBytes: res.metrics.img_bytes, imgSized: res.metrics.img_sized });
      const code = await addEv({ url: res.input, kind: 'storage', feature: 'HOSTING_STORAGE', detail: `Dự đoán ~${storage.gb} GB lưu trữ: ${storage.how}`, verification: 'inferred' });
      featureEv.HOSTING_STORAGE = { codes: [code], best: 'inferred' }; quantities.HOSTING_STORAGE = storage.gb;
    }
    if (featureEv.MULTILANG) quantities.MULTILANG = Math.max(1, (res.metrics?.max_languages || 2) - 1);
    const volumes = { urls: totalUrls, templates: quantities.PAGES ?? null, products: prodCount || 0, posts: postCount || 0, storage };

    // Độ phức tạp web mẫu → mức may đo M1–M8 (quyết định gói tối thiểu và vị trí giá trong khoảng của gói)
    // Chỉ dùng bảng tiêu chí công khai (quy mô, độ dày giao diện, menu, ngôn ngữ, nền tảng) — tính năng đã tính qua gói, không cộng lại.
    let complexity = null;
    if (res.metrics) {
      const measured = measureFromScan(res);
      const prevPricing = JSON.parse((await one('SELECT pricing_json FROM projects WHERE id=?', job.project_id))?.pricing_json || '{}');
      const overrides = prevPricing.complexity?.overrides || {}; // giữ phần sale đã chỉnh qua các lần quét lại
      complexity = { ...assessComplexity(measured, overrides), measured, overrides };
      const code = await addEv({ url: res.input, kind: 'complexity', feature: 'DESIGN_LEVEL', verification: 'inferred',
        detail: `Đo lường ${complexity.score}/${complexity.max} điểm → may đo M${complexity.level} ${complexity.name}${complexity.enterprise ? ' (vượt quy mô HERO 8 — Enterprise)' : ''}: ${complexity.rows.map((r) => `${r.title} ${r.value} → ${r.pts}đ`).join('; ')}` });
      featureEv.DESIGN_LEVEL = { codes: [code], best: 'inferred' };
      quantities.DESIGN_LEVEL = complexity.level;
    }

    // Yêu cầu: cập nhật dẫn chứng nếu đã có, tạo mới (thấy rõ → tick sẵn; suy luận → chờ quyết định)
    for (const [feature, ev] of Object.entries(featureEv)) {
      const f = catalog.features.find((x) => x.code === feature);
      if (!f) continue;
      const existing = await one('SELECT * FROM requirements WHERE project_id=? AND feature=?', job.project_id, feature);
      if (existing) {
        const codes = [...new Set([...JSON.parse(existing.evidence_codes), ...ev.codes])];
        await run("UPDATE requirements SET evidence_codes=?, updated_at=datetime('now') WHERE id=?", JSON.stringify(codes), existing.id);
        // quét lại: mức may đo theo đánh giá mới, trừ khi người dùng đã tự chỉnh
        // khối lượng (mẫu trang, sản phẩm, bài viết, dung lượng) theo lần quét mới, trừ khi sale đã tự nhập số
        if (AUTO_QTY.includes(feature) && existing.source_kind !== 'client' && quantities[feature] != null) await run('UPDATE requirements SET quantity=?, decision=? WHERE id=?', quantities[feature], existing.decision === 'pending' ? 'include' : existing.decision, existing.id);
        // (giữ lựa chọn "Tiết kiệm" = đã bỏ mức may đo; chỉ bật lại nếu đang chờ quyết định)
        if (feature === 'DESIGN_LEVEL' && existing.source_kind !== 'client') await run('UPDATE requirements SET quantity=?, decision=? WHERE id=?', quantities.DESIGN_LEVEL, existing.decision === 'pending' ? 'include' : existing.decision, existing.id);
        continue;
      }
      const code = await nextCode('requirements', job.project_id, 'R');
      const qty = quantities[feature] ?? f.default_qty ?? 1;
      const autoInclude = ev.best === 'observed' || AUTO_QTY.includes(feature) || feature === 'DESIGN_LEVEL';
      const r = await run(`INSERT INTO requirements (project_id, code, feature, title, source_kind, evidence_codes, decision, quantity, unit) VALUES (?,?,?,?,?,?,?,?,?)`,
        job.project_id, code, feature, f.title, ev.best === 'observed' ? 'observed' : 'inferred', JSON.stringify(ev.codes), autoInclude ? 'include' : 'pending', qty, f.unit);
      for (const q of f.questions || []) {
        await run('INSERT INTO questions (project_id, code, requirement_id, text, blocking) VALUES (?,?,?,?,?)', job.project_id, await nextCode('questions', job.project_id, 'Q'), Number(r.lastInsertRowid), q.text, q.blocking ? 1 : 0);
      }
    }
    if (complexity || res.ok) {
      const row = await one('SELECT pricing_json FROM projects WHERE id=?', job.project_id);
      const pricing = JSON.parse(row?.pricing_json || '{}');
      if (complexity) pricing.complexity = { ...complexity, url: job.url, at: new Date().toISOString() };
      if (res.ok) pricing.volumes = { ...volumes, url: job.url };
      await run('UPDATE projects SET pricing_json=? WHERE id=?', JSON.stringify(pricing), job.project_id);
    }
    if (res.ok) {
      // giá gốc theo phạm vi web mẫu; cập nhật theo lần quét mới trừ khi đã đặt tay
      const cur = JSON.parse((await one('SELECT pricing_json FROM projects WHERE id=?', job.project_id))?.pricing_json || '{}').baseline;
      await captureBaseline(job.project_id, cur?.domain || job.url, !!cur && !cur.manual);
    }
    await run(`UPDATE analysis_runs SET status=?, finished_at=datetime('now'), locked_at=NULL, coverage_json=?, robots_json=?, templates_json=?, crawler_version=?, error=? WHERE id=?`,
      res.ok ? 'done' : 'failed', JSON.stringify({ ...(res.coverage || {}), sitemap: res.sitemap, generator: res.generator, blocked_requests: res.blocked_requests, errors: (res.errors || []).slice(0, 20) }),
      JSON.stringify(res.robots || {}), JSON.stringify(tpl), res.crawler_version || null, res.fatal || null, job.id);
    await audit({ project_id: job.project_id, entity: 'analysis_run', entity_id: job.id, action: res.ok ? 'survey_done' : 'survey_failed', after: { pages: (res.pages || []).length, features: Object.keys(featureEv) } });
  });
  if (IS_SERVERLESS) fs.rmSync(dir, { recursive: true, force: true }); // ảnh đã lưu vào CSDL
}

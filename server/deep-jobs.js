// Hàng đợi "Đếm chính xác" (đi hết web mẫu, server/crawler/deep.js). Chạy RIÊNG với lượt quét nhanh:
//  - chỉ tải HTML (không mở trình duyệt) nên chạy song song được với lượt quét nhanh;
//  - chạy theo chặng ~3 phút, lưu trạng thái vào deep_scans.state_json → Vercel (giới hạn 5 phút / lần),
//    bộ quét Việt Nam và bản chạy trên máy đều chạy tiếp được; máy dừng giữa chừng thì chặng sau làm lại từ lần lưu cuối.
import { waitUntil } from '@vercel/functions';
import { one, all, run, tx, audit, loadJson, IS_SERVERLESS } from './db.js';
import { initDeepState, deepStep, deepSummary } from './crawler/deep.js';
import { scanWorkerStatus, scanWorkerKnown, captureBaseline, nextCode } from './jobs.js';
import { STORAGE_RULES } from './volume.js';

const CHUNK_MS = Number(process.env.DEEP_CHUNK_MS || (IS_SERVERLESS ? 170000 : 180000));
const STALE_MINUTES = 7; // chặng "đang chạy" quá lâu (máy bị dừng) → trả lại hàng đợi
const ON_VERCEL = IS_SERVERLESS && !process.env.SCAN_WORKER;
const utcMinus = (min) => new Date(Date.now() - min * 60000).toISOString().replace('T', ' ').slice(0, 19);
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const fmt = (n, d = 0) => Number(n).toLocaleString('vi-VN', { maximumFractionDigits: d });

/** Dung lượng hosting theo số đo thật: mã nguồn & CSDL + tổng dung lượng ảnh đo được trên web mẫu. */
export function storageFromExact(r, R = STORAGE_RULES) {
  const imgMb = Number(r.image_bytes || 0) / 1048576;
  const mb = R.base_mb + imgMb;
  const gb = Math.max(0.5, Math.ceil(mb / 1024 / 0.5) * 0.5);
  return { gb, mb: Math.round(mb), exact: true, how: `${fmt(R.base_mb)} MB mã nguồn & CSDL + ${fmt(imgMb)} MB ảnh (${fmt(r.images)} ảnh, đọc kích thước thật trên web mẫu${r.images_sized < r.images ? `; ${fmt(r.images - r.images_sized)} ảnh không đọc được tính theo cỡ trung bình` : ''}) ≈ ${fmt(mb / 1024, 2)} GB → làm tròn ${fmt(gb, 1)} GB` };
}

export async function latestDeep(projectId) {
  const r = await one('SELECT id, url, status, route, progress_json, result_json, error, applied, created_at, finished_at FROM deep_scans WHERE project_id=? ORDER BY id DESC LIMIT 1', projectId);
  if (!r) return null;
  const { progress_json, result_json, ...x } = r;
  return { ...x, progress: JSON.parse(progress_json || 'null'), result: JSON.parse(result_json || 'null') };
}

export async function queueDeepScan(projectId, url, userId) {
  const active = await one("SELECT id FROM deep_scans WHERE project_id=? AND status IN ('queued','running')", projectId);
  if (active) return { id: active.id, already: true };
  const r = await run("INSERT INTO deep_scans (project_id, url, status, created_by) VALUES (?,?,'queued',?)", projectId, url, userId);
  const id = Number(r.lastInsertRowid);
  await audit({ project_id: projectId, entity: 'deep_scan', entity_id: id, user_id: userId, action: 'queue', after: { url } });
  return { id };
}

/** Vercel: chạy một chặng sau khi trả lời yêu cầu (trang đang mở gọi lại định kỳ → chạy tiếp). Bộ quét Việt Nam đang chạy → nhường. */
export function kickDeep() {
  if (!IS_SERVERLESS) return;
  const p = (async () => {
    const w = await scanWorkerStatus().catch(() => null);
    if (w?.alive) return;
    await processDeepNext();
  })().catch((e) => console.error('[đếm đủ]', e.message));
  try { waitUntil(p); } catch { /* ngoài môi trường Vercel */ }
}

/** Bản chạy trên máy: vòng lặp nền. */
export async function startDeepLoop() {
  await run("UPDATE deep_scans SET status='queued', locked_at=NULL WHERE status='running'");
  setInterval(() => { processDeepNext().catch((e) => console.error('[đếm đủ]', e.message)); }, 3000).unref();
}

let busy = false; let runningId = null;
export const currentDeepId = () => runningId;
export async function processDeepNext() {
  if (busy) return false;
  busy = true;
  try {
    await run("UPDATE deep_scans SET status='queued', locked_at=NULL WHERE status='running' AND locked_at < ?", utcMinus(STALE_MINUTES));
    const job = await one(`SELECT id FROM deep_scans WHERE status='queued'${ON_VERCEL ? " AND route <> 'vn'" : ''} ORDER BY id LIMIT 1`);
    if (!job) return false;
    const claimed = await run("UPDATE deep_scans SET status='running', locked_at=datetime('now') WHERE id=? AND status='queued'", job.id);
    if (!claimed.changes) return false;
    runningId = job.id;
    const row = await one('SELECT * FROM deep_scans WHERE id=?', job.id);
    const state = row.state_json ? JSON.parse(row.state_json) : initDeepState(row.url);
    let lastSave = 0;
    const onProgress = (p) => {
      if (Date.now() - lastSave < 4000) return;
      lastSave = Date.now();
      run("UPDATE deep_scans SET progress_json=?, locked_at=datetime('now') WHERE id=? AND status='running'", JSON.stringify(p), row.id).catch(() => {});
    };
    try {
      await deepStep(state, { budgetMs: CHUNK_MS, onProgress, log: (...a) => console.log(`[đếm đủ #${row.id}]`, ...a) });
    } catch (e) {
      if (e.blocked && ON_VERCEL && (await scanWorkerKnown())) {
        await run("UPDATE deep_scans SET status='queued', route='vn', locked_at=NULL, error=? WHERE id=?", `Chờ bộ quét Việt Nam: máy chủ Vercel (Mỹ) bị web chặn — ${e.message}`, row.id);
        return true;
      }
      await run("UPDATE deep_scans SET status='failed', error=?, state_json=NULL, locked_at=NULL, finished_at=datetime('now') WHERE id=?", e.message, row.id);
      console.error(`[đếm đủ #${row.id}] lỗi:`, e.message);
      return true;
    }
    const cur = await one('SELECT status FROM deep_scans WHERE id=?', row.id);
    if (cur?.status !== 'running') return true; // sale bấm "Dừng" giữa chừng
    if (state.phase !== 'done') {
      const p = { phase: state.phase, pages: state.pages, queued: state.queue.length, products: state.products.length, posts: state.posts.length, images: state.images.length + state.img_extra, img_done: state.img_idx };
      await run("UPDATE deep_scans SET status='queued', state_json=?, progress_json=?, error=NULL, locked_at=NULL WHERE id=? AND status='running'", JSON.stringify(state), JSON.stringify(p), row.id);
      return true;
    }
    const result = deepSummary(state);
    await run("UPDATE deep_scans SET status='done', state_json=NULL, result_json=?, error=NULL, locked_at=NULL, finished_at=datetime('now') WHERE id=?", JSON.stringify(result), row.id);
    console.log(`[đếm đủ #${row.id}] xong: ${result.pages} trang, ${result.products} sản phẩm, ${result.posts} bài viết, ${result.images} ảnh (${fmt(result.image_bytes / 1048576)} MB), ${result.minutes} phút`);
    await applyDeepResult(row.id, { force: false });
    return true;
  } finally { busy = false; runningId = null; }
}

/** Tự điền số đếm được vào Số sản phẩm / Số bài viết / Dung lượng. force = sale bấm "Dùng số này" (ghi đè cả số đã nhập tay). */
export async function applyDeepResult(deepId, { force = false, userId = null } = {}) {
  const d = await one('SELECT * FROM deep_scans WHERE id=?', deepId);
  const r = JSON.parse(d?.result_json || 'null');
  if (!d || d.status !== 'done' || !r) return { applied: false, reason: 'Chưa đếm xong' };
  if (r.js_only || r.pages < 3) return { applied: false, reason: 'Web mẫu dựng bằng JavaScript (HTML gần như rỗng) — không đếm được bằng cách đọc trang, giữ số ước lượng' };
  const catalog = loadJson('data/catalog.json');
  const storage = storageFromExact(r);
  const day = new Date().toLocaleDateString('vi-VN');
  const scope = `đếm đủ ${fmt(r.pages)} trang của ${hostOf(r.url)} ngày ${day}${r.truncated ? ' — web quá lớn, đã dừng ở giới hạn nên là SỐ TỐI THIỂU' : ''}`;
  const items = [
    ['DATA_PRODUCTS', r.products, `${fmt(r.products)} sản phẩm / dịch vụ (${scope})`],
    ['DATA_POSTS', r.posts, `${fmt(r.posts)} bài viết (${scope})`],
    ['HOSTING_STORAGE', storage.gb, `${fmt(storage.gb, 1)} GB lưu trữ: ${storage.how}`],
  ];
  await tx(async () => {
    for (const [feature, qty, detail] of items) {
      if (!(qty > 0)) continue; // không thấy sản phẩm / bài viết nào → giữ nguyên ô (có thể web hiển thị bằng JavaScript)
      const code = await nextCode('evidence', d.project_id, 'E');
      await run('INSERT INTO evidence (project_id, run_id, code, url, kind, feature, detail, verification) VALUES (?,?,?,?,?,?,?,?)', d.project_id, null, code, r.url, 'volume_exact', feature, detail, 'observed');
      const ex = await one('SELECT * FROM requirements WHERE project_id=? AND feature=?', d.project_id, feature);
      if (ex) {
        const codes = JSON.stringify([...new Set([...JSON.parse(ex.evidence_codes || '[]'), code])]);
        if (force || ex.source_kind !== 'client') {
          await run("UPDATE requirements SET quantity=?, source_kind='observed', decision=?, evidence_codes=?, updated_at=datetime('now') WHERE id=?", qty, ex.decision === 'pending' || force ? 'include' : ex.decision, codes, ex.id);
          if (userId) await audit({ project_id: d.project_id, entity: 'requirement', entity_id: ex.id, user_id: userId, action: 'deep_apply', before: { quantity: ex.quantity }, after: { quantity: qty } });
        } else await run('UPDATE requirements SET evidence_codes=? WHERE id=?', codes, ex.id);
      } else {
        const f = catalog.features.find((x) => x.code === feature);
        if (!f) continue;
        await run('INSERT INTO requirements (project_id, code, feature, title, source_kind, evidence_codes, decision, quantity, unit) VALUES (?,?,?,?,?,?,?,?,?)',
          d.project_id, await nextCode('requirements', d.project_id, 'R'), feature, f.title, 'observed', JSON.stringify([code]), 'include', qty, f.unit);
      }
    }
    const row = await one('SELECT pricing_json FROM projects WHERE id=?', d.project_id);
    const pricing = JSON.parse(row?.pricing_json || '{}');
    pricing.volumes_exact = { url: r.url, deep_id: d.id, at: new Date().toISOString(), pages: r.pages, products: r.products, posts: r.posts, images: r.images, image_bytes: r.image_bytes, storage, truncated: r.truncated };
    if (pricing.volumes && hostOf(pricing.volumes.url) === hostOf(r.url)) pricing.volumes = { ...pricing.volumes, products: r.products || pricing.volumes.products, posts: r.posts || pricing.volumes.posts, storage, exact: true };
    await run('UPDATE projects SET pricing_json=? WHERE id=?', JSON.stringify(pricing), d.project_id);
    await run('UPDATE deep_scans SET applied=1 WHERE id=?', d.id);
    // giá gốc (phạm vi web mẫu) theo số đếm thật, trừ khi sale đã đặt tay
    if (pricing.baseline && !pricing.baseline.manual && hostOf(pricing.baseline.domain) === hostOf(r.url)) await captureBaseline(d.project_id, pricing.baseline.domain, true);
    await audit({ project_id: d.project_id, entity: 'deep_scan', entity_id: d.id, user_id: userId, action: force ? 'apply_force' : 'apply', after: { products: r.products, posts: r.posts, storage_gb: storage.gb } });
  });
  return { applied: true, storage };
}

/** Lượt quét nhanh sau này không ghi đè số đếm đủ của cùng web mẫu. */
export async function exactVolumesFor(projectId, url) {
  const row = await one('SELECT pricing_json FROM projects WHERE id=?', projectId);
  const ex = JSON.parse(row?.pricing_json || '{}').volumes_exact;
  return ex && hostOf(ex.url) === hostOf(url) ? ex : null;
}

export async function stopDeep(deepId) {
  await run("UPDATE deep_scans SET status='failed', error='Đã dừng theo yêu cầu', state_json=NULL, locked_at=NULL, finished_at=datetime('now') WHERE id=? AND status IN ('queued','running')", deepId);
}
export const deepRows = (projectId) => all('SELECT id, status FROM deep_scans WHERE project_id=? ORDER BY id DESC', projectId);

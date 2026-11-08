// Bộ quét riêng — chạy trên một máy đặt tại Việt Nam (VPS hoặc máy tính văn phòng) để quét web mẫu bằng IP Việt Nam.
// Web báo giá vẫn chạy trên Vercel; bộ quét nối vào CÙNG cơ sở dữ liệu (DATABASE_URL), tự nhận lượt quét đang chờ,
// quét rồi ghi kết quả + ảnh chụp về. Định kỳ báo "còn sống" để Vercel nhường việc quét (bộ quét tắt → Vercel tự quét lại).
//
// Chạy:  DATABASE_URL=postgres://... npm run scan-worker     (hướng dẫn đầy đủ: docs/bo-quet-viet-nam.md)
import os from 'node:os';

process.env.SCAN_WORKER = '1'; // phải đặt trước khi nạp các module bên dưới
const { detectFakeIp } = await import('./netcheck.js');
const { ready, run, DRIVER, closeDb } = await import('./db.js');
const jobs = await import('./jobs.js');

const POLL_MS = Number(process.env.SCAN_WORKER_POLL_MS || 3000);
const BEAT_MS = 20000;
const id = `${os.hostname()}#${process.pid}`;
const startedAt = new Date().toISOString();
let stopping = false;

if (DRIVER !== 'pg') console.warn('⚠ Chưa đặt DATABASE_URL → bộ quét dùng cơ sở dữ liệu trên máy này (chỉ để thử, Vercel sẽ không thấy kết quả).');
await detectFakeIp();
await ready();

async function beat() {
  const value = JSON.stringify({ id, host: os.hostname(), started_at: startedAt, busy: jobs.currentRunId(), platform: `${os.platform()} ${os.release()}` });
  await run("INSERT INTO app_kv (key, value, updated_at) VALUES ('scan_worker', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at", value);
}
await beat();
const beatTimer = setInterval(() => beat().catch((e) => console.error('[bộ quét] không báo được trạng thái:', e.message)), BEAT_MS);
console.log(`Bộ quét đang chạy trên ${os.hostname()} (CSDL: ${DRIVER}). Nhấn Ctrl+C để dừng.`);

async function shutdown(sig) {
  if (stopping) return;
  stopping = true;
  console.log(`\n${sig}: dừng bộ quét…`);
  clearInterval(beatTimer);
  const rid = jobs.currentRunId();
  try {
    if (rid) await run("UPDATE job_queue SET status='queued', locked_at=NULL WHERE run_id=? AND status='running'", rid); // trả lượt đang quét về hàng đợi
    await run("DELETE FROM app_kv WHERE key='scan_worker'"); // Vercel quét thay ngay, không phải chờ hết hạn
  } catch (e) { console.error(e.message); }
  await closeDb().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

while (!stopping) {
  let did = false;
  try { did = await jobs.processNext(); } catch (e) { console.error('[bộ quét]', e.message); }
  if (!did) await new Promise((r) => setTimeout(r, POLL_MS));
}

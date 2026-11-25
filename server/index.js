import os from 'node:os';
import { app } from './app.js';
import { detectFakeIp } from './netcheck.js';
import { startJobLoop, currentRunId } from './jobs.js';
import { startDeepLoop, currentDeepId } from './deep-jobs.js';
import { ready, run, DRIVER } from './db.js';

const PORT = Number(process.env.PORT || 3100);
const HOST = process.env.HOST || '127.0.0.1';

await detectFakeIp();
await ready(); // tạo bảng / dữ liệu mẫu trước khi nhận yêu cầu
await startJobLoop();
await startDeepLoop();
app.listen(PORT, HOST, () => console.log(`Công cụ báo giá: http://${HOST}:${PORT}`));

// Máy chủ riêng (VPS) dùng CHUNG CSDL Postgres với bản Vercel: báo "còn sống" như bộ quét Việt Nam
// để Vercel nhường việc quét / đếm cho máy này (quét bằng IP Việt Nam, không giới hạn 5 phút).
if (DRIVER === 'pg') {
  const startedAt = new Date().toISOString();
  const beat = async () => {
    const value = JSON.stringify({ id: `${os.hostname()}#${process.pid}`, host: os.hostname(), kind: 'server', started_at: startedAt, busy: currentRunId(), deep: currentDeepId(), caps: ['deep'], platform: `${os.platform()} ${os.release()}` });
    for (const key of ['scan_worker', 'scan_worker_seen']) {
      await run("INSERT INTO app_kv (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at", key, value);
    }
  };
  await beat().catch((e) => console.error('[máy chủ] không báo được trạng thái:', e.message));
  const timer = setInterval(() => beat().catch((e) => console.error('[máy chủ] không báo được trạng thái:', e.message)), 20000);
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    // tắt máy chủ (cập nhật / khởi động lại) → Vercel quét thay ngay, không phải chờ hết hạn
    await run("DELETE FROM app_kv WHERE key='scan_worker'").catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

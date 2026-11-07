import dns from 'node:dns/promises';
import crypto from 'node:crypto';
import { app } from './app.js';
import { startJobLoop } from './jobs.js';
import { ready } from './db.js';

const PORT = Number(process.env.PORT || 3100);
const HOST = process.env.HOST || '127.0.0.1';

// Tự nhận biết DNS fake-IP (proxy/VPN kiểu Clash, sing-box): một tên miền KHÔNG tồn tại mà vẫn
// phân giải về 198.18.0.0/15 nghĩa là proxy trả IP giả cho mọi tên miền. Khi đó mới cho phép dải này.
async function detectFakeIp() {
  if (process.env.CRAWLER_TRUST_FAKE_IP != null) return;
  const probe = `mbws-${crypto.randomBytes(6).toString('hex')}.invalid-check-${Date.now()}.com`;
  try {
    const addrs = await dns.lookup(probe, { all: true });
    if (addrs.length && addrs.every((a) => /^198\.(18|19)\./.test(a.address))) {
      process.env.CRAWLER_TRUST_FAKE_IP = '1';
      console.log('Phát hiện DNS fake-IP (proxy/VPN) → cho phép dải 198.18.0.0/15 cho crawler.');
    }
  } catch { /* tên miền không tồn tại → DNS bình thường */ }
}

await detectFakeIp();
await ready(); // tạo bảng / dữ liệu mẫu trước khi nhận yêu cầu
await startJobLoop();
app.listen(PORT, HOST, () => console.log(`Công cụ báo giá: http://${HOST}:${PORT}`));

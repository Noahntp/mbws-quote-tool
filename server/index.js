import { app } from './app.js';
import { detectFakeIp } from './netcheck.js';
import { startJobLoop } from './jobs.js';
import { ready } from './db.js';

const PORT = Number(process.env.PORT || 3100);
const HOST = process.env.HOST || '127.0.0.1';

await detectFakeIp();
await ready(); // tạo bảng / dữ liệu mẫu trước khi nhận yêu cầu
await startJobLoop();
app.listen(PORT, HOST, () => console.log(`Công cụ báo giá: http://${HOST}:${PORT}`));

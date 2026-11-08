# Cài bộ quét tại Việt Nam

Công cụ báo giá chạy trên Vercel, máy chủ đặt ở Mỹ. Một số web lớn (bachhoaxanh, shopee…) chặn truy cập từ máy chủ nước ngoài, nên bản trên Vercel không quét được các web này.

**Bộ quét** là một chương trình nhỏ chạy trên một máy đặt tại Việt Nam:

- Nó nối vào **cùng cơ sở dữ liệu** với bản trên Vercel.
- Nó tự nhận các lượt quét đang chờ, quét bằng IP Việt Nam, rồi ghi kết quả và ảnh chụp về.
- Sale vẫn dùng https://mbws-quote-tool.vercel.app như cũ, không cần làm gì thêm.
- Khi bộ quét tắt, Vercel tự quét thay sau khoảng 1 phút. Lượt quét không bị treo.

Máy chạy bộ quét **không cần mở cổng** nào cho bên ngoài. Nó chỉ cần ra được Internet.

## 1. Chuẩn bị

| | VPS Việt Nam | Máy tính văn phòng |
|---|---|---|
| Hệ điều hành | Ubuntu 22.04 / 24.04 | Windows 10 / 11 |
| RAM | từ 2 GB | từ 4 GB |
| Ưu điểm | chạy 24/7 | quét được cả web chặn IP trung tâm dữ liệu (như shopee) |
| Lưu ý | vài web chặn cả IP trung tâm dữ liệu | phải luôn bật, tắt chế độ ngủ |

### Chuỗi kết nối cơ sở dữ liệu (`DATABASE_URL`)

Lấy một trong hai cách:

- **Trên web Vercel:** vào dự án **mbws-quote-tool** → **Settings** → **Environment Variables**. Mở biến **DATABASE_URL** (môi trường Production) và bấm hiện giá trị.
- **Bằng dòng lệnh** (trên máy đã đăng nhập Vercel CLI, đang ở thư mục dự án):
  ```bash
  vercel env pull .env.worker --environment=production
  ```
  Lệnh này tạo file `.env.worker`. Đặt file này trong thư mục `mbws-quote-tool` thì bộ quét **tự đọc**, không cần đặt biến `DATABASE_URL` bằng tay. Cũng có thể tự tạo file `.env.worker` chỉ gồm một dòng `DATABASE_URL=postgres://...`.

> Đây là **mật khẩu cơ sở dữ liệu**. Không gửi qua chat công khai, không đưa lên git. File `.env*` đã được git bỏ qua.

## 2. Cài trên VPS Ubuntu

```bash
# Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git

# Mã nguồn (repo riêng tư: dùng tài khoản GitHub có quyền đọc)
git clone https://github.com/Noahntp/mbws-quote-tool.git
cd mbws-quote-tool
npm ci
npx playwright install --with-deps chromium

# Chạy thử
DATABASE_URL='postgres://...' npm run scan-worker
```

Khi chạy được, màn hình hiện dòng *"Bộ quét đang chạy trên … (CSDL: pg)"*. Nhấn Ctrl+C để dừng thử. Lượt quét đang dở sẽ tự trả về hàng đợi.

### Chạy nền và tự khởi động lại (systemd)

Tạo file `/etc/systemd/system/mbws-scan.service` (thay `ubuntu` và đường dẫn cho đúng máy):

```ini
[Unit]
Description=MBWS - bo quet web mau
After=network-online.target

[Service]
User=ubuntu
WorkingDirectory=/home/ubuntu/mbws-quote-tool
Environment=DATABASE_URL=postgres://...
ExecStart=/usr/bin/npm run scan-worker
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now mbws-scan
journalctl -u mbws-scan -f      # xem log quét
```

### Hoặc chạy bằng Docker

```bash
docker build -t mbws-quote .
docker run -d --name mbws-scan --restart unless-stopped -e DATABASE_URL='postgres://...' mbws-quote node server/scan-worker.js
docker logs -f mbws-scan
```

## 3. Cài trên máy tính Windows trong văn phòng

1. Cài **Node.js 22 LTS** (https://nodejs.org) và **Git** (https://git-scm.com).
2. Mở PowerShell, chạy:
   ```powershell
   git clone https://github.com/Noahntp/mbws-quote-tool.git
   cd mbws-quote-tool
   npm ci
   npx playwright install chromium
   ```
3. Tạo file `chay-bo-quet.bat` trong thư mục `mbws-quote-tool` với nội dung:
   ```bat
   @echo off
   cd /d %~dp0
   rem DATABASE_URL đọc từ file .env.worker cùng thư mục
   :loop
   call npm run scan-worker
   timeout /t 10
   goto loop
   ```
4. Bấm đúp file này để chạy. Muốn tự chạy khi bật máy: **Task Scheduler** → *Create Basic Task* → *When I log on* → *Start a program* → chọn `chay-bo-quet.bat`.
5. Vào **Settings → System → Power** và đặt **Sleep: Never**, để máy không ngủ khi không có người dùng.

## 4. Kiểm tra

Mở công cụ trên Vercel, vào một hồ sơ bất kỳ. Ở mục **1. Khách & web mẫu**:

- Thấy nhãn xanh **"Bộ quét: máy tại Việt Nam"** kèm tên máy: bộ quét đang hoạt động.
- Thấy nhãn vàng **"Bộ quét: máy chủ Vercel (Mỹ)"**: bộ quét đang tắt, Vercel quét thay.

Bấm **Quét lại** một web mẫu. Log của bộ quét sẽ hiện các dòng `[quét] bắt đầu …` và `[quét] xong …`.

## 5. Cập nhật khi có phiên bản mới

```bash
cd mbws-quote-tool
git pull
npm ci
npx playwright install chromium
sudo systemctl restart mbws-scan     # VPS; trên Windows: đóng cửa sổ rồi chạy lại file .bat
```

## Ghi chú

- Mỗi lần bộ quét chỉ quét một web. Có thể chạy nhiều bộ quét trên nhiều máy: lượt quét được nhận một cách độc quyền nên không bị quét trùng.
- Bộ quét tự xưng là `MBWS-QuoteBot` và tôn trọng `robots.txt`. Nó không vượt captcha hay cơ chế chặn của web.
- Biến tùy chọn:
  - `SCAN_WORKER_POLL_MS`: khoảng thời gian chờ giữa hai lần kiểm tra hàng đợi, mặc định 3000 ms.
  - `CRAWLER_USER_AGENT`: đổi tên tự xưng của bộ quét.

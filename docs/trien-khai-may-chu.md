# Đưa công cụ báo giá lên máy chủ riêng (VPS)

Chạy công cụ trên một VPS đặt tại Việt Nam thay cho (hoặc cùng với) bản Vercel:

- Quét web mẫu bằng IP Việt Nam, không bị các web lớn chặn, không cần bộ quét riêng ở văn phòng.
- Quét nhanh đọc tới 20 trang bằng trình duyệt đầy đủ; Vercel chỉ đọc 10 trang ở chế độ nhẹ và giới hạn 5 phút.
- "Đếm chính xác" chạy nền tới khi xong, không phải giữ trang mở.

Cài đặt và mỗi lần cập nhật đều chỉ là **một lệnh chạy trên máy văn phòng**.

## 1. Chuẩn bị

**VPS riêng cho công cụ.** Không cài chung lên máy hosting đang chạy web của khách.

| | Tối thiểu | Nên dùng |
|---|---|---|
| Hệ điều hành | Ubuntu 22.04 hoặc 24.04, 64-bit | Ubuntu 24.04 |
| CPU / RAM | 2 vCPU / 2 GB (script tự thêm 2 GB swap) | 2 vCPU / 4 GB |
| Ổ đĩa | 20 GB | 30 GB SSD |

Hosting chia sẻ (cPanel, DirectAdmin, Plesk) không chạy được: trình duyệt quét cần quyền root để cài thư viện hệ thống và cần khoảng 1 GB RAM.

**Tên miền.** Tạo bản ghi A, ví dụ `baogia.ten-mien.vn`, trỏ về IP của VPS. Nên tạo trước khi cài để HTTPS bật được ngay.

**Đăng nhập SSH bằng khóa.** Chạy trong Git Bash trên máy văn phòng:

```bash
ls ~/.ssh/id_ed25519.pub || ssh-keygen -t ed25519            # tạo khóa nếu chưa có
cat ~/.ssh/id_ed25519.pub | ssh root@IP_VPS "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys"
ssh root@IP_VPS "echo ok"                                     # phải in "ok" mà không hỏi mật khẩu
```

## 2. Cài lần đầu

Trong thư mục mã nguồn công cụ, trên máy văn phòng (Git Bash):

```bash
APP_PASSWORD='mat-khau-nhom' bash scripts/day-len-may-chu.sh root@IP_VPS baogia.ten-mien.vn
```

Script tự làm:

1. Đóng gói bản **đã commit** mới nhất (không mang theo `.env`, CSDL máy văn phòng, ảnh quét) và đẩy lên `/opt/mbws-quote-tool/releases/`.
2. Tạo cấu hình `/etc/mbws-quote-tool.env` (chỉ root đọc được).
3. Cài Node.js 22, thư viện, Chromium cho bộ quét, dịch vụ `mbws-quote-tool` (systemd, tự chạy khi khởi động máy), Caddy (HTTPS tự động) và sao lưu hằng ngày nếu dùng SQLite.
4. Khởi động, kiểm tra dịch vụ trả lời, rồi in địa chỉ truy cập.

**Cơ sở dữ liệu** (chọn khi cài lần đầu):

- **Mặc định:** dùng chung Postgres (Neon) với bản Vercel. `DATABASE_URL` được lấy từ `.env.worker` trên máy văn phòng, nên mọi hồ sơ cũ còn nguyên.
- `DATABASE_URL=none bash scripts/day-len-may-chu.sh ...`: dùng SQLite riêng trên VPS, bắt đầu trống, có sao lưu hằng ngày vào `/var/backups/mbws-quote-tool` (giữ 14 ngày).
- Postgres cài trên chính VPS (không có SSL): thêm `?sslmode=disable` vào cuối `DATABASE_URL`.

**Mật khẩu nhóm.** Nếu bỏ `APP_PASSWORD`, VPS tự tạo mật khẩu và in ra ở cuối. Gửi mật khẩu cho nhóm qua kênh nội bộ.

**Gợi ý tính năng bằng AI** (nếu bản Vercel đang bật): thêm dòng `ANTHROPIC_API_KEY=...` vào `/etc/mbws-quote-tool.env`, rồi chạy `systemctl restart mbws-quote-tool`.

## 3. Cập nhật phiên bản mới

Commit thay đổi, rồi chạy lại đúng lệnh cũ (không cần `APP_PASSWORD`):

```bash
bash scripts/day-len-may-chu.sh root@IP_VPS baogia.ten-mien.vn
```

Cấu hình và dữ liệu giữ nguyên. Nếu bản mới không khởi động được, script **tự quay lại bản trước** và báo lỗi kèm log. VPS giữ 3 bản gần nhất.

## 4. Chạy song song với bản Vercel

Khi VPS dùng chung CSDL với bản Vercel, VPS cứ 20 giây báo "còn sống" vào CSDL. Nhờ đó:

- Vercel tự nhường việc quét và "Đếm chính xác" cho VPS. Trên bản Vercel sẽ hiện nhãn "Bộ quét: máy tại Việt Nam".
- Khi VPS tắt hoặc đang cập nhật, Vercel quét thay ngay, tức là Vercel thành bản dự phòng.
- Bộ quét Việt Nam ở văn phòng (`chay-bo-quet.bat`) không cần nữa và có thể tắt.

Khi đã quen địa chỉ mới, cả nhóm nên dùng `https://baogia.ten-mien.vn`.

## 5. Vận hành

| Việc | Lệnh (trên VPS) |
|---|---|
| Xem log trực tiếp | `journalctl -u mbws-quote-tool -f` |
| Khởi động lại | `systemctl restart mbws-quote-tool` |
| Sửa cấu hình (mật khẩu, CSDL…) | sửa `/etc/mbws-quote-tool.env`, rồi khởi động lại |
| Quay lại bản trước bằng tay | `ls /opt/mbws-quote-tool/releases`, rồi `ln -sfn /opt/mbws-quote-tool/releases/<bản> /opt/mbws-quote-tool/current && systemctl restart mbws-quote-tool` |
| Xem chứng chỉ HTTPS / Caddy | `journalctl -u caddy -n 50` |

- Công cụ chỉ nghe trong máy (`127.0.0.1:3100`); bên ngoài vào qua Caddy (cổng 80/443).
- Nếu VPS bật tường lửa `ufw`, script tự mở cổng 80/443.
- Nếu cổng 80/443 đã có web server khác dùng, script không cài Caddy mà nhắc tự trỏ tên miền về `http://127.0.0.1:3100`.

## 6. Gỡ cài đặt

```bash
systemctl disable --now mbws-quote-tool && rm /etc/systemd/system/mbws-quote-tool.service
rm -rf /opt/mbws-quote-tool /etc/mbws-quote-tool.env /etc/cron.daily/mbws-quote-tool-backup
# dữ liệu SQLite (nếu có): /var/lib/mbws-quote-tool  ·  bản sao lưu: /var/backups/mbws-quote-tool
```

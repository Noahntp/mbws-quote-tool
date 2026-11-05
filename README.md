# Công cụ báo giá website (MBWS)

Hiện thực theo tài liệu `Tai_lieu_cong_cu_bao_gia_website.docx`: nhận URL web tham khảo + brief khách → khảo sát có dẫn chứng → chốt yêu cầu & câu hỏi → bóc tách WBS (O/M/P) → tính giá có kiểm tra giá sàn → phiên bản, duyệt, xuất báo giá cho khách → nhập giờ thực tế để hiệu chỉnh định mức.

Bảng giá gói lấy trực tiếp từ **https://www.matbao.ws/** (ZERO 1–8, HERO 1–8, Web Care 1–4, Audit) kèm bảng 63/71 tiêu chí so sánh.

## Chạy

Yêu cầu Node.js ≥ 22.13 (dùng SQLite tích hợp `node:sqlite`).

```bash
npm install
npm run setup            # tải Chromium cho Playwright (lần đầu)
npm start                # http://127.0.0.1:3100
npm test                 # kiểm thử bộ tính giá (tái hiện số liệu mục 05–06 của tài liệu)
npm run sync:packages    # đọc lại giá gói từ matbao.ws → data/packages.json
```

Biến môi trường:

| Biến | Ý nghĩa |
|---|---|
| `PORT`, `HOST` | Cổng/địa chỉ (mặc định 3100, 127.0.0.1) |
| `DATA_DIR` | Thư mục CSDL & ảnh khảo sát (mặc định `./storage`) |
| `CRAWLER_BUDGET_MS` | Ngân sách thời gian mỗi lần khảo sát (mặc định 240000) |
| `CRAWLER_TRUST_FAKE_IP=1` | **Chỉ** bật trên máy chạy sau proxy/VPN chế độ fake-IP (Clash, sing-box…) — mọi tên miền phân giải về 198.18.x.x và sẽ bị chặn SSRF nếu không bật |
| `ANTHROPIC_API_KEY` | Tùy chọn. Có thì "Phân tích brief" dùng Claude (`claude-opus-5-5`, bật fallback khi bị từ chối); không có thì dùng luật từ khóa tiếng Việt |
| `CLAUDE_MODEL` | Ghi đè model cho bước phân tích brief |

## Luồng sử dụng

1. **Hồ sơ & brief** — tạo hồ sơ, thêm web tham khảo (ghi phần cần học theo), "Phân tích brief" để ra danh sách yêu cầu đề xuất.
2. **Khảo sát web mẫu** — crawler đọc robots.txt + sitemap, nhóm URL theo mẫu trang, lấy mẫu đại diện (≤ 40 URL), chụp desktop + mobile, phát hiện tính năng qua DOM. Mỗi dẫn chứng có mã `E###`, URL, thời điểm, viewport, hash ảnh. Báo cáo độ phủ không ghi "100%".
3. **Chốt yêu cầu** — mỗi yêu cầu có nguồn (Quan sát được / Khách yêu cầu / Suy luận / Chưa kiểm tra được), quyết định Làm/Bỏ/Hỏi lại, khối lượng, tiêu chí nghiệm thu. Câu hỏi chặn phải trả lời trước khi phát hành.
4. **Bóc tách công việc** — sinh WBS từ yêu cầu đã chọn theo `data/catalog.json`; sửa định mức bắt buộc ghi lý do; rủi ro (xác suất × chi phí) và chi phí ngoài nhân sự.
5. **Tính giá** — hai chế độ:
   - *Theo bảng giá gói matbao.ws*: giá gói (không chia 1 − g) + add-on niêm yết (500k/20 SP, 500k/200 bài, Omni) + phần ngoài gói tính C ÷ (1 − g). Phần nào "trong gói" được xác định bằng cách đối chiếu bảng tiêu chí trên matbao.ws. Nút **Tính đề xuất** xếp hạng 16 gói theo tổng giá.
   - *Theo chi phí*: P = C ÷ (1 − g).
   - Luôn kiểm tra giá sàn C ÷ (1 − g_min) sau giảm giá **và** làm tròn; 3 kịch bản Thuận lợi/Cơ sở/Bất lợi; PERT tham khảo; VAT; phí định kỳ (gia hạn gói, Web Care) tách dòng riêng.
6. **Duyệt & xuất** — phiên bản là snapshot bất biến (đầu vào + đơn giá + chính sách + dữ liệu gói + kết quả). Nháp → Chờ duyệt (phải qua kiểm tra phát hành) → Đã duyệt (quản lý giá; người gửi không tự duyệt). Bản gửi khách (HTML/PDF) chỉ có giá bán & phạm vi, không có chi phí nội bộ/biên.
7. **Sau bàn giao** — nhập giờ thực tế theo phạm vi gốc/thay đổi/sửa lỗi/làm lại; trang **Hiệu chỉnh** tính WAPE, sai lệch có hướng, tỷ lệ thiếu > 20%.

Trạng thái hồ sơ (Nháp → Cần làm rõ → Dự toán → Chờ duyệt → Đã duyệt) được suy ra từ dữ liệu; sửa bất kỳ đầu vào nào sau khi duyệt sẽ đưa hồ sơ về "Dự toán" và cần phiên bản mới.

## Phân quyền

| Vai trò | Quyền |
|---|---|
| Sales | Hồ sơ, quyết định phạm vi, chọn gói/giảm giá, tạo & gửi duyệt phiên bản |
| Kỹ thuật | Khảo sát, định mức WBS, rủi ro, giờ thực tế |
| Quản lý giá | Đơn giá, chính sách, duyệt/từ chối, đồng bộ gói |
| Quản trị | Tất cả |

> Bản này chọn người dùng qua menu (header `X-User-Id`) — **chưa có đăng nhập**. Khi đưa vào core admin, thay middleware trong `server/app.js` bằng xác thực của core.

## Cấu trúc

```
server/pricing.js        Bộ tính giá xác định (BigInt VND, không phụ thuộc AI) — dễ port sang PHP/Laravel
server/estimate.js       Yêu cầu → WBS; đối chiếu tiêu chí gói matbao.ws; đề xuất gói
server/crawler/          Worker Playwright (tiến trình con), SSRF guard, robots.txt, nhóm URL, phát hiện tính năng
server/jobs.js           Hàng đợi khảo sát trên CSDL (khóa, retry, timeout, ghi idempotent)
server/brief.js          Phân tích brief (luật từ khóa / Claude + kiểm tra lại theo danh mục)
server/app.js            API, kiểm tra phát hành, phiên bản, duyệt, xuất, số liệu hiệu chỉnh
scripts/sync-packages.js Đồng bộ giá gói từ matbao.ws
data/packages.json       Dữ liệu gói đã đồng bộ (nguồn + thời điểm)
data/catalog.json        Danh mục WBS, định mức O/M/P, tính năng ↔ tiêu chí gói, câu hỏi
public/                  Giao diện (HTML/JS thuần, không cần build)
```

## Số liệu GIẢ ĐỊNH cần thay trước khi dùng thật

- Đơn giá nội bộ theo vai trò (`RC-2026.1`: 200k/150k ₫/giờ) và định mức O/M/P trong `data/catalog.json` — lấy theo ví dụ của tài liệu.
- `package_cost_pct = 60`: chi phí nội bộ của gói chuẩn bằng 60% giá niêm yết (dùng cho kiểm tra giá sàn ở chế độ gói).
- VAT 10%, biên 30%/25%, sales giảm tối đa 5%, sức chứa mẫu trang theo cấp sitemap S1–S8.
- Rủi ro mặc định (30%/40%/40% × 2 triệu).

Sửa đơn giá/chính sách trên trang **Đơn giá & chính sách** (tạo phiên bản mới có ngày hiệu lực).

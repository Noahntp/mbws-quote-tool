// Đo lường web mẫu → mức "may đo" M1–M8 (thang giao diện của matbao.ws). Bảng tiêu chí CÔNG KHAI:
// sale đọc được, khách tự kiểm chứng được, in kèm báo giá.
// Nguyên tắc chống "ép giá":
//  1. Mỗi yếu tố chỉ tính tiền MỘT lần: tính năng (giỏ hàng, đăng nhập…), số mẫu trang, số sản phẩm/bài viết đã tính
//     qua tiêu chí gói → KHÔNG cộng vào điểm may đo.
//  2. Chỉ dùng số đo kiểm chứng được (sitemap, số ngôn ngữ, menu, độ dày trang có ảnh chụp, nền tảng).
//  3. Thang nghiêng về phía thấp: web nhỏ/vừa không bị đẩy lên gói đắt; trong khoảng giá (HERO 6–8) lấy phía thấp.
//  4. Sale chỉnh được từng tiêu chí khi số đo chưa chuẩn (có lưu lịch sử); luôn kèm phương án tiết kiệm.
// Ngưỡng là GIẢ ĐỊNH hiệu chỉnh trên 8 web thật (11/2026) — chỉnh tại RUBRIC / LEVEL_FROM.

const NAMES = { 1: 'Tối giản', 2: 'Cơ bản', 3: 'Tiêu chuẩn', 4: 'Mở rộng', 5: 'Nâng cao', 6: 'Phức tạp', 7: 'Chuyên sâu', 8: 'Cao cấp' };
const fmt = (n) => Number(n || 0).toLocaleString('vi-VN');

export const RUBRIC = [
  { key: 'scale', title: 'Quy mô web', how: 'Số trang trên sitemap.xml (hoặc tìm thấy khi quét)', bands: [
    { lt: 100, label: 'Dưới 100 trang', pts: 0 },
    { lt: 500, label: '100 – 500 trang', pts: 1 },
    { lt: 2000, label: '500 – 2.000 trang', pts: 2 },
    { lt: 10000, label: '2.000 – 10.000 trang', pts: 3 },
    { lt: 50000, label: '10.000 – 50.000 trang', pts: 4 },
    { lt: 200000, label: '50.000 – 200.000 trang', pts: 5 },
    { lt: Infinity, label: 'Trên 200.000 trang', pts: 6 }] },
  { key: 'ui', title: 'Độ dày giao diện', how: 'Số phần tử HTML của trang nặng nhất (có ảnh chụp kèm)', bands: [
    { lt: 1500, label: 'Gọn (dưới 1.500 phần tử)', pts: 0 },
    { lt: 3000, label: 'Vừa (1.500 – 3.000)', pts: 1 },
    { lt: 4500, label: 'Dày (3.000 – 4.500)', pts: 2 },
    { lt: 6000, label: 'Rất dày (4.500 – 6.000)', pts: 3 },
    { lt: Infinity, label: 'Cực dày, kiểu sàn TMĐT (trên 6.000)', pts: 4 }] },
  { key: 'menu', title: 'Menu', how: 'Số liên kết ở đầu trang / menu', bands: [
    { lt: 60, label: 'Gọn (dưới 60 liên kết)', pts: 0 },
    { lt: 150, label: 'Lớn, nhiều tầng (60 – 150)', pts: 1 },
    { lt: Infinity, label: 'Mega menu (trên 150)', pts: 2 }] },
  { key: 'languages', title: 'Ngôn ngữ', how: 'Số phiên bản ngôn ngữ (hreflang / nút chọn ngôn ngữ)', bands: [
    { lt: 2, label: '1 ngôn ngữ', pts: 0 },
    { lt: 4, label: '2 – 3 ngôn ngữ', pts: 1 },
    { lt: 10, label: '4 – 9 ngôn ngữ', pts: 2 },
    { lt: Infinity, label: 'Từ 10 ngôn ngữ', pts: 3 }] },
  { key: 'platform', title: 'Nền tảng', how: 'Web nội dung dựng từ theme, hay ứng dụng viết riêng (React, Next.js, Vue…)', bands: [
    { lt: 1, label: 'Web nội dung / theme', pts: 0 },
    { lt: Infinity, label: 'Ứng dụng viết riêng', pts: 2 }] },
];
// Điểm tối thiểu của M1..M8 (0–1 điểm = M1: gói chọn theo tính năng, không ép mức giao diện)
export const LEVEL_FROM = [0, 2, 3, 4, 6, 7, 9, 10];
export const ENTERPRISE_FROM = 11; // vượt quy mô HERO 8 → matbao.ws báo giá riêng (alibaba đo 11–13 điểm)
export const MAX_SCORE = RUBRIC.reduce((n, r) => n + r.bands[r.bands.length - 1].pts, 0);
export const SCALE_TEXT = LEVEL_FROM.map((from, i) => {
  const to = i < 7 ? LEVEL_FROM[i + 1] - 1 : null;
  return `${to == null ? `${from}+` : from === to ? from : `${from}–${to}`} điểm → M${i + 1}`;
}).join(' · ') + ` · từ ${ENTERPRISE_FROM} điểm: Enterprise`;

const bandOf = (rub, v) => Math.max(0, rub.bands.findIndex((b) => Number(v || 0) < b.lt));

/** Số đo thô từ kết quả quét (lưu lại để tính lại khi đổi ngưỡng / khi sale chỉnh). */
export function measureFromScan(res) {
  const m = res.metrics || {};
  const discovered = res.coverage?.discovered || 0;
  const est = res.coverage?.estimated_urls || 0;
  const sitemapOk = res.sitemap?.status === 'found';
  return {
    scale: Math.max(discovered, est),
    scale_src: est > discovered ? 'ước lượng theo sitemap' : sitemapOk ? 'theo sitemap' : 'tìm thấy khi quét — không đọc được sitemap, có thể nhiều hơn',
    ui: m.max_elements || 0, menu: m.max_nav_links || 0, languages: m.max_languages || 0,
    platform: m.framework ? 1 : 0, platform_name: m.framework || null, pages_measured: m.pages || 0,
  };
}

const display = (key, ms) => ({
  scale: `${fmt(ms.scale)} trang (${ms.scale_src || 'đo khi quét'})`,
  ui: `~${fmt(ms.ui)} phần tử/trang`,
  menu: `${fmt(ms.menu)} liên kết`,
  languages: `${Math.max(1, ms.languages || 0)} ngôn ngữ`,
  platform: ms.platform ? `Viết riêng (${ms.platform_name || 'framework JS'})` : 'Theme / CMS',
}[key]);

/** Mức tương ứng tổng điểm; fraction = vị trí trong dải điểm của mức (đặt giá trong khoảng của HERO 6–8, nghiêng về thấp). */
export function fromScore(score) {
  let i = 0; while (i < 7 && score >= LEVEL_FROM[i + 1]) i++;
  const level = i + 1;
  const lo = LEVEL_FROM[i]; const next = i < 7 ? LEVEL_FROM[i + 1] : ENTERPRISE_FROM;
  const enterprise = score >= ENTERPRISE_FROM;
  const fraction = enterprise ? 1 : next > lo ? Math.round(((score - lo) / (next - lo)) * 100) / 100 : 0;
  return { level, name: NAMES[level], fraction, enterprise };
}

/**
 * Chấm điểm theo bảng tiêu chí. overrides = { key: chỉ số mức sale chọn } (ghi đè số đo khi chưa chuẩn).
 * Trả về từng dòng (số đo, mức, điểm, đã chỉnh tay chưa) để hiển thị & in kèm báo giá.
 */
export function assessComplexity(measured, overrides = {}) {
  const rows = RUBRIC.map((rub) => {
    const auto = bandOf(rub, measured[rub.key]);
    const ov = overrides?.[rub.key];
    const band = Number.isInteger(ov) && ov >= 0 && ov < rub.bands.length ? ov : auto;
    return { key: rub.key, title: rub.title, how: rub.how, value: display(rub.key, measured), auto_band: auto, band, label: rub.bands[band].label, pts: rub.bands[band].pts, overridden: band !== auto };
  });
  const score = rows.reduce((n, r) => n + r.pts, 0);
  const reasons = rows.filter((r) => r.pts > 0).map((r) => `${r.title}: ${r.label}${r.overridden ? ' (sale chỉnh)' : ''}`);
  return { version: 2, score, max: MAX_SCORE, ...fromScore(score), rows, reasons: reasons.length ? reasons : ['Web nhỏ, giao diện gọn — chọn gói theo tính năng'], scale_text: SCALE_TEXT };
}

/** Đánh giá đã lưu → tính lại theo bảng hiện hành (không cần quét lại khi chỉnh ngưỡng). Bản đo cũ (trước v2) giữ nguyên, đánh dấu legacy. */
export function refreshAssessment(c) {
  if (!c) return null;
  if (c.measured) return { ...c, ...assessComplexity(c.measured, c.overrides || {}) };
  return { ...c, legacy: true };
}

export const levelName = (m) => NAMES[m] || '';

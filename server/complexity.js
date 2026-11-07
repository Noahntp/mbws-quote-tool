// Đánh giá độ phức tạp web mẫu → mức "may đo" M1–M8 (theo thang của matbao.ws).
// Gói matbao.ws khác nhau chủ yếu ở mức may đo: ZERO tới M3, HERO 4 = M4 … HERO 8 = M8.
// Làm "giống web mẫu 90–100%" thì mức may đo phải tương xứng quy mô & độ phức tạp của web đó.
// Ngưỡng là GIẢ ĐỊNH hiệu chỉnh trên 7 web thật (11/2026) — chỉnh ở COMPLEXITY_RULES nếu cần.

const NAMES = { 1: 'Tối giản', 2: 'Cơ bản', 3: 'Tiêu chuẩn', 4: 'Mở rộng', 5: 'Nâng cao', 6: 'Phức tạp', 7: 'Chuyên sâu', 8: 'Cao cấp' };
const BUSINESS = ['CART', 'MEMBER_LOGIN', 'FILTER', 'SEARCH', 'MULTILANG', 'BOOKING', 'LOYALTY', 'PAYMENT_ONLINE'];
const step = (v, cuts) => cuts.reduce((n, c) => n + (v >= c ? 1 : 0), 0);

export const COMPLEXITY_RULES = {
  urls: [50, 200, 500, 2000, 10000, 50000], // quy mô (số URL, có ước lượng theo sitemap) → 0..6
  business: 6, // tối đa điểm tính năng nghiệp vụ (giỏ hàng, thành viên, lọc, tìm kiếm, đa ngôn ngữ, đặt lịch…)
  elements: [700, 1500, 3000, 5000, 8000], // phần tử HTML nhiều nhất trên một trang → 0..5
  nav: [40, 120], // liên kết ở menu/đầu trang (menu lớn nhiều tầng) → 0..2
  carousels: [3, 20], // khối trượt/slider (trang sản phẩm dày đặc) → 0..2
  custom: 2, // web viết riêng (React/Next/Vue/Angular) khó làm giống hơn web dựng từ theme
  templates: [5, 8], // số nhóm mẫu trang → 0..2
  products: [1000, 10000], // sản phẩm theo sitemap → 0..2
  languages: [3, 8], // số ngôn ngữ (web đa quốc gia) → 0..2
  // điểm → mức M: ≤2 → M1, ≤4 → M2, ≤7 → M3, ≤9 → M4, ≤11 → M5, ≤13 → M6, ≤15 → M7, còn lại M8
  levels: [2, 4, 7, 9, 11, 13, 15],
  enterprise: 17, // từ điểm này: vượt quy mô HERO 8 → Enterprise, báo giá riêng (alibaba đo 17–18 điểm qua các lần quét)
};

export function assessComplexity({ discovered = 0, estimatedUrls = 0, templateGroups = 0, observed = new Set(), metrics = {}, productCount = 0 }, R = COMPLEXITY_RULES) {
  const reasons = [];
  const pts = {};
  const urls = Math.max(discovered, estimatedUrls);
  pts.scale = step(urls, R.urls);
  if (urls) reasons.push(`${estimatedUrls > discovered ? '~' : ''}${urls.toLocaleString('vi-VN')} URL`);
  const biz = BUSINESS.filter((f) => observed.has(f));
  pts.business = Math.min(biz.length, R.business);
  if (biz.length) reasons.push(`${biz.length} tính năng nghiệp vụ`);
  pts.ui = step(metrics.max_elements || 0, R.elements);
  if (metrics.max_elements) reasons.push(`~${metrics.max_elements.toLocaleString('vi-VN')} phần tử/trang`);
  pts.nav = step(metrics.max_nav_links || 0, R.nav);
  if (pts.nav) reasons.push(`menu ${metrics.max_nav_links} liên kết`);
  pts.dynamic = step(metrics.max_carousels || 0, R.carousels);
  if (pts.dynamic) reasons.push(`${metrics.max_carousels} khối trượt`);
  pts.custom = metrics.framework ? R.custom : 0;
  if (metrics.framework) reasons.push(`viết riêng bằng ${metrics.framework}`);
  pts.templates = step(templateGroups, R.templates);
  if (templateGroups) reasons.push(`${templateGroups} nhóm trang`);
  pts.languages = step(metrics.max_languages || 0, R.languages);
  if (pts.languages) reasons.push(`${metrics.max_languages} ngôn ngữ`);
  pts.products = step(productCount, R.products);
  if (pts.products) reasons.push(`~${productCount.toLocaleString('vi-VN')} sản phẩm`);

  const score = Object.values(pts).reduce((a, b) => a + b, 0);
  const max = R.urls.length + R.business + R.elements.length + R.nav.length + R.carousels.length + R.custom + R.templates.length + R.products.length + R.languages.length;
  return { score, max, ...fromScore(score, R), points: pts, reasons };
}

/** Điểm → mức M, vị trí trong khoảng giá (0..1), có vượt quy mô không — theo ngưỡng hiện hành. */
export function fromScore(score, R = COMPLEXITY_RULES) {
  const level = 1 + step(score, R.levels.map((x) => x + 1));
  // vị trí trong dải điểm của mức (0..1) → đặt giá trong khoảng giá của gói (vd HERO 8: 45–60 tr)
  const lo = level === 1 ? 0 : R.levels[level - 2] + 1;
  const hi = level === 8 ? R.enterprise : R.levels[level - 1];
  const fraction = hi > lo ? Math.max(0, Math.min(1, (score - lo) / (hi - lo))) : 1;
  return { level, name: NAMES[level], fraction: Math.round(fraction * 100) / 100, enterprise: score >= R.enterprise };
}
/** Đánh giá đã lưu (lúc quét) → tính lại theo ngưỡng hiện hành, không cần quét lại khi chỉnh ngưỡng. */
export const refreshAssessment = (c) => (c && Number.isFinite(c.score) ? { ...c, ...fromScore(c.score) } : c || null);

export const levelName = (m) => NAMES[m] || '';

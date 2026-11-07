// Dự đoán dung lượng lưu trữ (GB) trên máy chủ cho web giống web mẫu — công thức CÔNG KHAI để sale giải thích được.
//   dung lượng = mã nguồn & CSDL + ảnh × số bản kích thước
//   ảnh = sản phẩm × 5 + bài viết × 3 + trang khác × 2 (số ảnh giả định / trang), mỗi ảnh = cỡ trung bình đo trên web mẫu
// Làm tròn lên 0,5 GB. Chưa tính tăng trưởng nội dung về sau (sale cộng thêm nếu khách dự kiến đăng nhiều).
export const STORAGE_RULES = {
  base_mb: 300, // mã nguồn, CSDL, plugin
  img_per: { product: 5, post: 3, page: 2 },
  default_img_kb: 200, // khi không đo được (web chặn tải ảnh / chế độ quét nhẹ)
  copies: 3, // CMS tự tạo ảnh thu nhỏ / vừa / lớn
};

const fmt = (n, d = 0) => Number(n).toLocaleString('vi-VN', { maximumFractionDigits: d });

export function estimateStorage({ pages = 0, products = 0, posts = 0, imgBytes = 0, imgSized = 0 }, R = STORAGE_RULES) {
  const measured = imgSized >= 5 && imgBytes > 0;
  const imgKb = measured ? Math.min(800, Math.max(40, Math.round(imgBytes / imgSized / 1024))) : R.default_img_kb;
  const other = Math.max(0, pages - products - posts);
  const images = products * R.img_per.product + posts * R.img_per.post + other * R.img_per.page;
  const mb = R.base_mb + (images * imgKb * R.copies) / 1024;
  const gb = Math.max(0.5, Math.ceil(mb / 1024 / 0.5) * 0.5);
  const how = `${fmt(R.base_mb)} MB mã nguồn & CSDL + ${fmt(images)} ảnh (${fmt(products)} SP × ${R.img_per.product} + ${fmt(posts)} bài × ${R.img_per.post} + ${fmt(other)} trang khác × ${R.img_per.page}) × ~${fmt(imgKb)} KB${measured ? ' (đo trên web mẫu)' : ' (giả định)'} × ${R.copies} bản kích thước ≈ ${fmt(mb / 1024, 1)} GB → làm tròn ${fmt(gb, 1)} GB`;
  return { gb, mb: Math.round(mb), images, img_kb: imgKb, img_measured: measured, how };
}

// Nhận dạng loại trang khi "Đếm chính xác" (đọc HTML, không mở trình duyệt) — hàm thuần, không cần mạng.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeHtml, deepSummary, initDeepState, deepStep } from '../server/crawler/deep.js';

const page = (body, head = '') => `<!doctype html><html><head>${head}</head>${body}</html>`;

test('WordPress / WooCommerce: lớp CSS của thẻ body quyết định sản phẩm, bài viết, trang', () => {
  assert.equal(analyzeHtml(page('<body class="product-template-default single single-product postid-12">'), 'https://shop.vn/san-pham/a/').kind, 'product');
  assert.equal(analyzeHtml(page('<body class="post-template-default single single-post postid-3 wp-theme-x">'), 'https://shop.vn/a-b-c/').kind, 'post');
  // trang tĩnh WordPress có og:type article (Yoast) nhưng không phải bài viết
  assert.equal(analyzeHtml(page('<body class="page-template-default page page-id-9">', '<meta property="og:type" content="article"><meta property="article:published_time" content="2024-01-01">'), 'https://shop.vn/gioi-thieu/').kind, 'page');
  assert.equal(analyzeHtml(page('<body class="archive tax-product_cat wp-theme-x">'), 'https://shop.vn/danh-muc/gao/').kind, 'page');
});

test('Haravan / Shopify / web tự viết: dữ liệu cấu trúc, khối chi tiết sản phẩm, dấu ngày đăng', () => {
  assert.equal(analyzeHtml(page('<body>', '<meta property="og:type" content="product">'), 'https://h.vn/products/gao-st25').kind, 'product');
  assert.equal(analyzeHtml(page('<body><script type="application/ld+json">{"@type":"BlogPosting"}</script>'), 'https://h.vn/x').kind, 'post');
  // trang danh mục có nhiều Product trong ItemList → không phải 1 sản phẩm
  assert.equal(analyzeHtml(page('<body><script type="application/ld+json">{"@type":"ItemList","itemListElement":[{"@type":"Product"},{"@type":"Product"}]}</script>'), 'https://h.vn/collections/all').kind, 'page');
  // web PHP tự viết: khối "chi tiết sản phẩm" (ctsp / spdt) trên đường dẫn phẳng
  assert.equal(analyzeHtml(page('<body><div class="dv-mota_ctsp">Mô tả</div><a class="btn btn-cart">Đặt hàng</a>'), 'https://w.vn/cay-nuoc/kg-34c.html').kind, 'product');
  // 1 dấu ngày đăng = bài viết; nhiều dấu = trang danh sách bài
  assert.equal(analyzeHtml(page('<body><h1>Bài</h1><span>Ngày đăng: 01/02/2025</span>'), 'https://w.vn/co-nen-dung-nuoc-khoang.html').kind, 'post');
  assert.equal(analyzeHtml(page(`<body>${'<h3>Bài</h3><span>Ngày đăng: 01/02/2025</span>'.repeat(10)}`), 'https://w.vn/tags/nuoc-khoang.html').kind, 'page');
  // trang liên hệ / chính sách có ngày đăng vẫn là trang
  assert.equal(analyzeHtml(page('<body><span>Ngày đăng: 01/02/2025</span>'), 'https://w.vn/chinh-sach-doi-tra.html').kind, 'page');
});

test('liên kết & ảnh: theo <base href>, bỏ phần chú thích, lấy ảnh lớn (srcset, lightbox), bỏ trang ảnh của web khác', () => {
  const a = analyzeHtml(page(`<body><base href="https://w.vn/">
    <!-- <img src="img/an.png"> -->
    <img src="img/logo.png"><img data-src="/up/a.jpg" srcset="/up/a-300.jpg 300w, /up/a-1024.jpg 1024w">
    <a href="up/big.jpg" class="highslide"><img src="up/small.jpg"></a>
    <a href="https://commons.wikimedia.org/wiki/File:Rice.jpg">nguồn ảnh</a>
    <a href="tin-tuc/bai-1.html">Bài 1</a><a href="javascript:void(0)">x</a><a href="tel:0909">gọi</a>
    <div style="background-image:url('/up/banner.webp')"></div>`, '<link rel="canonical" href="https://w.vn/cat/p.html">'), 'https://w.vn/cat/p.html');
  assert.deepEqual(a.images.sort(), ['https://w.vn/img/logo.png', 'https://w.vn/up/a-1024.jpg', 'https://w.vn/up/a.jpg', 'https://w.vn/up/banner.webp', 'https://w.vn/up/big.jpg', 'https://w.vn/up/small.jpg'].sort());
  assert.ok(a.links.includes('https://w.vn/tin-tuc/bai-1.html'), 'đường dẫn tương đối tính theo <base href>');
  assert.ok(!a.links.some((l) => /javascript:|tel:/.test(l)));
  assert.equal(a.canonical, 'https://w.vn/cat/p.html');
  // trang chuyển hướng bằng JavaScript (tên miền đỗ / trang đích) vẫn đi tiếp được
  assert.ok(analyzeHtml('<script>window.location.href="/lander"</script>', 'https://d.com/').links.includes('https://d.com/lander'));
});

test('tổng kết: ảnh hỏng không tính, ảnh chưa đọc được kích thước tính theo cỡ trung bình; web chỉ chạy JavaScript bị đánh dấu', () => {
  const S = { ...initDeepState('https://w.vn/'), origin: 'https://w.vn', pages: 100, products: ['a', 'b'], posts: ['c'], images: ['1', '2', '3', '4', '5'], img_sized: 3, img_bytes: 3000, img_missing: 1, phase: 'done' };
  const r = deepSummary(S);
  assert.equal(r.images, 4); // 5 ảnh − 1 ảnh hỏng
  assert.equal(r.image_bytes, 4000); // 3 ảnh đo được 3000 byte + 1 ảnh chưa đọc ≈ 1000
  assert.equal(r.products, 2); assert.equal(r.posts, 1); assert.equal(r.js_only, false);
  assert.equal(deepSummary({ ...initDeepState('https://x.vn/'), pages: 1, home_links: 0, phase: 'done' }).js_only, true);
});

test('web giới hạn tốc độ: bỏ nhiều trang sau khi thử lại → đánh dấu đếm chưa đủ; vài trang 404 lẻ tẻ thì không', () => {
  const base = { ...initDeepState('https://w.vn/'), origin: 'https://w.vn', products: ['a'], posts: ['b'], phase: 'done' };
  assert.equal(deepSummary({ ...base, pages: 26, rate_limited: 40, limited_failed: 12 }).incomplete, true);
  assert.equal(deepSummary({ ...base, pages: 800, errors: 3 }).incomplete, false);
  assert.equal(deepSummary({ ...base, pages: 100, errors: 40 }).incomplete, true);
});

// web giả: trang chủ liên kết tới 30 bài viết; giới hạn tốc độ theo kịch bản truyền vào
function fakeSite(refuse) {
  const hits = {};
  const page = (body) => ({ status: 200, type: 'text/html', text: `<html><body>${body}</body></html>`, bytes: 100 });
  const fetchText = async (url) => {
    const u = new URL(url); hits[u.pathname] = (hits[u.pathname] || 0) + 1;
    if (u.pathname === '/robots.txt' || /sitemap/.test(u.pathname)) return { status: 404, url, text: '' };
    if (u.pathname === '/') return { ...page(Array.from({ length: 30 }, (_, i) => `<a href="/bai-${i}.html">Bài ${i}</a>`).join('')), url };
    if (refuse(u.pathname, hits[u.pathname])) return { status: 429, url, text: '', retry_after: null };
    return { ...page(`<h1>Bài</h1><span>Ngày đăng: 01/02/2025</span><img src="/up${u.pathname}.jpg">`), url };
  };
  return { fetchText, headSize: async () => 1000, checkUrl: async () => {}, hits };
}
const fastLimits = { maxPages: 5000, maxImages: 10000, maxTotalMs: 60000, perPathVariants: 400, throttleMs: 5 };

test('web giới hạn tốc độ: giãn nhịp và thử lại trang bị từ chối → vẫn đếm đủ 30 bài', async () => {
  const site = fakeSite((path, n) => path.startsWith('/bai-') && n === 1); // mỗi bài từ chối lần đầu
  const S = initDeepState('https://w.test/');
  while (S.phase !== 'done') await deepStep(S, { ...site, limits: fastLimits, budgetMs: 30000 });
  const r = deepSummary(S);
  assert.equal(r.posts, 30);
  assert.ok(r.rate_limited >= 30, 'phải ghi nhận các lần bị từ chối');
  assert.equal(r.limited_failed, 0);
  assert.equal(r.incomplete, false);
  assert.ok(S.delay_ms > 0, 'phải giãn nhịp sau khi bị từ chối');
});

test('web từ chối mãi một số trang: bỏ sau 8 lần thử lại, kết quả đánh dấu chưa đủ', async () => {
  const site = fakeSite((path) => /^\/bai-(1|2|3|4|5)\.html$/.test(path)); // 5 bài luôn bị từ chối
  const S = initDeepState('https://w.test/');
  while (S.phase !== 'done') await deepStep(S, { ...site, limits: fastLimits, budgetMs: 30000 });
  const r = deepSummary(S);
  assert.equal(r.posts, 25);
  assert.equal(r.limited_failed, 5);
  assert.equal(site.hits['/bai-1.html'], 9); // 1 lần đầu + 8 lần thử lại
  assert.equal(r.incomplete, true);
});

test('web giới hạn theo tốc độ thật (1 yêu cầu / 20 ms): tự tìm nhịp phù hợp, đếm đủ, không chậm vô hạn', async () => {
  let last = 0;
  const site = fakeSite(() => { const now = Date.now(); if (now - last < 20) return true; last = now; return false; });
  const S = initDeepState('https://w.test/');
  const t0 = Date.now();
  while (S.phase !== 'done') await deepStep(S, { ...site, concurrency: 4, limits: { ...fastLimits, throttleMs: 30 }, budgetMs: 30000 });
  const r = deepSummary(S);
  assert.equal(r.posts, 30);
  assert.equal(r.incomplete, false);
  assert.ok(Date.now() - t0 < 10000, `đếm quá chậm: ${Date.now() - t0} ms`);
});

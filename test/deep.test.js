// Nhận dạng loại trang khi "Đếm chính xác" (đọc HTML, không mở trình duyệt) — hàm thuần, không cần mạng.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeHtml, deepSummary, initDeepState } from '../server/crawler/deep.js';

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

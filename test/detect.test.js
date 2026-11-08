// Kiểm thử bộ nhận diện tính năng trên trang HTML mẫu (offline, không cần mạng).
// Mỗi ca tái hiện một tình huống thật đã gặp khi quét: trang dịch vụ nhắc tên tính năng,
// link chứa chuỗi "m.me", pixel Zalo, nút "Mua ngay", khung tìm kiếm dạng div, link quy cách sản phẩm…
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { detectInPage } from '../server/crawler/detect.js';

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

async function detect(html, url = 'https://shop.test/') {
  const page = await browser.newPage();
  await page.route('**/*', (r) => (r.request().url() === url
    ? r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><head><meta charset="utf-8"></head><body>${html}</body></html>` })
    : r.abort()));
  await page.goto(url);
  const d = await page.evaluate(detectInPage);
  await page.close();
  const f = {};
  for (const x of d.features) if (!f[x.feature] || x.verification === 'observed') f[x.feature] = x.verification;
  return { f, d };
}
const observed = (f, k) => assert.equal(f[k], 'observed', `${k} phải được tick sẵn (observed), thực tế: ${f[k]}`);
const notTicked = (f, k) => assert.notEqual(f[k], 'observed', `${k} KHÔNG được tick sẵn, thực tế: ${f[k]}`);
const absent = (f, k) => assert.equal(f[k], undefined, `${k} không được nhận ra, thực tế: ${f[k]}`);

test('WooCommerce: nút thêm vào giỏ, ô tìm kiếm name=s, giá', async () => {
  const { f, d } = await detect(`
    <form role="search"><input name="s" placeholder="Tìm sản phẩm…"></form>
    <h1>Gạo ST25</h1><p class="price">250.000₫</p>
    <form class="cart"><button type="submit" name="add-to-cart" class="single_add_to_cart_button">Thêm vào giỏ hàng</button></form>`);
  observed(f, 'CART'); observed(f, 'SEARCH');
  assert.ok(d.price_count >= 1);
});

test('Trang dịch vụ chỉ NHẮC TỚI tính năng trong bảng so sánh → không tick sẵn', async () => {
  const { f } = await detect(`
    <table><tr><td>Giỏ hàng</td><td>✓</td></tr><tr><td>Chat Facebook Messenger</td><td>✓</td></tr>
    <tr><td>Tích điểm, hạng thành viên</td><td>✓</td></tr><tr><td>Đặt lịch booking</td><td>✓</td></tr><tr><td>Chatbot AI</td><td>✓</td></tr></table>
    <a href="https://redeem.mementophoto.ai/worldchefs/">Ảnh sự kiện</a>
    <script id="filter-config">var myAjax = {"filter": "price", "chatbot": true, "customerchat": 1};</script>`);
  absent(f, 'CART'); absent(f, 'MESSENGER'); absent(f, 'FILTER'); absent(f, 'AI_ASSISTANT');
  notTicked(f, 'LOYALTY'); notTicked(f, 'BOOKING');
});

test('Nhà hàng: đặt bàn ở hệ thống riêng, bản đồ, gọi điện, Zalo, Messenger, đa ngôn ngữ', async () => {
  const page = `
    <link rel="alternate" hreflang="vi" href="https://shop.test/vi"><link rel="alternate" hreflang="en" href="https://shop.test/en">
    <a href="https://booking.nhahang.test/" target="_blank"><span>RESERVATION</span></a>
    <iframe data-src="https://www.google.com/maps/embed?pb=xyz"></iframe>
    <a href="tel:0901234567">Gọi</a> <a href="https://zalo.me/0901234567">Zalo</a>
    <div id="fb-customer-chat" class="fb-customerchat"></div>`;
  const { f } = await detect(page);
  for (const k of ['BOOKING', 'MAP', 'PHONE_CALL', 'CHAT_ZALO', 'MESSENGER', 'MULTILANG']) observed(f, k);
});

test('Nút "Đặt lịch tư vấn" trên web dịch vụ không phải tính năng đặt chỗ', async () => {
  const { f } = await detect('<a href="#lien-he">Đặt lịch tư vấn</a>');
  notTicked(f, 'BOOKING');
});

test('Trang danh mục: khối lọc có ô chọn, link đăng nhập; pixel Zalo không phải chat; form đăng nhập không phải form liên hệ', async () => {
  const { f } = await detect(`
    <a href="/dang-nhap">Đăng nhập</a>
    <aside class="sidebar"><h3>Lọc theo giá</h3>
      <label><input type="checkbox"> Dưới 100.000đ</label><label><input type="checkbox"> 100–200.000đ</label><label><input type="checkbox"> Trên 200.000đ</label></aside>
    <form><input type="email" name="email"><input type="password" name="pw"><button>Đăng nhập</button></form>
    <script src="https://px.dmp.zaloapp.com/ztr.js?id=1"></script>`);
  observed(f, 'FILTER'); observed(f, 'MEMBER_LOGIN');
  absent(f, 'CHAT_ZALO'); absent(f, 'CONTACT_FORM');
});

test('Siêu thị online: nhiều nút "Mua ngay" cạnh giá, khung tìm kiếm dạng div', async () => {
  const items = [1, 2, 3, 4].map((i) => `<div class="item"><div>Mì gói ${i}</div><div>${i}5.000đ</div><div class="btn">Mua ngay</div></div>`).join('');
  const { f } = await detect(`<div id="input_open_search" style="width:300px;height:30px">Bạn tìm gì ở cửa hàng</div>${items}`);
  observed(f, 'CART'); observed(f, 'SEARCH');
});

test('Một nút "Mua ngay" đơn lẻ (landing page) chỉ là có thể có', async () => {
  const { f } = await detect('<h1>Khóa học</h1><a href="#dang-ky">Mua ngay</a>');
  notTicked(f, 'CART');
});

test('Link quy cách sản phẩm (?pack=&size=) không phải bộ lọc', async () => {
  const { f } = await detect(`
    <a href="/products/sua-chua?pack=100g&size=thung">100g</a><a href="/products/sua-chua?pack=400ml&size=loc">400ml</a>
    <a href="/products/sua-tuoi?pack=1l&size=hop">1L</a>`);
  absent(f, 'FILTER');
});

test('Link lọc tới trang danh mục là bộ lọc', async () => {
  const { f } = await detect('<a href="/danh-muc/gao?brand=st25">ST25</a><a href="/danh-muc/gao?price=0-100000">Dưới 100k</a>');
  observed(f, 'FILTER');
});

test('Ô tìm kiếm trong khung chat nhân viên không phải tìm kiếm trên web', async () => {
  const { f } = await detect('<div class="staff-chat"><input id="staff-chat-search-input" placeholder="Tìm theo nội dung, SĐT"></div>');
  notTicked(f, 'SEARCH');
});

test('Giá liền chữ ("303.096₫Thêm") vẫn được đếm', async () => {
  const { d } = await detect('<div>303.096₫Thêm vào giỏ</div><div>1.200.000 đ</div><div>99.000 VNĐ</div><div>Đã có 10.000 đơn hàng</div>');
  assert.equal(d.price_count, 3);
});

test('Link đăng nhập sang hệ thống ngoài chỉ là có thể có', async () => {
  const { f } = await detect('<a href="https://id.other-service.test/login">Đăng nhập</a>');
  notTicked(f, 'MEMBER_LOGIN');
});

test('nhận diện trang chặn máy quét (CAPTCHA / chống bot), không nhầm trang thường có reCAPTCHA ở form', async () => {
  const { botWall } = await import('../server/crawler/worker.js');
  assert.ok(botWall({ url: 'https://www.alibaba.com/_____tmd_____/punish?x5secdata=abc', title: '', text: '' }));
  assert.ok(botWall({ url: 'https://x.vn/', title: 'Just a moment...', text: 'checking your browser before accessing x.vn' }));
  assert.ok(botWall({ url: 'https://x.vn/', title: 'x', text: 'sorry, we have detected unusual traffic from your network. please slide to verify' }));
  assert.ok(botWall({ url: 'https://x.vn/', title: 'x', text: 'short', marker: true }));
  const normal = 'trang chủ nhà hàng thực đơn đặt bàn liên hệ '.repeat(200) + ' form liên hệ có captcha';
  assert.equal(botWall({ url: 'https://x.vn/', title: 'Nhà hàng ABC', text: normal }), null);
  assert.equal(botWall({ url: 'https://x.vn/lien-he', title: 'Liên hệ', text: normal, marker: false }), null);
});

test('Trang đăng ký hợp tác (form nhiều trường có lựa chọn) là landing; form thanh toán / liên hệ ngắn thì không', async () => {
  const { f } = await detect(`<section><h1>Đăng ký hợp tác bán lẻ</h1><form>
    <input name="name" placeholder="Họ và tên"><input type="tel" name="phone"><input type="email" name="email">
    <select name="city"><option>Chọn tỉnh</option><option>HCM</option></select>
    <label><input type="radio" name="kind" checked> NPP / Đại lý</label><label><input type="radio" name="kind"> Siêu thị</label>
    <label><input type="checkbox" name="need"> Bảng giá</label><button>Gửi thông tin đăng ký</button></form></section>`);
  observed(f, 'LANDING');
  const { f: f2 } = await detect(`<form><h2>Thanh toán</h2><input name="a"><input name="b"><input name="c"><input name="d">
    <label><input type="radio" name="pay"> COD</label><label><input type="radio" name="pay"> Chuyển khoản</label><button>Đặt hàng</button></form>`);
  absent(f2, 'LANDING');
  const { f: f3 } = await detect(`<form><input type="email" placeholder="Email"><textarea></textarea><button>Gửi liên hệ</button></form>`);
  absent(f3, 'LANDING');
});

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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDomain, domainOf, normalizeUrl, normalizeInput, dedupeKey, classify, groupTemplates, sampleUrls, parseRobots, robotsAllows, sameSite } from '../server/crawler/urls.js';
import { isPublicIp } from '../server/crawler/ssrf.js';

test('chuẩn hóa URL: bỏ tham số theo dõi, hash, dấu / cuối', () => {
  assert.equal(normalizeUrl('https://Shop.VN/san-pham/?utm_source=fb&id=2&fbclid=x#top'), 'https://shop.vn/san-pham?id=2');
  assert.equal(normalizeInput('shop.vn'), 'https://shop.vn/');
  assert.equal(normalizeUrl('javascript:alert(1)'), null);
  assert.equal(normalizeUrl('ftp://shop.vn/a'), null);
});

test('loại trùng phân trang & sắp xếp', () => {
  assert.equal(dedupeKey('https://shop.vn/san-pham/page/3'), 'https://shop.vn/san-pham');
  assert.equal(dedupeKey('https://shop.vn/san-pham?page=2&orderby=price'), 'https://shop.vn/san-pham');
});

test('cùng phạm vi: www và không www', () => {
  assert.ok(sameSite('https://www.shop.vn/a', 'shop.vn'));
  assert.ok(!sameSite('https://evil.vn/a', 'shop.vn'));
});

test('phân loại mẫu trang', () => {
  assert.equal(classify('https://shop.vn/').template, 'home');
  assert.equal(classify('https://shop.vn/san-pham').template, 'product:list');
  assert.equal(classify('https://shop.vn/san-pham/gao-st25').template, 'product:detail');
  assert.equal(classify('https://shop.vn/tin-tuc/bai-1').template, 'blog:detail');
  assert.equal(classify('https://shop.vn/lien-he').template, 'contact');
});

test('1.000 URL chung mẫu chỉ là 1 nhóm mẫu trang; lấy mẫu phủ mọi nhóm', () => {
  const urls = ['https://shop.vn/', 'https://shop.vn/lien-he', ...Array.from({ length: 1000 }, (_, i) => `https://shop.vn/san-pham/sp-${i}`)];
  const groups = groupTemplates(urls);
  assert.equal(groups.find((g) => g.template === 'product:detail').urls.length, 1000);
  assert.equal(groups.length, 3);
  const picked = sampleUrls(groups, 5);
  assert.deepEqual(new Set(picked.map((p) => p.template)), new Set(['home', 'contact', 'product:detail']));
});

test('robots.txt: luật dài nhất thắng, Allow thắng khi bằng nhau', () => {
  const r = parseRobots('User-agent: *\nDisallow: /admin\nAllow: /admin/public\nDisallow: /*?sort=\nSitemap: https://shop.vn/sitemap.xml');
  assert.equal(robotsAllows(r, 'https://shop.vn/admin/x'), false);
  assert.equal(robotsAllows(r, 'https://shop.vn/admin/public/a'), true);
  assert.equal(robotsAllows(r, 'https://shop.vn/sp?sort=price'), false);
  assert.equal(robotsAllows(r, 'https://shop.vn/sp'), true);
  assert.deepEqual(r.sitemaps, ['https://shop.vn/sitemap.xml']);
});

test('chặn SSRF: IP nội bộ / metadata không được truy cập', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.16.0.5', '169.254.169.254', '100.64.0.1', '::1', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1']) assert.equal(isPublicIp(ip), false, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '2001:4860:4860::8888']) assert.equal(isPublicIp(ip), true, ip);
});

test('chỉ cần gõ tên miền: mọi dạng nhập đều về trang chủ', () => {
  assert.equal(normalizeDomain('bachhoaxanh.com'), 'https://bachhoaxanh.com/');
  assert.equal(normalizeDomain('  WWW.BachHoaXanh.com  '), 'https://www.bachhoaxanh.com/');
  assert.equal(normalizeDomain('https://pizza4ps.com/vn/menu?x=1#top'), 'https://pizza4ps.com/');
  assert.equal(normalizeDomain('http://shop.com.vn/san-pham'), 'http://shop.com.vn/');
  assert.match(normalizeDomain('cửahàng.vn'), /^https:\/\/xn--[a-z0-9-]+\.vn\/$/); // tên miền tiếng Việt → punycode
  assert.equal(normalizeDomain('abc .vn'), 'https://abc.vn/'); // gõ thừa dấu cách vẫn nhận
  assert.equal(domainOf('https://www.abc.vn/'), 'abc.vn');
  for (const bad of ['', 'abc', 'localhost', '192.168.1.1', 'http://10.0.0.1/', 'ftp://abc.vn', '-abc.vn', 'javascript:alert(1)']) assert.equal(normalizeDomain(bad), null, bad);
});

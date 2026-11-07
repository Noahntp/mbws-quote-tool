// Bảng đo lường web mẫu → mức may đo → gói & giá. Số đo lấy từ các lần quét thật 11/2026.
// Mục tiêu: web nhỏ không bị đẩy giá (happyrice ~ 5–7 tr), web khổng lồ không bị báo rẻ (alibaba ≥ 60 tr).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { assessComplexity, measureFromScan, refreshAssessment, MAX_SCORE } from '../server/complexity.js';
import { findPackage, packagePrice, recommendPackages, buildAutoLines } from '../server/estimate.js';

const M = (scale, ui, menu, languages, framework, scale_src = 'theo sitemap') => ({ scale, scale_src, ui, menu, languages, platform: framework ? 1 : 0, platform_name: framework || null });
const sites = {
  'example.com': M(0, 22, 0, 0),
  'happyrice.vn': M(40, 1614, 35, 0),
  'pizza4ps.com': M(2906, 1099, 39, 5),
  'vinamilk.com.vn': M(104, 1272, 43, 2, 'Next.js'),
  'matbao.ws': M(1425, 4678, 72, 0),
  'worldchefs.org': M(197, 4252, 243, 3),
  'bachhoaxanh.com': M(17500, 2388, 27, 0, 'Next.js', 'ước lượng theo sitemap'),
  'alibaba.com': M(592, 6419, 153, 17, 'React'),
};
const lv = (k, ov) => assessComplexity(sites[k], ov);

test('thang đo: web nhỏ ở mức thấp, web lớn ở mức cao, alibaba vượt quy mô', () => {
  assert.equal(lv('example.com').level, 1);
  assert.ok(lv('happyrice.vn').level <= 3, `happyrice M${lv('happyrice.vn').level}`); // web bán gạo 40 trang không bị đẩy lên HERO 4+
  assert.equal(lv('pizza4ps.com').level, 4);
  assert.equal(lv('vinamilk.com.vn').level, 4);
  assert.equal(lv('matbao.ws').level, 5);
  assert.equal(lv('bachhoaxanh.com').level, 6);
  assert.equal(lv('alibaba.com').level, 8);
  assert.equal(lv('alibaba.com').enterprise, true);
  // lần quét khác của alibaba đo ít hơn (482 trang, 4.852 phần tử) vẫn là Enterprise
  assert.equal(assessComplexity(M(482, 4852, 153, 17, 'React')).enterprise, true);
  assert.equal(lv('bachhoaxanh.com').enterprise, false);
  for (const k of Object.keys(sites)) { const a = lv(k); assert.ok(a.fraction >= 0 && a.fraction <= 1); assert.equal(a.rows.length, 5); assert.ok(a.score <= MAX_SCORE); }
});

test('tính năng không cộng vào điểm may đo (đã tính qua gói) — chỉ 5 tiêu chí kiểm chứng được', () => {
  const a = lv('happyrice.vn');
  assert.deepEqual(a.rows.map((r) => r.key), ['scale', 'ui', 'menu', 'languages', 'platform']);
  assert.match(a.rows[0].value, /40 trang/);
});

test('sale chỉnh tiêu chí khi số đo chưa chuẩn → mức tính lại, đánh dấu đã chỉnh', () => {
  // bachhoaxanh khi không đọc được sitemap chỉ thấy 197 trang → sale chọn đúng quy mô 10.000–50.000
  const raw = M(197, 2388, 27, 0, 'Next.js', 'tìm thấy khi quét — không đọc được sitemap, có thể nhiều hơn');
  assert.equal(assessComplexity(raw).level, 4);
  const fixed = assessComplexity(raw, { scale: 4 });
  assert.equal(fixed.level, 6);
  assert.equal(fixed.rows[0].overridden, true);
  assert.match(fixed.reasons.join(' '), /sale chỉnh/);
  // đánh giá đã lưu tính lại theo bảng hiện hành; bản đo cũ (không có số đo) giữ nguyên, đánh dấu legacy
  assert.equal(refreshAssessment({ measured: raw, overrides: { scale: 4 } }).level, 6);
  assert.equal(refreshAssessment({ score: 10, level: 5 }).legacy, true);
});

test('số đo từ kết quả quét', () => {
  const m = measureFromScan({ coverage: { discovered: 197, estimated_urls: 17500 }, sitemap: { status: 'found' }, metrics: { max_elements: 2388, max_nav_links: 27, max_languages: 0, framework: 'Next.js', pages: 8 } });
  assert.equal(m.scale, 17500); assert.equal(m.platform, 1); assert.match(m.scale_src, /ước lượng/);
  assert.match(measureFromScan({ coverage: { discovered: 30 }, sitemap: { status: 'not_found' }, metrics: {} }).scale_src, /không đọc được sitemap/);
});

const catalog = JSON.parse(fs.readFileSync(new URL('../data/catalog.json', import.meta.url)));
const packages = JSON.parse(fs.readFileSync(new URL('../data/packages.json', import.meta.url)));
const rates = { PM: 200000, DESIGN: 200000, FE: 200000, BE: 200000, DATA: 150000, QA: 150000 };
const policy = { target_margin_pct: 30, min_margin_pct: 25, rounding_step: 1000, package_cost_pct: 60 };
const quote = (feats, a) => {
  const reqs = feats.map(([feature, quantity], i) => ({ id: i + 1, code: 'R' + i, feature, quantity, decision: 'include' }));
  if (a) reqs.push({ id: 99, code: 'R99', feature: 'DESIGN_LEVEL', quantity: a.level, decision: 'include' });
  return recommendPackages(catalog, packages, { requirements: reqs, lines: buildAutoLines(catalog, reqs), rates, policy, priceHint: a ? { level: a.level, fraction: a.fraction, enterprise: a.enterprise } : null }).best;
};

test('happyrice.vn (web bán gạo 40 trang) ra giá cỡ 5–8 tr, không phải 13–15 tr', () => {
  const feats = [['CART', 1], ['SEARCH', 1], ['CONTACT_FORM', 1], ['CHAT_ZALO', 1], ['PHONE_CALL', 1], ['SOCIAL', 1], ['MEMBER_LOGIN', 1], ['BLOG', 1], ['PRODUCT_CATALOG', 1], ['FILTER', 1], ['MAP', 1], ['PAGES', 8]];
  const best = quote(feats, lv('happyrice.vn'));
  assert.ok(best.price_list >= 4000000 && best.price_list <= 8000000, `happyrice ${best.code} ${best.price_list}`);
});

test('giá trong khoảng của gói nghiêng về phía thấp; Enterprise lấy mức cao nhất', () => {
  const h8 = findPackage(packages, 'HERO 8');
  assert.equal(packagePrice(h8, null), 45000000);
  assert.equal(packagePrice(h8, { level: 8, fraction: 0 }), 45000000);
  assert.equal(packagePrice(h8, { level: 8, fraction: 1, enterprise: true }), 60000000);
  assert.equal(packagePrice(findPackage(packages, 'HERO 1'), { level: 3, fraction: 1 }), 7000000); // gói giá cố định
  const h6 = findPackage(packages, 'HERO 6');
  assert.equal(packagePrice(h6, { level: 6, fraction: lv('bachhoaxanh.com').fraction }), 15000000); // đúng ngưỡng M6 → giá thấp nhất HERO 6
});

test('web khổng lồ không bị xếp vào gói rẻ chỉ vì đủ tính năng', () => {
  const feats = [['CART', 1], ['SEARCH', 1], ['MEMBER_LOGIN', 1], ['PAGES', 5]];
  assert.ok(quote(feats, null).price_list < 20000000, 'không có mức may đo thì rẻ (phương án tiết kiệm)');
  const best = quote(feats, lv('alibaba.com'));
  assert.equal(best.code, 'HERO 8');
  assert.ok(best.price_list >= 60000000, `alibaba phải ≥ 60 tr, thực tế ${best.price_list}`);
});

// Đánh giá độ phức tạp → mức may đo → gói & giá. Số liệu lấy từ lần quét thật 11/2026.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { assessComplexity } from '../server/complexity.js';
import { findPackage, packagePrice, recommendPackages, buildAutoLines } from '../server/estimate.js';

const S = (...a) => new Set(a);
const sites = {
  'example.com': { discovered: 0, templateGroups: 0, observed: S(), metrics: { max_elements: 22 } },
  'pizza4ps.com': { discovered: 857, estimatedUrls: 2906, templateGroups: 9, observed: S('MULTILANG', 'BOOKING', 'BLOG', 'PRODUCT_CATALOG'), metrics: { max_elements: 1099, max_nav_links: 39, max_carousels: 0, max_languages: 5 } },
  'vinamilk.com.vn': { discovered: 114, templateGroups: 11, observed: S('SEARCH', 'MULTILANG', 'LOYALTY', 'CART'), metrics: { max_elements: 1703, max_nav_links: 43, max_carousels: 4, framework: 'Next.js', max_languages: 2 } },
  'bachhoaxanh.com': { discovered: 421, estimatedUrls: 17500, templateGroups: 5, observed: S('CART', 'SEARCH', 'MEMBER_LOGIN', 'FILTER'), metrics: { max_elements: 2331, max_nav_links: 27, max_carousels: 4, framework: 'Next.js' } },
  'alibaba.com': { discovered: 482, templateGroups: 5, observed: S('SEARCH', 'MULTILANG', 'MEMBER_LOGIN'), metrics: { max_elements: 5613, max_nav_links: 153, max_carousels: 519, framework: 'React', max_languages: 17 } },
};

test('mức may đo tăng theo quy mô web mẫu', () => {
  const lv = Object.fromEntries(Object.entries(sites).map(([k, v]) => [k, assessComplexity(v)]));
  assert.equal(lv['example.com'].level, 1);
  assert.ok(lv['pizza4ps.com'].level >= 4 && lv['pizza4ps.com'].level <= 5, `pizza4ps M${lv['pizza4ps.com'].level}`);
  assert.ok(lv['vinamilk.com.vn'].level >= 5, `vinamilk M${lv['vinamilk.com.vn'].level}`);
  assert.equal(lv['bachhoaxanh.com'].level, 7);
  assert.equal(lv['alibaba.com'].level, 8);
  assert.equal(lv['alibaba.com'].enterprise, true); // sàn TMĐT khổng lồ → vượt quy mô HERO 8
  // lần quét khác lấy mẫu trang nhẹ hơn (4.852 phần tử) vẫn phải là Enterprise
  assert.equal(assessComplexity({ ...sites['alibaba.com'], discovered: 452, metrics: { ...sites['alibaba.com'].metrics, max_elements: 4852, max_carousels: 636 } }).enterprise, true);
  assert.equal(lv['bachhoaxanh.com'].enterprise, false);
  for (const v of Object.values(lv)) assert.ok(v.fraction >= 0 && v.fraction <= 1);
});

const catalog = JSON.parse(fs.readFileSync(new URL('../data/catalog.json', import.meta.url)));
const packages = JSON.parse(fs.readFileSync(new URL('../data/packages.json', import.meta.url)));

test('giá trong khoảng của gói theo độ phức tạp; Enterprise lấy mức cao nhất', () => {
  const h8 = findPackage(packages, 'HERO 8');
  assert.equal(packagePrice(h8, null), 45000000);
  assert.equal(packagePrice(h8, { level: 8, fraction: 0.5 }), 52500000);
  assert.equal(packagePrice(h8, { level: 8, fraction: 1, enterprise: true }), 60000000);
  assert.equal(packagePrice(h8, { level: 7, fraction: 1 }), 60000000); // phải nâng gói vì tính năng → giữ vị trí trong khoảng
  assert.equal(packagePrice(h8, { level: 7, fraction: 0 }), 45000000);
  assert.ok(packagePrice(h8, { level: 7, fraction: 1 }) > packagePrice(findPackage(packages, 'HERO 7'), { level: 7, fraction: 1 })); // nâng gói luôn có chi phí
  assert.equal(packagePrice(findPackage(packages, 'HERO 1'), { level: 3, fraction: 1 }), 7000000); // gói giá cố định
});

test('web phức tạp không bị xếp vào gói rẻ chỉ vì đủ tính năng', () => {
  const rates = { PM: 200000, DESIGN: 200000, FE: 200000, BE: 200000, DATA: 150000, QA: 150000 };
  const policy = { target_margin_pct: 30, min_margin_pct: 25, rounding_step: 1000, package_cost_pct: 60 };
  const reqs = [['CART', 1], ['SEARCH', 1], ['MEMBER_LOGIN', 1], ['PAGES', 5]].map(([feature, quantity], i) => ({ id: i + 1, feature, quantity, decision: 'include' }));
  const cheap = recommendPackages(catalog, packages, { requirements: reqs, lines: buildAutoLines(catalog, reqs), rates, policy });
  const withLevel = [...reqs, { id: 99, feature: 'DESIGN_LEVEL', quantity: 8, decision: 'include' }];
  const a = assessComplexity(sites['alibaba.com']);
  const rec = recommendPackages(catalog, packages, { requirements: withLevel, lines: buildAutoLines(catalog, withLevel), rates, policy, priceHint: { level: a.level, fraction: a.fraction, enterprise: a.enterprise } });
  assert.ok(cheap.best.price_list < 20000000, 'không có mức may đo thì rẻ (đúng như lỗi cũ)');
  assert.equal(rec.best.code, 'HERO 8');
  assert.ok(rec.best.price_list >= 60000000, `alibaba phải ≥ 60 tr, thực tế ${rec.best.price_list}`);
  assert.ok(rec.ineligible.some((x) => x.code === 'ZERO 3'));
});

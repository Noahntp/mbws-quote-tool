// Kiểm tra việc đối chiếu yêu cầu với bảng tiêu chí gói matbao.ws (data/packages.json).
// Nếu đồng bộ lại giá mà bảng trên web đổi cấu trúc, các ca này sẽ báo ngay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { coverage, findPackage, featureTiers } from '../server/estimate.js';

const catalog = JSON.parse(fs.readFileSync(new URL('../data/catalog.json', import.meta.url)));
const packages = JSON.parse(fs.readFileSync(new URL('../data/packages.json', import.meta.url)));
const feature = (code) => catalog.features.find((f) => f.code === code);
const cov = (pkg, code, qty = 1) => coverage(catalog, packages, findPackage(packages, pkg), feature(code), qty).status;

test('tên tiêu chí khác dấu cách giữa bảng ZERO và HERO vẫn khớp (Blog có từ ZERO 2)', () => {
  assert.equal(cov('ZERO 1', 'BLOG'), 'not_included');
  assert.equal(cov('ZERO 2', 'BLOG'), 'included');
  assert.equal(cov('HERO 1', 'BLOG'), 'included');
});

test('mỗi tính năng nằm đúng cấp gói theo matbao.ws', () => {
  const t = featureTiers(catalog, packages);
  const at = (code) => (t[code] ? (t[code].all ? 'ALL' : t[code].code) : null);
  for (const code of ['SEARCH', 'FILTER', 'CONTACT_FORM', 'CHAT_ZALO', 'MESSENGER', 'PHONE_CALL', 'MAP', 'SOCIAL', 'ANALYTICS', 'SEO']) assert.equal(at(code), 'ALL', code);
  assert.equal(at('PRODUCT_CATALOG'), 'ZERO 2');
  assert.equal(at('CART'), 'ZERO 2');
  assert.equal(at('BLOG'), 'ZERO 2');
  assert.equal(at('MULTILANG'), 'HERO 1');
  assert.equal(at('BOOKING'), 'HERO 3');
  assert.equal(at('MEMBER_LOGIN'), 'HERO 4');
  assert.equal(at('LOYALTY'), 'HERO 4');
  assert.equal(at('OMNI_CONTENT'), 'HERO 5');
  assert.equal(at('AI_ASSISTANT'), 'HERO 6');
  assert.equal(at('INTERNATIONAL'), 'HERO 7');
  assert.equal(at('ERP_INTEGRATION'), 'HERO 8');
  assert.equal(at('SHIPPING'), null);
  assert.equal(t.OMNI_SYNC.paid_until, 'ZERO 5'); // ZERO 1–4 tính 500.000 ₫, miễn phí từ ZERO 5
});

test('vượt số sản phẩm của gói → mua thêm 500.000 ₫ / 20 sản phẩm', () => {
  const c = coverage(catalog, packages, findPackage(packages, 'ZERO 1'), feature('DATA_PRODUCTS'), 70);
  assert.equal(c.status, 'paid_addon');
  assert.equal(c.addons[0].qty, 2); // ZERO 1 cho 30 SP, vượt 40 → 2 × 20
});

test('mức may đo vượt gói thì gói không phù hợp', () => {
  assert.equal(cov('ZERO 1', 'DESIGN_LEVEL', 3), 'not_included');
  assert.equal(cov('ZERO 6', 'DESIGN_LEVEL', 3), 'included');
});

test('dung lượng hosting: gói gồm sẵn GB, vượt thì mua thêm theo GB; "Theo dự án" tính như mức cao nhất', async () => {
  const { gbOf, applyPackage } = await import('../server/estimate.js');
  assert.equal(gbOf('0.5 GB'), 0.5); assert.equal(gbOf('4,5 GB'), 4.5); assert.equal(gbOf('Theo dự án'), null);
  const pk = { ...packages, addons: [...packages.addons, { code: 'ADD_HOSTING_1GB', name: 'Thêm 1 GB hosting', price: 500000, unit: '1 GB', recurring: 'yearly' }] };
  const f = feature('HOSTING_STORAGE');
  const c = (pkg, q) => coverage(catalog, pk, findPackage(pk, pkg), f, q);
  assert.equal(c('ZERO 2', 1).status, 'included');
  const z1 = c('ZERO 1', 2); // gói 0,5 GB, cần 2 GB → mua thêm 2 GB (làm tròn lên)
  assert.equal(z1.status, 'paid_addon'); assert.equal(z1.addons[0].qty, 2);
  assert.equal(c('HERO 5', 8).status, 'included');
  const h7 = c('HERO 7', 10); // "Theo dự án" → như 8 GB
  assert.equal(h7.status, 'paid_addon'); assert.equal(h7.addons[0].qty, 2);
  assert.equal(coverage(catalog, packages, findPackage(packages, 'ZERO 1'), f, 3).status, 'not_included'); // chưa có giá mua thêm → không tự cộng 0đ
  // không có đầu việc nhưng vẫn cộng add-on khi áp gói
  const reqs = [{ id: 1, code: 'R1', feature: 'HOSTING_STORAGE', quantity: 3, decision: 'include' }];
  const ap = applyPackage(catalog, pk, findPackage(pk, 'ZERO 1'), [], reqs);
  assert.deepEqual(ap.addons.map((a) => [a.code, a.qty]), [['ADD_HOSTING_1GB', 3]]);
});

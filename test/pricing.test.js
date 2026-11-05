import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeQuote, grossUp, roundTo } from '../server/pricing.js';

// Ví dụ mục 05 của tài liệu: website bán gạo, 116 giờ, 22.000.000 nhân sự
const rates = { PM: 200000, DESIGN: 200000, FE: 200000, BE: 200000, DATA: 150000, QA: 150000 };
const docLines = [
  ['Khảo sát và chốt phạm vi', 'PM', 8],
  ['Thiết kế giao diện', 'DESIGN', 12],
  ['Frontend và responsive', 'FE', 36],
  ['Backend và cấu hình core', 'BE', 24],
  ['Nhập dữ liệu', 'DATA', 8],
  ['QA và hồi quy', 'QA', 12],
  ['Quản lý và phản hồi', 'PM', 8],
  ['Triển khai và đào tạo', 'PM', 4],
  ['Dự kiến sửa lỗi bảo hành', 'QA', 4],
].map(([title, role, h]) => ({ title, role, group: 'X', qty: 1, o: h, m: h, p: h }));
const docRisks = [
  { title: 'Ghép module', prob_pct: 30, impact: 2000000 },
  { title: 'Dữ liệu lệch', prob_pct: 40, impact: 2000000 },
  { title: 'Lỗi hiển thị', prob_pct: 40, impact: 2000000 },
];
const policy = { target_margin_pct: 30, min_margin_pct: 25, rounding_step: 1000, vat_pct: 0 };
const base = { mode: 'cost', rates, policy, lines: docLines, external: [{ title: 'Ngoài nhân sự', amount: 1000000 }], risks: docRisks };

test('ví dụ mục 05: 116 giờ, chi phí 25,2 triệu, giá 36 triệu', () => {
  const r = computeQuote(base);
  assert.equal(r.ok, true, JSON.stringify(r.checks));
  assert.equal(r.hours.m, 116);
  assert.equal(r.scenarios.m.labor, 22000000n);
  assert.equal(r.scenarios.m.risk, 2200000n);
  assert.equal(r.cost_total, 25200000n);
  assert.equal(r.price_list, 36000000n);
});

test('mục 06: giá sàn 33,6 triệu; giảm 5% còn 34,2 triệu, biên ~26,32%; giảm tối đa ~6,67%', () => {
  const r = computeQuote({ ...base, discount_pct: 5 });
  assert.equal(r.floor, 33600000n);
  assert.equal(r.price_net, 34200000n);
  assert.equal(r.margin_realized_pct, 26.32);
  assert.equal(r.max_discount_pct, 6.67);
  assert.equal(r.ok, true);
});

test('giảm giá qua giá sàn bị chặn, kể cả khi làm tròn', () => {
  const r = computeQuote({ ...base, discount_pct: 7 });
  assert.equal(r.ok, false);
  assert.ok(r.checks.some((c) => c.code === 'BELOW_FLOOR'));
  // làm tròn xuống tới 1 triệu cũng không lách được
  const r2 = computeQuote({ ...base, discount_pct: 6.6, policy: { ...policy, rounding_step: 1000000, rounding_mode: 'down' } });
  assert.ok(r2.price_net < r2.floor ? !r2.ok : r2.ok);
});

test('kịch bản thuận lợi/bất lợi: 30 triệu và 45 triệu', () => {
  const lines = [{ title: 'Tổng nhân sự', role: 'PM', group: 'X', qty: 1, o: 95, m: 110, p: 135 }]; // 19/22/27 triệu
  const r = computeQuote({ ...base, lines, risk_override: { o: 1000000, p: 3500000 } });
  assert.equal(r.scenarios.o.price, 30000000n);
  assert.equal(r.scenarios.m.price, 36000000n);
  assert.equal(r.scenarios.p.price, 45000000n);
});

test('cùng đầu vào tính hai lần cho kết quả giống hệt', () => {
  const a = JSON.stringify(computeQuote(base), (_, v) => (typeof v === 'bigint' ? v.toString() : v));
  const b = JSON.stringify(computeQuote(structuredClone(base)), (_, v) => (typeof v === 'bigint' ? v.toString() : v));
  assert.equal(a, b);
});

test('dòng giờ công bằng 0 bị chặn', () => {
  const r = computeQuote({ ...base, lines: [...docLines, { title: 'Tích hợp ERP chưa rõ', role: 'BE', qty: 1, o: 0, m: 0, p: 0 }] });
  assert.equal(r.ok, false);
  assert.ok(r.checks.some((c) => c.code === 'ZERO_HOURS'));
});

test('chế độ theo gói: không chia 1−g cho giá gói, phần ngoài gói mới gross-up', () => {
  const lines = [
    { title: 'Phần trong gói', role: 'FE', qty: 1, o: 40, m: 40, p: 40, billing: 'package' },
    { title: 'Tích hợp ngoài gói', role: 'BE', qty: 1, o: 7, m: 7, p: 7, billing: 'extra' }, // 1.4 triệu
  ];
  const r = computeQuote({
    mode: 'package', rates, policy, lines, external: [], risks: [],
    package: { code: 'HERO 1', price: 7000000, renewal_per_year: 5000000 },
    addons: [{ code: 'ADD_PRODUCTS_20', name: '+20 SP', qty: 2, unit_price: 500000, recurring: 'yearly' }],
  });
  assert.equal(r.package_price, 7000000n);
  assert.equal(r.addons_total, 1000000n);
  assert.equal(r.extras_sell, 2000000n); // 1.4tr / 0.7
  assert.equal(r.price_list, 10000000n);
  // chi phí gói = 60% giá niêm yết (gói + add-on) = 4,8tr; + phần ngoài gói 1,4tr
  assert.equal(r.cost_total, 6200000n);
  assert.equal(r.package_effort_cost, 8000000n);
  assert.equal(r.recurring.length, 2);
});

test('chế độ gói không có phần ngoài gói: không cộng dự phòng rủi ro', () => {
  const r = computeQuote({ mode: 'package', rates, policy, lines: [{ title: 'Trong gói', role: 'FE', qty: 1, o: 10, m: 10, p: 10, billing: 'package' }],
    external: [], risks: docRisks, package: { code: 'ZERO 6', price: 4000000 } });
  assert.equal(r.price_list, 4000000n);
  assert.equal(r.cost_total, 2400000n);
  assert.equal(r.ok, true);
});

test('VAT tính trên giá sau giảm', () => {
  const r = computeQuote({ ...base, policy: { ...policy, vat_pct: 8 } });
  assert.equal(r.vat, 2880000n);
  assert.equal(r.total_incl_vat, 38880000n);
});

test('helpers', () => {
  assert.equal(grossUp(70n, 3000), 100n);
  assert.equal(roundTo(36000001n, 1000), 36001000n);
  assert.equal(roundTo(36000499n, 1000, 'nearest'), 36000000n);
  assert.throws(() => grossUp(1n, 10000));
});

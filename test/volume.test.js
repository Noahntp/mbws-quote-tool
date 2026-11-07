// Dự đoán dung lượng lưu trữ theo khối lượng web mẫu (công thức công khai).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateStorage } from '../server/volume.js';

test('web nhỏ (happyrice: 41 trang, 6 SP, 8 bài) → 0,5 GB, nằm trong mọi gói', () => {
  const s = estimateStorage({ pages: 41, products: 6, posts: 8 });
  assert.equal(s.gb, 0.5);
  assert.match(s.how, /6 SP × 5/);
  assert.match(s.how, /giả định/);
});

test('web lớn (~17.500 trang) → vài chục GB; cỡ ảnh đo được thì dùng số đo', () => {
  const s = estimateStorage({ pages: 17500, products: 0, posts: 0 });
  assert.ok(s.gb >= 15 && s.gb <= 30, `${s.gb} GB`);
  const m = estimateStorage({ pages: 100, products: 50, posts: 20, imgBytes: 100 * 80 * 1024, imgSized: 100 }); // ảnh ~80 KB
  assert.equal(m.img_kb, 80); assert.equal(m.img_measured, true); assert.match(m.how, /đo trên web mẫu/);
  assert.equal(m.gb, 0.5);
  assert.equal(estimateStorage({ pages: 10, imgBytes: 10, imgSized: 2 }).img_measured, false); // quá ít ảnh đo được → dùng giả định
});

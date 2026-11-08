// Đếm bố cục theo cấu trúc trang (không theo đường dẫn). Chữ ký lấy từ lần quét thật drinkwana.com.vn 11/2026.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clusterLayouts, layoutSimilarity } from '../server/crawler/layout.js';

const product = ['div1'];
const page = ['divh1'];
const partner = ['sectionh1', 'sectionh2', 'sectionh2', 'sectionhf2'];
const partnerHub = ['section1', 'mainhfg3'];
test('trang cùng thiết kế gom 1 bố cục; khác thiết kế dù cùng đường dẫn cha vẫn tách', () => {
  assert.equal(layoutSimilarity(partner, partner), 1);
  assert.ok(layoutSimilarity(partner, partnerHub) < 0.7);
  const pages = [
    { url: 'https://x.vn/vi/doi-tac', kind: 'other', layout: partnerHub },
    { url: 'https://x.vn/vi/doi-tac/sieu-thi', kind: 'other', layout: partner },
    { url: 'https://x.vn/vi/doi-tac/nha-phan-phoi', kind: 'other', layout: partner },
    { url: 'https://x.vn/vi/products/a', kind: 'product', layout: product },
    { url: 'https://x.vn/vi/products/b', kind: 'product', layout: product },
    { url: 'https://x.vn/vi/pages/gioi-thieu', kind: 'about', layout: page },
    { url: 'https://x.vn/vi/pages/chinh-sach', kind: 'policy', layout: page },
    { url: 'https://x.vn/vi/products?keyword=a', kind: 'search', layout: ['divhg2'] }, // trang tìm kiếm không tính
    { url: 'https://x.vn/vi/loi', kind: 'other', layout: ['div9'], error: 'HTTP 500' }, // trang lỗi không tính
  ];
  const c = clusterLayouts(pages);
  assert.equal(c.length, 4);
  assert.deepEqual(c.map((x) => x.count), [1, 2, 2, 2]);
});

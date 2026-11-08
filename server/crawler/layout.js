// Đếm BỐ CỤC trang (layout) theo cấu trúc thật của trang, không theo đường dẫn.
// matbao.ws định giá theo "Bố cục trang web" S1–S8 (số bố cục khác nhau) → đếm sai là báo giá sai:
//  - gom theo đường dẫn làm 2 trang khác thiết kế (vd /doi-tac và /doi-tac/sieu-thi) thành 1;
//  - nhiều trang cùng thiết kế (sản phẩm, chính sách) dù khác đường dẫn vẫn chỉ là 1 bố cục.

/** Chạy TRONG trang: chữ ký bố cục = chuỗi khối nội dung chính (bỏ header/footer/nav), mỗi khối mô tả bằng
 *  thẻ + có tiêu đề + có form + dạng lưới + số cột. */
export function layoutSignatureInPage() {
  const root = document.querySelector('main') || document.body;
  const skip = ['HEADER', 'FOOTER', 'NAV', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'];
  const tall = (e) => e.getBoundingClientRect().height > 80;
  let blocks = [...root.children].filter((e) => !skip.includes(e.tagName) && tall(e));
  // web bọc toàn bộ nội dung trong 1–2 thẻ div → đi sâu xuống tới khi thấy các khối
  for (let i = 0; i < 3 && blocks.length > 0 && blocks.length <= 2; i++) {
    const inner = blocks.flatMap((b) => [...b.children].filter((e) => !skip.includes(e.tagName) && tall(e)));
    if (inner.length <= blocks.length) break;
    blocks = inner;
  }
  return blocks.slice(0, 16).map((e) => {
    const h = e.querySelector('h1,h2,h3') ? 'h' : '';
    const f = e.querySelector('form,input:not([type=hidden]),textarea') ? 'f' : '';
    const g = e.querySelectorAll('img,a').length > 8 ? 'g' : '';
    const cols = new Set([...e.querySelectorAll(':scope > * > *')].slice(0, 12).map((c) => Math.round(c.getBoundingClientRect().left / 200))).size;
    return `${e.tagName.toLowerCase()}${h}${f}${g}${Math.min(cols, 4)}`;
  });
}

const setOf = (sig) => new Set(sig.map((x, i) => `${x}#${Math.min(i, 6)}`));
export function layoutSimilarity(a, b) {
  const A = setOf(a); const B = setOf(b);
  const inter = [...A].filter((x) => B.has(x)).length;
  return inter / (new Set([...A, ...B]).size || 1);
}

/** Gom các trang đã quét thành nhóm bố cục (giống nhau ≥ 70%). Trang chức năng đi kèm tính năng (tìm kiếm, giỏ hàng,
 *  tài khoản) không tính là bố cục thiết kế riêng. */
export function clusterLayouts(pages, threshold = 0.7) {
  const clusters = [];
  for (const p of pages) {
    if (!p.layout?.length || p.error || p.blocked || ['search', 'cart', 'account'].includes(p.kind)) continue;
    const c = clusters.find((k) => layoutSimilarity(k.sig, p.layout) >= threshold);
    if (c) c.urls.push(p.url); else clusters.push({ sig: p.layout, urls: [p.url], kind: p.kind });
  }
  return clusters.map((c) => ({ kind: c.kind, count: c.urls.length, urls: c.urls.slice(0, 4) }));
}

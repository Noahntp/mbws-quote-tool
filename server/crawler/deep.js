// Đếm CHÍNH XÁC số sản phẩm, bài viết và dung lượng ảnh của web mẫu bằng cách đi hết web (không mở trình duyệt):
// tải HTML từng trang, theo mọi liên kết / phân trang / sitemap trong cùng web, tôn trọng robots.txt.
// Chạy lâu (vài phút → vài chục phút) nên chỉ chạy trên bộ quét Việt Nam hoặc bản chạy trên máy, không chạy trên Vercel.
import { safeFetchText, safeHeadSize, assertPublicUrl } from './ssrf.js';
import { normalizeUrl, isHtmlCandidate, dedupeKey, parseRobots, robotsAllows, classify } from './urls.js';

const UA = 'MBWS-QuoteBot';
const decode = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&#0?38;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/** Phân tích HTML một trang (hàm thuần, kiểm thử được): loại trang, liên kết, ảnh, đường dẫn chuẩn. */
export function analyzeHtml(html, pageUrl) {
  const h = String(html || '');
  const attr = (tag, name) => { const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')); return m ? decode(m[2] ?? m[3] ?? m[4] ?? '') : null; };
  const abs = (u) => { try { return new URL(u, pageUrl).toString(); } catch { return null; } };
  const links = [];
  for (const m of h.matchAll(/<a\b[^>]*>/gi)) { const href = attr(m[0], 'href'); if (href && !/^(#|javascript:|mailto:|tel:)/i.test(href)) { const a = abs(href); if (a) links.push(a); } }
  const images = new Set();
  for (const m of h.matchAll(/<img\b[^>]*>/gi)) {
    for (const name of ['src', 'data-src', 'data-lazy-src', 'data-original']) { const v = attr(m[0], name); if (v && !/^data:/i.test(v)) { const a = abs(v); if (a) images.add(a); } }
    const ss = attr(m[0], 'srcset') || attr(m[0], 'data-srcset');
    if (ss) { const best = ss.split(',').map((x) => x.trim().split(/\s+/)).filter((x) => x[0]).sort((a, b) => (parseInt(b[1], 10) || 0) - (parseInt(a[1], 10) || 0))[0]; if (best) { const a = abs(best[0]); if (a) images.add(a); } }
  }
  const linkTag = [...h.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]).find((t) => /rel\s*=\s*["']?canonical/i.test(t));
  const canonical = linkTag ? abs(attr(linkTag, 'href')) : null;
  const ogType = (([...h.matchAll(/<meta\b[^>]*>/gi)].map((m) => m[0]).find((t) => /property\s*=\s*["']og:type["']/i.test(t)) || '').match(/content\s*=\s*["']([^"']+)/i) || [])[1] || '';
  const ld = [...h.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join(' ');
  const ldTypes = new Set([...ld.matchAll(/"@type"\s*:\s*(?:\[\s*)?"([A-Za-z]+)"/g)].map((m) => m[1]));
  const text = h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
  const prices = (text.match(/\d{1,3}(?:[.,]\d{3})+\s?(?:₫|đ\b|vnđ|vnd|đồng)/gi) || []).length;
  const cartBtn = /(thêm vào giỏ|add to cart|mua ngay|đặt hàng ngay|add_to_cart|single_add_to_cart)/i.test(h);
  const bodyCls = ((h.match(/<body\b[^>]*class\s*=\s*["']([^"']*)/i) || [])[1] || '').toLowerCase();
  const tpl = classify(pageUrl).template;
  let kind = 'page';
  if (ldTypes.has('Product') || /product/i.test(ogType) || /single-product|product-template|woocommerce-page.*single/.test(bodyCls) || tpl === 'product:detail' || (cartBtn && prices >= 1 && prices <= 6)) kind = 'product';
  else if (['Article', 'BlogPosting', 'NewsArticle'].some((t) => ldTypes.has(t)) || /^article$/i.test(ogType) || /single-post|post-template-default/.test(bodyCls) || tpl === 'blog:detail') kind = 'post';
  // trang danh sách / chuyên mục không tính là sản phẩm / bài viết
  if (/(:list|^home$)/.test(tpl) && !ldTypes.has('Product') && !/^article$/i.test(ogType)) kind = 'page';
  return { kind, canonical, links, images: [...images], bytes: Buffer.byteLength(h) };
}

/**
 * Đi hết web từ startUrl. Trả về số trang, sản phẩm, bài viết (gộp trùng theo đường dẫn chuẩn), số ảnh & tổng dung lượng ảnh.
 * onProgress({ pages, queued, products, posts }) được gọi định kỳ để hiện tiến độ.
 */
export async function deepCount(startUrl, { maxPages = 3000, maxMs = 15 * 60 * 1000, concurrency = 5, maxImages = 6000, log = () => {}, onProgress = () => {} } = {}) {
  const t0 = Date.now(); const timeLeft = () => maxMs - (Date.now() - t0);
  let start = normalizeUrl(startUrl);
  await assertPublicUrl(start);
  // địa chỉ dùng được (SSL lỗi ở www / không www → đổi sang dạng kia)
  try { await safeFetchText(start, { userAgent: UA, maxBytes: 4000 }); } catch (e) {
    if (/CERT|SSL|TLS/i.test(String(e?.cause?.code || e?.code || e?.message))) { const alt = new URL(start); alt.hostname = alt.hostname.startsWith('www.') ? alt.hostname.slice(4) : 'www.' + alt.hostname; start = alt.toString(); }
  }
  const root = new URL(start); const host = root.hostname.replace(/^www\./, '');
  const sameHost = (u) => { try { return new URL(u).hostname.replace(/^www\./, '') === host; } catch { return false; } };
  const onRoot = (u) => { const x = new URL(u); x.hostname = root.hostname; x.protocol = root.protocol; return x.toString(); }; // www / http trong liên kết → địa chỉ dùng được

  let robots = null;
  try { const r = await safeFetchText(`${root.origin}/robots.txt`, { userAgent: UA }); if (r.status === 200) robots = parseRobots(r.text, UA); } catch { /* không có robots */ }

  const seen = new Set(); const queue = []; let blocked = 0;
  const push = (raw) => {
    const n = normalizeUrl(raw); if (!n || !sameHost(n) || !isHtmlCandidate(n) || classify(n).kind === 'junk') return;
    const u = onRoot(n); const key = dedupeKey(u).replace(/^(https?:\/\/)www\./, '$1');
    if (seen.has(key)) return; seen.add(key);
    if (robots && !robotsAllows(robots, u)) { blocked++; return; }
    queue.push(u);
  };
  push(start);
  // sitemap: mọi sitemap con (giới hạn 200 tệp)
  const smQueue = robots?.sitemaps?.length ? [...robots.sitemaps] : [`${root.origin}/sitemap.xml`, `${root.origin}/sitemap_index.xml`, `${root.origin}/wp-sitemap.xml`];
  for (let i = 0; i < smQueue.length && i < 200 && timeLeft() > 60000; i++) {
    const sm = sameHost(smQueue[i]) ? onRoot(smQueue[i]) : null; if (!sm) continue;
    const r = await safeFetchText(sm, { userAgent: UA, maxBytes: 10_000_000 }).catch(() => null);
    if (!r || r.status !== 200 || !/<(urlset|sitemapindex)/i.test(r.text)) continue;
    const locs = [...r.text.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/gi)].map((m) => decode(m[1].trim()));
    if (/<sitemapindex/i.test(r.text)) smQueue.push(...locs); else locs.forEach(push);
  }

  const products = new Set(); const posts = new Set(); const images = new Set();
  let pages = 0; let htmlBytes = 0; let errors = 0; let truncated = false;
  const worker = async () => {
    while (queue.length) {
      if (pages >= maxPages || timeLeft() < 20000) { truncated = true; queue.length = 0; return; }
      const url = queue.shift();
      let r; try { r = await safeFetchText(url, { userAgent: UA, maxBytes: 3_000_000, timeoutMs: 15000 }); } catch { errors++; continue; }
      if (r.status !== 200 || (r.type && !/html/i.test(r.type))) { if (r.status >= 400) errors++; continue; }
      if (/\/(404|not-?found)(\.(php|html?))?\/?$/i.test(new URL(r.url).pathname)) continue; // trang 404 "giả"
      pages++; htmlBytes += r.bytes || Buffer.byteLength(r.text);
      const a = analyzeHtml(r.text, r.url);
      const id = dedupeKey(onRoot(a.canonical && sameHost(a.canonical) ? a.canonical : r.url)).replace(/^(https?:\/\/)www\./, '$1');
      if (a.kind === 'product') products.add(id); else if (a.kind === 'post') posts.add(id);
      for (const im of a.images) if (images.size < maxImages) images.add(im);
      a.links.forEach(push);
      if (pages % 20 === 0) { onProgress({ pages, queued: queue.length, products: products.size, posts: posts.size }); log('đếm', pages, 'trang, còn', queue.length); }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));

  // dung lượng ảnh: đọc kích thước file từ máy chủ (HEAD), ảnh không đọc được tính theo trung bình
  const imgs = [...images]; let imgBytes = 0; let sized = 0; let k = 0;
  const imgWorker = async () => {
    while (k < imgs.length && timeLeft() > 10000) { const u = imgs[k++]; const n = await safeHeadSize(u, { userAgent: UA }).catch(() => null); if (n > 0) { imgBytes += n; sized++; } }
  };
  await Promise.all(Array.from({ length: 8 }, imgWorker));
  const avg = sized ? imgBytes / sized : 0;
  const imgTotal = Math.round(imgBytes + avg * (imgs.length - sized));
  onProgress({ pages, queued: 0, products: products.size, posts: posts.size, done: true });
  return {
    start, pages, products: products.size, posts: posts.size, images: imgs.length, images_sized: sized, image_bytes: imgTotal, html_bytes: htmlBytes,
    robots_blocked: blocked, errors, truncated: truncated || images.size >= maxImages, ms: Date.now() - t0,
  };
}

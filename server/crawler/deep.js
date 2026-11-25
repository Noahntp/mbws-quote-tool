// "Đếm chính xác": đi hết web mẫu để đếm THẬT số sản phẩm, bài viết và dung lượng ảnh (không mở trình duyệt):
// tải HTML từng trang, theo mọi liên kết / phân trang / sitemap trong cùng web, tôn trọng robots.txt,
// gộp trùng theo đường dẫn chuẩn (canonical), đọc kích thước file ảnh từ máy chủ.
//
// Chạy theo CHẶNG: trạng thái (hàng đợi, đã thấy, đã đếm) lưu được dạng JSON → mỗi chặng vài phút rồi chạy tiếp,
// nên chạy được cả trên Vercel (giới hạn 5 phút / lần) lẫn bộ quét Việt Nam.
import { safeFetchText, safeHeadSize, assertPublicUrl } from './ssrf.js';
import { normalizeUrl, isHtmlCandidate, parseRobots, robotsAllows, classify } from './urls.js';

const UA = 'MBWS-QuoteBot';
export const DEEP_LIMITS = { maxPages: 5000, maxImages: 10000, maxTotalMs: 45 * 60 * 1000, perPathVariants: 400, throttleMs: 1500 };

const decode = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&#0?38;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'");
// tham số chỉ sắp xếp / lọc / thao tác → cùng nội dung với trang gốc (bỏ đi trước khi so trùng)
const FACET = /^(orderby|order|sort|sort_by|dir|view|display|limit|per_page|mode|filter_.*|query_type_.*|attribute_.*|variant|min_price|max_price|rating_filter|add-to-cart|add_to_wishlist|add_to_compare|replytocom|currency|share|print|amp|swoof|attachment_id|preview|ver|v|lang_switch|_pos|_sid|_ss|_psq)$/i;
// đường dẫn không phải nội dung
const SKIP_PATH = /\/(wp-admin|wp-login\.php|wp-json|xmlrpc\.php|feed|trackback|comment-page-\d+|cdn-cgi|amp)(\/|$)|\/wp-content\/|\/embed\/?$/i;
const LANG_TAIL = /^\/.+\/(en|vi|in|tw|cn|zh|jp|ja|ko|kr|fr|de|ru|th|es|it|id|ms|lo|km|print)\/?$/i;
const THIRD_PARTY_IMG = /(google|gstatic|facebook|fbcdn|youtube|ytimg|gravatar|doubleclick|zalo|tiktok|twitter|pinterest|bing|yandex|hotjar|clarity)\./i;
const IMG_EXT = /\.(jpe?g|png|gif|webp|avif|svg|bmp)(\?|$)/i;
// lớp CSS của khối "chi tiết sản phẩm" (web tự viết / theme Việt: ctsp, spct, product-detail, single-product…)
const PRODUCT_DETAIL_CLS = /(^|[-_])(ctsp|spct|spdt|chitietsp|chitietsanpham|chi-tiet-san-pham|chi-tiet-sp|(product|prod|pro|prd|sp)[-_]?(detail|details|single|summary)|(detail|single)[-_]?(product|prod|pro|sp))([-_]|$)/i;
// dấu hiệu ngày đăng: trang chi tiết bài viết có 1–2 dấu, trang danh sách bài có nhiều dấu (mỗi bài một dấu)
const DATE_MARK = /(ngày đăng|ngày cập nhật|đăng ngày|đăng lúc|cập nhật lúc|ngày viết|posted on|published on|itemprop\s*=\s*["']datePublished|<time[^>]*\sdatetime=)/gi;
// trang thông tin cố định — không tính là bài viết dù có ngày đăng
const STATIC_KIND = new Set(['home', 'about', 'contact', 'policy', 'recruit', 'cart', 'account', 'search', 'booking']);

/** Phân tích HTML một trang (hàm thuần, kiểm thử được): loại trang, liên kết, ảnh, đường dẫn chuẩn. */
export function analyzeHtml(html, pageUrl) {
  const h = String(html || '').replace(/<!--[\s\S]*?-->/g, ' '); // phần bị chú thích không hiển thị
  const attr = (tag, name) => { const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')); return m ? decode(m[2] ?? m[3] ?? m[4] ?? '') : null; };
  const tags = (name) => [...h.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'gi'))].map((m) => m[0]);
  // <base href> đổi gốc của mọi đường dẫn tương đối (web PHP cũ hay dùng)
  let baseUrl = pageUrl;
  const baseTag = tags('base')[0];
  if (baseTag) { try { baseUrl = new URL(attr(baseTag, 'href') || '', pageUrl).toString(); } catch { /* giữ địa chỉ trang */ } }
  const abs = (u) => { try { return new URL(u, baseUrl).toString(); } catch { return null; } };
  const links = [];
  for (const t of tags('a')) { const href = attr(t, 'href'); if (href && !/^(#|javascript:|mailto:|tel:|sms:|zalo:)/i.test(href.trim())) { const a = abs(href.trim()); if (a) links.push(a); } }
  const linkTags = tags('link');
  for (const t of linkTags) if (/rel\s*=\s*["']?(next|prev)\b/i.test(t)) { const a = abs(attr(t, 'href') || ''); if (a) links.push(a); }
  // chuyển trang bằng thẻ meta refresh / JavaScript (location.href = "...")
  for (const t of tags('meta')) if (/http-equiv\s*=\s*["']?refresh/i.test(t)) { const m = (attr(t, 'content') || '').match(/url\s*=\s*['"]?([^'";]+)/i); const a = m && abs(m[1].trim()); if (a) links.push(a); }
  for (const m of h.matchAll(/location(?:\.href)?\s*=\s*["']([^"']+)["']/gi)) { const a = abs(m[1]); if (a) links.push(a); }
  const canonTag = linkTags.find((t) => /rel\s*=\s*["']?canonical/i.test(t));
  const canonical = canonTag ? abs(attr(canonTag, 'href') || '') : null;

  // ảnh: src / lazy-load / bản lớn nhất trong srcset / ảnh nền trong style
  const images = new Set();
  const addImg = (u) => { if (!u || /^data:/i.test(u)) return; const a = abs(u.trim()); if (a) images.add(a); };
  const bestOf = (ss) => ss.split(',').map((x) => x.trim().split(/\s+/)).filter((x) => x[0]).sort((a, b) => (parseFloat(b[1]) || 0) - (parseFloat(a[1]) || 0))[0]?.[0];
  for (const t of [...tags('img'), ...tags('source')]) {
    for (const name of ['src', 'data-src', 'data-lazy-src', 'data-original', 'data-lazyload']) { const v = attr(t, name); if (v && (t.startsWith('<img') || IMG_EXT.test(v))) addImg(v); }
    const ss = attr(t, 'srcset') || attr(t, 'data-srcset') || attr(t, 'data-lazy-srcset');
    if (ss) addImg(bestOf(ss));
  }
  for (const m of h.matchAll(/url\(\s*['"]?([^'")]+\.(?:jpe?g|png|gif|webp|avif)(?:\?[^'")]*)?)['"]?\s*\)/gi)) addImg(decode(m[1]));
  // ảnh cỡ lớn mở khi bấm vào (lightbox / thư viện ảnh: <a href="anh-lon.jpg">) và ảnh chia sẻ (og:image)
  // + mọi giá trị thuộc tính là đường dẫn ảnh (data-zoom-image, data-large, data-bg…)
  //   (chỉ ảnh nằm trên chính web mẫu — liên kết tới ảnh / trang ảnh của web khác không phải dung lượng của web này)
  const pageHost = hostOf(pageUrl);
  for (const m of h.matchAll(/\s(?:href|content|data-[\w-]+)\s*=\s*["']([^"'<>\s]+\.(?:jpe?g|png|gif|webp|avif|bmp)(?:\?[^"'<>\s]*)?)["']/gi)) { const a = abs(decode(m[1])); if (a && hostOf(a) === pageHost) images.add(a); }

  const metas = tags('meta');
  const metaProp = (p) => { const t = metas.find((x) => new RegExp(`(property|name)\\s*=\\s*["']${p}["']`, 'i').test(x)); return t ? attr(t, 'content') || '' : ''; };
  const ogType = metaProp('og:type').toLowerCase();
  const published = !!metaProp('article:published_time');
  const ld = [...h.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join(' ');
  const ldTypes = [...ld.matchAll(/"@type"\s*:\s*(?:\[\s*)?"([A-Za-z]+)"/g)].map((m) => m[1]);
  const nLdProduct = ldTypes.filter((t) => t === 'Product').length;
  const ldList = ldTypes.includes('ItemList') || ldTypes.includes('CollectionPage') || nLdProduct > 1;
  const bodyCls = ` ${(h.match(/<body\b[^>]*\sclass\s*=\s*["']([^"']*)/i) || [])[1] || ''} `.toLowerCase();
  const isWp = /\s(postid-\d+|page-id-\d+|wp-theme-[\w-]+|wp-custom-logo)\s/.test(bodyCls) || /\/wp-content\//i.test(h);
  const cls0 = classify(pageUrl); const tpl = cls0.template;
  const body = h.slice(Math.max(0, h.search(/<body/i)));
  const clsTokens = new Set([...body.matchAll(/\sclass\s*=\s*["']([^"']+)/gi)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean));
  const productBlock = [...clsTokens].some((c) => PRODUCT_DETAIL_CLS.test(c));
  const dates = (body.match(DATE_MARK) || []).length;

  let kind = null; let via = null;
  // 1) WordPress / WooCommerce: lớp CSS của thẻ body cho biết chính xác loại trang
  if (/\ssingle-product\s/.test(bodyCls)) { kind = 'product'; via = 'wp'; }
  else if (/\s(single-post|single-format-[\w-]+)\s/.test(bodyCls)) { kind = 'post'; via = 'wp'; }
  else if (isWp && /\s(page-id-\d+|page-template[\w-]*|archive|category|tag|tax-[\w-]+|post-type-archive[\w-]*|blog|search|search-results|woocommerce-shop|error404)\s/.test(bodyCls)) { kind = 'page'; via = 'wp'; }
  else {
    const cpt = bodyCls.match(/\ssingle-(?!format)([a-z0-9_-]+)\s/)?.[1];
    if (cpt && /(product|san-?pham|service|dich-?vu)/.test(cpt)) { kind = 'product'; via = 'wp'; }
    else if (cpt && /(news|tin|post|bai-?viet|blog|article)/.test(cpt)) { kind = 'post'; via = 'wp'; }
  }
  // 2) dữ liệu cấu trúc (schema.org) / Open Graph — Haravan, Shopify, Sapo, Joomla, web tự viết…
  if (!kind) {
    if (/^(product|og:product|product\.item)$/.test(ogType) || (nLdProduct === 1 && !ldList)) { kind = 'product'; via = 'schema'; }
    else if (['Article', 'BlogPosting', 'NewsArticle'].some((t) => ldTypes.includes(t)) || (ogType === 'article' && published)) { kind = 'post'; via = 'schema'; }
  }
  // 3) khối "chi tiết sản phẩm" / dấu ngày đăng (web tự viết, CMS Việt không có dữ liệu cấu trúc)
  const listLike = /(:list|^home$)/.test(tpl) || dates >= 3;
  if (!kind && !STATIC_KIND.has(cls0.kind) && !/(:list|^home$)/.test(tpl) && productBlock) { kind = 'product'; via = 'layout'; }
  if (!kind && !STATIC_KIND.has(cls0.kind) && !listLike && dates >= 1) { kind = 'post'; via = 'date'; }
  // 4) đường dẫn (/san-pham/abc, /tin-tuc/abc, /abc-12-sp.html…)
  if (!kind && !listLike && /^(product|service):detail$/.test(tpl)) { kind = 'product'; via = 'url'; }
  if (!kind && !listLike && tpl === 'blog:detail') { kind = 'post'; via = 'url'; }
  // 5) nút mua + 1–6 giá tiền trên trang (trang chi tiết sản phẩm, không phải danh sách)
  if (!kind && !listLike && !STATIC_KIND.has(cls0.kind)) {
    const text = h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
    const prices = (text.match(/\d{1,3}(?:[.,]\d{3})+\s?(?:₫|đ(?![a-zà-ỹ])|vnđ|vnd|đồng)/gi) || []).length;
    if (/(thêm vào giỏ|add to cart|mua ngay|đặt mua ngay|add_to_cart|single_add_to_cart)/i.test(h) && prices >= 1 && prices <= 6) { kind = 'product'; via = 'cart'; }
  }
  return { kind: kind || 'page', via: via || 'page', canonical, links, images: [...images], bytes: Buffer.byteLength(h) };
}

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

/** Trạng thái ban đầu của một lượt đếm (JSON thuần, lưu vào CSDL được). */
export function initDeepState(startUrl) {
  return { v: 1, input: startUrl, phase: 'init', start: null, origin: null, robots: null, sm_queue: [], sm_idx: 0, sm_urls: 0,
    seen: [], queue: [], variants: {}, products: [], posts: [], images: [], img_extra: 0, via: {},
    pages: 0, html_bytes: 0, errors: 0, robots_blocked: 0, img_idx: 0, img_bytes: 0, img_sized: 0, elapsed_ms: 0, truncated: false, home_links: null,
    delay_ms: 0, retries: {}, rate_limited: 0, limited_failed: 0 };
}

/**
 * Chạy một chặng (tối đa budgetMs) rồi trả về trạng thái mới. state.phase === 'done' là xong.
 * Lỗi không mở được trang chủ → ném lỗi (err.blocked = true nếu web từ chối máy quét).
 */
export async function deepStep(state, { budgetMs = 180000, concurrency = 4, imgConcurrency = 8, limits = DEEP_LIMITS, log = () => {}, onProgress = () => {}, onPage = null,
  fetchText = safeFetchText, headSize = safeHeadSize, checkUrl = assertPublicUrl } = {}) { // 3 hàm cuối: thay được khi kiểm thử
  const t0 = Date.now();
  // phần lớn tổng thời gian cho việc đọc trang, chừa ~20% để đo dung lượng ảnh
  const timeLeft = (share = 1) => Math.min(budgetMs - (Date.now() - t0), limits.maxTotalMs * share - state.elapsed_ms - (Date.now() - t0));
  const S = state;
  S.retries ||= {}; S.delay_ms ||= 0; S.bad_delay ||= 0; S.ok_streak ||= 0; S.rate_limited ||= 0; S.limited_failed ||= 0; // trạng thái lưu từ bản cũ
  const seen = new Set(S.seen); const products = new Set(S.products); const posts = new Set(S.posts); const images = new Set(S.images);
  const progress = () => onProgress({ phase: S.phase, pages: S.pages, queued: S.queue.length, products: products.size, posts: posts.size, images: images.size + S.img_extra, img_done: S.img_idx });
  try {
    if (S.phase === 'init') {
      let start = normalizeUrl(S.input);
      await checkUrl(start);
      let home;
      try { home = await fetchText(start, { userAgent: UA, maxBytes: 3_000_000, timeoutMs: 20000 }); } catch (e) {
        const code = String(e?.cause?.code || e?.code || e?.message || '');
        if (!/CERT|SSL|TLS/i.test(code)) throw Object.assign(new Error(`Không tải được trang chủ: ${e.message}`), { blocked: /ECONNRESET|ETIMEDOUT|abort/i.test(code) });
        // chứng chỉ SSL chỉ cấp cho dạng có / không có www → thử dạng còn lại
        const alt = new URL(start); alt.hostname = alt.hostname.startsWith('www.') ? alt.hostname.slice(4) : 'www.' + alt.hostname;
        start = alt.toString();
        home = await fetchText(start, { userAgent: UA, maxBytes: 3_000_000, timeoutMs: 20000 }).catch((e2) => { throw new Error(`Chứng chỉ SSL của web mẫu bị lỗi (${code.match(/[A-Z_]{6,}/)?.[0] || 'SSL'}) — không đọc được trang: ${e2.message}`); });
      }
      if ([401, 403, 429, 503].includes(home.status)) throw Object.assign(new Error(`Web mẫu từ chối máy quét (HTTP ${home.status})`), { blocked: true });
      if (home.status >= 400) throw new Error(`Trang chủ trả lỗi HTTP ${home.status}`);
      const fin = new URL(home.url); // theo chuyển hướng (http → https, có / không www)
      if (hostOf(fin.href) !== hostOf(start)) throw new Error(`Trang chủ chuyển sang tên miền khác (${fin.hostname}) — nhập địa chỉ đó để đếm`);
      S.start = start; S.origin = fin.origin;
      try { const r = await fetchText(`${S.origin}/robots.txt`, { userAgent: UA, timeoutMs: 10000 }); if (r.status === 200 && !/<html/i.test(r.text)) S.robots = parseRobots(r.text, UA); } catch { /* không có robots.txt */ }
      const smAbs = (x) => { try { return new URL(x, S.origin + '/').toString(); } catch { return null; } }; // "Sitemap: /sitemap.xml" (tương đối)
      S.sm_queue = (S.robots?.sitemaps || []).map(smAbs).filter(Boolean);
      if (!S.sm_queue.length) S.sm_queue = [`${S.origin}/sitemap.xml`, `${S.origin}/sitemap_index.xml`, `${S.origin}/wp-sitemap.xml`];
      S.phase = 'sitemap';
      log('bắt đầu', S.origin, S.robots ? `robots: ${S.robots.rules.length} quy tắc` : 'không có robots.txt');
    }

    // URL → địa chỉ tải (cùng giao thức / tên miền với trang chủ, bỏ tham số sắp xếp / lọc) + khóa so trùng
    const origin = S.origin ? new URL(S.origin) : null; const host = origin ? hostOf(origin.href) : '';
    const prep = (raw) => {
      const n = normalizeUrl(raw); if (!n || hostOf(n) !== host || !isHtmlCandidate(n)) return null;
      const u = new URL(n); u.protocol = origin.protocol; u.hostname = origin.hostname; u.port = origin.port;
      for (const k of [...u.searchParams.keys()]) if (FACET.test(k)) u.searchParams.delete(k);
      if (SKIP_PATH.test(u.pathname)) return null;
      if (LANG_TAIL.test(u.pathname)) return null; // /abc/en, /abc/tw… = bản ngôn ngữ / bản in của cùng trang
      const c = classify(u.toString()).kind;
      if (['junk', 'cart', 'account', 'search'].includes(c)) return null;
      const key = (u.pathname.length > 1 ? u.pathname.replace(/\/+$/, '') : '/') + (u.search || '');
      return { url: u.toString(), key, path: u.pathname };
    };
    const push = (raw) => {
      const p = prep(raw); if (!p || seen.has(p.key)) return;
      if (p.key.includes('?')) { const v = (S.variants[p.path] || 0) + 1; if (v > limits.perPathVariants) return; S.variants[p.path] = v; } // tránh vô hạn biến thể ?…
      seen.add(p.key);
      if (S.robots && !robotsAllows(S.robots, p.url)) { S.robots_blocked++; return; }
      S.queue.push(p.url);
    };
    const idOf = (url, canonical) => { const c = canonical && hostOf(canonical) === host ? prep(canonical) : null; return (c || prep(url))?.key || url; };
    // Web giới hạn tốc độ (HTTP 429 / 503): giãn nhịp MỌI yêu cầu (theo Retry-After nếu có), xếp trang vào hàng thử lại sau.
    // Không làm vậy thì trang bị từ chối bị bỏ qua và số đếm thiếu mà không ai biết.
    const base = limits.throttleMs ?? 1500;
    let nextAt = 0; let lastRaise = 0;
    const pace = async () => {
      if (!S.delay_ms) return;
      const wait = Math.max(0, nextAt - Date.now());
      nextAt = Math.max(Date.now(), nextAt) + S.delay_ms;
      if (wait) await new Promise((r) => setTimeout(r, wait));
    };
    const throttled = (url, retryAfter) => {
      S.rate_limited++;
      const ra = Number(retryAfter) > 0 ? Number(retryAfter) * 1000 : 0;
      S.ok_streak = 0;
      // nhiều yêu cầu đang chạy cùng bị từ chối = MỘT đợt → chỉ tăng nhịp chờ một lần mỗi đợt (không nhân đôi liên tục tới 30 giây);
      // nhớ nhịp vừa bị từ chối để về sau không nới xuống dưới mức đó
      if (Date.now() - lastRaise > Math.max(S.delay_ms, 1000)) {
        S.bad_delay = Math.max(S.bad_delay, S.delay_ms);
        S.delay_ms = Math.min(30000, Math.max(ra, S.delay_ms ? S.delay_ms * 2 : base));
        lastRaise = Date.now();
      }
      nextAt = Math.max(nextAt, Date.now() + Math.max(ra, S.delay_ms));
      // bị từ chối do tốc độ chung, không phải lỗi của riêng trang này → cho thử lại nhiều lần
      const n = (S.retries[url] || 0) + 1; S.retries[url] = n;
      if (n <= 8) S.queue.push(url); else S.limited_failed++;
      log('web giới hạn tốc độ (HTTP 429/503) — giãn nhịp', S.delay_ms, 'ms');
    };
    // tải được trang → nới chậm (10% sau mỗi 10 trang liền thành công), không thấp hơn nhịp từng bị từ chối, không dưới 1/3 mức cơ sở
    const eased = () => {
      if (!S.delay_ms || ++S.ok_streak < 10) return;
      S.ok_streak = 0;
      S.delay_ms = Math.max(Math.round(base / 3), Math.round(S.bad_delay * 1.2), Math.round(S.delay_ms * 0.9));
    };

    if (S.phase === 'sitemap') {
      if (!seen.size) push(S.start);
      // mọi sitemap con (tối đa 300 tệp)
      for (; S.sm_idx < S.sm_queue.length && S.sm_idx < 300; S.sm_idx++) {
        if (timeLeft(0.8) < 30000) break;
        const raw = S.sm_queue[S.sm_idx];
        if (hostOf(raw) !== host) continue;
        const sm = new URL(raw); sm.protocol = origin.protocol; sm.hostname = origin.hostname;
        const r = await fetchText(sm.toString(), { userAgent: UA, maxBytes: 15_000_000, timeoutMs: 20000 }).catch(() => null);
        if (!r || r.status !== 200 || !/<(urlset|sitemapindex)/i.test(r.text)) continue;
        const locs = [...r.text.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/gi)].map((m) => decode(m[1].trim()));
        if (/<sitemapindex/i.test(r.text)) { for (const l of locs) if (!S.sm_queue.includes(l)) S.sm_queue.push(l); } else { S.sm_urls += locs.length; locs.forEach(push); }
      }
      if (S.sm_idx < S.sm_queue.length && S.sm_idx < 300 && timeLeft(0.8) > 0 && budgetMs - (Date.now() - t0) < 30000) return S; // hết chặng → chặng sau đọc tiếp sitemap
      S.phase = 'crawl';
      log('sitemap:', S.sm_urls, 'URL; hàng đợi', S.queue.length);
    }

    if (S.phase === 'crawl') {
      let lastBeat = 0; let active = 0; let stop = false;
      const worker = async () => {
        for (;;) {
          if (S.pages >= limits.maxPages) { S.truncated = true; stop = true; }
          if (timeLeft(0.8) < 20000) stop = true;
          if (stop) return;
          if (!S.queue.length) { if (!active) return; await new Promise((r) => setTimeout(r, 50)); continue; } // trang khác đang tải có thể thêm liên kết mới
          const url = S.queue.shift(); active++;
          try { await pace(); await visit(url); } finally { active--; }
        }
      };
      const visit = async (url) => {
        let r;
        try { r = await fetchText(url, { userAgent: UA, maxBytes: 3_000_000, timeoutMs: 15000, htmlOnly: true }); } catch { S.errors++; return; }
        if (r.status === 429 || r.status === 503) { throttled(url, r.retry_after); return; }
        eased();
        if (r.status !== 200) { if (r.status >= 400) S.errors++; return; }
        if (!r.text || (r.type && !/html/i.test(r.type))) return;
        if (hostOf(r.url) !== host) return; // chuyển hướng ra ngoài
        if (/\/(404|not-?found|error-?404)(\.(php|html?|aspx?))?\/?$/i.test(new URL(r.url).pathname)) return; // trang 404 "giả"
        const a = analyzeHtml(r.text, r.url);
        if (S.pages === 0) S.home_links = a.links.filter((l) => hostOf(l) === host).length;
        S.pages++; S.html_bytes += r.bytes || 0;
        const id = idOf(r.url, a.canonical);
        if (onPage) onPage(r.url, a, id);
        if (a.kind === 'product') products.add(id); else if (a.kind === 'post') posts.add(id);
        if (a.kind !== 'page') S.via[a.via] = (S.via[a.via] || 0) + 1;
        for (const im of a.images) {
          if (images.has(im)) continue;
          const iu = new URL(im);
          if (hostOf(im) !== host && (THIRD_PARTY_IMG.test(iu.hostname) || !IMG_EXT.test(iu.pathname))) continue; // ảnh dịch vụ ngoài (Google, Facebook…)
          if (images.size < limits.maxImages) images.add(im); else S.img_extra++;
        }
        a.links.forEach(push);
        if (Date.now() - lastBeat > 3000) { lastBeat = Date.now(); progress(); }
      };
      await Promise.all(Array.from({ length: concurrency }, worker));
      const totalOut = limits.maxTotalMs * 0.8 - (S.elapsed_ms + Date.now() - t0) < 20000;
      if (S.queue.length && !S.truncated && !totalOut) return S; // hết thời gian chặng này → chặng sau đọc tiếp
      if (S.queue.length) { S.truncated = true; S.queue = []; }
      S.phase = 'images';
      log('đã đọc', S.pages, 'trang:', products.size, 'sản phẩm,', posts.size, 'bài viết,', images.size, 'ảnh');
    }

    if (S.phase === 'images') {
      // đọc kích thước file ảnh từ máy chủ (không tải ảnh về)
      const list = [...images]; let lastBeat = 0;
      const worker = async () => {
        while (S.img_idx < list.length && timeLeft() > 10000) {
          const u = list[S.img_idx++];
          await pace();
          const n = await headSize(u, { userAgent: UA }).catch(() => null);
          if (n > 0) { S.img_bytes += n; S.img_sized++; } else if (n === 0) S.img_missing = (S.img_missing || 0) + 1;
          if (Date.now() - lastBeat > 3000) { lastBeat = Date.now(); progress(); }
        }
      };
      await Promise.all(Array.from({ length: imgConcurrency }, worker));
      if (S.img_idx >= list.length) S.phase = 'done';
    }
    return S;
  } finally {
    S.seen = [...seen]; S.products = [...products]; S.posts = [...posts]; S.images = [...images];
    S.elapsed_ms += Date.now() - t0;
    if (S.phase !== 'done' && S.phase !== 'init' && S.elapsed_ms >= limits.maxTotalMs) { S.truncated = true; S.queue = []; S.phase = 'done'; } // quá tổng thời gian: dừng, ảnh chưa đo tính theo cỡ trung bình
    progress();
  }
}

/** Kết quả gọn để lưu / hiển thị. Ảnh không đọc được kích thước tính theo cỡ trung bình của ảnh đọc được. */
export function deepSummary(S) {
  // ảnh hỏng (404) không tính; ảnh chưa đọc được (bị chặn, quá thời gian, vượt giới hạn) tính theo cỡ trung bình
  const missing = S.img_missing || 0;
  const imgCount = S.images.length + S.img_extra - missing;
  const avg = S.img_sized ? S.img_bytes / S.img_sized : 0;
  const imageBytes = Math.round(S.img_bytes + avg * Math.max(0, imgCount - S.img_sized));
  return {
    url: S.origin ? S.origin + '/' : S.input, pages: S.pages, products: S.products.length, posts: S.posts.length,
    images: imgCount, images_sized: S.img_sized, images_missing: missing, image_bytes: imageBytes, html_bytes: S.html_bytes,
    sitemap_urls: S.sm_urls, robots_blocked: S.robots_blocked, errors: S.errors, via: S.via,
    rate_limited: S.rate_limited || 0, limited_failed: S.limited_failed || 0,
    // thiếu nhiều trang (web giới hạn tốc độ / lỗi) → số đếm có thể THIẾU, không tự điền vào báo giá
    incomplete: (S.limited_failed || 0) >= Math.max(3, S.pages * 0.05) || (S.errors || 0) > Math.max(10, S.pages * 0.2),
    truncated: !!S.truncated, js_only: S.pages <= 2 && (S.home_links ?? 0) < 5 && !S.sm_urls, minutes: Math.round(S.elapsed_ms / 6000) / 10,
  };
}

/** Đếm cả web trong một lần gọi (dùng cho thử nghiệm / chạy tay). */
export async function deepCount(startUrl, opts = {}) {
  const S = initDeepState(startUrl);
  while (S.phase !== 'done') await deepStep(S, { ...opts, budgetMs: opts.budgetMs ?? 10 * 60 * 1000 });
  return deepSummary(S);
}

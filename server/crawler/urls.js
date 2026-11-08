// Chuẩn hóa URL, loại trùng, nhóm theo mẫu trang, chọn mẫu đại diện. Thuần, không I/O.

const TRACKING = /^(utm_|fbclid$|gclid$|gbraid$|wbraid$|_ga$|_gl$|mc_|ref$|srsltid$|zarsrc$|yclid$)/i;
const SKIP_EXT = /\.(jpe?g|png|gif|webp|svg|ico|bmp|pdf|zip|rar|7z|docx?|xlsx?|pptx?|mp4|mp3|webm|avi|mov|css|js|json|woff2?|ttf|eot|xml|txt|rss|atom)$/i;
const PAGINATION_PARAMS = /^(page|paged|p|pg|trang|offset|start|sort|orderby|order|limit|view|display)$/i;

export function normalizeUrl(raw, base) {
  let u;
  try { u = new URL(String(raw).trim(), base); } catch { return null; }
  if (!['http:', 'https:'].includes(u.protocol)) return null;
  u.hash = '';
  u.username = ''; u.password = '';
  u.hostname = u.hostname.toLowerCase();
  if ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) u.port = '';
  const params = [...u.searchParams.entries()].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => a.localeCompare(b));
  u.search = params.length ? '?' + new URLSearchParams(params).toString() : '';
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.replace(/\/+$/, '');
  return u.toString();
}

export function normalizeInput(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  return normalizeUrl(s);
}

export function isHtmlCandidate(url) {
  try { return !SKIP_EXT.test(new URL(url).pathname); } catch { return false; }
}

/** Host gốc và biến thể www được coi là cùng phạm vi khảo sát. */
export function sameSite(url, rootHost) {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    return h === rootHost.replace(/^www\./, '');
  } catch { return false; }
}

/** Khóa loại trùng: bỏ tham số phân trang/sắp xếp và /page/N để tránh vòng lặp. */
export function dedupeKey(url) {
  const u = new URL(url);
  const params = [...u.searchParams.entries()].filter(([k]) => !PAGINATION_PARAMS.test(k));
  u.search = params.length ? '?' + new URLSearchParams(params).toString() : '';
  u.pathname = u.pathname.replace(/\/page\/\d+$/i, '').replace(/\/trang-\d+$/i, '') || '/';
  return u.toString();
}

const KINDS = [
  ['cart', /(^|\/)(gio-hang|cart|checkout|thanh-toan|dat-hang)(\/|$|\.)/i],
  ['account', /(^|\/)(dang-nhap|dang-ky|login|register|account|tai-khoan|my-account|signin|signup)(\/|$|\.)/i],
  ['search', /(^|\/)(tim-kiem|search)(\/|$|\.)/i],
  ['contact', /(^|\/)(lien-he|contact|contact-us)(\/|$|\.)/i],
  ['about', /(^|\/)(gioi-thieu|about|about-us|ve-chung-toi)(\/|$|\.)/i],
  ['policy', /(^|\/)(chinh-sach|policy|policies|dieu-khoan|terms|privacy|faq|huong-dan)[^/]*(\/|$|\.)/i],
  ['recruit', /(^|\/)(tuyen-dung|career|careers|jobs)(\/|$|\.)/i],
  ['blog', /(^|\/)(tin-tuc|blog|blogs|news|bai-viet|kien-thuc|cam-nang|article|articles|post)(\/|$|\.)/i],
  ['product', /(^|\/)(san-pham|product|products|shop|cua-hang|collections|danh-muc|category|product-category)(\/|$|\.)/i],
  ['service', /(^|\/)(dich-vu|service|services|giai-phap|solutions?)(\/|$|\.)/i],
  ['project', /(^|\/)(du-an|projects?|portfolio|thu-vien|gallery)(\/|$|\.)/i],
  ['booking', /(^|\/)(dat-lich|booking|dat-ban|dat-phong|reservation)(\/|$|\.)/i],
];

/** Phân loại mẫu trang theo đường dẫn. Trả về {kind, template}. */
export function classify(url) {
  const u = new URL(url);
  const path = u.pathname.replace(/\/page\/\d+$/i, '') || '/';
  if (path === '/' || /^\/(index\.(html?|php))?$/i.test(path) || /^\/[a-z]{2}(-[a-z]{2})?\/?$/i.test(path)) return { kind: 'home', template: 'home' };
  if (u.searchParams.has('s') || u.searchParams.has('q') || u.searchParams.has('keyword')) return { kind: 'search', template: 'search' };
  const segs = path.split('/').filter(Boolean);
  for (const [kind, re] of KINDS) {
    if (re.test(path)) {
      if (['blog', 'product', 'service', 'project'].includes(kind)) {
        // /san-pham → list ; /san-pham/abc → detail ; /danh-muc/abc → list
        const idx = segs.findIndex((s) => re.test('/' + s + '/'));
        const rest = segs.length - 1 - idx;
        const isCategory = /danh-muc|category|collections|product-category/i.test(path) && rest <= 1;
        return { kind, template: `${kind}:${rest <= 0 || isCategory ? 'list' : 'detail'}` };
      }
      return { kind, template: kind };
    }
  }
  // URL phẳng (ví dụ /gao-st25.html hoặc /abc) — nhóm theo độ sâu + đuôi
  const ext = /\.html?$/i.test(path) ? ':html' : '';
  return { kind: 'other', template: `other:d${segs.length}${ext}` };
}

export function groupTemplates(urls) {
  const groups = new Map();
  for (const url of urls) {
    const c = classify(url);
    if (!groups.has(c.template)) groups.set(c.template, { template: c.template, kind: c.kind, urls: [] });
    groups.get(c.template).urls.push(url);
  }
  return [...groups.values()];
}

const PRIORITY = ['home', 'product:list', 'product:detail', 'blog:list', 'blog:detail', 'service:list', 'service:detail', 'project:list', 'project:detail', 'contact', 'about', 'cart', 'booking', 'account', 'search', 'recruit', 'policy'];

/** Chọn mẫu đại diện: mỗi nhóm lấy URL ngắn nhất & dài nhất (ít/nhiều nội dung khác nhau), tổng ≤ max. */
export function sampleUrls(groups, max = 20, perGroup = 2) {
  const ordered = [...groups].sort((a, b) => rank(a.template) - rank(b.template) || b.urls.length - a.urls.length);
  const picked = [];
  // vòng 1: mỗi nhóm 1 URL để phủ nhiều nhóm nhất
  for (const g of ordered) { if (picked.length >= max) break; const s = [...g.urls].sort((a, b) => a.length - b.length); picked.push({ url: s[0], template: g.template, kind: g.kind }); }
  // vòng 2: thêm mẫu thứ hai cho nhóm có nhiều URL
  for (let k = 1; k < perGroup; k++) {
    for (const g of ordered) {
      if (picked.length >= max) break;
      if (g.urls.length <= k) continue;
      const s = [...g.urls].sort((a, b) => a.length - b.length);
      const u = s[s.length - k];
      if (!picked.some((p) => p.url === u)) picked.push({ url: u, template: g.template, kind: g.kind });
    }
  }
  return picked;
}
function rank(t) { const i = PRIORITY.indexOf(t); return i === -1 ? 100 : i; }

// ---------- robots.txt (RFC 9309, phần cơ bản) ----------
export function parseRobots(text, agent = 'mbws-quotebot') {
  const groups = []; let cur = null; let lastWasAgent = false;
  const sitemaps = [];
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase(); const val = m[2].trim();
    if (key === 'sitemap') { sitemaps.push(val); continue; }
    if (key === 'user-agent') {
      if (!lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase()); lastWasAgent = true; continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (key === 'allow' || key === 'disallow') cur.rules.push({ allow: key === 'allow', path: val });
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== '*' && agent.toLowerCase().includes(a)));
  const chosen = mine.length ? mine : groups.filter((g) => g.agents.includes('*'));
  const rules = chosen.flatMap((g) => g.rules).filter((r) => r.path !== '' || r.allow);
  return { rules, sitemaps };
}

export function robotsAllows(robots, url) {
  if (!robots) return true;
  const u = new URL(url);
  const target = u.pathname + u.search;
  let best = null;
  for (const r of robots.rules) {
    if (!r.path) continue;
    const re = new RegExp('^' + r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
    if (re.test(target) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r;
  }
  return best ? best.allow : true;
}

/**
 * Người dùng chỉ cần gõ tên miền. Nhận "abc.vn", "www.abc.vn", "https://abc.vn/trang-bat-ky"
 * → trả về trang chủ "https://abc.vn/" (hoặc "https://www.abc.vn/"). Không phải tên miền → null.
 */
export function normalizeDomain(raw) {
  let s = String(raw || '').trim().replace(/\s+/g, '');
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
  let u;
  try { u = new URL(s); } catch { return null; }
  if (!['http:', 'https:'].includes(u.protocol)) return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  const labels = host.split('.');
  const valid = host.length <= 253 && labels.length >= 2 && labels.every((l) => /^[a-z0-9-]{1,63}$/.test(l) && !l.startsWith('-') && !l.endsWith('-'))
    && /^(xn--[a-z0-9-]+|[a-z]{2,63})$/.test(labels[labels.length - 1]); // đuôi tên miền là chữ (không nhận địa chỉ IP)
  if (!valid) return null;
  return `${u.protocol}//${host}${u.port ? ':' + u.port : ''}/`;
}
export const domainOf = (url) => new URL(url).hostname.replace(/^www\./, '');

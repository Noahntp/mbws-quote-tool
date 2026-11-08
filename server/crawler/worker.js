// Worker khảo sát website tham khảo.
//  - Máy local: chạy như TIẾN TRÌNH CON riêng (cô lập, không mang khóa/secret): node worker.js <config.json>
//    → ghi kết quả (manifest dẫn chứng) ra config.outFile.
//  - Serverless (Vercel): gọi trực tiếp runSurvey(cfg) trong hàm — mỗi lần gọi hàm đã là một môi trường cô lập.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { launchChromium, devicesPreset, IS_SERVERLESS } from './browser.js';
import { normalizeInput, normalizeUrl, isHtmlCandidate, sameSite, dedupeKey, groupTemplates, sampleUrls, parseRobots, robotsAllows, classify } from './urls.js';
import { assertPublicUrl, assertPublicHost, safeFetchText } from './ssrf.js';
import { detectInPage } from './detect.js';
import { layoutSignatureInPage, clusterLayouts } from './layout.js';

export const CRAWLER_VERSION = 'mbws-crawler/0.1 (playwright 1.56)';
const UA_TOKEN = 'MBWS-QuoteBot';
const USER_AGENT_SUFFIX = ` ${UA_TOKEN}/0.1 (+khao sat bao gia noi bo)`;

/** Quét một web mẫu. Trả về manifest dẫn chứng; ảnh chụp ghi vào cfg.assetDir. */

// ---------- Nhận diện trang chặn bot (CAPTCHA / tường lửa chống bot) ----------
// Web lớn (alibaba, shopee...) thường trả trang này cho IP máy chủ đám mây. Không vượt qua — chỉ báo rõ.
const WALL_URL = /_____tmd_____|\/punish\b|captcha|\/cdn-cgi\/challenge|__cf_chl|validate\.perfdrive|\/sorry\/index|\/verify\/(traffic|captcha|human)|\/(anti-?bot|bot-?check)\b/i;
// Script nặng của bên thứ ba (quảng cáo, đo lường, chat, video nhúng): chặn khi quét chế độ nhẹ — bộ nhận diện chỉ đọc thẻ HTML nên không ảnh hưởng
const HEAVY_3P = /(^|\.)(googletagmanager\.com|google-analytics\.com|doubleclick\.net|googlesyndication\.com|googleadservices\.com|facebook\.net|hotjar\.com|clarity\.ms|analytics\.tiktok\.com|criteo\.(com|net)|adnxs\.com|taboola\.com|outbrain\.com|subiz\.(com|xyz)|tawk\.to|crisp\.chat|intercom(cdn)?\.io|zopim\.com|onesignal\.com|youtube\.com|ytimg\.com|vimeo\.com)$/i;
const WALL_TITLE = /captcha|just a moment|attention required|access denied|are you a robot|security check|interception|verif(y|ying) you are human|robot check|request blocked|bị chặn|xác minh/i;
const WALL_TEXT = /captcha|verify you are human|are you a robot|unusual traffic|slide to verify|press (&|and) hold|access denied|request (was )?blocked|checking your browser|enable javascript and cookies to continue|xác minh bạn không phải|lưu lượng truy cập bất thường/i;
// Dấu hiệu DOM đặc trưng của trang chặn (không tính reCAPTCHA trong form liên hệ thông thường)
const WALL_MARKER_JS = () => !!document.querySelector('#px-captcha, #challenge-form, .cf-challenge, #cf-challenge-running, [id^="nc_1_"], .nc-container, #nocaptcha, iframe[src*="captcha-delivery"], iframe[src*="/punish"], #baxia-punish');
export function botWall({ url = '', title = '', text = '', marker = false }) {
  const len = text.length;
  if (WALL_URL.test(url)) return 'chuyển tới trang xác minh';
  if (marker && len < 5000) return 'CAPTCHA chống bot';
  if (WALL_TITLE.test(title) && len < 5000) return `trang "${title.slice(0, 40)}"`;
  if (WALL_TEXT.test(text) && len < 3000) return 'yêu cầu xác minh không phải robot';
  return null;
}

export async function runSurvey(cfg, opts = {}) {
const MAX_URLS = Math.min(Math.max(Number(cfg.maxUrls) || 20, 1), 40);
const SHOT_MAX_H = Math.min(Math.max(Number(cfg.shotMaxHeight) || 6000, 900), 8000);
const BUDGET_MS = Math.min(Number(cfg.budgetMs) || 240000, 600000);
// Chế độ nhẹ (Vercel/Lambda: Chromium một tiến trình, ít bộ nhớ): không tải ảnh/phông, cuộn ít, bỏ ảnh mobile
const LIGHT = cfg.light ?? IS_SERVERLESS;
const MAX_REQUESTS = 4000;
const started = Date.now();
const timeLeft = () => BUDGET_MS - (Date.now() - started);

const result = {
  crawler_version: CRAWLER_VERSION, input: cfg.url, started_at: new Date().toISOString(),
  robots: { status: 'unknown' }, sitemap: { status: 'unknown', urls: 0 },
  discovered: [], templates: [], pages: [], errors: [], blocked_requests: 0, generator: null,
};

opts.onResult?.(result); // cho phép bên gọi lấy kết quả dở dang khi hết giờ
const log = opts.log || ((...a) => process.stderr.write(`[crawler +${Math.round((Date.now() - started) / 1000)}s] ${a.join(' ')}\n`));
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const finish = (ok, fatal) => {
  result.ok = ok; if (fatal) result.fatal = fatal;
  result.finished_at = new Date().toISOString();
  return result;
};
fs.mkdirSync(cfg.assetDir, { recursive: true });

  const start = normalizeInput(cfg.url);
  if (!start) return finish(false, 'URL không hợp lệ');
  try { await assertPublicUrl(start); } catch (e) { return finish(false, e.message); }
  const root = new URL(start);
  const rootHost = root.hostname;

  // robots.txt — chỉ dẫn cho crawler, không phải giấy phép truy cập
  let robots = null;
  try {
    const r = await safeFetchText(`${root.origin}/robots.txt`, { userAgent: UA_TOKEN });
    if (r.status === 200) { robots = parseRobots(r.text, UA_TOKEN); result.robots = { status: 'found', rules: robots.rules.length, sitemaps: robots.sitemaps }; }
    else result.robots = { status: r.status >= 500 ? 'server_error' : 'not_found', http: r.status };
  } catch (e) { result.robots = { status: 'error', error: e.message }; }
  if (result.robots.status === 'server_error') return finish(false, 'robots.txt trả lỗi 5xx — theo RFC 9309 tạm coi như cấm toàn bộ; thử lại sau.');

  const discovered = new Map(); // dedupeKey → url
  const addUrl = (raw, base) => {
    const u = normalizeUrl(raw, base);
    if (!u || !sameSite(u, rootHost) || !isHtmlCandidate(u)) return;
    if (!robotsAllows(robots, u)) { result.robots.disallowed = (result.robots.disallowed || 0) + 1; return; }
    const k = dedupeKey(u);
    const key = k.replace(/^(https?:\/\/)www\./, '$1'); // www.x.vn và x.vn là một trang
    if (!discovered.has(key) && discovered.size < 5000) discovered.set(key, k);
    return discovered.get(key);
  };
  const sitemapOf = new Map(); // URL → tên file sitemap chứa nó

  log('robots', result.robots.status);
  // sitemap
  try {
    const candidates = robots?.sitemaps?.length ? robots.sitemaps.slice(0, 3) : [`${root.origin}/sitemap.xml`, `${root.origin}/sitemap_index.xml`];
    let fetched = 0; const queue = [...candidates];
    let childSitemaps = 0; let urlsetCount = 0; let urlsetLocs = 0; // để ước lượng quy mô thật
    while (queue.length && fetched < 8 && timeLeft() > 60000) {
      const sm = queue.shift();
      if (!sameSite(sm, rootHost)) continue;
      const r = await safeFetchText(sm, { userAgent: UA_TOKEN, maxBytes: 5_000_000 }).catch(() => null);
      fetched++;
      if (!r || r.status !== 200 || !/<(urlset|sitemapindex)/i.test(r.text)) continue;
      const locs = [...r.text.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/gi)].map((m) => m[1].trim());
      if (/<sitemapindex/i.test(r.text)) { childSitemaps += locs.length; queue.push(...locs.slice(0, 6)); }
      else {
        urlsetCount++; urlsetLocs += locs.length;
        const name = sm.split('/').pop().toLowerCase(); locs.forEach((l) => { const k = addUrl(l); if (k) sitemapOf.set(k, name); });
      }
      result.sitemap = { ...result.sitemap, status: 'found', urls: discovered.size };
    }
    if (result.sitemap.status !== 'found') result.sitemap = { status: 'not_found', urls: 0 };
    // Sitemap chính liệt kê N sitemap con mà mới đọc được vài cái → ước lượng tổng URL = N × trung bình URL/sitemap con
    if (childSitemaps > urlsetCount && urlsetCount) result.sitemap.estimated_urls = Math.min(5_000_000, Math.round((urlsetLocs / urlsetCount) * childSitemaps));
    result.sitemap.child_sitemaps = childSitemaps;
  } catch (e) { result.sitemap = { status: 'error', error: e.message }; }

  log('sitemap', result.sitemap.status, discovered.size);
  let browser = await launchChromium();
  let requestCount = 0;
  const guard = async (route) => {
    const req = route.request();
    let u; try { u = new URL(req.url()); } catch { return route.abort(); }
    if (u.protocol === 'data:' || u.protocol === 'blob:') return route.continue();
    if (!['http:', 'https:'].includes(u.protocol)) return route.abort('blockedbyclient');
    // không gửi form / ghi dữ liệu
    if (!['GET', 'HEAD'].includes(req.method())) { result.blocked_requests++; return route.abort('blockedbyclient'); }
    if (++requestCount > MAX_REQUESTS) return route.abort('blockedbyclient');
    // điều hướng khung chính chỉ trong host được duyệt
    if (req.isNavigationRequest() && req.frame().parentFrame() === null && !sameSite(req.url(), rootHost)) { result.blocked_requests++; return route.abort('blockedbyclient'); }
    try { await assertPublicHost(u.hostname); } catch { result.blocked_requests++; return route.abort('blockedbyclient'); }
    if (req.resourceType() === 'media' || (LIGHT && (req.resourceType() === 'image' || req.resourceType() === 'font'))) return route.abort();
    if (LIGHT && HEAVY_3P.test(u.hostname) && !sameSite(req.url(), rootHost)) return route.abort();
    return route.continue();
  };
  const mkContext = async (opts) => {
    const ua = (opts.userAgent || `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version()} Safari/537.36`);
    const ctx = await browser.newContext({ ...opts, javaScriptEnabled: !staticMode, userAgent: ua + USER_AGENT_SUFFIX, acceptDownloads: false, serviceWorkers: 'block', locale: 'vi-VN' });
    await ctx.route('**/*', guard);
    return ctx;
  };
  let desktop; let mobile; let staticMode = false; // staticMode: chỉ đọc HTML máy chủ trả về (không chạy JavaScript)
  const openContexts = async () => {
    desktop = await mkContext({ viewport: { width: 1366, height: 900 } });
    mobile = LIGHT ? null : await mkContext({ ...(await devicesPreset('iPhone 13')) });
  };
  await openContexts();
  // Trình duyệt sập (trang quá nặng) → mở lại để quét tiếp
  const ensureBrowser = async () => {
    if (browser.isConnected()) return;
    log('mở lại trình duyệt sau khi sập');
    await browser.close().catch(() => {});
    browser = await launchChromium();
    await openContexts();
  };
  const CRASH = /Target page, context or browser has been closed|Target closed|browser has disconnected|has crashed|Page crashed/i;

  const visited = new Set();
  let shot = 0;
  async function visit(url, template, kind, retry = true) {
    const vkey = url.replace(/^(https?:\/\/)www\./, '$1');
    if (visited.has(vkey) || timeLeft() < 15000) return null;
    visited.add(vkey);
    log('visit', url);
    const page = { url, template, kind, captured_at: new Date().toISOString(), features: [] };
    await ensureBrowser();
    const p = await desktop.newPage();
    try {
      const resp = await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
      page.status = resp?.status() ?? null;
      if (page.status >= 400) throw new Error(`HTTP ${page.status}`);
      await p.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
      await p.evaluate(async (maxSteps) => {
        const step = Math.max(400, window.innerHeight * 0.9);
        for (let y = 0, i = 0; y < document.documentElement.scrollHeight && i < maxSteps; y += step, i++) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 200)); }
        window.scrollTo(0, 0);
      }, LIGHT ? 5 : 14).catch(() => {});
      await p.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
      await p.waitForTimeout(800);
      const finalUrl = p.url();
      if (!sameSite(finalUrl, rootHost)) throw new Error(`Chuyển hướng ra ngoài phạm vi: ${finalUrl}`);
      page.final_url = finalUrl;
      const text = (await p.evaluate(() => document.body?.innerText || '')).toLowerCase();
      const wall = botWall({ url: finalUrl, title: await p.title().catch(() => ''), text, marker: await p.evaluate(WALL_MARKER_JS).catch(() => false) });
      if (wall) {
        page.blocked = wall;
        page.features.push({ feature: null, detail: `Trang chặn máy quét (${wall}) — không vượt qua`, verification: 'unverified' });
      }
      const d = await p.evaluate(detectInPage);
      page.title = d.title; page.lang = d.lang; page.text_excerpt = d.text_excerpt; page.price_count = d.price_count; page.page_kind = d.page_kind; page.metrics = d.metrics;
      page.layout = await p.evaluate(layoutSignatureInPage).catch(() => null);
      if (!page.blocked) page.features = d.features;
      if (d.generator && !result.generator) result.generator = d.generator;
      page.links_count = d.links.length;
      d.links.forEach((h) => addUrl(h, finalUrl));
      // ảnh desktop (toàn trang, giới hạn chiều cao) + mobile
      const n = String(++shot).padStart(3, '0');
      const dFile = path.join(cfg.assetDir, `${n}-desktop.jpg`);
      const height = await p.evaluate((maxH) => Math.min(document.documentElement.scrollHeight, maxH), SHOT_MAX_H);
      const bufD = await p.screenshot({ type: 'jpeg', quality: 55, clip: { x: 0, y: 0, width: 1366, height: Math.max(height, 900) }, fullPage: true, timeout: 15000 });
      fs.writeFileSync(dFile, bufD);
      page.desktop = { file: path.basename(dFile), hash: sha256(bufD), viewport: '1366x900' };
      const pm = mobile ? await mobile.newPage() : null;
      if (pm) try {
        await pm.goto(finalUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await pm.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
        const bufM = await pm.screenshot({ type: 'jpeg', quality: 55, timeout: 15000 });
        const mFile = path.join(cfg.assetDir, `${n}-mobile.jpg`);
        fs.writeFileSync(mFile, bufM);
        page.mobile = { file: path.basename(mFile), hash: sha256(bufM), viewport: '390x844' };
      } catch (e) { page.mobile_error = e.message.split('\n')[0]; } finally { await pm.close().catch(() => {}); }
    } catch (e) {
      page.error = e.message.split('\n')[0];
      log('lỗi trang', url, staticMode ? '(HTML tĩnh)' : '(JS)', page.error.slice(0, 200));
      if (CRASH.test(page.error)) {
        page.error = 'Trình duyệt quét bị quá tải khi mở trang này (trang quá nặng cho máy chủ đám mây)';
        if (retry && timeLeft() > 40000) { // mở lại trình duyệt, thử lại một lần
          await p.close().catch(() => {});
          visited.delete(vkey);
          await ensureBrowser().catch(() => {});
          return visit(url, template, kind, false);
        }
      }
      result.errors.push({ url, error: page.error });
    } finally { await p.close().catch(() => {}); }
    result.pages.push(page);
    return page;
  }

  let homeFail = null;
  try {
    let home = await visit(start, 'home', 'home');
    // Trang chủ bị chặn (trang chống bot) hoặc quá nặng làm sập trình duyệt → quét lại bản HTML tĩnh (tắt JavaScript):
    // nhẹ, tránh được script chống bot; web dựng sẵn HTML (WordPress, sàn lớn có SSR…) vẫn đọc được tính năng.
    if (home && (home.blocked || home.error) && timeLeft() > 40000) {
      const why = home.blocked ? `bị chặn (${home.blocked})` : home.error;
      log('chuyển sang quét HTML tĩnh:', why);
      result.pages = result.pages.filter((x) => x !== home);
      result.errors = result.errors.filter((x) => x.url !== start);
      visited.delete(start.replace(/^(https?:\/\/)www\./, '$1'));
      staticMode = true;
      await desktop?.close().catch(() => {}); await mobile?.close().catch(() => {});
      if (browser.isConnected()) await openContexts(); else await ensureBrowser();
      const st = await visit(start, 'home', 'home');
      const usable = st && !st.error && !st.blocked && ((st.metrics?.elements || 0) >= 300 || (st.links_count || 0) >= 20);
      if (usable) { home = st; result.static_mode = { reason: why }; }
      else home = { ...home, blocked: home.blocked, error: home.error };
    }
    // Vẫn không đọc được → dừng: kết quả rỗng sẽ cho giá sai
    if (home?.blocked) homeFail = `Web mẫu chặn máy quét (${home.blocked}). Thử "Quét lại" sau, quét bằng bản chạy trên máy, hoặc tick tính năng tay.`;
    else if (home?.error) homeFail = `Không mở được trang chủ: ${home.error}. Web mẫu quá nặng cho máy chủ đám mây — quét bằng bản chạy trên máy, hoặc tick tính năng tay.`;
    if (homeFail) return finish(false, homeFail);
    // mở rộng khám phá qua một số trang menu khác loại
    const firstGroups = groupTemplates([...discovered.values()]).filter((g) => g.template !== 'home');
    for (const g of sampleUrls(firstGroups, Math.min(5, MAX_URLS - 1), 1)) {
      if (visited.size >= MAX_URLS) break;
      await visit(g.url, g.template, g.kind);
    }
    const groups = groupTemplates([...discovered.values()]);
    result.templates = groups.map((g) => ({ template: g.template, kind: g.kind, url_count: g.urls.length, examples: g.urls.slice(0, 5) }));
    for (const s of sampleUrls(groups, MAX_URLS, 2)) {
      if (visited.size >= MAX_URLS || timeLeft() < 15000) break;
      await visit(s.url, s.template, s.kind);
    }
  } finally {
    await browser.close().catch(() => {});
  }
  log('done', visited.size);
  result.discovered = [...discovered.values()];
  const groupsFinal = groupTemplates(result.discovered);
  result.templates = groupsFinal.map((g) => {
    const sampled = result.pages.filter((p) => !p.error && classify(p.url).template === g.template);
    const kinds = sampled.map((p) => p.page_kind).filter(Boolean);
    const detected = kinds.length && kinds.filter((k) => k === kinds[0]).length * 2 >= sampled.length ? kinds[0] : null;
    return { template: g.template, kind: g.kind, url_count: g.urls.length, examples: g.urls.slice(0, 5), sampled: sampled.length, detected };
  });
  // Bố cục theo cấu trúc trang thật + nhóm URL chưa kịp quét (mỗi nhóm coi như có thể là 1 bố cục riêng)
  const lay = clusterLayouts(result.pages);
  const unsampled = result.templates.filter((t) => !t.sampled && !['policy', 'search', 'account', 'cart'].includes(t.kind) && !(t.kind === 'other' && t.url_count < 2));
  result.layouts = { count: lay.length + unsampled.length, groups: lay, unsampled: unsampled.map((t) => t.template) };
  const smCount = (re) => [...sitemapOf.values()].filter((n) => re.test(n)).length;
  result.sitemap.product_urls = smCount(/product|san-?pham|sanpham/);
  result.sitemap.post_urls = smCount(/post|bai-?viet|tin-?tuc|news|blog|article/);
  result.coverage = {
    discovered: result.discovered.length,
    estimated_urls: Math.max(result.discovered.length, result.sitemap?.estimated_urls || 0),
    read: result.pages.filter((p) => !p.error && !p.blocked).length,
    failed: result.pages.filter((p) => p.error || p.blocked).length,
    template_groups: groupsFinal.length,
    unsampled_groups: result.templates.filter((t) => !t.sampled).map((t) => t.template),
    budget_exhausted: timeLeft() < 15000,
    note: 'Không biết tổng số trang thực tế nên không ghi tỷ lệ hoàn tất 100%.',
  };
  const ms = result.pages.filter((p) => p.metrics && !p.error && !p.blocked).map((p) => p.metrics);
  const mx = (k) => ms.reduce((m, x) => Math.max(m, x[k] || 0), 0);
  result.metrics = ms.length ? {
    pages: ms.length, max_elements: mx('elements'), avg_elements: Math.round(ms.reduce((n, x) => n + x.elements, 0) / ms.length),
    max_nav_links: mx('nav_links'), max_carousels: mx('carousels'), max_animated: mx('animated'), max_height: mx('height'),
    max_forms: mx('forms'), max_languages: mx('languages'), framework: ms.find((x) => x.framework)?.framework || null,
    img_bytes: ms.reduce((n, x) => n + (x.img_bytes || 0), 0), img_sized: ms.reduce((n, x) => n + (x.img_sized || 0), 0),
  } : null;
  return finish(true);
}

// ---------- Chạy như tiến trình con: node worker.js <config.json> ----------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  let partial = null;
  const write = (r) => fs.writeFileSync(cfg.outFile, JSON.stringify(r));
  const budget = Math.min(Number(cfg.budgetMs) || 240000, 600000);
  // watchdog: không để worker chạy quá ngân sách thời gian — ghi phần đã quét được rồi dừng
  setTimeout(() => {
    const r = partial || { pages: [], errors: [] };
    r.errors = [...(r.errors || []), { error: 'Vượt ngân sách thời gian, dừng cưỡng bức' }];
    write({ ...r, ok: (r.pages || []).length > 0, fatal: (r.pages || []).length ? undefined : 'Hết thời gian', finished_at: new Date().toISOString() });
    process.exit(0);
  }, budget + 30000).unref();
  runSurvey(cfg, { onResult: (r) => { partial = r; } })
    .then((r) => { write(r); process.exit(0); })
    .catch((e) => { write({ ...(partial || {}), ok: false, fatal: e.message, finished_at: new Date().toISOString() }); process.exit(1); });
}

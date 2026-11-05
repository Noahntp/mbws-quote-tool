// Đồng bộ dữ liệu các gói dịch vụ từ https://www.matbao.ws/ về data/packages.json
// Website là SPA nên phải render bằng trình duyệt (Playwright) rồi đọc DOM.
// Chạy: npm run sync:packages
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'packages.json');
const BASE = 'https://www.matbao.ws';

export function parseVnd(text) {
  if (!text) return null;
  const t = text.replace(/\s+/g, ' ').trim();
  const trieu = t.match(/([\d.,]+)\s*[–-]\s*([\d.,]+)\s*triệu/i);
  if (trieu) return { min: num(trieu[1]) * 1e6, max: num(trieu[2]) * 1e6 };
  const one = t.match(/([\d.]+)\s*₫/);
  if (one) { const v = Number(one[1].replace(/\./g, '')); return { min: v, max: v }; }
  return null;
}
const num = (s) => Number(s.replace(',', '.'));
const lines = (t) => t.split('\n').map((s) => s.trim()).filter(Boolean);

// Thẻ gói (HERO / ZERO): code, tên, giá, gia hạn, hosting, SP, bài viết, nhu cầu, giá trị
function parseHeroCard(text) {
  const L = lines(text);
  const code = L[0];
  const iPrice = L.indexOf('GIÁ ĐẦU TƯ BAN ĐẦU');
  const name = L[1];
  const tagline = iPrice > 2 ? L[2] : null;
  const price = parseVnd(L[iPrice + 1]);
  const iRenew = L.indexOf('Gia hạn:');
  const renewal = parseVnd(L[iRenew + 1]);
  const hosting = L[iRenew + 2];
  const products = (L.find((s) => s.startsWith('📦')) || '').replace('📦', '').trim();
  const posts = (L.find((s) => s.startsWith('📝')) || '').replace('📝', '').trim();
  const iNeed = L.findIndex((s) => s === 'NHU CẦU' || s === 'ĐỐI TƯỢNG');
  const iVal = L.indexOf('GIÁ TRỊ');
  const need = L.slice(iNeed + 1, iVal).join(' ');
  const values = [];
  for (let i = iVal + 1; i < L.length; i++) {
    if (/^\d+$/.test(L[i]) && L[i + 1]) { values.push(L[i + 1]); i++; }
    else if (L[i].startsWith('⚡') || L[i].startsWith('+ (')) break;
  }
  return { code, name, tagline, price, renewal_per_year: renewal?.min ?? null, hosting, products, posts, need, highlights: values };
}

async function scrapeHeroLine(page, tabLabel) {
  if (tabLabel) {
    await page.getByText(tabLabel, { exact: true }).first().click();
    await page.waitForTimeout(2000);
  }
  return page.evaluate(() => {
    const cards = [...document.querySelectorAll('.hero-col')].map((c) => c.innerText);
    const table = document.querySelector('table.hero-table, table.ws-table');
    const header = [...(table?.querySelectorAll('thead th, thead td') || [])].map((c) => c.innerText.trim());
    const rows = [];
    let group = null;
    for (const tr of table?.tBodies[0]?.rows || []) {
      const cells = [...tr.cells].map((c) => c.innerText.trim());
      if (cells.length <= 2) { group = cells.join(' ').split('\n')[1] || cells[0].split('\n')[0]; continue; }
      rows.push({ group, head: cells[0], values: cells.slice(1) });
    }
    return { cards, header, rows };
  });
}

function buildLine(id, title, sourceUrl, raw) {
  const pkgs = raw.cards.map(parseHeroCard).filter((p) => p.price);
  const criteria = [];
  for (const r of raw.rows) {
    const h = lines(r.head);
    const no = /^\d+$/.test(h[0]) ? Number(h.shift()) : null;
    if (!no) continue; // dòng nút "Đăng ký"
    criteria.push({ no, group: r.group, title: h[0], desc: h.slice(1).join(' '), values: r.values.slice(0, pkgs.length).map((v) => v.replace(/\s+/g, ' ')) });
  }
  // gắn bảng tiêu chí vào từng gói
  pkgs.forEach((p, i) => { p.features = Object.fromEntries(criteria.map((c) => [c.no, c.values[i] ?? null])); });
  return { id, title, source_url: sourceUrl, unit: 'one_time', packages: pkgs, criteria: criteria.map(({ values, ...c }) => c) };
}

function parseCare(text) {
  const re = /CARE (\d)\n([^\n]+)\n([^\n]+)\n([\d.]+)₫\/tháng\nNHU CẦU\n([^\n]+)\n[^\n]*\nGIÁ TRỊ - CARE \d\n([\s\S]*?)ĐĂNG KÝ CARE/g;
  const out = [];
  for (const m of text.matchAll(re)) {
    const highlights = lines(m[6]).filter((s) => !/^\d+$/.test(s));
    out.push({ code: `CARE ${m[1]}`, name: m[2], tagline: m[3], price: { min: Number(m[4].replace(/\./g, '')), max: Number(m[4].replace(/\./g, '')) }, need: m[5], highlights });
  }
  return out;
}

function parseAudit(text) {
  const re = /\n(Audit [^\n]+)\n([^\n]+)\n([\d.]+)₫[\s ]*\/[\s ]*lần\n[^\n]*\n((?:✓\n[^\n]+\n)+)/g;
  const out = [];
  for (const m of text.matchAll(re)) {
    const v = Number(m[3].replace(/\./g, ''));
    out.push({ code: m[1].toUpperCase(), name: m[1], tagline: m[2], price: { min: v, max: v }, highlights: lines(m[4]).filter((s) => s !== '✓') });
  }
  const full = text.match(/([\d.]+)₫ \(Trọn Gói 4 Phân Hệ\)/);
  if (full) { const v = Number(full[1].replace(/\./g, '')); out.push({ code: 'AUDIT FULL', name: 'Audit Full (trọn gói 4 phân hệ)', tagline: 'Pháp lý + Chuyển đổi + UX-UI + SEO & Tốc độ', price: { min: v, max: v }, highlights: [] }); }
  return out;
}

// innerText đã bỏ dòng trống và khoảng trắng đầu/cuối dòng để regex ổn định
const bodyText = async (page) => '\n' + lines(await page.evaluate(() => document.body.innerText)).join('\n') + '\n';

async function gotoText(page, p) {
  await page.goto(BASE + p, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(1500);
  for (let i = 0; i < 12; i++) { await page.mouse.wheel(0, 2000); await page.waitForTimeout(120); }
}

export async function syncPackages({ log = console.log } = {}) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const heroUrl = BASE + '/web-hero/chi-tiet-7-goi-web-hero';
    await gotoText(page, '/web-hero/chi-tiet-7-goi-web-hero');
    const hero = buildLine('WEB_HERO', 'Web HERO (thiết kế website, đầu tư một lần)', heroUrl, await scrapeHeroLine(page));
    log(`HERO: ${hero.packages.length} gói, ${hero.criteria.length} tiêu chí`);
    const zero = buildLine('WEB_ZERO', 'Web ZERO (website khởi đầu, đầu tư một lần)', heroUrl, await scrapeHeroLine(page, 'WEB ZERO'));
    log(`ZERO: ${zero.packages.length} gói, ${zero.criteria.length} tiêu chí`);

    await gotoText(page, '/web-care');
    const care = { id: 'WEB_CARE', title: 'Web Care (chăm sóc website, trả hàng tháng)', source_url: BASE + '/web-care', unit: 'monthly', packages: parseCare(await bodyText(page)), criteria: [] };
    log(`CARE: ${care.packages.length} gói`);

    await gotoText(page, '/audit-web');
    const audit = { id: 'AUDIT', title: 'Audit Web (kiểm định website, trả theo lần)', source_url: BASE + '/audit-web', unit: 'per_run', packages: parseAudit(await bodyText(page)), criteria: [] };
    log(`AUDIT: ${audit.packages.length} gói`);

    const all = [zero, hero, care, audit];
    if (zero.packages.length < 8 || hero.packages.length < 8) throw new Error('Không đọc đủ gói ZERO/HERO — cấu trúc trang có thể đã đổi, giữ nguyên dữ liệu cũ.');
    return {
      source: BASE,
      captured_at: new Date().toISOString(),
      note: 'Giá niêm yết công khai trên matbao.ws tại thời điểm đồng bộ, chưa gồm VAT. Đây là bảng giá bán (đã gồm lợi nhuận), dùng cho chế độ tính giá theo bảng giá bán.',
      addons: [
        { code: 'ADD_PRODUCTS_20', name: 'Nâng cấp thêm 20 sản phẩm (gia hạn hằng năm)', price: 500000, unit: '20 sản phẩm', recurring: 'yearly', source: '#8 bảng so sánh' },
        { code: 'ADD_POSTS_200', name: 'Nâng cấp thêm 200 bài viết (gia hạn hằng năm)', price: 500000, unit: '200 bài', recurring: 'yearly', source: '#9 bảng so sánh' },
        { code: 'ADD_OMNI', name: 'Kết nối phần mềm đa kênh Omni (gói ZERO 1–4)', price: 500000, unit: 'lần', recurring: null, source: '#18 bảng so sánh ZERO' },
      ],
      lines: all,
    };
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const data = await syncPackages();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(data, null, 2));
  console.log('Đã ghi', OUT);
}

// Từ yêu cầu đã chốt → dòng dự toán (WBS); đối chiếu bảng tiêu chí gói matbao.ws để biết
// phần nào nằm trong gói (không tính lại) và phần nào phải tính thêm.
import { computeQuote } from './pricing.js';

export function itemByCode(catalog, code) { return catalog.items.find((i) => i.code === code); }
export function featureByCode(catalog, code) { return catalog.features.find((f) => f.code === code); }

/** Tạo dòng tự động: các đầu việc nền + đầu việc theo từng yêu cầu được chọn làm. */
export function buildAutoLines(catalog, requirements) {
  const out = [];
  for (const code of catalog.base_items) {
    const it = itemByCode(catalog, code);
    out.push(lineFrom(it, 1, { feature: null, requirement_id: null }));
  }
  for (const r of requirements) {
    if (r.decision !== 'include') continue;
    const f = featureByCode(catalog, r.feature);
    if (!f) continue;
    const q = Number(r.quantity ?? f.default_qty ?? 1);
    for (const spec of f.items) {
      const it = itemByCode(catalog, spec.code);
      if (!it) continue;
      const qty = Math.max(1, Math.ceil(q / (spec.per || 1)));
      out.push(lineFrom(it, qty, { feature: f.code, requirement_id: r.id, requirement_code: r.code }));
    }
  }
  return out;
}

function lineFrom(it, qty, extra) {
  return { code: it.code, title: it.title, group: it.group, role: it.role, unit: it.unit, qty, o: it.o, m: it.m, p: it.p, source: 'auto', ...extra };
}

// ---------- Đọc bảng tiêu chí gói ----------
export function packageList(packagesData) {
  const out = [];
  for (const line of packagesData.lines) {
    if (!['WEB_ZERO', 'WEB_HERO'].includes(line.id)) continue;
    for (const p of line.packages) out.push({ line, pkg: p });
  }
  return out;
}

export function findPackage(packagesData, code) {
  for (const line of packagesData.lines) {
    const p = line.packages.find((x) => x.code === code);
    if (p) return { line, pkg: p };
  }
  return null;
}

// So khớp tên tiêu chí bỏ qua dấu cách & hoa/thường: bảng ZERO ghi "tin tức / Blog", bảng HERO ghi "tin tức/Blog"
const normTitle = (s) => String(s).toLowerCase().normalize('NFC').replace(/\s+/g, '');
function criterionValue(ctx, title) {
  const t = normTitle(title);
  const c = ctx.line.criteria.find((c) => normTitle(c.title).startsWith(t));
  if (!c) return undefined;
  return ctx.pkg.features?.[c.no] ?? undefined;
}
const maxNumber = (v) => {
  if (!v) return null;
  const nums = String(v).match(/\d[\d.]*/g);
  if (!nums) return null;
  const n = Math.max(...nums.map((s) => Number(s.replace(/\./g, ''))));
  return /\+/.test(v) ? Infinity : n;
};
// "0.5 GB", "4,5 GB" → số GB (dấu chấm/phẩy là phần thập phân, khác maxNumber); "Theo dự án" → null
export const gbOf = (v) => { const m = String(v ?? '').match(/(\d+(?:[.,]\d+)?)\s*GB/i); return m ? Number(m[1].replace(',', '.')) : null; };
const levelOf = (v) => { const m = String(v || '').match(/[MS](\d)/); return m ? Number(m[1]) : null; };

/** Mức may đo M1–M8 của gói (theo bảng tiêu chí matbao.ws). */
export function packageDesignLevel(ctx) { return levelOf(criterionValue(ctx, 'Giao diện thiết kế theo yêu cầu')); }

/**
 * Giá gói. Gói có khoảng giá (HERO 6: 15–30 tr, HERO 7: 30–45 tr, HERO 8: 45–60 tr) được đặt theo độ phức tạp
 * của web mẫu (gói từ mức may đo cần trở lên): fraction 0 → giá thấp nhất, 1 → cao nhất. Enterprise → giá cao nhất của HERO 8.
 * hint = { level, fraction, enterprise } (từ đánh giá độ phức tạp), không có → giá thấp nhất.
 */
export function packagePrice(ctx, hint) {
  const { min, max } = ctx.pkg.price;
  if (!hint || min === max) return min;
  const lv = packageDesignLevel(ctx);
  if (hint.enterprise && lv === 8) return max;
  if (lv == null || lv < hint.level) return min; // gói thấp hơn mức cần (thường đã bị loại)
  // gói đúng mức hoặc phải nâng lên gói cao hơn (vì tính năng): giữ cùng vị trí trong khoảng giá → nâng gói luôn có chi phí
  return Math.round((min + (max - min) * Math.max(0, Math.min(1, hint.fraction || 0))) / 500000) * 500000;
}

/** Gói có bao phủ một yêu cầu không? Trả về {status: 'included'|'paid_addon'|'capacity'|'not_included', ...} */
export function coverage(catalog, packagesData, ctx, feature, qty) {
  const addons = packagesData.addons || [];
  if (feature.capacity === 'design_level') {
    const lv = levelOf(criterionValue(ctx, 'Giao diện thiết kế theo yêu cầu'));
    return lv != null && qty <= lv ? { status: 'included', note: `May đo M${lv}` } : { status: 'not_included', hard: true, note: `Gói chỉ đến M${lv ?? '?'}, yêu cầu M${qty}` };
  }
  if (feature.capacity === 'sitemap') {
    const lv = levelOf(criterionValue(ctx, 'Bố cục trang web'));
    const cap = catalog.sitemap_capacity[String(lv)] ?? 0;
    if (qty <= cap) return { status: 'included', capacity: cap, note: `Sitemap S${lv} (~${cap} mẫu trang)` };
    // Vượt sức chứa: mỗi mẫu trang thêm tính theo đơn giá mẫu trang CỦA CHÍNH GÓI (giá gói ÷ số mẫu trang) — dễ giải thích,
    // không bao giờ để 1 mẫu trang đắt hơn cả gói (trước đây tính theo giờ công đầy đủ ~4,7 tr/mẫu).
    const over = qty - cap;
    // Chỉ cho mua thêm ít (≈25% sức chứa, tối thiểu 1); vượt nhiều hơn phải lên gói lớn hơn (như matbao.ws bán theo cấp sitemap)
    const allowed = Math.max(1, Math.round(cap * 0.25));
    const maxCap = Math.max(0, ...packageList(packagesData).map((c) => catalog.sitemap_capacity[String(levelOf(criterionValue(c, 'Bố cục trang web')))] ?? 0));
    if (over > allowed && qty <= maxCap) return { status: 'not_included', hard: true, capacity: cap, note: `Sitemap S${lv} ~${cap} mẫu trang, cần ${qty} — vượt quá nhiều, cần gói lớn hơn` };
    const unit = Math.max(100000, Math.round(ctx.pkg.price.min / Math.max(cap, 1) / 100000) * 100000);
    return { status: 'capacity', capacity: cap, over, addons: [{ code: 'ADD_TEMPLATE', name: `Thêm mẫu trang ngoài sức chứa gói ${ctx.pkg.code}`, qty: over, unit_price: unit, recurring: null }],
      note: `Sitemap S${lv} ~${cap} mẫu trang, vượt ${over} → ${over} × ${unit.toLocaleString('vi-VN')} ₫ (giá gói ÷ ${cap} mẫu trang)` };
  }
  if (feature.capacity === 'hosting') {
    // Gói ZERO/HERO 1–5 ghi rõ GB; HERO 6–8 "Theo dự án" → tính như mức cao nhất có niêm yết, phần vượt mua thêm
    const listed = gbOf(ctx.pkg.hosting);
    const cap = listed ?? Math.max(0, ...packageList(packagesData).map((c) => gbOf(c.pkg.hosting) ?? 0));
    const capNote = listed != null ? `Gói gồm ${cap} GB hosting` : `Hosting "${ctx.pkg.hosting || 'theo dự án'}" — tính như ${cap} GB`;
    if (qty <= cap) return { status: 'included', capacity: cap, note: capNote };
    const ad = addons.find((a) => a.code === 'ADD_HOSTING_1GB');
    const n = Math.ceil(qty - cap - 1e-9);
    if (!ad) return { status: 'not_included', capacity: cap, note: `${capNote}, cần ${qty} GB — chưa có giá mua thêm dung lượng` };
    return { status: 'paid_addon', capacity: cap, addons: [{ code: ad.code, name: ad.name, qty: n, unit_price: ad.price, recurring: ad.recurring }], note: `${capNote}, cần ${qty} GB → mua thêm ${n} GB` };
  }
  if (feature.capacity === 'products' || feature.capacity === 'posts') {
    const title = feature.capacity === 'products' ? 'Số lượng sản phẩm' : 'Số lượng bài viết';
    const cap = maxNumber(criterionValue(ctx, title)) ?? 0;
    if (qty <= cap) return { status: 'included', capacity: cap, note: `Gói cho tối đa ${cap === Infinity ? 'không giới hạn' : cap}` };
    const ad = addons.find((a) => a.code === (feature.capacity === 'products' ? 'ADD_PRODUCTS_20' : 'ADD_POSTS_200'));
    const per = feature.capacity === 'products' ? 20 : 200;
    const n = Math.ceil((qty - cap) / per);
    return { status: 'paid_addon', addons: [{ code: ad.code, name: ad.name, qty: n, unit_price: ad.price, recurring: ad.recurring }], note: `Vượt ${qty - cap}, mua thêm ${n} × ${ad.unit}` };
  }
  if (!feature.criteria) return { status: 'not_included', note: 'Không có trong bảng tiêu chí gói — tính ngoài gói' };
  for (const spec of feature.criteria) {
    const [title, mustContain] = spec.split('=');
    const v = criterionValue(ctx, title);
    if (v === undefined || v === null || v === '' || v === '✕') return { status: 'not_included', note: v === '✕' ? `Gói không có "${title}"` : `Dòng gói không có tiêu chí "${title}"` };
    if (mustContain && !v.includes(mustContain)) return { status: 'not_included', note: `"${title}" của gói là ${v}` };
    if (/₫/.test(v) && !/miễn phí/i.test(v)) {
      const ad = addons.find((a) => a.code === feature.addon_if_paid);
      if (ad) return { status: 'paid_addon', addons: [{ code: ad.code, name: ad.name, qty: 1, unit_price: ad.price, recurring: ad.recurring }], note: `"${title}" tính phí ${v}` };
    }
  }
  return { status: 'included', note: feature.covered_note || 'Có trong gói' };
}

/**
 * Gắn cờ billing cho từng dòng theo gói đã chọn; tách dòng mẫu trang khi vượt sức chứa gói.
 * Dòng có billing_override giữ nguyên lựa chọn tay.
 */
export function applyPackage(catalog, packagesData, ctx, lines, requirements) {
  const reqById = Object.fromEntries(requirements.map((r) => [r.id, r]));
  const cov = {}; const addons = [];
  const out = [];
  for (const l of lines) {
    if (l.billing_override) { out.push({ ...l, billing: l.billing_override, coverage_note: 'Chọn tay' }); continue; }
    if (!l.feature) { out.push({ ...l, billing: l.source === 'manual' ? 'extra' : 'package', coverage_note: l.source === 'manual' ? 'Dòng thêm tay' : 'Đầu việc nền của gói' }); continue; }
    const f = featureByCode(catalog, l.feature);
    const r = reqById[l.requirement_id];
    const q = Number(r?.quantity ?? f.default_qty ?? 1);
    if (!cov[l.feature + ':' + l.requirement_id]) {
      cov[l.feature + ':' + l.requirement_id] = coverage(catalog, packagesData, ctx, f, q);
      for (const a of cov[l.feature + ':' + l.requirement_id].addons || []) addons.push({ ...a, reason: `${r?.code || ''} ${f.title}` });
    }
    const c = cov[l.feature + ':' + l.requirement_id];
    if (c.status === 'capacity' && f.capacity === 'sitemap') { // phần vượt đã tính bằng add-on theo đơn giá mẫu trang của gói
      out.push({ ...l, billing: 'package', coverage_note: `Vượt sức chứa gói: ${c.note}` });
      continue;
    }
    out.push({ ...l, billing: c.status === 'not_included' ? 'extra' : 'package', coverage_note: c.note });
  }
  // Tính năng không có đầu việc (dung lượng hosting): không sinh dòng giờ công, chỉ cộng add-on khi vượt sức chứa gói
  for (const r of requirements) {
    if (r.decision !== 'include' || !r.feature || cov[r.feature + ':' + r.id]) continue;
    const f = featureByCode(catalog, r.feature);
    if (f?.capacity !== 'hosting') continue;
    const c = coverage(catalog, packagesData, ctx, f, Number(r.quantity ?? f.default_qty ?? 1));
    cov[r.feature + ':' + r.id] = c;
    for (const a of c.addons || []) addons.push({ ...a, reason: `${r.code || ''} ${f.title}` });
  }
  return { lines: out, addons, coverage: cov };
}

/** Xếp hạng các gói ZERO/HERO theo tổng giá bán (gói + add-on + phần ngoài gói). */
export function recommendPackages(catalog, packagesData, { requirements, lines, rates, policy, external = [], risks = [], priceHint = null }) {
  const results = [];
  // mức may đo cần (từ đánh giá độ phức tạp web mẫu) — gói thấp hơn mức này không làm giống web mẫu được
  const dl = requirements.find((r) => r.feature === 'DESIGN_LEVEL' && r.decision === 'include');
  const dlFeature = featureByCode(catalog, 'DESIGN_LEVEL');
  for (const ctx of packageList(packagesData)) {
    const applied = applyPackage(catalog, packagesData, ctx, lines, requirements);
    let hard = Object.values(applied.coverage).find((c) => c.hard);
    if (!hard && dl && dlFeature) { const c = coverage(catalog, packagesData, ctx, dlFeature, Number(dl.quantity || 1)); if (c.status === 'not_included') hard = c; }
    const price = packagePrice(ctx, priceHint);
    const q = computeQuote({
      mode: 'package', rates, policy, lines: applied.lines, external, risks, addons: applied.addons,
      package: { code: ctx.pkg.code, price, price_min: ctx.pkg.price.min, price_max: ctx.pkg.price.max, renewal_per_year: ctx.pkg.renewal_per_year },
    });
    const extras = applied.lines.filter((l) => l.billing === 'extra');
    results.push({
      code: ctx.pkg.code, name: ctx.pkg.name, line: ctx.line.id,
      package_price: ctx.pkg.price, price_used: price, renewal_per_year: ctx.pkg.renewal_per_year,
      eligible: !hard, blocker: hard?.note || null,
      addons: applied.addons,
      extra_lines: extras.map((l) => `${l.title} ×${l.qty}${l.coverage_note ? ' — ' + l.coverage_note : ''}`),
      price_list: Number(q.price_list ?? 0), floor: Number(q.floor ?? 0), cost_total: Number(q.cost_total ?? 0),
      below_floor: q.price_list != null && q.price_list < q.floor,
    });
  }
  const ranked = results.filter((r) => r.eligible).sort((a, b) => a.price_list - b.price_list || a.package_price.min - b.package_price.min);
  return { best: ranked[0] || null, ranked, ineligible: results.filter((r) => !r.eligible) };
}

/**
 * Mỗi tính năng có từ gói nào (gói rẻ nhất bao phủ), đọc từ bảng tiêu chí matbao.ws.
 * Dùng để xếp danh mục tính năng theo cấp gói trên màn hình báo giá nhanh.
 */
export function featureTiers(catalog, packagesData) {
  const list = packageList(packagesData).map((c, i) => ({ c, i })).sort((a, b) => a.c.pkg.price.min - b.c.pkg.price.min || a.i - b.i).map((x) => x.c);
  const out = {};
  for (const f of catalog.features) {
    const q = f.default_qty ?? 1;
    const st = list.map((c) => ({ c, cov: coverage(catalog, packagesData, c, f, q) }));
    const first = st.find((x) => x.cov.status === 'included' || (x.cov.status === 'paid_addon' && !f.capacity));
    const free = st.find((x) => x.cov.status === 'included');
    out[f.code] = first ? {
      code: first.c.pkg.code, name: first.c.pkg.name, price: first.c.pkg.price.min, line: first.c.line.id,
      all: first.c === list[0],
      paid_until: first !== free && free ? free.c.pkg.code : null,
      addon_note: first !== free ? first.cov.note : null,
      note: free?.cov.note && free.cov.note !== 'Có trong gói' ? free.cov.note : null,
    } : null;
  }
  return out;
}

// Bộ tính giá xác định (deterministic). Không phụ thuộc AI.
// Tiền: VND nguyên (BigInt) — không dùng số thực cho tiền.
// Giờ: lưu theo phần trăm giờ (centi-hour) để tránh sai số dấu phẩy động.
// Tỷ lệ (%): quy về basis point (1% = 100 bp).
//
// Hai chế độ:
//  - 'cost'    : Giá = C / (1 − g). C = nhân sự + ngoài nhân sự + chi phí chung + dự phòng rủi ro.
//  - 'package' : Giá = giá gói matbao.ws (đã gồm lợi nhuận, không chia 1 − g) + add-on niêm yết
//                + phần việc NGOÀI gói tính theo chi phí / (1 − g). Vẫn tính C toàn bộ để kiểm tra giá sàn.

const B = (v) => BigInt(v);
const bp = (pct) => Math.round(Number(pct || 0) * 100); // % → basis point
const centi = (h) => Math.round(Number(h || 0) * 100);

function divRoundHalfUp(a, b) { // a,b BigInt, b>0, a>=0
  return (a * 2n + b) / (2n * b);
}
function divCeil(a, b) { return (a + b - 1n) / b; }

export function roundTo(amount, step, mode = 'up') {
  const s = B(step || 1);
  if (s <= 1n) return amount;
  if (mode === 'down') return (amount / s) * s;
  if (mode === 'nearest') return divRoundHalfUp(amount, s) * s;
  return divCeil(amount, s) * s;
}

/** C / (1 − g), làm tròn lên tới đồng để không làm hụt biên. */
export function grossUp(cost, marginBp) {
  if (marginBp < 0 || marginBp >= 10000) throw new Error('Biên lợi nhuận g phải nằm trong [0, 100%)');
  return divCeil(cost * 10000n, B(10000 - marginBp));
}

export function pert(o, m, p) { return (o + 4 * m + p) / 6; }

function lineHoursC(line, which) {
  // giờ của dòng = số lượng × định mức/đơn vị
  const qtyC = centi(line.qty ?? 1);
  return Math.round((qtyC * centi(line[which])) / 100);
}

export function computeQuote(input) {
  const checks = [];
  const err = (code, message) => checks.push({ level: 'error', code, message });
  const warn = (code, message) => checks.push({ level: 'warn', code, message });

  const policy = input.policy || {};
  const mode = input.mode === 'package' ? 'package' : 'cost';
  const g = bp(policy.target_margin_pct ?? 30);
  const gMin = bp(policy.min_margin_pct ?? 25);
  const step = policy.rounding_step ?? 1000;
  const roundMode = policy.rounding_mode || 'up';
  const vatBp = bp(policy.vat_pct ?? 0);
  const overheadBp = bp(policy.overhead_pct ?? 0);
  const discountBp = bp(input.discount_pct ?? 0);
  const rates = input.rates || {};

  if (g < 0 || g >= 10000) err('MARGIN_RANGE', 'Biên lợi nhuận mục tiêu phải trong khoảng 0% đến dưới 100%.');
  if (gMin < 0 || gMin >= 10000) err('MIN_MARGIN_RANGE', 'Biên tối thiểu phải trong khoảng 0% đến dưới 100%.');
  if (discountBp < 0 || discountBp >= 10000) err('DISCOUNT_RANGE', 'Giảm giá phải trong khoảng 0% đến dưới 100%.');
  if (checks.length) return { mode, checks, ok: false };

  // ---- Dòng công việc ----
  const lines = [];
  const sum = { package: { o: 0n, m: 0n, p: 0n }, extra: { o: 0n, m: 0n, p: 0n } };
  const hours = { o: 0, m: 0, p: 0 };
  const byGroup = {}; const byRole = {};
  for (const l of input.lines || []) {
    if (l.include === false) continue;
    const rate = rates[l.role];
    if (rate == null) { err('RATE_MISSING', `Chưa có đơn giá cho vai trò ${l.role} (dòng ${l.code || l.title}).`); continue; }
    const hc = { o: lineHoursC(l, 'o'), m: lineHoursC(l, 'm'), p: lineHoursC(l, 'p') };
    if (hc.m <= 0) err('ZERO_HOURS', `Dòng "${l.title}" có giờ công bằng 0 — không được tự gán công sức 0; cần định mức hoặc câu hỏi/khảo sát.`);
    if (!(hc.o <= hc.m && hc.m <= hc.p)) warn('OMP_ORDER', `Dòng "${l.title}": cần O ≤ M ≤ P.`);
    const cost = {};
    for (const k of ['o', 'm', 'p']) cost[k] = divRoundHalfUp(B(hc[k]) * B(rate), 100n);
    const billing = mode === 'package' && l.billing === 'package' ? 'package' : 'extra';
    for (const k of ['o', 'm', 'p']) { sum[billing][k] += cost[k]; hours[k] += hc[k]; }
    byGroup[l.group] = (byGroup[l.group] || 0n) + cost.m;
    byRole[l.role] = (byRole[l.role] || { hours_c: 0, cost: 0n });
    byRole[l.role].hours_c += hc.m; byRole[l.role].cost += cost.m;
    lines.push({ ...l, billing, rate, hours_o: hc.o / 100, hours_m: hc.m / 100, hours_p: hc.p / 100,
      hours_pert: Math.round(pert(hc.o, hc.m, hc.p)) / 100, cost_o: cost.o, cost_m: cost.m, cost_p: cost.p });
  }
  if (mode === 'cost' && lines.length === 0) err('NO_LINES', 'Chưa có đầu việc nào được đưa vào dự toán.');

  // ---- Ngoài nhân sự, dự phòng rủi ro ----
  let external = 0n;
  for (const e of input.external || []) {
    if (e.include === false) continue;
    external += B(Math.round(Number(e.amount || 0)));
  }
  let riskExpected = 0n;
  const risks = [];
  for (const r of input.risks || []) {
    if (r.include === false) continue;
    const ev = divRoundHalfUp(B(Math.round(Number(r.impact || 0))) * B(bp(r.prob_pct)), 10000n);
    riskExpected += ev;
    risks.push({ ...r, expected: ev });
  }
  const riskFor = { o: riskExpected, m: riskExpected, p: riskExpected };
  if (input.risk_override?.o != null && input.risk_override.o !== '') riskFor.o = B(Math.round(Number(input.risk_override.o)));
  if (input.risk_override?.p != null && input.risk_override.p !== '') riskFor.p = B(Math.round(Number(input.risk_override.p)));

  // ---- Gói & add-on (chế độ package) ----
  let pkgPrice = 0n; let addonsTotal = 0n;
  const addons = [];
  const recurring = [];
  if (mode === 'package') {
    const pk = input.package;
    if (!pk || pk.price == null) err('PACKAGE_MISSING', 'Chế độ theo bảng giá bán cần chọn gói.');
    else {
      pkgPrice = B(Math.round(Number(pk.price)));
      if (pk.price_min != null && pk.price_max != null && (pk.price < pk.price_min || pk.price > pk.price_max))
        warn('PACKAGE_PRICE_RANGE', `Giá gói ${pk.code} nằm ngoài khoảng niêm yết ${pk.price_min}–${pk.price_max}.`);
      if (pk.renewal_per_year) recurring.push({ title: `Phí gia hạn gói ${pk.code}`, amount: B(pk.renewal_per_year), period: 'năm' });
    }
    for (const a of input.addons || []) {
      const qty = Math.max(0, Math.round(Number(a.qty || 0)));
      if (!qty) continue;
      const amount = B(qty) * B(Math.round(Number(a.unit_price || 0)));
      addonsTotal += amount;
      addons.push({ ...a, qty, amount });
      if (a.recurring === 'yearly') recurring.push({ title: `Gia hạn: ${a.name}`, amount, period: 'năm' });
    }
  }
  for (const r of input.recurring || []) {
    recurring.push({ title: r.title, amount: B(Math.round(Number(r.amount || 0))), period: r.period || 'tháng' });
  }

  // ---- Kịch bản O / M / P ----
  // Chế độ gói: phần trong gói được giao theo mẫu chuẩn, nên chi phí nội bộ của gói lấy theo tỷ lệ
  // chi phí/giá niêm yết đã duyệt (policy.package_cost_pct), KHÔNG lấy giờ may đo của dòng 'package'
  // (các giờ đó chỉ hiển thị để lập kế hoạch). Dự phòng rủi ro chỉ áp cho phần tùy chỉnh ngoài gói.
  const pkgCostBp = bp(policy.package_cost_pct ?? 60);
  const pkgCost = mode === 'package' ? divRoundHalfUp((pkgPrice + addonsTotal) * B(pkgCostBp), 10000n) : 0n;
  const hasExtras = sum.extra.m > 0n;
  const scenarios = {};
  for (const k of ['o', 'm', 'p']) {
    const labor = sum.package[k] + sum.extra[k];
    let price; let cost; let overhead; let risk;
    if (mode === 'cost') {
      overhead = divRoundHalfUp(labor * B(overheadBp), 10000n);
      risk = riskFor[k];
      cost = labor + external + overhead + risk;
      price = roundTo(grossUp(cost, g), step, 'up');
    } else {
      overhead = divRoundHalfUp(sum.extra[k] * B(overheadBp), 10000n);
      risk = hasExtras ? riskFor[k] : 0n;
      const extraCost = sum.extra[k] + overhead + external + risk;
      cost = pkgCost + extraCost;
      price = pkgPrice + addonsTotal + (extraCost > 0n ? roundTo(grossUp(extraCost, g), step, 'up') : 0n);
    }
    scenarios[k] = { labor, external, overhead, risk, cost, price, package_cost: pkgCost };
  }

  const base = scenarios.m;
  const C = base.cost;
  let extrasSell = 0n;
  if (mode === 'package') extrasSell = base.price - pkgPrice - addonsTotal;
  const priceList = base.price;
  const floor = roundTo(grossUp(C, gMin), step, 'up');

  const netRaw = divRoundHalfUp(priceList * B(10000 - discountBp), 10000n);
  const priceNet = roundTo(netRaw, step, roundMode);
  const discountAmount = priceList - priceNet;
  const vat = divRoundHalfUp(priceNet * B(vatBp), 10000n);
  const totalInclVat = priceNet + vat;
  // tỷ lệ hiển thị: basis point làm tròn → % với 2 chữ số thập phân
  const ratioBp = (num, den) => {
    if (den <= 0n) return 0;
    const neg = num < 0n;
    const v = Number(divRoundHalfUp((neg ? -num : num) * 10000n, den));
    return neg ? -v : v;
  };
  const marginRealizedBp = ratioBp(priceNet - C, priceNet);
  const maxDiscountBp = priceList > floor ? ratioBp(priceList - floor, priceList) : 0;

  if (priceNet < floor) err('BELOW_FLOOR', `Giá sau giảm & làm tròn (${fmt(priceNet)}) thấp hơn giá sàn (${fmt(floor)}). Sửa phạm vi hoặc chuyển cấp có quyền duyệt.`);
  if (mode === 'package' && priceList < floor) warn('PACKAGE_BELOW_COST', 'Giá gói + phần ngoài gói thấp hơn giá sàn theo chi phí dự toán — cần xem lại việc chọn gói hoặc định mức.');

  const result = {
    mode,
    ok: !checks.some((c) => c.level === 'error'),
    checks,
    lines,
    risks,
    addons,
    recurring,
    hours: { o: hours.o / 100, m: hours.m / 100, p: hours.p / 100, pert: Math.round(pert(hours.o, hours.m, hours.p)) / 100 },
    labor_by_group: byGroup,
    labor_by_role: Object.fromEntries(Object.entries(byRole).map(([r, v]) => [r, { hours: v.hours_c / 100, cost: v.cost }])),
    scenarios,
    cost_total: C,
    package_price: pkgPrice,
    package_cost_pct: pkgCostBp / 100,
    package_cost: pkgCost,
    package_effort_cost: sum.package.m, // giờ trong gói quy tiền — chỉ tham khảo, không vào C
    addons_total: addonsTotal,
    extras_sell: extrasSell,
    price_list: priceList,
    discount_pct: discountBp / 100,
    discount_amount: discountAmount,
    price_net: priceNet,
    vat_pct: vatBp / 100,
    vat,
    total_incl_vat: totalInclVat,
    floor,
    target_margin_pct: g / 100,
    min_margin_pct: gMin / 100,
    margin_realized_pct: marginRealizedBp / 100,
    max_discount_pct: maxDiscountBp / 100,
  };
  return result;
}

export function fmt(v) {
  return (typeof v === 'bigint' ? v : B(Math.round(Number(v)))).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/** Chuyển BigInt → Number/string để trả JSON. */
export function toJSONSafe(obj) {
  return JSON.parse(JSON.stringify(obj, (_, v) => (typeof v === 'bigint' ? Number(v) : v)));
}

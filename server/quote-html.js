// Bản báo giá gửi khách. CHỈ dùng giá bán & phạm vi — không đưa giờ công, đơn giá nhân sự, chi phí, biên lợi nhuận.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const vnd = (n) => (n == null ? '—' : Math.round(Number(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ' ₫');

export function renderCustomerQuote(v, { draft, preliminary } = {}) {
  const s = v.snapshot; const r = v.result; const p = s.project;
  const included = s.requirements.filter((x) => x.decision === 'include');
  const excluded = s.requirements.filter((x) => x.decision === 'exclude');
  const pkg = s.input.package;
  const rows = [];
  if (r.mode === 'package' && pkg) {
    rows.push([`Gói ${pkg.code} – ${pkg.name}`, 'Gói website Mắt Bão WS (đầu tư ban đầu)', r.package_price]);
    for (const a of r.addons || []) rows.push([a.name, `${a.qty} × ${vnd(a.unit_price)}${a.reason ? ' — ' + a.reason : ''}`, a.amount]);
    if (Number(r.extras_sell) > 0) {
      const extras = [...new Set((r.lines || []).filter((l) => l.billing === 'extra').map((l) => l.title))];
      rows.push(['Hạng mục tùy chỉnh ngoài gói', extras.join('; '), r.extras_sell]);
    }
  } else {
    rows.push(['Thiết kế & xây dựng website trọn phạm vi', `${included.length} hạng mục yêu cầu (chi tiết bên dưới)`, r.price_list]);
  }
  const recurring = r.recurring || [];
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(v.quote_code)} – Báo giá website</title>
<style>
  :root{--ink:#14213d;--muted:#5c6577;--line:#d9dee7;--accent:#f95700;--bg:#fff}
  *{box-sizing:border-box} body{font-family:"Segoe UI",Roboto,Arial,sans-serif;color:var(--ink);background:var(--bg);margin:0;padding:28px;font-size:14px;line-height:1.5}
  .wrap{max-width:860px;margin:0 auto} h1{font-size:22px;margin:0 0 4px} h2{font-size:15px;margin:26px 0 8px;border-bottom:2px solid var(--accent);padding-bottom:4px;display:inline-block}
  .muted{color:var(--muted)} table{width:100%;border-collapse:collapse;margin-top:6px} th,td{border-bottom:1px solid var(--line);padding:8px 6px;text-align:left;vertical-align:top}
  th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)} td.n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
  .total td{font-weight:700;font-size:15px;border-bottom:2px solid var(--ink)} .head{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap}
  .badge{display:inline-block;background:#fde8dc;color:#9a3a00;border-radius:4px;padding:2px 8px;font-size:12px;font-weight:600}
  .draft{background:#fff3cd;border:1px solid #e0b100;padding:8px 12px;border-radius:6px;margin-bottom:14px}
  ul{margin:4px 0 0 18px;padding:0} li{margin:2px 0}
  @media print{body{padding:0}.noprint{display:none}}
</style></head><body><div class="wrap">
${draft ? '<div class="draft"><b>BẢN XEM TRƯỚC — chưa được duyệt, không gửi khách.</b></div>' : ''}
${preliminary ? '<div class="draft"><b>BÁO GIÁ SƠ BỘ</b> — giá tham khảo theo phạm vi dưới đây; có thể điều chỉnh khi chốt yêu cầu chi tiết.</div>' : ''}
<div class="head"><div><h1>Báo giá thiết kế website</h1><div class="muted">${esc(p.name)}</div></div>
<div style="text-align:right"><div><b>${esc(v.quote_code)}</b> <span class="badge">${preliminary ? 'Sơ bộ' : 'Phiên bản ' + esc(v.version)}</span></div>
<div class="muted">Ngày lập: ${esc(String(v.created_at).slice(0, 10))}</div><div class="muted">Hiệu lực đến: <b>${esc(v.valid_until)}</b></div></div></div>
<p>Kính gửi: <b>${esc(p.customer_name || '')}</b>${p.customer_contact ? ' — ' + esc(p.customer_contact) : ''}</p>

<h2>Giá trị báo giá</h2>
<table><thead><tr><th>Hạng mục</th><th>Mô tả</th><th style="text-align:right">Thành tiền</th></tr></thead><tbody>
${rows.map(([a, b, c]) => `<tr><td>${esc(a)}</td><td class="muted">${esc(b)}</td><td class="n">${vnd(c)}</td></tr>`).join('')}
${Number(r.discount_amount) > 0 ? `<tr><td>Ưu đãi</td><td class="muted">Giảm ${r.discount_pct}%</td><td class="n">− ${vnd(r.discount_amount)}</td></tr>` : ''}
<tr><td colspan="2"><b>Giá trước thuế</b></td><td class="n"><b>${vnd(r.price_net)}</b></td></tr>
<tr><td colspan="2">Thuế GTGT ${r.vat_pct}%</td><td class="n">${vnd(r.vat)}</td></tr>
<tr class="total"><td colspan="2">Tổng thanh toán</td><td class="n">${vnd(r.total_incl_vat)}</td></tr>
</tbody></table>
${recurring.length ? `<h2>Phí định kỳ (tính riêng, không gộp vào giá xây dựng)</h2><table><tbody>${recurring.map((x) => `<tr><td>${esc(x.title)}</td><td class="n">${vnd(x.amount)} / ${esc(x.period)}</td></tr>`).join('')}</tbody></table><p class="muted">Phí định kỳ chưa gồm thuế.</p>` : ''}

<h2>Phạm vi bàn giao</h2>
<ul>${included.map((x) => `<li><b>${esc(x.title)}</b>${x.quantity != null ? ` — ${esc(x.quantity)} ${esc(x.unit || '')}` : ''}${x.acceptance ? `<br><span class="muted">Tiêu chí nghiệm thu: ${esc(x.acceptance)}</span>` : ''}</li>`).join('')}</ul>
${pkg ? `<p class="muted">Quyền lợi gói ${esc(pkg.code)}: ${(pkg.highlights || []).map(esc).join('; ')}</p>` : ''}

<h2>Ngoài phạm vi</h2>
<ul>${excluded.map((x) => `<li>${esc(x.title)}</li>`).join('')}${(s.exclusions_standard || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>

<h2>Điều kiện</h2>
<ul>
<li>Thanh toán: ${esc(v.payment_terms)}</li>
<li>Tiến độ tính từ khi đủ nội dung và chốt phạm vi; mốc cụ thể theo kế hoạch hai bên thống nhất.</li>
<li>Yêu cầu mới hoặc thay đổi phạm vi được ghi nhận bằng báo giá bổ sung có phiên bản riêng, không ghi đè phạm vi gốc.</li>
<li>Báo giá hết hiệu lực sau ngày ${esc(v.valid_until)}.</li>
</ul>
${preliminary ? '' : `<p class="muted" style="margin-top:28px">Người duyệt: ${esc(v.approved_by_name || '—')}${v.approved_at ? ' — ' + esc(String(v.approved_at).slice(0, 10)) : ''}</p>`}
<p class="noprint"><button onclick="print()">In / Lưu PDF</button></p>
</div></body></html>`;
}

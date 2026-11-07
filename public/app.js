// Giao diện công cụ báo giá — SPA thuần JS, không cần build.
const $app = document.getElementById('app');
const S = { users: [], me: null, meta: null, project: null, tab: 'profile', rec: null, briefSug: null, versionView: null, poll: null };

// ---------- tiện ích ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const vnd = (n) => (n == null || n === '' ? '—' : Math.round(Number(n)).toLocaleString('vi-VN') + ' ₫');
const num = (n, d = 2) => (n == null ? '—' : Number(n).toLocaleString('vi-VN', { maximumFractionDigits: d }));
const trieu = (n) => (n == null ? '—' : (Number(n) / 1e6).toLocaleString('vi-VN', { maximumFractionDigits: 2 }) + ' tr');
function toast(msg, err) { const d = document.createElement('div'); d.textContent = msg; if (err) d.className = 'err'; document.getElementById('toast').append(d); setTimeout(() => d.remove(), err ? 7000 : 3000); }
async function api(url, method = 'GET', body) {
  const r = await fetch(url, { method, headers: { 'content-type': 'application/json', 'x-user-id': String(S.me?.id || '') }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && j.code === 'LOGIN_REQUIRED') { boot(); throw new Error('Phiên đăng nhập đã hết, vui lòng đăng nhập lại.'); }
  if (!r.ok) { const extra = j.checks ? ': ' + j.checks.map((c) => c.message).join(' | ') : ''; throw Object.assign(new Error((j.error || r.statusText || 'Lỗi máy chủ ' + r.status) + extra), { status: r.status }); }
  return j;
}
const can = (p) => !!S.meta?.perms?.[p];
const ROLE = { sales: 'Sales', tech: 'Kỹ thuật', pricing_manager: 'Quản lý giá', admin: 'Quản trị' };
const SRC = { observed: ['Quan sát được', 'ok'], client: ['Khách yêu cầu', 'accent'], inferred: ['Suy luận', 'warn'], unverified: ['Chưa kiểm tra được', 'err'] };
const DEC = { pending: 'Chờ quyết định', include: 'Làm', exclude: 'Bỏ', ask: 'Hỏi lại' };
const STATUS_CHIP = { draft: '', clarify: 'warn', estimating: 'accent', pending: 'warn', approved: 'ok', rejected: 'err' };
const VSTATUS = { draft: 'Nháp', pending: 'Chờ duyệt', approved: 'Đã duyệt', rejected: 'Từ chối' };
const chip = (text, cls = '') => `<span class="chip ${cls}">${esc(text)}</span>`;

// ---------- khởi động ----------
// Đăng nhập (khi máy chủ đặt APP_PASSWORD)
async function ensureLogin() {
  const st = await fetch('/auth/status').then((r) => r.json()).catch(() => ({ required: false, ok: true }));
  if (!st.required || st.ok) return true;
  $app.innerHTML = `<div class="panel" style="max-width:380px;margin:60px auto">
    <h1>Báo giá website</h1><p class="muted">Nhập mật khẩu của nhóm để vào công cụ.</p>
    <form id="loginForm"><input id="loginPw" type="password" placeholder="Mật khẩu" autocomplete="current-password" style="width:100%;padding:10px;font-size:16px" autofocus>
    <p><button class="primary" style="width:100%;padding:10px">Đăng nhập</button></p><p id="loginErr" class="checks"></p></form></div>`;
  document.getElementById('loginForm').onsubmit = async (e) => {
    e.preventDefault();
    const r = await fetch('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: document.getElementById('loginPw').value }) });
    if (r.ok) { boot(); return; }
    document.getElementById('loginErr').innerHTML = `<span class="error">${esc((await r.json().catch(() => ({}))).error || 'Không đăng nhập được')}</span>`;
  };
  return false;
}

async function boot() {
  if (!(await ensureLogin())) return;
  S.users = await fetch('/api/users').then((r) => r.json());
  const saved = Number(localStorageGet('uid')) || S.users[0]?.id;
  S.me = S.users.find((u) => u.id === saved) || S.users[0];
  const sel = document.getElementById('user');
  sel.innerHTML = S.users.map((u) => `<option value="${u.id}" ${u.id === S.me.id ? 'selected' : ''}>${esc(u.name)} — ${ROLE[u.role]}</option>`).join('');
  sel.onchange = async () => { S.me = S.users.find((u) => u.id === Number(sel.value)); localStorageSet('uid', S.me.id); await loadMeta(); route(); };
  await loadMeta();
  window.addEventListener('hashchange', route);
  route();
}
function localStorageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localStorageSet(k, v) { try { localStorage.setItem(k, v); } catch {} }
async function loadMeta() { S.meta = await api('/api/meta'); storageBanner(); }
// Máy chủ chưa nối CSDL bền vững (Vercel chưa có Postgres) → dữ liệu có thể mất bất cứ lúc nào: báo rõ cho người dùng.
function storageBanner() {
  document.getElementById('storageWarn')?.remove();
  if (S.meta?.storage?.persistent !== false) return;
  const d = document.createElement('div');
  d.id = 'storageWarn'; d.className = 'storage-warn';
  d.textContent = '⚠ Máy chủ chưa nối cơ sở dữ liệu bền vững (Postgres): hồ sơ và kết quả quét có thể biến mất sau vài phút. Chưa dùng bản này cho báo giá thật.';
  document.querySelector('header.top')?.after(d);
}

function route() {
  clearInterval(S.poll);
  const h = location.hash.slice(1) || '/';
  document.querySelectorAll('.top nav a').forEach((a) => a.classList.toggle('on', a.getAttribute('href') === '#' + h || (h.startsWith('/p/') && a.getAttribute('href') === '#/')));
  const m = h.match(/^\/p\/(\d+)(?:\/(\w+))?/);
  if (m) { S.tab = m[2] || 'quick'; return openProject(Number(m[1])); }
  if (h === '/packages') return viewPackages();
  if (h === '/settings') return viewSettings();
  if (h === '/metrics') return viewMetrics();
  return viewProjects();
}

// ---------- danh sách hồ sơ ----------
async function viewProjects() {
  const rows = await api('/api/projects');
  $app.innerHTML = `
  <h1>Báo giá website</h1>
  ${can('project.edit') ? `<div class="panel">
    <h3 style="margin-top:0">Báo giá theo web mẫu</h3>
    <div class="row" style="gap:8px">
      <input id="np_domain" placeholder="Nhập tên miền web mẫu, ví dụ: bachhoaxanh.com" autocomplete="off" style="flex:1;min-width:240px;font-size:16px;padding:10px 12px">
      <button class="primary" data-act="createProject" style="padding:10px 20px;font-size:15px">Quét & báo giá</button>
    </div>
    <p class="small muted" style="margin:6px 0 0">Chỉ cần tên miền — hệ thống tự quét web, chọn sẵn tính năng và ra giá theo gói (1–4 phút).</p>
    <details style="margin-top:8px"><summary class="small">Thêm tên khách / mô tả nhu cầu (không bắt buộc)</summary>
      <div class="grid2" style="margin-top:8px">
        <label class="f">Khách hàng<input id="np_customer" placeholder="Tên khách / công ty"></label>
        <label class="f">Khách cần gì?<input id="np_brief" placeholder="Ví dụ: đặt bàn online, 2 ngôn ngữ"></label>
      </div></details></div>` : ''}
  <h2>Báo giá đã tạo</h2>
  <div class="panel tablewrap"><table><thead><tr><th>Mã</th><th>Dự án</th><th>Khách hàng</th><th>Phụ trách</th><th>Trạng thái</th><th class="n">Giá dự kiến</th><th>Cập nhật</th></tr></thead><tbody>
  ${rows.map((p) => `<tr><td><a href="#/p/${p.id}">${esc(p.code)}</a></td><td><a href="#/p/${p.id}">${esc(p.name)}</a></td><td>${esc(p.customer_name || '')}</td><td>${esc(p.owner_name || '')}</td><td>${chip(p.status_label, STATUS_CHIP[p.status])}</td><td class="n">${vnd(p.price_net)}</td><td class="small muted">${esc(p.updated_at)}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">Chưa có hồ sơ.</td></tr>'}
  </tbody></table></div>`;
}

// ---------- hồ sơ ----------
// Người dùng đang gõ trong một ô → không được vẽ lại màn hình (mất chữ, mất con trỏ)
function isEditing() {
  const a = document.activeElement;
  return !!a && $app.contains(a) && (a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || (a.tagName === 'INPUT' && !['checkbox', 'radio', 'button'].includes(a.type)));
}
// Ghi nhớ ô đang focus + chữ chưa lưu để khôi phục sau khi vẽ lại
function keyOf(el) {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const d = [...el.attributes].find((x) => x.name.startsWith('data-') && x.name !== 'data-k');
  if (!d) return null;
  const k = el.getAttribute('data-k');
  return `[${d.name}="${CSS.escape(d.value)}"]${k ? `[data-k="${CSS.escape(k)}"]` : ''}`;
}
function captureUi() {
  const a = document.activeElement;
  const focus = a && $app.contains(a) ? { sel: keyOf(a), start: a.selectionStart, end: a.selectionEnd } : null;
  const dirty = [...$app.querySelectorAll('input[id], textarea[id]')].filter((el) => el.type !== 'checkbox' && el.value !== el.defaultValue).map((el) => [`#${CSS.escape(el.id)}`, el.value]);
  return { focus, dirty };
}
function restoreUi({ focus, dirty }) {
  for (const [sel, v] of dirty) { const el = $app.querySelector(sel); if (el) el.value = v; }
  if (focus?.sel) {
    const el = $app.querySelector(focus.sel);
    if (el) { el.focus({ preventScroll: true }); try { if (focus.start != null) el.setSelectionRange(focus.start, focus.end); } catch {} }
  }
}

async function openProject(id, keepScroll, fromPoll) {
  if (fromPoll && isEditing()) return; // để lần cập nhật sau
  const y = window.scrollY;
  let project; let rec; let quick;
  try {
    project = await api(`/api/projects/${id}`);
    rec = S.tab === 'quick' ? await api(`/api/projects/${id}/recommend`).catch(() => null) : S.rec;
    quick = S.tab === 'quick' ? await api(`/api/projects/${id}/quick`) : null;
  } catch (e) {
    clearInterval(S.poll); // không gọi lại liên tục khi hồ sơ không còn / máy chủ lỗi
    if (fromPoll && e.status !== 404 && S.project?.project?.id === id) { toast('Mất kết nối khi cập nhật tiến độ quét: ' + e.message, true); return; }
    $app.innerHTML = `<div class="panel"><h2>Không mở được hồ sơ #${id}</h2><p class="checks"><span class="error">${esc(e.message)}</span></p>
      <p><a href="#/">← Về danh sách hồ sơ</a> · <a href="#/p/${id}" onclick="location.reload()">Thử lại</a></p></div>`;
    return;
  }
  if (fromPoll && isEditing()) return; // người dùng bắt đầu gõ trong lúc chờ mạng
  S.project = project; S.rec = rec; S.quick = quick;
  const ui = captureUi();
  renderProject();
  restoreUi(ui);
  if (keepScroll) window.scrollTo(0, y);
  const running = S.project.runs.some((r) => r.status === 'queued' || r.status === 'running');
  clearInterval(S.poll);
  if (running) S.poll = setInterval(() => openProject(id, true, true), 4000);
}
const reload = () => openProject(S.project.project.id, true);

function renderProject() {
  if (S.tab === 'quick') return renderQuick();
  const P = S.project; const p = P.project;
  const tabs = [['quick', '⚡ Báo giá nhanh'], ['profile', 'Hồ sơ & brief'], ['survey', 'Khảo sát web mẫu'], ['reqs', 'Chốt yêu cầu'], ['wbs', 'Bóc tách công việc'], ['price', 'Tính giá'], ['versions', 'Duyệt & xuất'], ['actuals', 'Sau bàn giao'], ['log', 'Lịch sử']];
  const blocking = P.questions.filter((q) => q.blocking && q.status === 'open').length;
  $app.innerHTML = `
  <div class="row" style="justify-content:space-between">
    <div><h1>${esc(p.name)} ${chip(P.status_label, STATUS_CHIP[P.status])}</h1>
    <div class="muted">${esc(p.code)} · ${esc(p.customer_name || 'Chưa có khách hàng')} · phụ trách ${esc(p.owner_name || '')}</div></div>
    <div class="kpis" style="min-width:420px;max-width:640px;flex:1">
      <div class="kpi"><div class="l">Giá dự kiến (trước thuế)</div><div class="v">${vnd(P.preview.price_net)}</div></div>
      <div class="kpi"><div class="l">Yêu cầu chờ quyết định</div><div class="v">${P.requirements.filter((r) => r.decision === 'pending' || r.decision === 'ask').length}</div></div>
      <div class="kpi"><div class="l">Câu hỏi chặn còn mở</div><div class="v">${blocking}</div></div>
    </div>
  </div>
  ${nextStepHtml(P)}
  <nav class="tabs">${tabs.map(([k, l]) => `<a href="#/p/${p.id}/${k}" class="${S.tab === k ? 'on' : ''}">${l}</a>`).join('')}</nav>
  <div id="tab"></div>`;
  const el = document.getElementById('tab');
  ({ profile: tabProfile, survey: tabSurvey, reqs: tabReqs, wbs: tabWbs, price: tabPrice, versions: tabVersions, actuals: tabActuals, log: tabLog })[S.tab]?.(el);
}

// ---------- BÁO GIÁ NHANH (1 màn hình) ----------
// Danh mục tính năng xếp theo CẤP GÓI matbao.ws: mỗi tính năng nằm ở nhóm của gói rẻ nhất có nó
// (máy chủ tính từ bảng tiêu chí — tự đổi khi đồng bộ lại giá). Thứ tự trong nhóm theo mục dưới đây.
const QUICK_FEATURES = ['SEARCH', 'FILTER', 'CONTACT_FORM', 'CHAT_ZALO', 'MESSENGER', 'PHONE_CALL', 'MAP', 'SOCIAL', 'ANALYTICS', 'SEO', 'PAYMENT_ONLINE', 'OMNI_SYNC', 'DATA_MIGRATION',
  'PRODUCT_CATALOG', 'CART', 'BLOG', 'MULTILANG', 'BOOKING', 'LANDING', 'TRACKING', 'MEMBER_LOGIN', 'LOYALTY', 'OMNI_CONTENT', 'AI_ASSISTANT', 'INTERNATIONAL', 'ERP_INTEGRATION', 'SHIPPING'];
const FEATURE_NOTE = {
  PAYMENT_ONLINE: 'Gói có QR BIDV miễn phí; VNPay/MoMo tính thêm',
  OMNI_SYNC: (t) => (t?.paid_until ? `+500.000 ₫ ở gói dưới ${t.paid_until}, miễn phí từ ${t.paid_until}` : ''),
};
// Thứ tự gói theo giá (cùng giá thì ZERO trước HERO, giữ thứ tự trên matbao.ws)
function packageOrder() {
  return S.meta.packages.lines.filter((l) => ['WEB_ZERO', 'WEB_HERO'].includes(l.id)).flatMap((l) => l.packages.map((p) => ({ p, l })))
    .map((x, i) => ({ ...x, i })).sort((a, b) => a.p.price.min - b.p.price.min || a.i - b.i);
}
function featureGroups() {
  const tiers = S.meta.feature_tiers || {};
  const order = packageOrder().map((x) => x.p.code);
  const groups = new Map();
  for (const code of QUICK_FEATURES) {
    const t = tiers[code];
    const key = !t ? 'NONE' : t.all ? 'ALL' : t.code;
    if (!groups.has(key)) groups.set(key, { key, tier: t, codes: [] });
    groups.get(key).codes.push(code);
  }
  const rank = (g) => (g.key === 'ALL' ? -1 : g.key === 'NONE' ? 999 : order.indexOf(g.key));
  return [...groups.values()].sort((a, b) => rank(a) - rank(b)).map((g) => ({ ...g, rank: rank(g) }));
}
// Giới hạn khối lượng của gói đang chọn (mẫu trang theo cấp sitemap, sản phẩm, bài viết)
function packageCapacity(code) {
  const x = packageOrder().find((y) => y.p.code === code);
  if (!x) return null;
  const crit = x.l.criteria.find((c) => /bố cục trang web/i.test(c.title));
  const lv = (String(x.p.features?.[crit?.no] || '').match(/S(\d)/) || [])[1];
  const pages = lv ? S.meta.catalog.sitemap_capacity[lv] : null;
  // HERO 6–8 ghi "Theo dự án" → tính như mức GB cao nhất có niêm yết (giống máy chủ)
  const gb = (v) => { const m = String(v || '').match(/(\d+(?:[.,]\d+)?)\s*GB/i); return m ? Number(m[1].replace(',', '.')) : null; };
  const maxGb = Math.max(0, ...packageOrder().map((y) => gb(y.p.hosting) || 0));
  const hosting = gb(x.p.hosting) != null ? `${gb(x.p.hosting)} GB` : `~${maxGb} GB (theo dự án)`;
  return { pages, products: x.p.products, posts: x.p.posts, hosting, hosting_short: hosting.replace(/ \(theo dự án\)/, ''), sitemap: x.p.features?.[crit?.no] };
}
const QUICK_QTY = [['PAGES', 'Số mẫu trang'], ['DATA_PRODUCTS', 'Số sản phẩm cần nhập'], ['DATA_POSTS', 'Số bài viết cần nhập'], ['HOSTING_STORAGE', 'Dung lượng hosting (GB)']];

function renderQuick() {
  const P = S.project; const p = P.project; const r = P.preview; const cat = S.meta.catalog;
  const reqBy = Object.fromEntries(P.requirements.map((x) => [x.feature, x]));
  const cov = P.applied?.coverage || {};
  const covOf = (rq) => (rq ? cov[`${rq.feature}:${rq.id}`] : null);
  const running = P.runs.filter((x) => x.status === 'queued' || x.status === 'running');
  const runOf = (url) => P.runs.find((x) => x.url === url);
  const included = P.requirements.filter((x) => x.decision === 'include');
  const pkgCode = p.pricing.package_code || P.meta.auto_package;
  const pkgAll = S.meta.packages.lines.flatMap((l) => l.packages);
  const pkg = pkgAll.find((x) => x.code === pkgCode);
  const fatal = (r.checks || []).filter((c) => c.level === 'error');
  const questions = P.questions.filter((q) => q.status === 'open' && q.blocking && included.some((x) => x.id === q.requirement_id));
  const feat = (code) => {
    const f = cat.features.find((x) => x.code === code); if (!f) return '';
    const rq = reqBy[code]; const on = rq?.decision === 'include'; const c = covOf(rq);
    const seen = rq && rq.evidence_codes.length ? (rq.source_kind === 'observed' ? chip('web mẫu có', 'ok') : chip('web mẫu có thể có', 'warn')) : '';
    const Q = S.quick; const mg = Q?.marginal?.[code];
    const inBase = Q?.baseline && code in (Q.baseline.features || {});
    let bill = '';
    if (mg) {
      if (!on) bill = mg.delta > 0 ? `<span title="${mg.package && mg.package !== Q.current.package ? 'Giá sẽ theo gói ' + esc(mg.package) : 'Tính thêm ngoài gói'}">${chip('+' + money(mg.delta), 'accent')}</span>` : mg.delta < 0 ? chip(money(mg.delta), 'ok') : '<span class="small muted">+0 ₫</span>';
      else if (Q.baseline && !inBase) { const t = S.meta.feature_tiers?.[code]; bill = chip('phát sinh' + (t && !t.all ? ' · cần ' + t.code : ''), 'accent'); }
    } else if (on && c && c.status !== 'included') bill = chip('+ tính thêm', 'accent');
    const n = FEATURE_NOTE[code]; const note = typeof n === 'function' ? n(S.meta.feature_tiers?.[code]) : n;
    return `<label class="feat"><input type="checkbox" data-qfeat="${code}" ${on ? 'checked' : ''} ${can('requirement.decide') ? '' : 'disabled'}><span>${esc(f.title)} ${seen} ${bill}${note ? `<span class="small muted" style="display:block">${esc(note)}</span>` : ''}</span></label>`;
  };
  const curRank = pkgCode ? packageOrder().findIndex((x) => x.p.code === pkgCode) : -1;
  const tierCard = (g) => {
    const t = g.tier;
    const title = g.key === 'ALL' ? 'Có sẵn trong mọi gói' : g.key === 'NONE' ? 'Không có trong gói nào' : `${esc(t.code)} · ${esc(t.name)}`;
    const sub = g.key === 'ALL' ? 'Gói ZERO / HERO nào cũng có' : g.key === 'NONE' ? 'Tính thêm theo giờ công' : `Cần tối thiểu gói ${esc(t.code)} — từ ${trieu(t.price)}`;
    const nOn = g.codes.filter((c) => reqBy[c]?.decision === 'include').length;
    let state = '';
    if (g.key === 'ALL') state = chip('đã gồm', 'ok');
    else if (g.key === 'NONE') state = nOn ? chip('+ tính thêm', 'accent') : '';
    else if (curRank >= 0 && g.rank <= curRank) state = chip(`đã gồm trong ${esc(pkgCode)}`, 'ok');
    else state = chip(nOn ? '+ tính thêm hoặc nâng gói' : 'chọn → cần nâng gói', nOn ? 'accent' : '');
    return `<div class="tier ${g.key !== 'ALL' && g.key !== 'NONE' && curRank >= 0 && g.rank > curRank ? 'above' : ''}">
      <div class="tier-head"><div><b>${title}</b><div class="small muted">${sub}</div></div><div>${state}</div></div>
      ${g.codes.map(feat).join('')}</div>`;
  };
  const cap = pkgCode ? packageCapacity(pkgCode) : null;
  const qty = ([code, label]) => {
    const rq = reqBy[code]; const on = rq?.decision === 'include';
    const gb = code === 'HOSTING_STORAGE';
    const hint = rq && !on && rq.quantity ? `web mẫu ~${num(rq.quantity, 0)}` : gb ? (cap?.hosting_short ? 'gói gồm ' + cap.hosting_short : 'theo gói') : 'không';
    const c = gb && on ? covOf(rq) : null; // dung lượng vượt gói → ghi rõ phần mua thêm
    return `<label class="f">${label}<input type="number" min="0" ${gb ? 'step="0.5"' : ''} class="num" data-qqty="${code}" style="width:130px" value="${on ? esc(rq.quantity ?? '') : ''}" placeholder="${esc(hint)}">${c && c.status !== 'included' ? `<span class="small" style="color:var(--accent)">${esc(c.note)}</span>` : ''}</label>`;
  };
  $app.innerHTML = `
  <div class="row" style="justify-content:space-between">
    <div><a href="#/" class="small">← Danh sách</a><h1 style="margin-top:4px">${esc(p.name)}</h1><div class="muted small">${esc(p.code)}</div></div>
    <a href="#/p/${p.id}/profile" class="small">Nâng cao ▸ (bóc tách giờ công, duyệt, phiên bản)</a>
  </div>
  <div style="display:grid;grid-template-columns:minmax(0,1.4fr) minmax(320px,1fr);gap:14px;margin-top:12px" class="quick">
  <div>
    <div class="panel">
      <h3 style="margin-top:0">1. Khách & web mẫu</h3>
      <div class="grid2">
        <label class="f">Khách hàng<input data-qinfo="customer_name" value="${esc(p.customer_name || '')}"></label>
        <label class="f">Liên hệ<input data-qinfo="customer_contact" value="${esc(p.customer_contact || '')}"></label>
      </div>
      <div style="margin-top:8px">${[...new Map(P.refs.map((x) => [x.url, x])).values()].map((x) => { const ru = runOf(x.url); return `<div class="row" style="gap:8px;margin:4px 0"><a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">${esc(x.url)}</a> ${!ru ? `<button class="link" data-act="surveyAll">Quét web này</button>` : ru.status === 'done' ? chip('đã quét', 'ok') + ` <button class="link small" data-act="rescan" data-id="${x.id}">Quét lại</button>` : ru.status === 'failed' ? `<span title="${esc(ru.error || '')}">${chip('quét lỗi: ' + (ru.error || '').slice(0, 140), 'err')}</span> <button class="link small" data-act="rescan" data-id="${x.id}">Quét lại</button>` : chip('đang quét… (1–4 phút)', 'warn')}</div>`; }).join('')}
        <div class="row" style="margin-top:6px"><input id="newRef" placeholder="Thêm tên miền khác, ví dụ: abc.vn" style="flex:1"><button data-act="addRef">Thêm & quét</button></div></div>
      <label class="f" style="margin-top:10px">Khách cần gì?<textarea id="qBrief" placeholder="Ví dụ: 7 trang, 50 sản phẩm, giỏ hàng, chat Zalo, 2 ngôn ngữ">${esc(p.brief || '')}</textarea></label>
      <p style="margin:6px 0 0"><button data-act="applyBrief">Đọc mô tả → chọn tính năng</button></p>
    </div>
    <div class="panel">
      <h3 style="margin-top:0">${S.quick?.baseline ? '2. Chọn thêm tính năng (tính phát sinh)' : '2. Tính năng cần làm'}</h3>
      ${S.quick?.baseline ? `<p class="small muted" style="margin:0 0 6px">Đã tick sẵn ${S.quick.baseline.count} tính năng thấy trên ${esc(domainLabel(S.quick.baseline.domain))}. Mỗi mục chưa chọn ghi sẵn giá cộng thêm nếu chọn.</p>` : ''}
      ${running.length ? `<p class="checks"><span class="warn">⏳ Đang quét web mẫu — danh sách sẽ tự cập nhật.</span></p>` : ''}
      <div class="row">${QUICK_QTY.map(qty).join('')}</div>
      ${cap ? `<p class="small muted" style="margin:6px 0 0">Gói <b>${esc(pkgCode)}</b> gồm: ~${cap.pages ?? '?'} mẫu trang (${esc(cap.sitemap || '')}) · ${esc(cap.products || '')} · ${esc(cap.posts || '')} · hosting ${esc(cap.hosting || 'theo dự án')}. Vượt số sản phẩm/bài viết/dung lượng sẽ cộng phí mua thêm (gia hạn hằng năm).</p>` : ''}
      <p class="small muted" style="margin:12px 0 6px">Tính năng xếp theo gói matbao.ws: chọn mục ở nhóm cao hơn thì giá chuyển lên gói đó (hoặc tính thêm nếu rẻ hơn).</p>
      <div class="tiers">${featureGroups().map(tierCard).join('')}</div>
    </div>
  </div>
  <div>
    <div class="panel" style="position:sticky;top:64px;border-color:var(--accent)">
      <h3 style="margin-top:0">3. Giá</h3>
      ${priceStepsHtml(P, r, pkg, running)}
      ${!included.length ? (running.length ? '' : `<p class="muted">Nhập tên miền web mẫu (hoặc tick tính năng) để ra giá.</p>`) : `
      <details ${S.quick?.baseline ? '' : 'open'} style="margin-top:8px"><summary class="small">Chi tiết theo gói ${esc(pkg?.code || '')}</summary>
      <table style="margin-top:6px"><tbody>
        ${r.mode === 'package' ? `<tr><td>Giá gói</td><td class="n">${vnd(r.package_price)}</td></tr>` : ''}
        ${(r.addons || []).map((a) => `<tr><td>${esc(a.name)} ×${a.qty}</td><td class="n">${vnd(a.amount)}</td></tr>`).join('')}
        ${Number(r.extras_sell) > 0 ? `<tr><td>Tính thêm ngoài gói</td><td class="n">${vnd(r.extras_sell)}</td></tr>` : ''}
        ${Number(r.discount_amount) > 0 ? `<tr><td>Giảm ${r.discount_pct}%</td><td class="n">− ${vnd(r.discount_amount)}</td></tr>` : ''}
        ${(r.recurring || []).map((x) => `<tr><td class="muted">${esc(x.title)}</td><td class="n muted">${vnd(x.amount)}/${esc(x.period)}</td></tr>`).join('')}
      </tbody></table></details>
      <div class="row" style="margin-top:8px"><label class="f" style="min-width:0">Giảm giá %<input class="num" type="number" step="0.5" min="0" data-pr="discount_pct" value="${esc(p.pricing.discount_pct || 0)}"></label>
        <button class="primary" data-act="printQuick" ${fatal.length ? 'disabled' : ''} style="flex:1;padding:10px">🖨 In báo giá</button></div>
      ${fatal.length ? `<ul class="checks small">${fatal.map((c) => `<li class="error">⛔ ${esc(c.message)}</li>`).join('')}</ul>` : ''}
      ${S.rec?.ranked?.length ? `<h3>Gói khác</h3><table class="small"><tbody>${S.rec.ranked.slice(0, 6).map((x) => `<tr ${x.code === pkgCode ? 'style="font-weight:700"' : ''}><td>${esc(x.code)} <span class="muted">${esc(x.name)}</span></td><td class="n">${trieu(x.price_list)}</td><td>${x.code === pkgCode ? '✓' : `<button class="link" data-act="pickPkg" data-code="${esc(x.code)}">Chọn</button>`}</td></tr>`).join('')}</tbody></table>
        ${p.pricing.package_code ? `<button class="link small" data-act="autoPkg">↺ Tự chọn gói rẻ nhất</button>` : ''}` : ''}
      ${questions.length ? `<h3>Nên hỏi khách</h3><ul class="small" style="margin:0 0 0 16px;padding:0">${questions.slice(0, 6).map((q) => `<li>${esc(q.text)}</li>`).join('')}</ul>` : ''}`}
    </div>
  </div></div>`;
}

const money = (n) => { const a = Math.abs(Number(n) || 0); const s = a >= 1e6 ? (a / 1e6).toLocaleString('vi-VN', { maximumFractionDigits: 1 }) + ' tr' : a ? Math.round(a / 1000).toLocaleString('vi-VN') + 'k' : '0 ₫'; return (n < 0 ? '−' : '') + s; };
const domainLabel = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u || 'web mẫu'; } };

const LEVEL_NAME = { 1: 'Tối giản', 2: 'Cơ bản', 3: 'Tiêu chuẩn', 4: 'Mở rộng', 5: 'Nâng cao', 6: 'Phức tạp', 7: 'Chuyên sâu', 8: 'Cao cấp' };
// Mức may đo theo độ phức tạp web mẫu (quyết định gói tối thiểu); cho phép chỉnh tay
function complexityHtml(Q) {
  const c = Q?.complexity; const lv = Q?.design_level || c?.level;
  if (!c && !lv) return '';
  return `<div class="small" style="margin-top:6px">Độ phức tạp: <select data-qlevel title="Mức may đo quyết định gói tối thiểu">${[1, 2, 3, 4, 5, 6, 7, 8].map((m) => `<option value="${m}" ${m === lv ? 'selected' : ''}>M${m} – ${LEVEL_NAME[m]}${c && m === c.level ? ' (đánh giá)' : ''}</option>`).join('')}</select>
    ${c ? `<span class="muted">${c.score}/${c.max} điểm</span><div class="muted">${esc(c.reasons.join(' · '))}</div>` : ''}</div>
    ${c?.enterprise && lv === c.level ? `<p class="checks" style="margin:6px 0 0"><span class="warn">⚠️ Quy mô vượt gói HERO 8 — matbao.ws xếp loại <b>Enterprise, báo giá riêng</b>. Giá trên là mức tối thiểu.</span></p>` : ''}`;
}

// ① Giá sơ bộ cho web giống web mẫu → ② Phát sinh theo tính năng chọn thêm → Tổng
function priceStepsHtml(P, r, pkg, running) {
  const Q = S.quick;
  if (!Q?.baseline) {
    if (running.length) return `<div class="step"><div class="small muted">① Đánh giá sơ bộ web mẫu</div><div style="font-size:18px;margin:6px 0">⏳ Đang quét ${esc(domainLabel(running[0].url))}…</div><div class="small muted">Giá sơ bộ hiện sau 1–4 phút.</div></div>`;
    if (!P.requirements.some((x) => x.decision === 'include')) return '';
    return `${pkg ? `<div class="small muted">Gói ${P.project.pricing.package_code ? 'đã chọn' : 'đề xuất (rẻ nhất phù hợp)'}</div><div style="font-size:16px"><b>${esc(pkg.code)}</b> – ${esc(pkg.name)}</div>` : ''}
      <div class="big">${vnd(r.price_net)}</div><div class="small">Chưa VAT · Gồm VAT ${r.vat_pct}%: <b>${vnd(r.total_incl_vat)}</b></div>`;
  }
  const b = Q.baseline;
  if (!b.count && !b.package) { // quét xong nhưng không nhận ra gì (web chặn máy quét / trang trống) → không bày giá gốc 0 ₫
    const warn = `<div class="step"><div class="small muted">① Đánh giá sơ bộ web mẫu</div><p class="checks" style="margin:6px 0"><span class="warn">Không nhận ra tính năng nào trên ${esc(domainLabel(b.domain))} — web có thể chặn máy quét. Bấm <b>Quét lại</b> hoặc tick tính năng ở mục 2.</span></p></div>`;
    if (!P.requirements.some((x) => x.decision === 'include')) return warn;
    return `${warn}<div class="step total"><div class="small muted">Tổng báo giá${pkg ? ` · gói ${esc(pkg.code)}` : ''}</div><div class="big">${vnd(r.price_net)}</div><div class="small">Chưa VAT · Gồm VAT ${r.vat_pct}%: <b>${vnd(r.total_incl_vat)}</b></div></div>`;
  }
  const ch = Q.changes || [];
  const tierOf = (code) => { const t = S.meta.feature_tiers?.[code]; return t && !t.all ? ` <span class="muted">· cần ${esc(t.code)}</span>` : !t ? ' <span class="muted">· ngoài gói</span>' : ''; };
  const line = (c) => c.kind === 'added' ? `<li>+ ${esc(c.title)}${Number(c.to) > 1 ? ` (${num(c.to, 0)})` : ''}${tierOf(c.code)}</li>` : c.kind === 'removed' ? `<li>− Bỏ ${esc(c.title)}</li>` : `<li>${esc(c.title)}: ${num(c.from, 0)} → ${num(c.to, 0)}</li>`;
  return `
    <div class="step"><div class="small muted">① Web giống <b>${esc(domainLabel(b.domain))}</b> — đánh giá sơ bộ</div>
      <div class="big2">${vnd(b.price)}</div>
      <div class="small muted">Gói ${esc(b.package || '')}${b.package_name ? ' – ' + esc(b.package_name) : ''} · ${b.count} tính năng thấy trên web mẫu</div>
      ${complexityHtml(Q)}</div>
    <div class="step"><div class="small muted">② Phát sinh theo tính năng chọn thêm</div>
      <div class="big2" style="color:${Q.extra > 0 ? 'var(--accent)' : 'inherit'}">${Q.extra >= 0 ? '+' : '−'} ${vnd(Math.abs(Q.extra))}</div>
      ${ch.length ? `<ul class="small" style="margin:4px 0 0 16px;padding:0">${ch.map(line).join('')}</ul>` : '<div class="small muted">Chưa chọn thêm — tick ở mục 2, mỗi mục ghi sẵn giá cộng thêm.</div>'}
      ${Q.current.package && Q.current.package !== b.package ? `<div class="small">Gói chuyển: ${esc(b.package)} → <b>${esc(Q.current.package)}</b></div>` : ''}</div>
    <div class="step total"><div class="small muted">Tổng báo giá${pkg ? ` · gói ${esc(pkg.code)}` : ''}</div>
      <div class="big">${vnd(r.price_net)}</div><div class="small">Chưa VAT · Gồm VAT ${r.vat_pct}%: <b>${vnd(r.total_incl_vat)}</b></div>
      ${ch.length && can('pricing.edit') ? `<button class="link small" data-act="setBaseline" title="Dùng khi khách chốt phạm vi mới làm mốc">↺ Lấy lựa chọn hiện tại làm giá gốc</button>` : ''}</div>`;
}

// Gợi ý bước kế tiếp để luôn biết vì sao chưa có giá
function nextStepHtml(P) {
  const id = P.project.id;
  const go = (tab, label) => `<a class="chip accent" href="#/p/${id}/${tab}">${label} →</a>`;
  const running = P.runs.filter((r) => r.status === 'queued' || r.status === 'running');
  const failed = P.runs.filter((r) => r.status === 'failed');
  const pending = P.requirements.filter((r) => r.decision === 'pending' || r.decision === 'ask');
  const included = P.requirements.filter((r) => r.decision === 'include');
  const blockingQ = P.questions.filter((q) => q.blocking && q.status === 'open');
  const msgs = [];
  const surveyed = new Set(P.runs.map((r) => r.url));
  const unsurveyed = [...new Set(P.refs.map((r) => r.url).filter((u) => !surveyed.has(u)))];
  if (unsurveyed.length && can('survey.run')) msgs.push(`Có ${unsurveyed.length} web tham khảo chưa khảo sát (${unsurveyed.map(esc).join(', ')}). <button class="primary" data-act="surveyAll">Khảo sát ngay</button>`);
  if (running.length) msgs.push(`⏳ Đang khảo sát ${running.map((r) => esc(r.url)).join(', ')} (1–4 phút). Kết quả sẽ tự tạo yêu cầu.`);
  if (!P.refs.length && !P.requirements.length) msgs.push(`Chưa có dữ liệu: thêm web tham khảo hoặc nhập brief rồi bấm "Phân tích brief". ${go('profile', 'Hồ sơ & brief')}`);
  if (failed.length && !running.length && !P.requirements.length) msgs.push(`⛔ Khảo sát lỗi: ${esc(failed[0].error || '')} ${go('survey', 'Xem chi tiết')}`);
  if (!included.length && pending.length) msgs.push(`Có ${pending.length} yêu cầu chờ quyết định — giá chỉ tính các mục chọn <b>Làm</b>. ${go('reqs', 'Chốt yêu cầu')}`);
  if (included.length) {
    if (P.meta.auto_package) msgs.push(`Giá đang tạm theo gói đề xuất <b>${esc(P.meta.auto_package)}</b>. ${go('price', 'Xem & chốt gói')}`);
    if (P.meta.provisional_lines) msgs.push(`Giờ công đang theo định mức chuẩn. ${go('wbs', 'Sinh dự toán để rà soát')}`);
    if (pending.length) msgs.push(`Còn ${pending.length} yêu cầu chờ quyết định. ${go('reqs', 'Chốt yêu cầu')}`);
    if (blockingQ.length) msgs.push(`Còn ${blockingQ.length} câu hỏi chặn chưa trả lời. ${go('reqs', 'Trả lời')}`);
  }
  if (!msgs.length) return '';
  return `<div class="panel" style="margin-top:10px;border-color:var(--accent)"><b>Bước tiếp theo</b><ul style="margin:6px 0 0 18px;padding:0">${msgs.map((m) => `<li style="margin:3px 0">${m}</li>`).join('')}</ul></div>`;
}

function tabProfile(el) {
  const P = S.project; const p = P.project;
  const sug = S.briefSug;
  el.innerHTML = `
  <div class="grid2">
  <div class="panel">
    <h3 style="margin-top:0">Thông tin hồ sơ</h3>
    <div class="grid2">
      <label class="f">Tên dự án<input data-pf="name" value="${esc(p.name)}"></label>
      <label class="f">Khách hàng<input data-pf="customer_name" value="${esc(p.customer_name || '')}"></label>
      <label class="f">Liên hệ<input data-pf="customer_contact" value="${esc(p.customer_contact || '')}"></label>
      <label class="f">Ngân sách khách (VND)<input data-pf="budget" type="number" value="${esc(p.budget ?? '')}"></label>
    </div>
    <label class="f" style="margin-top:8px">Brief / yêu cầu khách<textarea data-pf="brief" style="min-height:120px">${esc(p.brief || '')}</textarea></label>
    <p class="row"><button data-act="saveProfile" ${can('project.edit') ? '' : 'disabled'}>Lưu</button>
    <button class="primary" data-act="suggestBrief" ${can('requirement.edit') ? '' : 'disabled'}>Phân tích brief → đề xuất yêu cầu</button></p>
    ${sug ? `<div class="panel" style="background:var(--bg)"><b>Đề xuất từ brief</b> <span class="muted small">(${esc(sug.engine)})</span>${sug.warning ? `<div class="chip warn">${esc(sug.warning)}</div>` : ''}
      <table><thead><tr><th></th><th>Tính năng</th><th>Khách muốn?</th><th class="n">SL</th><th>Căn cứ trong brief</th></tr></thead><tbody>
      ${sug.items.map((it, i) => `<tr><td><input type="checkbox" data-sug="${i}" ${it.wanted ? 'checked' : ''}></td><td>${esc(it.title)}</td><td>${it.wanted ? chip('Có', 'ok') : chip('Không làm', 'err')}</td><td class="n">${esc(it.quantity ?? '')}</td><td class="small muted">${esc(it.evidence)}</td></tr>`).join('') || `<tr><td colspan="5" class="muted">Không nhận ra tính năng nào trong brief. Hãy mô tả cụ thể hơn (ví dụ: "7 mẫu trang, 50 sản phẩm, đặt bàn online, chat Zalo, 2 ngôn ngữ"), hoặc chạy khảo sát web tham khảo — kết quả khảo sát tự tạo yêu cầu ở tab "Chốt yêu cầu".</td></tr>`}
      </tbody></table>
      ${sug.open_questions?.length ? `<p class="small"><b>Câu hỏi AI gợi ý:</b></p><ul class="small">${sug.open_questions.map((q) => `<li>${esc(q)}</li>`).join('')}</ul>` : ''}
      ${sug.items.length ? `<p><button class="primary" data-act="applySuggest">Thêm mục đã chọn vào yêu cầu</button> <span class="muted small">Mục "Không làm" được thêm với quyết định Bỏ.</span></p>` : (P.refs.length ? `<p><a class="chip accent" href="#/p/${p.id}/survey">→ Khảo sát web tham khảo</a></p>` : '')}</div>` : ''}
  </div>
  <div class="panel">
    <h3 style="margin-top:0">Web tham khảo</h3>
    <p class="muted small">Ghi rõ phần cần học theo (giao diện, nội dung hay luồng nghiệp vụ), phần giữ, phần sửa.</p>
    <table><tbody>${P.refs.map((r) => `<tr><td><a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.url)}</a>
      <input class="w" data-refnote="${r.id}" placeholder="Phần cần học theo…" value="${esc(r.learn_notes || '')}"></td>
      <td><button class="link" data-act="delRef" data-id="${r.id}">Xóa</button></td></tr>`).join('') || '<tr><td class="muted">Chưa có.</td></tr>'}</tbody></table>
    <div class="row" style="margin-top:8px"><input id="newRef" placeholder="https://web-mau.vn" style="flex:1"><button data-act="addRef">Thêm</button></div>
  </div></div>`;
}

function tabSurvey(el) {
  const P = S.project;
  const evByRun = {};
  for (const e of P.evidence) (evByRun[e.run_id] ||= []).push(e);
  el.innerHTML = `
  <div class="panel">
    <h3 style="margin-top:0">Chạy khảo sát</h3>
    <p class="muted small">Crawler chạy trong tiến trình riêng: chỉ HTTP/HTTPS tới IP công khai, đọc robots.txt, không gửi form, không đăng nhập, không vượt CAPTCHA. Lấy mẫu đại diện theo nhóm mẫu trang (mặc định 20 URL).</p>
    ${P.refs.length ? `<table><tbody>${P.refs.map((r) => `<tr><td>${esc(r.url)}</td><td class="n"><input class="num" type="number" min="1" max="40" value="20" id="mx${r.id}"> URL</td><td><button class="primary" data-act="survey" data-id="${r.id}" ${can('survey.run') ? '' : 'disabled'}>Khảo sát</button></td></tr>`).join('')}</tbody></table>` : '<p>Thêm web tham khảo ở tab Hồ sơ.</p>'}
  </div>
  ${P.runs.map((run) => {
    const c = run.coverage || {}; const ev = evByRun[run.id] || [];
    const pages = ev.filter((e) => e.kind === 'page');
    const mobiles = Object.fromEntries(ev.filter((e) => e.kind === 'page_mobile').map((e) => [e.url, e]));
    return `<div class="panel">
    <div class="row" style="justify-content:space-between"><h3 style="margin:0">Lần khảo sát #${run.id} — ${esc(run.url)}</h3>
      <div>${chip({ queued: 'Đang chờ', running: 'Đang chạy…', done: 'Hoàn tất', failed: 'Lỗi' }[run.status], { done: 'ok', failed: 'err', running: 'warn', queued: 'warn' }[run.status])} <span class="small muted">${esc(run.finished_at || run.created_at)}</span></div></div>
    ${run.error ? `<p class="checks"><span class="error">${esc(run.error)}</span></p>` : ''}
    ${run.status === 'done' || c.discovered != null ? `
    <div class="kpis" style="margin:10px 0">
      <div class="kpi"><div class="l">URL phát hiện</div><div class="v">${num(c.discovered)}</div></div>
      <div class="kpi"><div class="l">Trang đã đọc</div><div class="v">${num(c.read)}</div></div>
      <div class="kpi"><div class="l">Đọc lỗi / bị chặn</div><div class="v">${num(c.failed)}</div></div>
      <div class="kpi"><div class="l">Nhóm mẫu trang</div><div class="v">${num(c.template_groups)}</div></div>
      <div class="kpi"><div class="l">robots.txt</div><div class="v small">${esc(run.robots?.status || '')}${run.robots?.disallowed ? ` · bỏ ${run.robots.disallowed} URL cấm` : ''}</div></div>
      <div class="kpi"><div class="l">Nền tảng</div><div class="v small">${esc(c.generator || 'không rõ')}</div></div>
    </div>
    <p class="small muted">${esc(c.note || '')} ${c.unsampled_groups?.length ? `<b>Nhóm chưa khảo sát:</b> ${c.unsampled_groups.map(esc).join(', ')}.` : ''} Yêu cầu chặn ${num(c.blocked_requests)} request ngoài phạm vi/không phải GET.</p>
    <details><summary>Nhóm mẫu trang (${run.templates.length})</summary><table><thead><tr><th>Mẫu</th><th class="n">Số URL</th><th class="n">Đã đọc</th><th>Ví dụ</th></tr></thead><tbody>
    ${run.templates.map((t) => `<tr><td>${esc(t.template)}</td><td class="n">${num(t.url_count)}</td><td class="n">${t.sampled ?? 0}</td><td class="small">${(t.examples || []).slice(0, 2).map((u) => esc(u)).join('<br>')}</td></tr>`).join('')}</tbody></table></details>
    <h3>Trang mẫu & ảnh dẫn chứng</h3>
    <div class="tablewrap"><table><tbody>${pages.map((e) => {
      const feats = ev.filter((f) => f.kind === 'feature' && f.url === e.url);
      const m = mobiles[e.url];
      return `<tr><td style="width:260px"><div class="thumbs"><a href="/storage/${esc(e.asset_path)}" target="_blank"><img src="/storage/${esc(e.asset_path)}" alt="desktop" style="width:180px"></a>${m ? `<a href="/storage/${esc(m.asset_path)}" target="_blank"><img class="m" src="/storage/${esc(m.asset_path)}" alt="mobile"></a>` : ''}</div></td>
      <td><b>${esc(e.code)}</b> <a href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">${esc(e.url)}</a><div class="small muted">${esc(e.detail)} · ${esc(e.captured_at)} · hash ${esc((e.asset_hash || '').slice(0, 12))}</div>
      <div style="margin-top:6px">${feats.map((f) => `<span title="${esc(f.code + ': ' + f.detail)}">${chip(f.feature + (f.verification !== 'observed' ? ' (suy luận)' : ''), f.verification === 'observed' ? 'ok' : 'warn')}</span>`).join(' ')}</div></td></tr>`;
    }).join('')}
    ${ev.filter((e) => e.kind === 'unreadable').map((e) => `<tr><td>${chip('Chưa kiểm tra được', 'err')}</td><td><b>${esc(e.code)}</b> ${esc(e.url)}<div class="small">${esc(e.detail)}</div></td></tr>`).join('')}
    </tbody></table></div>` : ''}
  </div>`;
  }).join('')}`;
}

function tabReqs(el) {
  const P = S.project; const cat = S.meta.catalog;
  const evMap = Object.fromEntries(P.evidence.map((e) => [e.code, e]));
  el.innerHTML = `
  <div class="panel tablewrap">
    <div class="row" style="justify-content:space-between"><h3 style="margin:0">Danh sách yêu cầu</h3>
      <div>${P.requirements.some((r) => r.decision === 'pending' || r.decision === 'ask') && can('requirement.decide') ? `<button class="primary" data-act="bulkDecide" data-d="include">Làm tất cả mục đang chờ</button> <button data-act="bulkDecide" data-d="exclude">Bỏ tất cả mục đang chờ</button>` : ''}</div></div>
    <p class="muted small">Web mẫu có tính năng không có nghĩa khách cần làm: phạm vi khách xác nhận quyết định việc đưa vào giá. Yêu cầu "Suy luận" cần câu hỏi xác nhận.</p>
    <table><thead><tr><th>Mã</th><th>Yêu cầu</th><th>Nguồn</th><th>Dẫn chứng</th><th class="n">Khối lượng</th><th>Quyết định</th><th>Tiêu chí nghiệm thu</th><th></th></tr></thead><tbody>
    ${P.requirements.map((r) => `<tr class="${r.decision === 'exclude' ? 'excluded' : ''}">
      <td>${esc(r.code)}</td><td>${esc(r.title)}<div class="small muted">${esc(r.feature || '')}</div></td>
      <td>${chip(SRC[r.source_kind][0], SRC[r.source_kind][1])}</td>
      <td class="small">${r.evidence_codes.map((c) => `<span title="${esc(evMap[c] ? evMap[c].url + ' — ' + evMap[c].detail : '')}">${esc(c)}</span>`).join(', ')}</td>
      <td class="n"><input class="num" type="number" step="any" data-rq="${r.id}" data-k="quantity" value="${esc(r.quantity ?? '')}"> <span class="small muted">${esc(r.unit || '')}</span></td>
      <td><select data-rq="${r.id}" data-k="decision" ${can('requirement.decide') ? '' : 'disabled'}>${Object.entries(DEC).map(([k, v]) => `<option value="${k}" ${r.decision === k ? 'selected' : ''}>${v}</option>`).join('')}</select></td>
      <td><input class="w" data-rq="${r.id}" data-k="acceptance" value="${esc(r.acceptance || '')}" placeholder="Đo được: số lượng, thiết bị, quy tắc…"></td>
      <td><button class="link" data-act="delReq" data-id="${r.id}">Xóa</button></td></tr>`).join('') || '<tr><td colspan="8" class="muted">Chưa có yêu cầu. Khảo sát web mẫu, phân tích brief hoặc thêm thủ công.</td></tr>'}
    </tbody></table>
    <div class="row" style="margin-top:10px">
      <label class="f">Thêm yêu cầu khách<select id="nr_feature">${cat.features.map((f) => `<option value="${f.code}">${esc(f.title)}</option>`).join('')}</select></label>
      <label class="f">Khối lượng<input id="nr_qty" type="number" class="num"></label>
      <label class="f" style="flex:1">Tiêu chí nghiệm thu<input id="nr_acc"></label>
      <button data-act="addReq">Thêm</button>
    </div>
  </div>
  <div class="panel">
    <h3 style="margin-top:0">Câu hỏi làm rõ</h3>
    <p class="muted small">Câu hỏi <b>chặn</b> phải được trả lời trước khi phát hành giá cố định; không tự gán công sức bằng 0.</p>
    <table><thead><tr><th>Mã</th><th>Câu hỏi</th><th>Yêu cầu</th><th>Chặn</th><th>Trả lời</th><th>Trạng thái</th></tr></thead><tbody>
    ${P.questions.map((q) => { const r = P.requirements.find((x) => x.id === q.requirement_id); return `<tr class="${q.status === 'dropped' ? 'excluded' : ''}"><td>${esc(q.code)}</td><td>${esc(q.text)}</td><td class="small">${esc(r?.code || 'chung')}</td>
      <td><input type="checkbox" data-q="${q.id}" data-k="blocking" ${q.blocking ? 'checked' : ''}></td>
      <td><input class="w" data-q="${q.id}" data-k="answer" value="${esc(q.answer || '')}"></td>
      <td>${chip({ open: 'Mở', answered: 'Đã trả lời', dropped: 'Bỏ' }[q.status], { open: q.blocking ? 'err' : 'warn', answered: 'ok', dropped: '' }[q.status])}</td></tr>`; }).join('')}
    </tbody></table>
    <div class="row" style="margin-top:8px"><input id="nq_text" placeholder="Câu hỏi mới…" style="flex:1"><label><input type="checkbox" id="nq_block"> chặn</label><button data-act="addQ">Thêm</button></div>
  </div>`;
}

function tabWbs(el) {
  const P = S.project; const cat = S.meta.catalog;
  const resLines = P.preview.lines || [];
  el.innerHTML = `
  <div class="panel">
    <div class="row" style="justify-content:space-between"><h3 style="margin:0">Danh mục công việc (WBS)</h3>
    <div><button class="primary" data-act="genLines" ${can('estimate.edit') ? '' : 'disabled'}>Sinh dự toán từ yêu cầu đã chọn</button></div></div>
    <p class="muted small">Định mức O/M/P (giờ/đơn vị) lấy từ danh mục ${esc(cat.version)}. ${esc(cat.note)} Sửa định mức/khối lượng cần ghi lý do; sinh lại sẽ thay các dòng tự động (giữ dòng thêm tay).</p>
    <div class="tablewrap"><table><thead><tr><th>Mã</th><th>Đầu việc</th><th>Nhóm</th><th>Vai trò</th><th class="n">SL</th><th>Đơn vị</th><th class="n">O</th><th class="n">M</th><th class="n">P</th><th>Tính tiền</th><th>Có</th><th></th></tr></thead><tbody>
    ${P.lines.map((l) => {
      const rl = resLines.filter((x) => x.id === l.id);
      const bill = rl.map((x) => `${x.billing === 'package' ? chip('Trong gói', 'ok') : chip('Ngoài gói', 'accent')}${rl.length > 1 ? ' ×' + x.qty : ''}`).join(' ');
      const note = rl.map((x) => x.coverage_note).filter(Boolean)[0] || '';
      return `<tr class="${l.include ? '' : 'excluded'} ${rl.some((x) => x.billing === 'extra') ? 'extra' : ''}"><td class="small">${esc(l.code || '')}</td><td>${esc(l.title)}${l.source === 'manual' ? ' ' + chip('tay') : ''}<div class="small muted">${esc(l.manual_reason || '')}</div></td>
      <td>${esc(l.grp)}</td><td>${esc(l.role)}</td>
      ${['qty', 'o', 'm', 'p'].map((k) => `<td class="n"><input class="num" type="number" step="any" data-ln="${l.id}" data-k="${k}" value="${esc(l[k])}"></td>`).join('').replace('</td>', `</td><td class="small">${esc(l.unit || '')}</td>`)}
      <td class="small">${P.project.pricing.mode === 'package' ? bill + `<div class="muted">${esc(note)}</div>` : '—'}
        <select data-ln="${l.id}" data-k="billing_override" class="small"><option value="">tự động</option><option value="package" ${l.billing_override === 'package' ? 'selected' : ''}>ép trong gói</option><option value="extra" ${l.billing_override === 'extra' ? 'selected' : ''}>ép ngoài gói</option></select></td>
      <td><input type="checkbox" data-ln="${l.id}" data-k="include" ${l.include ? 'checked' : ''}></td>
      <td><button class="link" data-act="delLine" data-id="${l.id}">Xóa</button></td></tr>`;
    }).join('') || '<tr><td colspan="12" class="muted">Chưa có dòng. Chốt yêu cầu (quyết định "Làm") rồi bấm Sinh dự toán.</td></tr>'}
    </tbody></table></div>
    <details style="margin-top:10px"><summary>+ Thêm dòng thủ công</summary>
      <div class="row" style="margin-top:8px">
        <label class="f">Từ danh mục<select id="nl_code"><option value="">— tự nhập —</option>${cat.items.map((i) => `<option value="${i.code}">${esc(i.code)} · ${esc(i.title)}</option>`).join('')}</select></label>
        <label class="f">Tên<input id="nl_title"></label>
        <label class="f">Nhóm<select id="nl_grp">${Object.entries(cat.groups).map(([k, v]) => `<option value="${k}">${k} · ${esc(v)}</option>`).join('')}</select></label>
        <label class="f">Vai trò<select id="nl_role">${Object.entries(cat.roles).map(([k, v]) => `<option value="${k}">${k} · ${esc(v)}</option>`).join('')}</select></label>
        <label class="f">SL<input id="nl_qty" class="num" type="number" value="1"></label>
        <label class="f">O<input id="nl_o" class="num" type="number" step="any"></label><label class="f">M<input id="nl_m" class="num" type="number" step="any"></label><label class="f">P<input id="nl_p" class="num" type="number" step="any"></label>
        <label class="f" style="flex:1">Lý do *<input id="nl_reason"></label><button data-act="addLine">Thêm</button>
      </div></details>
  </div>
  <div class="grid2">
  <div class="panel"><h3 style="margin-top:0">Rủi ro còn lại (dự phòng = xác suất × chi phí)</h3>
    <p class="muted small">Xác minh rủi ro chưa nằm trong định mức QA/bất lợi để tránh cộng hai lần. Ở chế độ theo gói, dự phòng chỉ áp cho phần ngoài gói.</p>
    <table><thead><tr><th>Rủi ro</th><th class="n">XS %</th><th class="n">Chi phí nếu xảy ra</th><th class="n">Kỳ vọng</th><th>Có</th><th></th></tr></thead><tbody>
    ${P.risks.map((r) => `<tr><td><input class="w" data-rk="${r.id}" data-k="title" value="${esc(r.title)}"></td><td class="n"><input class="num" type="number" data-rk="${r.id}" data-k="prob_pct" value="${r.prob_pct}"></td><td class="n"><input type="number" style="width:120px" data-rk="${r.id}" data-k="impact" value="${r.impact}"></td><td class="n">${vnd(r.prob_pct * r.impact / 100)}</td><td><input type="checkbox" data-rk="${r.id}" data-k="include" ${r.include ? 'checked' : ''}></td><td><button class="link" data-act="delRisk" data-id="${r.id}">Xóa</button></td></tr>`).join('')}
    </tbody></table><p><button data-act="addRisk">+ Rủi ro</button></p></div>
  <div class="panel"><h3 style="margin-top:0">Chi phí ngoài nhân sự (một lần)</h3>
    <table><thead><tr><th>Khoản</th><th class="n">Số tiền</th><th>Có</th><th></th></tr></thead><tbody>
    ${P.external.map((x) => `<tr><td><input class="w" data-ex="${x.id}" data-k="title" value="${esc(x.title)}"></td><td class="n"><input type="number" style="width:130px" data-ex="${x.id}" data-k="amount" value="${x.amount}"></td><td><input type="checkbox" data-ex="${x.id}" data-k="include" ${x.include ? 'checked' : ''}></td><td><button class="link" data-act="delExt" data-id="${x.id}">Xóa</button></td></tr>`).join('') || '<tr><td colspan="4" class="muted">Không có (theme/plugin trả phí, API bên thứ ba…)</td></tr>'}
    </tbody></table><p><button data-act="addExt">+ Khoản chi</button></p></div>
  </div>`;
}

function checksHtml(list) {
  if (!list?.length) return `<p>${chip('Đạt các kiểm tra phát hành', 'ok')}</p>`;
  return `<ul class="checks">${list.map((c) => `<li class="${c.level}">${c.level === 'error' ? '⛔' : '⚠️'} ${esc(c.message)}</li>`).join('')}</ul>`;
}

function tabPrice(el) {
  const P = S.project; const pr = P.project.pricing; const r = P.preview; const pol = S.meta.policy?.data || {};
  const pkgs = S.meta.packages.lines.filter((l) => ['WEB_ZERO', 'WEB_HERO'].includes(l.id)).flatMap((l) => l.packages);
  const care = S.meta.packages.lines.find((l) => l.id === 'WEB_CARE')?.packages || [];
  const sel = pkgs.find((x) => x.code === pr.package_code);
  const rec = S.rec;
  const sc = r.scenarios || {};
  el.innerHTML = `
  <div class="grid2">
  <div class="panel">
    <h3 style="margin-top:0">Chế độ tính giá</h3>
    ${P.meta.auto_package ? `<p class="checks"><span class="warn">⚠️ Chưa chọn gói — đang tạm dùng gói rẻ nhất phù hợp: <b>${esc(P.meta.auto_package)}</b>. Bấm "Tính đề xuất" bên dưới rồi "Chọn" để chốt.</span></p>` : ''}
    ${!P.requirements.some((r) => r.decision === 'include') ? `<p class="checks"><span class="warn">⚠️ Chưa có yêu cầu nào chọn "Làm" nên chưa có giá. Sang tab Chốt yêu cầu.</span></p>` : ''}
    <div class="row">
      <label class="f">Chế độ<select data-pr="mode"><option value="package" ${pr.mode !== 'cost' ? 'selected' : ''}>Theo bảng giá gói matbao.ws</option><option value="cost" ${pr.mode === 'cost' ? 'selected' : ''}>Theo chi phí (C ÷ (1 − g))</option></select></label>
      ${pr.mode !== 'cost' ? `<label class="f">Gói<select data-pr="package_code"><option value="">— chọn gói —</option>${pkgs.map((x) => `<option value="${x.code}" ${x.code === pr.package_code ? 'selected' : ''}>${x.code} · ${esc(x.name)} · ${x.price.min === x.price.max ? trieu(x.price.min) : trieu(x.price.min) + '–' + trieu(x.price.max)}</option>`).join('')}</select></label>
      ${sel && sel.price.min !== sel.price.max ? `<label class="f">Giá gói chọn trong khoảng<input type="number" data-pr="package_price" value="${esc(pr.package_price ?? sel.price.min)}" min="${sel.price.min}" max="${sel.price.max}" step="500000"></label>` : ''}` : ''}
      <label class="f">Giảm giá %<input class="num" type="number" step="0.1" data-pr="discount_pct" value="${esc(pr.discount_pct || 0)}"></label>
      <label class="f">Hiệu lực (ngày)<input class="num" type="number" data-pr="valid_days" value="${esc(pr.valid_days || 30)}"></label>
    </div>
    <label class="f" style="margin-top:8px">Điều kiện thanh toán<input class="w" data-pr="payment_terms" value="${esc(pr.payment_terms || '')}"></label>
    <div class="row" style="margin-top:8px"><label class="f">Thêm dịch vụ định kỳ Web Care<select id="careSel"><option value="">— không —</option>${care.map((c) => `<option value="${c.code}">${c.code} · ${esc(c.name)} · ${vnd(c.price.min)}/tháng</option>`).join('')}</select></label><button data-act="addCare">Thêm</button></div>
    ${(pr.recurring || []).length ? `<table style="margin-top:6px"><tbody>${pr.recurring.map((x, i) => `<tr><td>${esc(x.title)}</td><td class="n">${vnd(x.amount)}/${esc(x.period)}</td><td><button class="link" data-act="delRecurring" data-i="${i}">Xóa</button></td></tr>`).join('')}</tbody></table>` : ''}
    <p class="small muted">Chính sách ${esc(P.meta.policy?.version)}: biên mục tiêu ${pol.target_margin_pct}%, tối thiểu ${pol.min_margin_pct}%, VAT ${pol.vat_pct}%, sales giảm tối đa ${pol.sales_max_discount_pct}%, chi phí gói chuẩn ≈ ${pol.package_cost_pct ?? 60}% giá niêm yết. Đơn giá ${esc(P.meta.rate_card?.version)}. Dữ liệu gói lấy lúc ${esc(P.meta.packages_captured_at)}.</p>
  </div>
  <div class="panel">
    <h3 style="margin-top:0">Kết quả nội bộ</h3>
    <div class="kpis">
      ${r.mode === 'package' ? `<div class="kpi"><div class="l">Giá gói</div><div class="v">${vnd(r.package_price)}</div></div><div class="kpi"><div class="l">Add-on</div><div class="v">${vnd(r.addons_total)}</div></div><div class="kpi"><div class="l">Phần ngoài gói</div><div class="v">${vnd(r.extras_sell)}</div></div>` : ''}
      <div class="kpi"><div class="l">Giá niêm yết</div><div class="v">${vnd(r.price_list)}</div></div>
      <div class="kpi hi"><div class="l">Giá sau giảm (trước thuế)</div><div class="v">${vnd(r.price_net)}</div></div>
      <div class="kpi"><div class="l">Tổng gồm VAT ${r.vat_pct ?? ''}%</div><div class="v">${vnd(r.total_incl_vat)}</div></div>
      <div class="kpi"><div class="l">Chi phí dự toán C</div><div class="v">${vnd(r.cost_total)}</div></div>
      <div class="kpi"><div class="l">Giá sàn (biên ${r.min_margin_pct}%)</div><div class="v">${vnd(r.floor)}</div></div>
      <div class="kpi"><div class="l">Biên thực tế</div><div class="v">${num(r.margin_realized_pct)}%</div></div>
      <div class="kpi"><div class="l">Giảm tối đa còn được</div><div class="v">${num(r.max_discount_pct)}%</div></div>
      <div class="kpi"><div class="l">Giờ công M / PERT</div><div class="v">${num(r.hours?.m)} / ${num(r.hours?.pert)}</div></div>
    </div>
    ${r.mode === 'package' ? `<p class="small muted">Giờ công trong gói quy tiền: ${vnd(r.package_effort_cost)} — chỉ tham khảo năng lực; chi phí gói tính theo ${r.package_cost_pct}% giá niêm yết.</p>` : ''}
    <p class="small muted">${num(r.hours?.m)} giờ là công sức nhiều vai trò, không tự quy đổi thành ngày lịch (≈ ${num((r.hours?.m || 0) / 6, 1)} ngày công 6 giờ nếu một người làm, chưa gồm thời gian chờ duyệt).</p>
  </div></div>

  <div class="grid2">
  <div class="panel"><h3 style="margin-top:0">Kịch bản giá</h3>
    <table><thead><tr><th>Kịch bản</th><th class="n">Nhân sự</th><th class="n">Ngoài nhân sự</th><th class="n">Dự phòng</th><th class="n">Chi phí C</th><th class="n">Giá bán</th></tr></thead><tbody>
    ${[['o', 'Thuận lợi'], ['m', 'Cơ sở'], ['p', 'Bất lợi']].map(([k, l]) => sc[k] ? `<tr><td>${l}</td><td class="n">${trieu(sc[k].labor)}</td><td class="n">${trieu(sc[k].external)}</td><td class="n">${trieu(sc[k].risk)}</td><td class="n">${trieu(sc[k].cost)}</td><td class="n"><b>${trieu(sc[k].price)}</b></td></tr>` : '').join('')}
    </tbody></table>
    <p class="small muted">Phân tích tình huống với cùng biên — không phải khoảng tin cậy thống kê.</p>
    <div class="row"><label class="f">Dự phòng kịch bản thuận lợi (ghi đè)<input type="number" data-pr="risk_override.o" value="${esc(pr.risk_override?.o ?? '')}"></label><label class="f">Dự phòng kịch bản bất lợi (ghi đè)<input type="number" data-pr="risk_override.p" value="${esc(pr.risk_override?.p ?? '')}"></label></div>
  </div>
  <div class="panel"><h3 style="margin-top:0">Kiểm tra phát hành giá cố định</h3>${checksHtml(P.release_checks)}
    ${(r.addons || []).length ? `<h3>Add-on tự động theo khối lượng</h3><table><tbody>${r.addons.map((a) => `<tr><td>${esc(a.name)}<div class="small muted">${esc(a.reason || '')}</div></td><td class="n">${a.qty} × ${vnd(a.unit_price)}</td><td class="n">${vnd(a.amount)}</td></tr>`).join('')}</tbody></table>` : ''}
  </div></div>

  <div class="panel">
    <div class="row" style="justify-content:space-between"><h3 style="margin:0">So sánh & đề xuất gói matbao.ws</h3><button class="primary" data-act="recommend">Tính đề xuất</button></div>
    <p class="muted small">Với mỗi gói ZERO/HERO: đối chiếu yêu cầu đã chọn với bảng tiêu chí trên matbao.ws → phần có trong gói không tính lại; vượt hạn mức SP/bài viết mua add-on; tính năng không có trong gói tính theo chi phí ÷ (1 − g). Xếp theo tổng giá.</p>
    ${rec ? `<div class="tablewrap"><table><thead><tr><th>Gói</th><th class="n">Giá gói</th><th class="n">Tổng giá</th><th>Add-on</th><th>Phần ngoài gói</th><th></th></tr></thead><tbody>
    ${rec.ranked.map((x, i) => `<tr><td><b>${esc(x.code)}</b> ${esc(x.name)} ${i === 0 ? chip('Rẻ nhất', 'ok') : ''}${x.below_floor ? chip('dưới giá sàn', 'err') : ''}</td><td class="n">${x.package_price.min === x.package_price.max ? trieu(x.package_price.min) : trieu(x.package_price.min) + '–' + trieu(x.package_price.max)}</td><td class="n"><b>${trieu(x.price_list)}</b></td>
      <td class="small">${x.addons.map((a) => `${esc(a.name)} ×${a.qty}`).join('<br>') || '—'}</td><td class="small">${x.extra_lines.slice(0, 6).map(esc).join('<br>') || '—'}${x.extra_lines.length > 6 ? `<br>… +${x.extra_lines.length - 6}` : ''}</td>
      <td><button data-act="pickPkg" data-code="${esc(x.code)}" ${can('pricing.edit') ? '' : 'disabled'}>Chọn</button></td></tr>`).join('')}
    ${rec.ineligible.map((x) => `<tr class="excluded"><td>${esc(x.code)} ${esc(x.name)}</td><td class="n">${trieu(x.package_price.min)}</td><td colspan="4" class="small">Không phù hợp: ${esc(x.blocker)}</td></tr>`).join('')}
    </tbody></table></div>` : ''}
  </div>`;
}

function tabVersions(el) {
  const P = S.project; const V = S.versionView;
  el.innerHTML = `
  <div class="panel">
    <div class="row" style="justify-content:space-between"><h3 style="margin:0">Phiên bản báo giá</h3>
      <button class="primary" data-act="newVersion" ${can('version.create') ? '' : 'disabled'}>Tạo phiên bản từ dữ liệu hiện tại</button></div>
    <p class="muted small">Mỗi phiên bản lưu snapshot bất biến: yêu cầu, câu trả lời, định mức, đơn giá, chính sách, gói và kết quả tính. Sửa sau khi duyệt phải tạo phiên bản mới; bản cũ giữ nguyên để đối chiếu.</p>
    ${checksHtml(P.release_checks)}
    <table><thead><tr><th>Bản</th><th>Mã báo giá</th><th>Trạng thái</th><th class="n">Giá trước thuế</th><th>Tạo bởi</th><th>Duyệt</th><th>Hiệu lực</th><th></th></tr></thead><tbody>
    ${P.versions.map((v) => `<tr><td>V${v.version}${v.input_hash === P.input_hash ? ' ' + chip('khớp dữ liệu hiện tại', 'ok') : ''}</td><td>${esc(v.quote_code)}</td><td>${chip(VSTATUS[v.status], STATUS_CHIP[v.status])}${v.review_note ? `<div class="small muted">${esc(v.review_note)}</div>` : ''}</td>
      <td class="n">${vnd(v.price_net)}</td><td class="small">${esc(v.created_by_name)}<br>${esc(v.created_at)}</td><td class="small">${esc(v.approved_by_name || '')}<br>${esc(v.approved_at || '')}</td><td>${esc(v.valid_until)}</td>
      <td class="small">
        <button class="link" data-act="viewVersion" data-id="${v.id}">Chi tiết</button>
        ${v.status === 'draft' ? `<button class="link" data-act="vAct" data-id="${v.id}" data-a="submit">Gửi duyệt</button>` : ''}
        ${v.status === 'pending' && can('version.approve') ? `<button class="link" data-act="vAct" data-id="${v.id}" data-a="approve">Duyệt</button><button class="link" data-act="vAct" data-id="${v.id}" data-a="reject">Từ chối</button>` : ''}
        <a href="/quote/${v.id}?preview=1" target="_blank">Xem bản khách</a>
        ${v.status === 'approved' ? ` · <a href="/quote/${v.id}/pdf">PDF</a>` : ''}
      </td></tr>`).join('') || '<tr><td colspan="8" class="muted">Chưa có phiên bản.</td></tr>'}
    </tbody></table>
  </div>
  ${V ? versionDetail(V) : ''}`;
}

function versionDetail(V) {
  const P = S.project;
  const prev = V.prev;
  const r = V.result; const pr = prev?.result;
  const reqDiff = [];
  if (prev) {
    const old = Object.fromEntries(prev.snapshot.requirements.map((x) => [x.code, x]));
    for (const x of V.snapshot.requirements) {
      const o = old[x.code];
      if (!o) reqDiff.push(`+ ${x.code} ${x.title} (${DEC[x.decision]})`);
      else if (o.decision !== x.decision || o.quantity !== x.quantity) reqDiff.push(`~ ${x.code} ${x.title}: ${DEC[o.decision]} ${o.quantity ?? ''} → ${DEC[x.decision]} ${x.quantity ?? ''}`);
    }
    for (const o of prev.snapshot.requirements) if (!V.snapshot.requirements.find((x) => x.code === o.code)) reqDiff.push(`− ${o.code} ${o.title}`);
  }
  const d = (a, b) => (b == null ? '' : ` <span class="small muted">(${a - b >= 0 ? '+' : ''}${trieu(a - b)})</span>`);
  return `<div class="panel"><h3 style="margin-top:0">${esc(V.quote_code)} — chi tiết ${prev ? `so với V${prev.version}` : ''}</h3>
    <div class="kpis">
      <div class="kpi"><div class="l">Giá trước thuế</div><div class="v">${vnd(r.price_net)}${d(r.price_net, pr?.price_net)}</div></div>
      <div class="kpi"><div class="l">Chi phí C</div><div class="v">${vnd(r.cost_total)}${d(r.cost_total, pr?.cost_total)}</div></div>
      <div class="kpi"><div class="l">Giờ M</div><div class="v">${num(r.hours?.m)}</div></div>
      <div class="kpi"><div class="l">Gói</div><div class="v small">${esc(V.snapshot.input.package?.code || 'theo chi phí')}</div></div>
    </div>
    <p class="small muted">Đơn giá ${esc(V.snapshot.meta.rate_card?.version)} · chính sách ${esc(V.snapshot.meta.policy?.version)} · danh mục ${esc(V.snapshot.meta.catalog_version)} · dữ liệu gói ${esc(V.snapshot.meta.packages_captured_at)}</p>
    ${prev ? `<h3>Thay đổi yêu cầu</h3>${reqDiff.length ? `<ul class="small">${reqDiff.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="small muted">Không đổi.</p>'}` : ''}
    <h3>Kiểm tra lúc tạo</h3>${checksHtml(V.snapshot.release_checks)}
    <details><summary>Dòng tính tiền (${r.lines.length})</summary><table><thead><tr><th>Đầu việc</th><th>Vai trò</th><th class="n">Giờ M</th><th class="n">Chi phí M</th><th>Tính</th></tr></thead><tbody>
    ${r.lines.map((l) => `<tr><td>${esc(l.title)}</td><td>${esc(l.role)}</td><td class="n">${num(l.hours_m)}</td><td class="n">${vnd(l.cost_m)}</td><td>${esc(l.billing)}</td></tr>`).join('')}</tbody></table></details>
  </div>`;
}

function tabActuals(el) {
  const P = S.project;
  const approved = P.versions.find((v) => v.status === 'approved');
  el.innerHTML = `<div class="panel"><h3 style="margin-top:0">Giờ thực tế sau bàn giao</h3>
    <p class="muted small">Tách giờ phạm vi gốc, thay đổi được duyệt, sửa lỗi và làm lại do thiếu yêu cầu. Dữ liệu dùng để hiệu chỉnh định mức (WAPE, sai lệch có hướng).</p>
    ${!approved && !P.actuals.length ? '<p>Chưa có phiên bản đã duyệt.</p>' : `
    <table id="actTbl"><thead><tr><th>Mã</th><th>Đầu việc</th><th>Nhóm</th><th class="n">Giờ dự toán</th><th class="n">Giờ thực tế</th><th>Phạm vi</th><th>Nguyên nhân chênh lệch</th></tr></thead><tbody></tbody></table>
    <p><button data-act="actPrefill" data-id="${approved?.id || ''}" ${approved ? '' : 'disabled'}>Nạp đầu việc từ bản đã duyệt</button> <button data-act="actAdd">+ Dòng phát sinh</button> <button class="primary" data-act="actSave" data-id="${approved?.id || ''}">Lưu</button></p>`}
  </div>`;
  if (approved || P.actuals.length) fillActuals(P.actuals);
}
function fillActuals(rows) {
  const tb = document.querySelector('#actTbl tbody');
  tb.innerHTML = rows.map((r) => `<tr><td><input data-a="code" value="${esc(r.code || '')}" style="width:120px"></td><td><input data-a="title" class="w" value="${esc(r.title)}"></td><td><input data-a="grp" value="${esc(r.grp || '')}" style="width:60px"></td>
    <td class="n"><input data-a="hours_estimated" class="num" type="number" step="any" value="${esc(r.hours_estimated)}"></td><td class="n"><input data-a="hours_actual" class="num" type="number" step="any" value="${esc(r.hours_actual ?? '')}"></td>
    <td><select data-a="scope">${['original', 'change', 'bugfix', 'rework'].map((s) => `<option value="${s}" ${r.scope === s ? 'selected' : ''}>${{ original: 'Phạm vi gốc', change: 'Thay đổi đã duyệt', bugfix: 'Sửa lỗi', rework: 'Làm lại do thiếu yêu cầu' }[s]}</option>`).join('')}</select></td>
    <td><input data-a="cause" class="w" value="${esc(r.cause || '')}"></td></tr>`).join('');
}

async function tabLog(el) {
  const rows = await api(`/api/projects/${S.project.project.id}/audit`);
  el.innerHTML = `<div class="panel tablewrap"><table><thead><tr><th>Thời gian</th><th>Người</th><th>Đối tượng</th><th>Hành động</th><th>Trước</th><th>Sau</th><th>Lý do</th></tr></thead><tbody>
  ${rows.map((a) => `<tr><td class="small">${esc(a.at)}</td><td>${esc(a.user_name || 'hệ thống')}</td><td>${esc(a.entity)} #${esc(a.entity_id ?? '')}</td><td>${esc(a.action)}</td><td class="small muted">${esc((a.before_json || '').slice(0, 160))}</td><td class="small muted">${esc((a.after_json || '').slice(0, 160))}</td><td class="small">${esc(a.reason || '')}</td></tr>`).join('')}
  </tbody></table></div>`;
}

// ---------- gói matbao.ws ----------
async function viewPackages() {
  const d = S.meta.packages;
  const lineId = S.pkgLine || 'WEB_HERO';
  const line = d.lines.find((l) => l.id === lineId);
  $app.innerHTML = `<div class="row" style="justify-content:space-between"><div><h1>Gói dịch vụ matbao.ws</h1>
    <div class="muted">Nguồn: <a href="${esc(d.source)}" target="_blank" rel="noopener">${esc(d.source)}</a> · đồng bộ lúc ${esc(d.captured_at)} · ${esc(d.note)}</div></div>
    <button class="primary" data-act="syncPkgs" ${can('packages.sync') ? '' : 'disabled'}>Đồng bộ lại từ website</button></div>
  <nav class="tabs">${d.lines.map((l) => `<a href="javascript:void 0" data-act="pkgLine" data-id="${l.id}" class="${l.id === lineId ? 'on' : ''}">${esc(l.title)} (${l.packages.length})</a>`).join('')}</nav>
  <p class="small"><a href="${esc(line.source_url)}" target="_blank" rel="noopener">${esc(line.source_url)}</a></p>
  <div class="pkgs">${line.packages.map((p) => `<div class="pkg"><div class="row" style="justify-content:space-between"><b>${esc(p.code)}</b><span class="small muted">${esc(p.name)}</span></div>
    <div class="price">${p.price.min === p.price.max ? vnd(p.price.min) : trieu(p.price.min) + ' – ' + trieu(p.price.max)}${line.unit === 'monthly' ? '<span class="small">/tháng</span>' : line.unit === 'per_run' ? '<span class="small">/lần</span>' : ''}</div>
    ${p.renewal_per_year ? `<div class="small">Gia hạn: ${vnd(p.renewal_per_year)}/năm</div>` : ''}
    ${p.hosting ? `<div class="small muted">${esc(p.hosting)} · ${esc(p.products)} · ${esc(p.posts)}</div>` : ''}
    ${p.need ? `<div class="small" style="margin-top:4px"><i>${esc(p.need)}</i></div>` : ''}
    <ul>${(p.highlights || []).map((h) => `<li>${esc(h)}</li>`).join('')}</ul></div>`).join('')}</div>
  ${line.criteria.length ? `<h2>Bảng tiêu chí (${line.criteria.length})</h2><div class="panel tablewrap" style="max-height:70vh;overflow:auto"><table class="sticky-head"><thead><tr><th>#</th><th>Tiêu chí</th>${line.packages.map((p) => `<th>${esc(p.code)}</th>`).join('')}</tr></thead><tbody>
    ${line.criteria.map((c) => `<tr><td>${c.no}</td><td>${esc(c.title)}<div class="small muted">${esc(c.desc)}</div></td>${line.packages.map((p) => `<td class="small">${esc(p.features?.[c.no] ?? '')}</td>`).join('')}</tr>`).join('')}
  </tbody></table></div>` : ''}
  ${d.addons?.length ? `<h2>Add-on niêm yết</h2><div class="panel"><table><tbody>${d.addons.map((a) => `<tr><td>${esc(a.name)}</td><td class="n">${vnd(a.price)} / ${esc(a.unit)}</td><td class="small muted">${esc(a.source)}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
}

// ---------- cấu hình ----------
function viewSettings() {
  const m = S.meta; const cat = m.catalog;
  const rc = m.rate_card; const pol = m.policy;
  const polFields = [['target_margin_pct', 'Biên mục tiêu %'], ['min_margin_pct', 'Biên tối thiểu %'], ['vat_pct', 'VAT %'], ['overhead_pct', 'Chi phí chung % (nếu đơn giá chưa gồm)'], ['package_cost_pct', 'Chi phí gói chuẩn % giá niêm yết'], ['sales_max_discount_pct', 'Sales giảm tối đa %'], ['hosting_gb_price_year', 'Giá thêm 1 GB hosting / năm (VND, giả định)'], ['rounding_step', 'Bước làm tròn (VND)'], ['quote_valid_days', 'Hiệu lực báo giá (ngày)']];
  const today = new Date().toISOString().slice(0, 10);
  $app.innerHTML = `<h1>Đơn giá & chính sách</h1>
  <p class="muted">Mỗi thay đổi tạo phiên bản mới có ngày hiệu lực. Báo giá đã duyệt giữ snapshot giá trị cũ nên không bị ảnh hưởng. ${can('settings.edit') ? '' : 'Chỉ quản lý giá / quản trị được sửa.'}</p>
  <div class="grid2">
  <div class="panel"><h3 style="margin-top:0">Bảng đơn giá chi phí nội bộ — ${esc(rc?.version)} (từ ${esc(rc?.effective_from)})</h3><p class="small muted">${esc(rc?.note || '')}</p>
    <table><tbody>${Object.entries(cat.roles).map(([k, v]) => `<tr><td>${k}</td><td>${esc(v)}</td><td class="n"><input type="number" data-rc="${k}" value="${esc(rc?.data[k] ?? '')}" style="width:120px"> ₫/giờ</td></tr>`).join('')}</tbody></table>
    <div class="row" style="margin-top:8px"><label class="f">Mã phiên bản mới<input id="rc_ver" value="RC-${today}"></label><label class="f">Hiệu lực từ<input id="rc_from" type="date" value="${today}"></label><label class="f" style="flex:1">Ghi chú<input id="rc_note"></label><button class="primary" data-act="saveRc" ${can('settings.edit') ? '' : 'disabled'}>Lưu phiên bản</button></div></div>
  <div class="panel"><h3 style="margin-top:0">Chính sách giá — ${esc(pol?.version)} (từ ${esc(pol?.effective_from)})</h3><p class="small muted">${esc(pol?.note || '')}</p>
    <div class="grid2">${polFields.map(([k, l]) => `<label class="f">${l}<input type="number" step="any" data-pol="${k}" value="${esc(pol?.data[k] ?? '')}"></label>`).join('')}
    <label class="f">Kiểu làm tròn<select data-pol="rounding_mode">${['up', 'nearest', 'down'].map((x) => `<option ${pol?.data.rounding_mode === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label></div>
    <label class="f">Điều kiện thanh toán mặc định<input data-pol="default_payment_terms" value="${esc(pol?.data.default_payment_terms || '')}"></label>
    <div class="row" style="margin-top:8px"><label class="f">Mã phiên bản mới<input id="pol_ver" value="POL-${today}"></label><label class="f">Hiệu lực từ<input id="pol_from" type="date" value="${today}"></label><button class="primary" data-act="savePol" ${can('settings.edit') ? '' : 'disabled'}>Lưu phiên bản</button></div></div>
  </div>
  <div class="panel"><h3 style="margin-top:0">Lịch sử phiên bản</h3><table><thead><tr><th>Loại</th><th>Phiên bản</th><th>Hiệu lực</th><th>Người duyệt</th><th>Giá trị</th></tr></thead><tbody>
    ${m.settings.map((s) => `<tr><td>${s.kind}</td><td>${esc(s.version)}</td><td>${esc(s.effective_from)} → ${esc(s.effective_to || 'nay')}</td><td>${esc(s.approved_by_name || '')}</td><td class="small muted">${esc(JSON.stringify(s.data))}</td></tr>`).join('')}</tbody></table></div>
  <div class="panel tablewrap"><h3 style="margin-top:0">Danh mục định mức ${esc(cat.version)}</h3><p class="small muted">${esc(cat.note)} Sửa trong <code>data/catalog.json</code>.</p>
    <table><thead><tr><th>Mã</th><th>Đầu việc</th><th>Nhóm</th><th>Vai trò</th><th>Đơn vị</th><th class="n">O</th><th class="n">M</th><th class="n">P</th><th>Tiêu chí hoàn thành</th></tr></thead><tbody>
    ${cat.items.map((i) => `<tr><td class="small">${i.code}</td><td>${esc(i.title)}</td><td>${i.group}</td><td>${i.role}</td><td>${esc(i.unit)}</td><td class="n">${i.o}</td><td class="n">${i.m}</td><td class="n">${i.p}</td><td class="small muted">${esc(i.done)}</td></tr>`).join('')}</tbody></table></div>`;
}

async function viewMetrics() {
  const m = await api('/api/metrics');
  $app.innerHTML = `<h1>Hiệu chỉnh độ chính xác</h1><p class="muted">${esc(m.note)}</p>
  <div class="kpis"><div class="kpi"><div class="l">Hồ sơ đủ dữ liệu</div><div class="v">${m.n}</div></div>
    <div class="kpi"><div class="l">WAPE giờ công</div><div class="v">${m.wape_pct == null ? '—' : num(m.wape_pct) + '%'}</div></div>
    <div class="kpi"><div class="l">Sai lệch có hướng (âm = thiếu)</div><div class="v">${m.bias_pct == null ? '—' : num(m.bias_pct) + '%'}</div></div>
    <div class="kpi"><div class="l">Tỷ lệ ước lượng thiếu &gt;20%</div><div class="v">${m.under20_pct == null ? '—' : num(m.under20_pct) + '%'}</div></div></div>
  <div class="grid2" style="margin-top:14px">
  <div class="panel"><h3 style="margin-top:0">Theo hồ sơ</h3><table><thead><tr><th>Hồ sơ</th><th class="n">Dự toán</th><th class="n">Thực tế</th><th class="n">Thay đổi phạm vi</th></tr></thead><tbody>
  ${m.projects.map((p) => `<tr><td><a href="#/p/${p.id}">${esc(p.code)}</a> ${esc(p.name)}</td><td class="n">${num(p.est)}</td><td class="n">${num(p.act)}</td><td class="n">${num(p.change_hours)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">Chưa có giờ thực tế.</td></tr>'}</tbody></table></div>
  <div class="panel"><h3 style="margin-top:0">Theo nhóm công việc</h3><table><thead><tr><th>Nhóm</th><th class="n">Dự toán</th><th class="n">Thực tế</th><th class="n">Lệch</th></tr></thead><tbody>
  ${m.by_group.map((g) => `<tr><td>${esc(g.grp || '—')}</td><td class="n">${num(g.est)}</td><td class="n">${num(g.act)}</td><td class="n">${g.act ? num(((g.est - g.act) / g.act) * 100) + '%' : '—'}</td></tr>`).join('')}</tbody></table></div></div>`;
}

// ---------- sự kiện ----------
const pid = () => S.project.project.id;
const val = (id) => document.getElementById(id)?.value?.trim();
// Ô "thêm mới" đã dùng xong → trả về rỗng để không bị khôi phục chữ cũ
const clearFields = (...ids) => ids.forEach((id) => { const el = document.getElementById(id); if (el) el.value = el.defaultValue = ''; });
const run = (fn) => async (el) => { try { el.disabled = true; await fn(el); } catch (e) { toast(e.message, true); } finally { el.disabled = false; } };

const ACT = {
  createProject: run(async () => {
    const { id } = await api('/api/projects', 'POST', { customer_name: val('np_customer'), brief: val('np_brief'), ref_urls: [val('np_domain')].filter(Boolean) });
    location.hash = `#/p/${id}`;
  }),
  applyBrief: run(async () => { const r = await api(`/api/projects/${pid()}/brief-apply`, 'POST', { brief: document.getElementById('qBrief').value }); toast(r.found ? `Đã nhận ra ${r.found} tính năng từ mô tả` : 'Không nhận ra tính năng nào — hãy tick tay ở mục 2', !r.found); reload(); }),
  printQuick: (el) => { window.open(`/quote/project/${pid()}`, '_blank'); },
  autoPkg: run(async () => { await savePricing({ package_code: null, package_price: null }); }),
  setBaseline: run(async () => { if (!confirm('Lấy các tính năng đang chọn làm giá gốc? Phần phát sinh sẽ tính lại từ 0.')) return; await api(`/api/projects/${pid()}/baseline`, 'POST', {}); toast('Đã đặt giá gốc mới'); reload(); }),
  saveProfile: run(async () => {
    const b = { rev: S.project.project.rev };
    document.querySelectorAll('[data-pf]').forEach((i) => { b[i.dataset.pf] = i.value; });
    await api(`/api/projects/${pid()}`, 'PUT', b); toast('Đã lưu'); reload();
  }),
  suggestBrief: run(async () => {
    const brief = document.querySelector('[data-pf=brief]').value;
    if (!brief.trim()) {
      S.briefSug = null;
      toast(S.project.refs.length
        ? 'Brief đang trống. Nhập yêu cầu của khách, hoặc sang tab "Khảo sát web mẫu" để phân tích web tham khảo.'
        : 'Brief đang trống — nhập yêu cầu của khách trước khi phân tích.', true);
      return;
    }
    S.briefSug = await api(`/api/projects/${pid()}/brief-suggest`, 'POST', { brief }); renderProject();
  }),
  applySuggest: run(async () => {
    const items = [...document.querySelectorAll('[data-sug]')].filter((c) => c.checked).map((c) => S.briefSug.items[Number(c.dataset.sug)]);
    for (const it of items) await api(`/api/projects/${pid()}/requirements`, 'POST', { feature: it.feature, quantity: it.quantity ?? undefined, acceptance: it.acceptance, notes: 'Từ brief: ' + it.evidence, decision: it.wanted ? 'pending' : 'exclude' });
    for (const q of S.briefSug.open_questions || []) await api(`/api/projects/${pid()}/questions`, 'POST', { text: q, blocking: false });
    S.briefSug = null; toast(`Đã thêm ${items.length} yêu cầu`); location.hash = `#/p/${pid()}/reqs`;
  }),
  addRef: run(async () => { const r = await api(`/api/projects/${pid()}/refs`, 'POST', { url: val('newRef') }); toast(r.survey_run_id ? 'Đã thêm và bắt đầu khảo sát web này' : 'Đã thêm web tham khảo'); clearFields('newRef'); reload(); }),
  rescan: run(async (el) => { await api(`/api/projects/${pid()}/survey`, 'POST', { ref_id: Number(el.dataset.id) }); toast('Đang quét lại web mẫu (1–4 phút)'); reload(); }),
  surveyAll: run(async () => { const r = await api(`/api/projects/${pid()}/survey-all`, 'POST', {}); toast(`Đã bắt đầu khảo sát ${r.queued} web`); reload(); }),
  bulkDecide: run(async (el) => {
    const d = el.dataset.d;
    if (!confirm(d === 'include' ? 'Đánh dấu LÀM cho tất cả yêu cầu đang chờ / hỏi lại?' : 'Đánh dấu BỎ cho tất cả yêu cầu đang chờ / hỏi lại?')) return;
    const r = await api(`/api/projects/${pid()}/requirements/bulk-decision`, 'POST', { decision: d }); toast(`Đã cập nhật ${r.n} yêu cầu`); reload();
  }),
  delRef: run(async (el) => { if (confirm('Xóa web tham khảo?')) { await api(`/api/refs/${el.dataset.id}`, 'DELETE'); reload(); } }),
  survey: run(async (el) => { await api(`/api/projects/${pid()}/survey`, 'POST', { ref_id: Number(el.dataset.id), max_urls: Number(val('mx' + el.dataset.id)) }); toast('Đã đưa vào hàng đợi khảo sát'); reload(); }),
  addReq: run(async () => { await api(`/api/projects/${pid()}/requirements`, 'POST', { feature: val('nr_feature'), quantity: val('nr_qty') ? Number(val('nr_qty')) : undefined, acceptance: val('nr_acc') }); clearFields('nr_qty', 'nr_acc'); reload(); }),
  delReq: run(async (el) => { if (confirm('Xóa yêu cầu (kèm câu hỏi và dòng dự toán liên quan)?')) { await api(`/api/requirements/${el.dataset.id}`, 'DELETE'); reload(); } }),
  addQ: run(async () => { await api(`/api/projects/${pid()}/questions`, 'POST', { text: val('nq_text'), blocking: document.getElementById('nq_block').checked }); clearFields('nq_text'); reload(); }),
  genLines: run(async () => { if (S.project.lines.some((l) => l.source === 'auto') && !confirm('Sinh lại sẽ thay toàn bộ dòng tự động (dòng thêm tay được giữ). Tiếp tục?')) return; const r = await api(`/api/projects/${pid()}/estimate/generate`, 'POST', {}); toast(`Đã sinh ${r.lines} dòng`); reload(); }),
  addLine: run(async () => {
    const code = val('nl_code'); const it = S.meta.catalog.items.find((i) => i.code === code);
    await api(`/api/projects/${pid()}/lines`, 'POST', { code: code || null, title: val('nl_title') || it?.title, grp: it?.group || val('nl_grp'), role: it?.role || val('nl_role'), unit: it?.unit, qty: val('nl_qty'), o: val('nl_o') || it?.o, m: val('nl_m') || it?.m, p: val('nl_p') || it?.p, manual_reason: val('nl_reason') });
    clearFields('nl_title', 'nl_o', 'nl_m', 'nl_p', 'nl_reason');
    reload();
  }),
  delLine: run(async (el) => { const reason = prompt('Lý do xóa dòng?'); if (reason) { await api(`/api/lines/${el.dataset.id}`, 'DELETE'); reload(); } }),
  addRisk: run(async () => { await api(`/api/projects/${pid()}/risks`, 'POST', { title: 'Rủi ro mới', prob_pct: 20, impact: 1000000 }); reload(); }),
  delRisk: run(async (el) => { await api(`/api/risks/${el.dataset.id}`, 'DELETE'); reload(); }),
  addExt: run(async () => { await api(`/api/projects/${pid()}/external`, 'POST', { title: 'Chi phí mới', amount: 0 }); reload(); }),
  delExt: run(async (el) => { await api(`/api/external/${el.dataset.id}`, 'DELETE'); reload(); }),
  recommend: run(async () => { S.rec = await api(`/api/projects/${pid()}/recommend`); renderProject(); }),
  pickPkg: run(async (el) => { await savePricing({ mode: 'package', package_code: el.dataset.code, package_price: null }); }),
  addCare: run(async () => {
    const c = S.meta.packages.lines.find((l) => l.id === 'WEB_CARE').packages.find((x) => x.code === val('careSel')); if (!c) return;
    await savePricing({ recurring: [...(S.project.project.pricing.recurring || []), { title: `${c.code} ${c.name} (Web Care)`, amount: c.price.min, period: 'tháng' }] });
  }),
  delRecurring: run(async (el) => { const r = [...(S.project.project.pricing.recurring || [])]; r.splice(Number(el.dataset.i), 1); await savePricing({ recurring: r }); }),
  newVersion: run(async () => { const r = await api(`/api/projects/${pid()}/versions`, 'POST', {}); toast(r.reused ? 'Dữ liệu không đổi — dùng lại phiên bản hiện có' : 'Đã tạo phiên bản'); await reload(); await ACT_viewVersion(r.id); }),
  viewVersion: run(async (el) => ACT_viewVersion(Number(el.dataset.id))),
  vAct: run(async (el) => {
    const a = el.dataset.a; let note;
    if (a === 'reject') { note = prompt('Lý do từ chối?'); if (!note) return; }
    if (a === 'approve') { note = prompt('Ghi chú duyệt (tùy chọn)') ?? ''; }
    await api(`/api/versions/${el.dataset.id}/${a}`, 'POST', { note }); toast('Đã cập nhật'); reload();
  }),
  actPrefill: run(async (el) => {
    const v = await api(`/api/versions/${el.dataset.id}`);
    const agg = {};
    for (const l of v.result.lines) { const k = l.code || l.title; agg[k] ||= { code: l.code, title: l.title, grp: l.group, hours_estimated: 0, hours_actual: '', scope: 'original' }; agg[k].hours_estimated += l.hours_m; }
    fillActuals(Object.values(agg));
  }),
  actAdd: () => { const rows = readActuals(); rows.push({ title: 'Phát sinh', hours_estimated: 0, hours_actual: 0, scope: 'change' }); fillActuals(rows); },
  actSave: run(async (el) => { await api(`/api/projects/${pid()}/actuals`, 'POST', { quote_version_id: Number(el.dataset.id) || null, rows: readActuals() }); toast('Đã lưu giờ thực tế'); reload(); }),
  syncPkgs: run(async () => { toast('Đang đọc matbao.ws (~1 phút)…'); const r = await api('/api/packages/sync', 'POST', {}); await loadMeta(); toast(r.changes.length ? 'Thay đổi giá: ' + r.changes.join(', ') : 'Đồng bộ xong, không đổi giá'); viewPackages(); }),
  pkgLine: (el) => { S.pkgLine = el.dataset.id; viewPackages(); },
  saveRc: run(async () => {
    const data = {}; document.querySelectorAll('[data-rc]').forEach((i) => { data[i.dataset.rc] = Number(i.value); });
    await api('/api/settings', 'POST', { kind: 'rate_card', version: val('rc_ver'), effective_from: val('rc_from'), note: val('rc_note'), data }); await loadMeta(); toast('Đã lưu đơn giá'); viewSettings();
  }),
  savePol: run(async () => {
    const data = { ...S.meta.policy.data }; document.querySelectorAll('[data-pol]').forEach((i) => { data[i.dataset.pol] = i.type === 'number' ? Number(i.value) : i.value; });
    await api('/api/settings', 'POST', { kind: 'policy', version: val('pol_ver'), effective_from: val('pol_from'), data }); await loadMeta(); toast('Đã lưu chính sách'); viewSettings();
  }),
};
async function ACT_viewVersion(id) {
  const v = await api(`/api/versions/${id}`);
  const prevMeta = S.project.versions.find((x) => x.version === v.version - 1);
  v.prev = prevMeta ? await api(`/api/versions/${prevMeta.id}`) : null;
  S.versionView = v; S.tab = 'versions'; renderProject();
}
function readActuals() {
  return [...document.querySelectorAll('#actTbl tbody tr')].map((tr) => Object.fromEntries([...tr.querySelectorAll('[data-a]')].map((i) => [i.dataset.a, i.value])));
}
async function savePricing(patch) {
  await api(`/api/projects/${pid()}`, 'PUT', { pricing: patch, rev: S.project.project.rev });
  S.rec = null; await reload();
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (el && ACT[el.dataset.act]) { e.preventDefault(); ACT[el.dataset.act](el); }
});
// Enter trong ô tên miền = bấm nút
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.isComposing) return;
  const map = { np_domain: 'createProject', newRef: 'addRef' };
  const act = map[e.target.id];
  if (act) { e.preventDefault(); const btn = document.querySelector(`[data-act="${act}"]`); if (btn && !btn.disabled) ACT[act](btn); }
});
document.addEventListener('change', async (e) => {
  const t = e.target;
  try {
    if ('qlevel' in t.dataset) {
      await api(`/api/projects/${pid()}/quick-feature`, 'POST', { feature: 'DESIGN_LEVEL', include: true, quantity: Number(t.value) });
      await reload();
    } else if (t.dataset.qfeat) {
      await api(`/api/projects/${pid()}/quick-feature`, 'POST', { feature: t.dataset.qfeat, include: t.checked });
      await reload();
    } else if (t.dataset.qqty) {
      const q = t.value === '' ? 0 : Number(t.value);
      await api(`/api/projects/${pid()}/quick-feature`, 'POST', { feature: t.dataset.qqty, include: q > 0, quantity: q > 0 ? q : null });
      await reload();
    } else if (t.dataset.qinfo) {
      await api(`/api/projects/${pid()}`, 'PUT', { [t.dataset.qinfo]: t.value, rev: S.project.project.rev });
      await reload();
    } else if (t.dataset.rq) {
      await api(`/api/requirements/${t.dataset.rq}`, 'PUT', { [t.dataset.k]: t.dataset.k === 'quantity' ? (t.value === '' ? null : Number(t.value)) : t.value });
      await reload();
    } else if (t.dataset.q) {
      await api(`/api/questions/${t.dataset.q}`, 'PUT', { [t.dataset.k]: t.type === 'checkbox' ? t.checked : t.value });
      await reload();
    } else if (t.dataset.ln) {
      const v = t.type === 'checkbox' ? (t.checked ? 1 : 0) : t.value;
      const reason = prompt('Lý do điều chỉnh (bắt buộc, lưu vào lịch sử)?');
      if (!reason) { await reload(); return; }
      await api(`/api/lines/${t.dataset.ln}`, 'PUT', { [t.dataset.k]: t.dataset.k === 'billing_override' ? v || null : v, reason });
      await reload();
    } else if (t.dataset.rk || t.dataset.ex) {
      const id = t.dataset.rk || t.dataset.ex; const route = t.dataset.rk ? 'risks' : 'external';
      await api(`/api/${route}/${id}`, 'PUT', { [t.dataset.k]: t.type === 'checkbox' ? (t.checked ? 1 : 0) : t.type === 'number' ? Number(t.value) : t.value });
      await reload();
    } else if (t.dataset.pr) {
      const k = t.dataset.pr; let v = t.type === 'number' ? (t.value === '' ? null : Number(t.value)) : t.value;
      if (k.startsWith('risk_override.')) { const ro = { ...(S.project.project.pricing.risk_override || {}) }; ro[k.split('.')[1]] = v; await savePricing({ risk_override: ro }); }
      else await savePricing({ [k]: v });
    } else if (t.dataset.refnote) {
      await api(`/api/refs/${t.dataset.refnote}`, 'PUT', { learn_notes: t.value }); toast('Đã lưu ghi chú');
    }
  } catch (err) { toast(err.message, true); reload(); }
});

boot().catch((e) => { $app.innerHTML = `<p class="checks"><span class="error">${esc(e.message)}</span></p>`; });

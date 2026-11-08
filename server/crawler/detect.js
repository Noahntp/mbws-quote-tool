// Hàm chạy TRONG trang (page.evaluate) — phải tự chứa, không tham chiếu biến ngoài.
// Chỉ đọc DOM, không bấm, không gửi form.
// Nguyên tắc: "observed" (tick sẵn) chỉ khi có PHẦN TỬ CHỨC NĂNG thật (nút, ô nhập, form, link tới đúng
// tên miền dịch vụ, script widget). Chữ chỉ được nhắc trong nội dung → "inferred" (có thể có, không tick sẵn).
export function detectInPage() {
  const out = [];
  const add = (feature, detail, verification = 'observed') => out.push({ feature, detail: String(detail).replace(/\s+/g, ' ').trim().slice(0, 240), verification });
  const qa = (s, root = document) => { try { return [...root.querySelectorAll(s)]; } catch { return []; } };
  const NONVISUAL = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'TEMPLATE', 'NOSCRIPT', 'HEAD', 'TITLE']);
  const isReal = (el) => el && !NONVISUAL.has(el.tagName) && !el.closest('script,style,template,noscript');
  const shown = (el) => {
    if (!isReal(el)) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const label = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || '').replace(/\s+/g, ' ').trim();
  const here = location.hostname.replace(/^www\./, '');
  const links = qa('a[href]').map((a) => {
    const href = a.getAttribute('href') || '';
    let u = null; try { u = new URL(href, location.href); } catch {}
    return { a, href, u, host: u ? u.hostname.replace(/^www\./, '').toLowerCase() : '', path: u ? (u.pathname + u.search).toLowerCase() : '', text: label(a) };
  });
  const same = (l) => l.host === here || l.host.endsWith('.' + here);
  const hostIs = (l, ...hs) => hs.some((h) => l.host === h || l.host.endsWith('.' + h));
  const findLink = (pred) => links.find((l) => { try { return pred(l); } catch { return false; } });
  const scriptSrcs = qa('script[src]').map((s) => s.src.toLowerCase());
  const inlineJs = qa('script:not([src])').map((s) => s.textContent.slice(0, 4000)).join('\n').toLowerCase();
  const iframeSrcs = qa('iframe').map((f) => (f.getAttribute('src') || f.getAttribute('data-src') || f.getAttribute('data-lazy-src') || '').toLowerCase());
  const buttons = qa('button, a, input[type=submit], input[type=button], [role=button]').filter(isReal);
  const text = (document.body?.innerText || '').replace(/\s+/g, ' ');
  const lower = text.toLowerCase();
  const short = (s, n = 60) => s.slice(0, n);

  // ---------- Giỏ hàng ----------
  const addToCart = qa('button[name="add-to-cart"], .add_to_cart_button, .single_add_to_cart_button, form[action*="/cart" i] button, [data-action*="add-to-cart" i], [data-action*="addtocart" i], [class*="add-to-cart" i], [id*="add-to-cart" i], [class*="addtocart" i], [class*="btn-cart" i]').find(isReal);
  const cartBtn = buttons.find((e) => /(thêm vào giỏ|cho vào giỏ|add to (cart|bag|basket)|giỏ hàng của bạn)/i.test(label(e)));
  const cartLink = findLink((l) => same(l) && /(^|\/)(gio-hang|cart|checkout|thanh-toan|basket)(\/|$|\?|\.)/.test(l.u.pathname.toLowerCase()));
  const BUY = /^(mua ngay|mua hàng|chọn mua|đặt hàng|đặt mua|buy now|order now)$/i;
  const buyBtns = qa('button, a, [role=button], div, span').filter((e) => isReal(e) && e.children.length <= 2 && BUY.test(label(e)));
  const orderLink = findLink((l) => /^(delivery|order|dat-?mon|giao-?hang|shop)\./.test(l.host) || /^(delivery|order online|đặt món|giao hàng|đặt món online)$/i.test(l.text));
  const priceCount = ((document.body?.innerText || '').match(/\d{1,3}(?:[.,]\d{3})+\s?(?:₫|đồng|vnđ|vnd|đ(?![a-zà-ỹ]))/gi) || []).length;
  if (addToCart) add('CART', `Nút thêm vào giỏ: "${short(label(addToCart) || addToCart.className)}"`);
  else if (cartBtn) add('CART', `Nút "${short(label(cartBtn))}"`);
  else if (cartLink) add('CART', `Liên kết giỏ hàng ${cartLink.u.pathname}`);
  else if (buyBtns.length >= 3 && priceCount >= 3) add('CART', `${buyBtns.length} nút "${short(label(buyBtns[0]))}" cạnh giá sản phẩm`);
  else if (buyBtns.length) add('CART', `Chỉ có nút "${short(label(buyBtns[0]))}" (chưa thấy giỏ hàng)`, 'inferred');
  else if (orderLink) add('CART', `Đặt món/đặt hàng ở hệ thống riêng: ${orderLink.host}`, 'inferred');

  // ---------- Tìm kiếm ----------
  const searchInput = qa('input[type=search], form[role=search] input, [role=search] input, input[name=s], input[name=q], input[name=keyword], input[name=key], input[name=search], input[name=query], input[name=k], input[placeholder*="tìm" i], input[placeholder*="search" i], input[aria-label*="tìm" i], input[aria-label*="search" i]').find((el) => isReal(el) && !el.closest('[id*="chat" i], [class*="chat" i]') && !/chat/i.test(el.id + ' ' + (el.name || '')));
  const searchBox = qa('[id*="search" i], [class*="search" i]').find((el) => shown(el) && !['INPUT', 'FORM'].includes(el.tagName) && !el.closest('[id*="chat" i], [class*="chat" i]') && /(tìm|search)/i.test(label(el)) && label(el).length < 80);
  const searchLink = findLink((l) => same(l) && /(^|\/)(tim-kiem|search)(\/|$|\?)|[?&](s|q|key|keyword)=/.test(l.path));
  const searchBtn = buttons.find((e) => /^(tìm kiếm|search)$/i.test(label(e)) || /search|tim-kiem/i.test(e.getAttribute('aria-label') || ''));
  if (searchInput) add('SEARCH', `Ô tìm kiếm ${searchInput.tagName.toLowerCase()}[name=${searchInput.getAttribute('name') || ''}] "${short(searchInput.getAttribute('placeholder') || '', 40)}"`);
  else if (searchBox) add('SEARCH', `Khung tìm kiếm "${short(label(searchBox))}"`);
  else if (searchLink) add('SEARCH', `Liên kết tìm kiếm ${searchLink.u.pathname}${searchLink.u.search}`);
  else if (searchBtn) add('SEARCH', `Nút tìm kiếm "${short(label(searchBtn) || searchBtn.getAttribute('aria-label') || '')}"`, 'inferred');

  // ---------- Bộ lọc ----------
  const FILTER_WORDS = /(bộ lọc|lọc theo|lọc sản phẩm|khoảng giá|mức giá|thương hiệu|filter|refine|price range|brand|kích cỡ|màu sắc)/i;
  const filterBox = qa('aside, form, [class*="filter" i], [id*="filter" i], [class*="facet" i], [class*="sidebar" i], [class*="refine" i]')
    .filter((el) => shown(el) && el.tagName !== 'BODY')
    .find((el) => {
      const controls = qa('input[type=checkbox], input[type=radio], input[type=range], select, [role=checkbox], [role=option]', el).length;
      return controls >= 2 && FILTER_WORDS.test((el.innerText || '').slice(0, 600));
    });
  const isProductPage = /"@type"\s*:\s*\[?\s*"product"/i.test(qa('script[type="application/ld+json"]').map((x) => x.textContent).join(' '));
  const filterLinks = isProductPage ? [] : links.filter((l) => same(l) && !/\/(products?|san-pham|sp)\/[^/]+\/?$/.test(l.u.pathname.toLowerCase()) && /[?&](brand|thuong-?hieu|price|gia|min_?price|max_?price|filter[^=]*|attr[^=]*|pa_[a-z]+|color|mau|size|kich-?thuoc)=/.test(l.path));
  const filterBtn = buttons.find((e) => /^(bộ lọc|lọc|filter|filters|lọc sản phẩm)$/i.test(label(e)));
  if (filterBox) add('FILTER', `Khối lọc có ô chọn: "${short(filterBox.innerText || '', 70)}"`);
  else if (filterLinks.length >= 2) add('FILTER', `${filterLinks.length} liên kết lọc, ví dụ ${filterLinks[0].u.search}`);
  else if (filterBtn) add('FILTER', `Nút "${short(label(filterBtn))}"`);
  else if (qa('select[name*=sort i], select[name*=orderby i]').some(isReal)) add('FILTER', 'Chỉ có ô sắp xếp (chưa thấy bộ lọc thuộc tính)', 'inferred');

  // ---------- Form liên hệ ----------
  const contactForms = qa('form').filter(isReal).filter((f) => !f.querySelector('input[type=password]') && f.querySelector('textarea, input[type=email], input[type=tel], input[name*=phone i], input[name*=email i], input[name*=sdt i], input[name*=dien-thoai i]'));
  const gform = iframeSrcs.find((s) => /docs\.google\.com\/forms|forms\.gle/.test(s));
  if (contactForms.length) add('CONTACT_FORM', `${contactForms.length} form có trường liên hệ (${contactForms.map((f) => [...f.querySelectorAll('input[type=email],input[type=tel],textarea')].map((i) => i.type || i.tagName.toLowerCase()).join('+')).slice(0, 2).join('; ')})`);
  else if (gform) add('CONTACT_FORM', 'Google Form nhúng');
  // Landing đăng ký: form ≥ 5 trường, có ô lựa chọn, nội dung đăng ký/hợp tác (không phải đăng nhập, thanh toán, giỏ hàng)
  const leadForm = qa('form').filter(shown).find((f) => {
    const fields = f.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]), select, textarea').length;
    const choices = f.querySelectorAll('input[type=radio], input[type=checkbox], select').length;
    const t = (f.innerText || '').toLowerCase();
    return fields >= 5 && choices >= 2 && /(đăng ký|hợp tác|đại lý|nhà phân phối|nhận báo giá|register|partner|distributor|get a quote)/.test(t) && !/(đăng nhập|mật khẩu|login|password|thanh toán|đặt hàng|checkout|giỏ hàng)/.test(t);
  });
  if (leadForm) add('LANDING', `Trang đăng ký có form ${leadForm.querySelectorAll('input:not([type=hidden]), select, textarea').length} trường: "${short(label(leadForm.closest('section,div') || leadForm), 70)}"`);

  // ---------- Kênh liên hệ ----------
  const zalo = findLink((l) => hostIs(l, 'zalo.me', 'chat.zalo.me', 'oa.zalo.me', 'zalo.vn'));
  const zaloWidget = scriptSrcs.find((s) => /sp\.zalo\.me|zalo\.me\/plugins/.test(s)) || qa('.zalo-chat-widget, [class*="zalo-chat" i]').find(isReal);
  if (zalo) add('CHAT_ZALO', zalo.u.href);
  else if (zaloWidget) add('CHAT_ZALO', 'Widget chat Zalo');
  const mess = findLink((l) => hostIs(l, 'm.me', 'messenger.com'));
  const messWidget = qa('.fb-customerchat, [class*="fb_customer_chat" i], [class*="fb-customerchat" i]')[0] || (/customerchat/.test(inlineJs) && /connect\.facebook\.net/.test(scriptSrcs.join(' ') + inlineJs));
  if (mess) add('MESSENGER', mess.u.href);
  else if (messWidget) add('MESSENGER', 'Plugin chat Messenger (customerchat)');
  const tel = findLink((l) => /^tel:/i.test(l.href));
  if (tel) add('PHONE_CALL', tel.href);
  const mapFrame = iframeSrcs.find((s) => /google\.[a-z.]+\/maps|maps\.google\.|google\.com\/maps\/embed/.test(s));
  const mapLink = findLink((l) => (/^(maps\.app\.goo\.gl|goo\.gl)$/.test(l.host) && /maps|\//.test(l.path)) || (/google\.[a-z.]+$/.test(l.host) && l.path.startsWith('/maps')));
  if (mapFrame) add('MAP', 'Bản đồ Google Maps nhúng');
  else if (mapLink) add('MAP', `Liên kết Google Maps ${short(mapLink.u.href, 80)}`);
  const SOCIAL_HOSTS = ['facebook.com', 'fb.com', 'youtube.com', 'tiktok.com', 'instagram.com', 'linkedin.com', 'twitter.com', 'x.com', 'pinterest.com'];
  const socials = [...new Set(links.filter((l) => SOCIAL_HOSTS.some((h) => hostIs(l, h))).map((l) => l.host))];
  if (socials.length) add('SOCIAL', socials.join(', '));
  const jsAll = scriptSrcs.join(' ') + '\n' + inlineJs;
  if (/googletagmanager\.com|google-analytics\.com|gtag\(|\bga\(['"]create/.test(jsAll)) add('ANALYTICS', 'Mã Google Analytics/GTM');
  if (/connect\.facebook\.net\/[^"']*fbevents|fbq\(['"]init/.test(jsAll)) add('ANALYTICS', 'Facebook Pixel');

  // ---------- Đa ngôn ngữ ----------
  const hreflang = [...new Set(qa('link[rel=alternate][hreflang]').map((l) => (l.getAttribute('hreflang') || '').toLowerCase().split('-')[0]).filter((x) => x && x !== 'x'))];
  const LANG_TEXT = /^(en|vi|vn|ja|jp|ko|kr|zh|cn|fr|de|th|english|tiếng việt|tiếng anh|vietnamese|日本語|한국어|中文|français|deutsch)$/i;
  const langLinks = links.filter((l) => same(l) && (LANG_TEXT.test(l.text) || /^\/(en|vi|vn|ja|jp|ko|kr|zh|cn|fr|de|th)(\/|$)|[?&](lang|language|hl)=/.test(l.path)));
  const langCodes = [...new Set(langLinks.map((l) => (l.path.match(/^\/([a-z]{2})(\/|$)/) || l.path.match(/[?&](?:lang|language|hl)=([a-z]{2})/) || [])[1] || l.text.toLowerCase()))];
  if (hreflang.length > 1) add('MULTILANG', `hreflang: ${hreflang.join(', ')}`);
  else if (langLinks.length && (langCodes.length >= 2 || langLinks.some((l) => LANG_TEXT.test(l.text)))) add('MULTILANG', `Nút chuyển ngôn ngữ: ${langLinks.slice(0, 3).map((l) => l.text || l.u.pathname).join(', ')}`);

  // ---------- Tài khoản, thành viên ----------
  const pwd = qa('input[type=password]').find(isReal);
  const LOGIN_PATH = /(^|\/)(dang-nhap|dang-ky|login|log-in|signin|sign-in|register|signup|sign-up|my-account|tai-khoan|account|customer\/account|member)(\/|$|\?|\.)/;
  const loginLink = findLink((l) => same(l) && LOGIN_PATH.test(l.u.pathname.toLowerCase()));
  const loginText = findLink((l) => /^(đăng nhập|đăng ký|login|log in|sign in|sign up|tài khoản( của tôi)?|my account)$/i.test(l.text));
  const loginBtn = buttons.find((e) => /^(đăng nhập|login|log in|sign in)$/i.test(label(e)));
  if (pwd) add('MEMBER_LOGIN', 'Form đăng nhập (ô mật khẩu)');
  else if (loginLink) add('MEMBER_LOGIN', `Liên kết ${loginLink.u.pathname}`);
  else if (loginText && same(loginText)) add('MEMBER_LOGIN', `Liên kết "${loginText.text}"`);
  else if (loginText || loginBtn) add('MEMBER_LOGIN', `"${(loginText || {}).text || label(loginBtn)}" ${loginText && !same(loginText) ? '→ ' + loginText.host + ' (hệ thống ngoài)' : ''}`, 'inferred');
  const loyaltyLink = findLink((l) => same(l) && (/^\/[^/]*(tich-diem|loyalty|rewards?|diem-thuong|thanh-vien-than-thiet|membership)[^/]*\/?$/.test(l.u.pathname.toLowerCase()) || (/^(tích điểm|điểm thưởng|thành viên thân thiết|rewards?|loyalty|membership)$/i.test(l.text))));
  if (loyaltyLink) add('LOYALTY', `Liên kết ${loyaltyLink.u.pathname}`);
  else if (/(tích điểm|điểm thưởng|hạng thành viên|loyalty|reward points)/i.test(lower)) add('LOYALTY', 'Nội dung nhắc tới tích điểm/hạng thành viên', 'inferred');

  // ---------- Nội dung ----------
  const blogLink = findLink((l) => same(l) && /(^|\/)(tin-tuc|blogs?|news|bai-viet|kien-thuc|cam-nang|tin-tuc-su-kien|articles?|posts?|kinh-nghiem[a-z-]*|meo-hay|goc-tu-van)(\/|$|\?|\.)/.test(l.u.pathname.toLowerCase()));
  if (blogLink) add('BLOG', `Liên kết ${blogLink.u.pathname}`);
  else if (qa('article').filter(isReal).length >= 2) add('BLOG', 'Danh sách bài <article>', 'inferred');
  const priceMatches = text.match(/\d{1,3}(?:[.,]\d{3})+\s?(?:₫|đồng|vnđ|vnd|đ(?![a-zà-ỹ]))|(?:₫|\$|usd)\s?\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})?/gi) || [];
  const jsonld = qa('script[type="application/ld+json"]').map((s) => s.textContent).join(' ');
  const productSchema = /"@type"\s*:\s*\[?\s*"product"/i.test(jsonld) || document.querySelector('meta[property="og:type"][content*="product" i]') != null;
  const productLink = findLink((l) => same(l) && /(^|\/)(san-pham|products?|shop|cua-hang|collections|danh-muc|menu|thuc-don)(\/|$|\?)/.test(l.u.pathname.toLowerCase()));
  if (productSchema) add('PRODUCT_CATALOG', 'Schema.org Product / og:type product');
  else if (priceMatches.length >= 3) add('PRODUCT_CATALOG', `${priceMatches.length} giá hiển thị (ví dụ ${priceMatches[0]})`);
  else if (productLink) add('PRODUCT_CATALOG', `Liên kết ${productLink.u.pathname}`, 'inferred');

  // ---------- Thanh toán, đặt lịch, chat ----------
  const PAY = /(vnpay|momo|zalopay|onepay|payoo|vietqr|napas|alepay|9pay|appotapay)/;
  const payImg = qa('img').find((i) => PAY.test(((i.getAttribute('src') || '') + ' ' + (i.getAttribute('alt') || '')).toLowerCase()));
  if (payImg || PAY.test(lower)) add('PAYMENT_ONLINE', payImg ? `Logo cổng thanh toán (${short(payImg.getAttribute('alt') || payImg.getAttribute('src') || '', 50)})` : 'Nội dung nhắc tới cổng thanh toán', 'inferred');
  const BOOK_HOSTS = ['tablecheck.com', 'opentable.com', 'quandoo.com', 'resy.com', 'eatigo.com', 'pasgo.vn', 'booking.com', 'agoda.com', 'calendly.com', 'simplybook.me', 'setmore.com', 'fresha.com'];
  const bookExt = findLink((l) => BOOK_HOSTS.some((h) => hostIs(l, h)));
  const bookPath = findLink((l) => same(l) && /(^|\/)(dat-ban|dat-lich|dat-cho|dat-phong|dat-hen|booking|reservations?|book-a-table|book-now)(\/|$|\?|\.)/.test(l.u.pathname.toLowerCase()));
  const bookForm = qa('form').filter(isReal).find((f) => f.querySelector('input[type=date], input[type=time], input[type=datetime-local], input[name*=date i], input[name*=ngay i]') && /(đặt bàn|đặt lịch|đặt chỗ|đặt phòng|đặt hẹn|booking|reservation|reserve|book)/i.test(f.innerText || ''));
  const bookSub = findLink((l) => /^(booking|reservations?|reserve|book|datban|dat-ban|datlich|dat-lich)\./.test(l.host));
  const bookCta = findLink((l) => /^(reservations?|đặt bàn|đặt bàn ngay|đặt chỗ|đặt phòng|book a table|book now|đặt lịch hẹn)$/i.test(l.text) && l.href && !/^(#|javascript:)/i.test(l.href) && !/tư vấn/i.test(l.text));
  const bookBtn = buttons.find((e) => /(đặt bàn|đặt lịch|đặt chỗ|đặt phòng|đặt hẹn|booking|book now|book a table|reservation|reserve)/i.test(label(e)));
  if (bookForm) add('BOOKING', `Form đặt chỗ có chọn ngày/giờ`);
  else if (bookExt) add('BOOKING', `Liên kết hệ thống đặt chỗ ${bookExt.host}`);
  else if (bookSub) add('BOOKING', `Hệ thống đặt chỗ ${bookSub.host}`);
  else if (bookCta) add('BOOKING', `Nút "${short(bookCta.text)}" → ${short(bookCta.u ? bookCta.u.href : bookCta.href, 60)}`);
  else if (bookPath) add('BOOKING', `Liên kết ${bookPath.u.pathname}`);
  else if (bookBtn) add('BOOKING', `Nút "${short(label(bookBtn))}"`, 'inferred');
  else if (/(đặt bàn|đặt lịch|đặt chỗ|đặt phòng|booking|reservation)/i.test(lower)) add('BOOKING', 'Nội dung nhắc tới đặt chỗ', 'inferred');
  const CHAT = /(tawk\.to|subiz|crisp\.chat|tidio|intercom|livechatinc|fchat\.vn|botpress|chatwoot|static\.zdassets|zopim|botbanhang|ahachat|cxgenie|dialogflow|smax\.ai|chatbase|vbot)/;
  const chatJs = scriptSrcs.find((s) => CHAT.test(s)) || iframeSrcs.find((s) => CHAT.test(s));
  if (chatJs) add('AI_ASSISTANT', `Widget chat trực tuyến (${short(chatJs.replace(/^https?:\/\//, ''), 50)}) — cần hỏi có dùng AI không`, 'inferred');
  const market = findLink((l) => hostIs(l, 'shopee.vn', 'lazada.vn', 'tiki.vn') || (hostIs(l, 'tiktok.com') && /shop/.test(l.path)));
  if (market) add('OMNI_SYNC', `Liên kết sàn: ${market.host}`, 'inferred');

  // Gợi ý loại trang (để đếm sản phẩm khi URL không có chữ "san-pham")
  const hasCart = !!(addToCart || cartBtn);
  const pageKind = productSchema && hasCart ? 'product_detail' : hasCart && priceMatches.length >= 1 && priceMatches.length <= 4 ? 'product_detail' : priceMatches.length >= 6 ? 'product_list' : null;

  // ---------- Độ phức tạp giao diện (để đánh giá mức may đo M1–M8) ----------
  const allEls = document.getElementsByTagName('*');
  const navLinks = qa('header a[href], nav a[href], [class*="menu" i] a[href], [class*="header" i] a[href]').length;
  // Chỉ đếm khung slider ngoài cùng (không đếm từng slide / nút / chấm phân trang bên trong — trước đây 1 slider bị đếm thành hàng chục)
  const CAROUSEL = '[class*="swiper" i], [class*="slick" i], [class*="carousel" i], [class*="owl-" i], [class*="splide" i], [class*="slider" i]';
  const carousels = qa(CAROUSEL).filter((e) => isReal(e) && !e.parentElement?.closest(CAROUSEL)).length;
  let animated = 0;
  for (let i = 0, n = Math.min(allEls.length, 2500); i < n; i++) { const cs = getComputedStyle(allEls[i]); if ((cs.animationName && cs.animationName !== 'none') || (cs.transitionDuration && cs.transitionDuration !== '0s')) animated++; }
  const framework = window.__NEXT_DATA__ || document.getElementById('__next') || scriptSrcs.some((s) => s.includes('/_next/')) || self.__next_f ? 'Next.js' : window.__NUXT__ || document.getElementById('__nuxt') ? 'Nuxt' : document.querySelector('[ng-version]') ? 'Angular' : document.querySelector('[data-reactroot], #root > div') && scriptSrcs.some((s) => /react|chunk|bundle/.test(s)) ? 'React' : document.querySelector('[data-v-app], #app[data-v-]') ? 'Vue' : null;
  const metrics = {
    elements: allEls.length, links: links.length, nav_links: navLinks, images: qa('img').length,
    forms: qa('form').filter(isReal).length, iframes: iframeSrcs.length, carousels, animated,
    height: Math.round(document.documentElement.scrollHeight), text_len: text.length, framework,
    languages: Math.max(hreflang.length, langCodes.length),
  };
  try {
    const imgs = performance.getEntriesByType('resource').filter((e) => e.initiatorType === 'img' || /\.(jpe?g|png|webp|gif|avif)(\?|$)/i.test(e.name));
    const sized = imgs.map((e) => e.encodedBodySize || e.transferSize || 0).filter((b) => b > 0);
    metrics.img_bytes = sized.reduce((n, b) => n + b, 0); metrics.img_sized = sized.length;
  } catch { metrics.img_bytes = 0; metrics.img_sized = 0; }

  const gen = document.querySelector('meta[name=generator]')?.getAttribute('content')
    || (scriptSrcs.some((s) => s.includes('/wp-content/') || s.includes('/wp-includes/')) ? 'WordPress' : scriptSrcs.some((s) => s.includes('cdn.shopify')) ? 'Shopify' : scriptSrcs.some((s) => s.includes('haravan')) ? 'Haravan' : scriptSrcs.some((s) => /bizweb|sapo/.test(s)) ? 'Sapo' : null);
  return {
    title: document.title,
    lang: document.documentElement.lang || null,
    generator: gen,
    links: links.map((l) => l.href),
    text_excerpt: text.slice(0, 3000),
    price_count: priceMatches.length,
    product_schema: productSchema,
    page_kind: pageKind,
    metrics,
    features: out,
  };
}

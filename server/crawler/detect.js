// Hàm chạy TRONG trang (page.evaluate) — phải tự chứa, không tham chiếu biến ngoài.
// Chỉ đọc DOM, không bấm, không gửi form. Kết quả là dấu hiệu quan sát được kèm chi tiết làm dẫn chứng.
export function detectInPage() {
  const out = [];
  const add = (feature, detail, verification = 'observed') => out.push({ feature, detail: String(detail).slice(0, 240), verification });
  const q = (s) => { try { return document.querySelector(s); } catch { return null; } };
  const qa = (s) => { try { return [...document.querySelectorAll(s)]; } catch { return []; } };
  const text = (document.body?.innerText || '').replace(/\s+/g, ' ');
  const lower = text.toLowerCase();
  const hrefs = qa('a[href]').map((a) => a.getAttribute('href') || '');
  const anyHref = (re) => hrefs.find((h) => re.test(h));
  const html = document.documentElement.outerHTML.slice(0, 600000).toLowerCase();

  // Giỏ hàng / đặt hàng
  const cartEl = qa('button, a, input[type=submit]').find((e) => /(thêm vào giỏ|add to cart|mua ngay|giỏ hàng|đặt hàng|buy now)/i.test(e.innerText || e.value || ''));
  const cartHref = anyHref(/(gio-hang|\/cart|checkout|thanh-toan)/i);
  if (cartEl) add('CART', `Nút "${(cartEl.innerText || cartEl.value || '').trim().slice(0, 40)}"`);
  else if (cartHref) add('CART', `Liên kết ${cartHref}`);

  // Tìm kiếm
  const search = q('input[type=search], form[role=search], input[name=s], input[name=q], input[name=keyword], input[name=search], input[placeholder*="tìm" i], input[placeholder*="search" i]');
  if (search) add('SEARCH', `Ô tìm kiếm ${search.tagName.toLowerCase()}[name=${search.getAttribute('name') || ''}]`);

  // Bộ lọc
  const filterBlock = qa('aside, .filter, [class*=filter], [id*=filter], [class*=loc-], .sidebar').find((e) => /(lọc|filter|khoảng giá|price range|thương hiệu|kích thước|màu sắc)/i.test(e.innerText || ''));
  if (filterBlock) add('FILTER', `Khối lọc: "${(filterBlock.innerText || '').trim().slice(0, 60)}"`);
  else if (q('select[name*=sort], select[name*=orderby]')) add('FILTER', 'Có ô sắp xếp (chưa thấy bộ lọc thuộc tính)', 'inferred');

  // Form liên hệ
  const forms = qa('form').filter((f) => f.querySelector('textarea, input[type=email], input[type=tel], input[name*=phone], input[name*=email]'));
  if (forms.length) add('CONTACT_FORM', `${forms.length} form có trường liên hệ`);

  // Widget liên hệ
  if (anyHref(/zalo\.me|chat\.zalo|zalo\.vn|oa\.zalo/i) || /zalo-chat-widget|sp\.zalo\.me|zaloapp/i.test(html)) add('CHAT_ZALO', anyHref(/zalo/i) || 'Widget Zalo');
  if (anyHref(/m\.me\/|messenger\.com/i) || /fb-customerchat|customerchat|messenger/i.test(html)) add('MESSENGER', anyHref(/m\.me|messenger/i) || 'Plugin Messenger');
  const tel = anyHref(/^tel:/i); if (tel) add('PHONE_CALL', tel);
  if (q('iframe[src*="google.com/maps"], iframe[src*="maps.google"]')) add('MAP', 'Iframe Google Maps');
  const socials = ['facebook.com', 'youtube.com', 'tiktok.com', 'instagram.com', 'linkedin.com', 'twitter.com', 'x.com/'].filter((s) => hrefs.some((h) => h.includes(s)));
  if (socials.length) add('SOCIAL', socials.join(', '));
  if (/googletagmanager\.com|google-analytics\.com|gtag\(/i.test(html)) add('ANALYTICS', 'Mã Google Analytics/GTM');
  if (/connect\.facebook\.net\/.*fbevents|fbq\(/i.test(html)) add('ANALYTICS', 'Facebook Pixel');

  // Đa ngôn ngữ
  const hreflang = qa('link[rel=alternate][hreflang]').map((l) => l.getAttribute('hreflang'));
  const langLinks = hrefs.filter((h) => /^\/(en|vi|ja|ko|zh|fr|de|th)(\/|$)|[?&]lang=/i.test(h));
  if (hreflang.length > 1) add('MULTILANG', `hreflang: ${[...new Set(hreflang)].join(', ')}`);
  else if (langLinks.length) add('MULTILANG', `Liên kết ngôn ngữ: ${[...new Set(langLinks)].slice(0, 4).join(', ')}`, 'inferred');

  // Tài khoản
  if (q('input[type=password]')) add('MEMBER_LOGIN', 'Có ô mật khẩu (form đăng nhập)');
  else { const acc = anyHref(/(dang-nhap|login|dang-ky|register|my-account|tai-khoan|account)/i); if (acc) add('MEMBER_LOGIN', `Liên kết ${acc}`, 'inferred'); }
  if (/(tích điểm|điểm thưởng|hạng thành viên|loyalty|reward points)/i.test(lower)) add('LOYALTY', 'Có nhắc tới tích điểm/hạng thành viên', 'inferred');

  // Nội dung
  const blogHref = anyHref(/(tin-tuc|\/blog|\/news|bai-viet|kien-thuc|cam-nang)/i);
  if (q('article') || blogHref) add('BLOG', blogHref ? `Liên kết ${blogHref}` : 'Phần tử <article>');
  const priceMatches = text.match(/\d{1,3}(?:[.,]\d{3})+\s?(?:₫|đ|vnđ|vnd)/gi) || [];
  const productSchema = /"@type"\s*:\s*"product"/i.test(html);
  if (productSchema) add('PRODUCT_CATALOG', 'Schema.org Product');
  else if (priceMatches.length >= 3 || anyHref(/(san-pham|\/product|\/shop|collections)/i)) add('PRODUCT_CATALOG', priceMatches.length >= 3 ? `${priceMatches.length} giá hiển thị` : `Liên kết ${anyHref(/(san-pham|\/product|\/shop|collections)/i)}`, priceMatches.length >= 3 ? 'observed' : 'inferred');

  // Thanh toán, đặt lịch, AI chat
  if (/(vnpay|momo|zalopay|onepay|payoo|vietqr|thanh toán online|thanh toán trực tuyến)/i.test(lower) || /vnpay|momo|zalopay/i.test(html)) add('PAYMENT_ONLINE', 'Nhắc tới cổng thanh toán (VNPay/MoMo/QR...)', 'inferred');
  if (/(đặt lịch|đặt bàn|đặt phòng|booking|book now|đặt hẹn)/i.test(lower) || anyHref(/(dat-lich|booking|dat-ban|dat-phong)/i)) add('BOOKING', 'Nhắc tới đặt lịch/booking', 'inferred');
  if (/(tawk\.to|subiz|crisp\.chat|tidio|intercom|livechat|chatbot|botpress|fchat)/i.test(html)) add('AI_ASSISTANT', 'Widget live chat/chatbot', 'inferred');
  if (anyHref(/shopee\.vn|tiktok\.com\/@.*shop|lazada\.vn|tiki\.vn/i)) add('OMNI_SYNC', `Liên kết sàn: ${anyHref(/shopee|lazada|tiki|tiktok/i)}`, 'inferred');

  const gen = q('meta[name=generator]')?.getAttribute('content') || (/wp-content\//.test(html) ? 'WordPress' : /cdn\.shopify|shopify/.test(html) ? 'Shopify' : /haravan/.test(html) ? 'Haravan' : /sapo\.vn|bizweb/.test(html) ? 'Sapo' : null);
  return {
    title: document.title,
    lang: document.documentElement.lang || null,
    generator: gen,
    links: hrefs,
    text_excerpt: text.slice(0, 3000),
    price_count: priceMatches.length,
    product_schema: productSchema,
    features: out,
  };
}

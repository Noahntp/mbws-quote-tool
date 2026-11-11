// Kiểm soát đích truy cập của crawler (theo OWASP SSRF Prevention).
// Chỉ cho phép http/https tới địa chỉ IP công khai; chặn loopback, private, link-local, metadata, CGNAT, multicast… ở cả IPv4 và IPv6.
import dns from 'node:dns/promises';
import net from 'node:net';

function v4ToInt(ip) { return ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0; }
const V4_BLOCK = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([b, m]) => [v4ToInt(b), m]);

// Máy chạy sau proxy/VPN chế độ fake-IP (Clash, sing-box...) nhận mọi tên miền về dải 198.18.0.0/15.
// Chỉ bật CRAWLER_TRUST_FAKE_IP=1 trên máy như vậy; khi đó proxy mới là nơi phân giải IP thật.
const FAKE_IP = [v4ToInt('198.18.0.0'), 15];
const trustFakeIp = () => process.env.CRAWLER_TRUST_FAKE_IP === '1';

export function isPublicIp(ip) {
  if (net.isIPv4(ip)) {
    const n = v4ToInt(ip);
    if (trustFakeIp() && (n >>> (32 - FAKE_IP[1])) === (FAKE_IP[0] >>> (32 - FAKE_IP[1]))) return true;
    return !V4_BLOCK.some(([b, m]) => (n >>> (32 - m)) === (b >>> (32 - m)));
  }
  if (net.isIPv6(ip)) {
    const s = ip.toLowerCase();
    const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicIp(mapped[1]);
    if (s === '::' || s === '::1') return false;
    const first = parseInt(s.split(':')[0] || '0', 16);
    if ((first & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return false; // fe80::/10 link local
    if ((first & 0xff00) === 0xff00) return false; // multicast
    if (s.startsWith('64:ff9b:') || s.startsWith('2001:db8') || s.startsWith('100::')) return false;
    if (s.startsWith('2002:')) return false; // 6to4 có thể nhúng IPv4 nội bộ
    return true;
  }
  return false;
}

// Bộ nhớ đệm tra tên miền có hạn 10 phút (bộ quét chạy lâu ngày không giữ kết quả cũ); lỗi tra DNS không lưu.
const cache = new Map();
const CACHE_MS = 10 * 60 * 1000;
const DNS_TRANSIENT = new Set(['EBUSY', 'EAI_AGAIN', 'ETIMEOUT', 'ESERVFAIL', 'ECONNREFUSED', 'EAI_FAIL']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Tra tên miền → IP. Máy chủ DNS bận (EBUSY, EAI_AGAIN…) thì thử lại; getaddrinfo lỗi thì hỏi thẳng DNS (resolve4/6). */
async function lookupAll(h) {
  let last;
  for (let i = 0; i < 3; i++) {
    try { return (await dns.lookup(h, { all: true, verbatim: true })).map((a) => a.address); } catch (e) {
      last = e;
      if (!DNS_TRANSIENT.has(e.code)) break;
      await sleep(700 * (i + 1));
    }
  }
  const [a4, a6] = await Promise.all([dns.resolve4(h).catch(() => []), dns.resolve6(h).catch(() => [])]);
  if (a4.length || a6.length) return [...a4, ...a6];
  const err = new Error(DNS_TRANSIENT.has(last?.code)
    ? `Máy chủ DNS không trả lời khi tra tên miền ${h} (${last.code}) — lỗi mạng tạm thời, bấm "Quét lại" sau ít phút.`
    : `Không tìm thấy địa chỉ của tên miền ${h}${last?.code ? ` (${last.code})` : ''}: tên miền chưa trỏ về máy chủ nào hoặc web đã ngừng hoạt động.`);
  err.dns = true; err.transient = DNS_TRANSIENT.has(last?.code);
  throw err;
}

/** Phân giải host và bảo đảm MỌI địa chỉ trả về đều là IP công khai. */
export async function assertPublicHost(hostname) {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const c = cache.get(h);
  if (c && Date.now() - c.at < CACHE_MS) { if (c.ok) return c.addrs; throw new Error(c.err); }
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h === 'metadata.google.internal') {
    cache.set(h, { ok: false, err: `Host bị chặn: ${h}`, at: Date.now() }); throw new Error(`Host bị chặn: ${h}`);
  }
  let addrs;
  if (net.isIP(h)) addrs = [h];
  else addrs = await lookupAll(h); // lỗi tra DNS ném ra ngay, không lưu đệm
  const bad = addrs.find((a) => !isPublicIp(a));
  if (!addrs.length || bad) { const err = `Đích không phải IP công khai (${h} → ${bad || 'không phân giải được'})`; cache.set(h, { ok: false, err, at: Date.now() }); throw new Error(err); }
  cache.set(h, { ok: true, addrs, at: Date.now() });
  return addrs;
}

export async function assertPublicUrl(url) {
  const u = new URL(url);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Chỉ cho phép http/https');
  if (u.port && !['80', '443', '8080', '8443'].includes(u.port)) throw new Error(`Cổng không được phép: ${u.port}`);
  await assertPublicHost(u.hostname);
  return u;
}

/** fetch an toàn: tự xử lý chuyển hướng và kiểm tra lại đích sau mỗi lần chuyển. */
export async function safeFetchText(url, { timeoutMs = 10000, maxBytes = 2_000_000, maxRedirects = 5, userAgent } = {}) {
  let current = url;
  for (let i = 0; i <= maxRedirects; i++) {
    await assertPublicUrl(current);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(current, { redirect: 'manual', signal: ctrl.signal, headers: { 'user-agent': userAgent || 'MBWS-QuoteBot/0.1' } });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { current = new URL(res.headers.get('location'), current).toString(); continue; }
      const reader = res.body?.getReader();
      let size = 0; const chunks = [];
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > maxBytes) { ctrl.abort(); break; }
          chunks.push(value);
        }
      }
      return { status: res.status, url: current, text: Buffer.concat(chunks).toString('utf8') };
    } finally { clearTimeout(t); }
  }
  throw new Error('Quá nhiều chuyển hướng');
}

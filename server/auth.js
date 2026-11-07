// Đăng nhập bằng mật khẩu chung của nhóm (bật khi đặt biến môi trường APP_PASSWORD).
// Phiên đăng nhập là cookie ký HMAC, hiệu lực 30 ngày. Không đặt APP_PASSWORD → không yêu cầu đăng nhập (chạy nội bộ).
import crypto from 'node:crypto';

const COOKIE = 'mbws_auth';
const TTL_MS = 30 * 24 * 3600 * 1000;
const password = () => process.env.APP_PASSWORD || '';
const secret = () => process.env.SESSION_SECRET || crypto.createHash('sha256').update('mbws-quote|' + password()).digest('hex');
export const authRequired = () => !!password();

const sign = (exp) => crypto.createHmac('sha256', secret()).update(String(exp)).digest('base64url');
function readCookie(req) {
  const m = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(COOKIE + '='));
  return m ? decodeURIComponent(m.slice(COOKIE.length + 1)) : '';
}
export function isLoggedIn(req) {
  if (!authRequired()) return true;
  const [exp, sig] = readCookie(req).split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const good = sign(exp);
  return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
}

// Chặn dò mật khẩu: tối đa 10 lần sai / 10 phút / địa chỉ IP (theo từng tiến trình)
const fails = new Map();
const ipOf = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

export function mountAuth(app) {
  app.get('/auth/status', (req, res) => res.json({ required: authRequired(), ok: isLoggedIn(req) }));
  app.post('/auth/login', (req, res) => {
    if (!authRequired()) return res.json({ ok: true });
    const ip = ipOf(req); const now = Date.now();
    const f = (fails.get(ip) || []).filter((t) => now - t < 600000);
    if (f.length >= 10) return res.status(429).json({ error: 'Sai mật khẩu quá nhiều lần, thử lại sau 10 phút.' });
    const given = String(req.body?.password || '');
    const a = crypto.createHash('sha256').update(given).digest(); const b = crypto.createHash('sha256').update(password()).digest();
    if (!crypto.timingSafeEqual(a, b)) { f.push(now); fails.set(ip, f); return res.status(401).json({ error: 'Sai mật khẩu.' }); }
    fails.delete(ip);
    const exp = now + TTL_MS;
    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.setHeader('Set-Cookie', `${COOKIE}=${exp}.${sign(exp)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TTL_MS / 1000}${secure ? '; Secure' : ''}`);
    res.json({ ok: true });
  });
  app.post('/auth/logout', (req, res) => { res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`); res.json({ ok: true }); });
  // Mọi dữ liệu (API, báo giá, ảnh chụp) cần đăng nhập
  app.use(['/api', '/quote', '/storage'], (req, res, next) => {
    if (isLoggedIn(req)) return next();
    if (req.baseUrl === '/api') return res.status(401).json({ error: 'Cần đăng nhập', code: 'LOGIN_REQUIRED' });
    res.status(401).type('html').send('<!doctype html><meta charset="utf-8"><p>Cần đăng nhập. <a href="/">Mở công cụ báo giá</a></p>');
  });
}

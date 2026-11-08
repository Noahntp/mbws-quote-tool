// Lớp CSDL dùng chung:
//  - Máy local: SQLite (node:sqlite, file storage/quote.db) — không cần cài gì.
//  - Vercel / máy chủ: Postgres khi có DATABASE_URL (hoặc POSTGRES_URL) — ví dụ Neon.
//  - Kiểm thử: PGlite (Postgres chạy trong tiến trình) khi DB_DRIVER=pglite.
// Câu SQL viết một kiểu (dấu ? cho tham số, datetime('now')), lớp này tự chuyển cho Postgres.
// Mọi hàm truy vấn đều bất đồng bộ (await).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const IS_SERVERLESS = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
export const DATA_DIR = process.env.DATA_DIR || (IS_SERVERLESS ? '/tmp/storage' : path.join(ROOT, 'storage'));
const PG_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
export const DRIVER = process.env.DB_DRIVER || (PG_URL ? 'pg' : 'sqlite');
export const IS_PG = DRIVER === 'pg' || DRIVER === 'pglite';
// Dữ liệu có còn sau khi máy chủ khởi động lại? Serverless (Vercel) chỉ bền khi nối Postgres thật; SQLite/PGlite ở /tmp mất bất cứ lúc nào.
export const PERSISTENT = !IS_SERVERLESS || DRIVER === 'pg';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('sales','tech','pricing_manager','admin')));

CREATE TABLE IF NOT EXISTS settings_versions (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('rate_card','policy')), version TEXT NOT NULL,
  data_json TEXT NOT NULL, effective_from TEXT NOT NULL, effective_to TEXT,
  approved_by INTEGER REFERENCES users(id), note TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(kind, version));

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, customer_name TEXT, customer_contact TEXT,
  project_type TEXT, site_kind TEXT, brief TEXT, budget INTEGER, owner_id INTEGER REFERENCES users(id),
  pricing_json TEXT NOT NULL DEFAULT '{}', rev INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS refs (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  url TEXT NOT NULL, learn_notes TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS analysis_runs (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ref_id INTEGER REFERENCES refs(id) ON DELETE SET NULL, url TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','done','failed')), attempts INTEGER NOT NULL DEFAULT 0,
  max_urls INTEGER NOT NULL DEFAULT 20, locked_at TEXT, started_at TEXT, finished_at TEXT,
  coverage_json TEXT, robots_json TEXT, templates_json TEXT, error TEXT, crawler_version TEXT, input_hash TEXT,
  created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS evidence (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id INTEGER REFERENCES analysis_runs(id) ON DELETE CASCADE, code TEXT NOT NULL, url TEXT,
  captured_at TEXT, viewport TEXT, asset_path TEXT, asset_hash TEXT, kind TEXT NOT NULL, feature TEXT, detail TEXT,
  verification TEXT NOT NULL CHECK (verification IN ('observed','client','inferred','unverified')),
  UNIQUE(project_id, code));

CREATE TABLE IF NOT EXISTS requirements (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  code TEXT NOT NULL, feature TEXT, title TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('observed','client','inferred','unverified')),
  evidence_codes TEXT NOT NULL DEFAULT '[]', decision TEXT NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending','include','exclude','ask')),
  quantity REAL, unit TEXT, acceptance TEXT, priority TEXT DEFAULT 'normal', notes TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(project_id, code));

CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  code TEXT NOT NULL, requirement_id INTEGER REFERENCES requirements(id) ON DELETE CASCADE,
  text TEXT NOT NULL, blocking INTEGER NOT NULL DEFAULT 0, answer TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','dropped')), UNIQUE(project_id, code));

CREATE TABLE IF NOT EXISTS estimate_lines (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  code TEXT, title TEXT NOT NULL, grp TEXT NOT NULL, role TEXT NOT NULL, unit TEXT, qty REAL NOT NULL DEFAULT 1,
  o REAL NOT NULL, m REAL NOT NULL, p REAL NOT NULL, feature TEXT, requirement_id INTEGER REFERENCES requirements(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'auto' CHECK (source IN ('auto','manual')), billing_override TEXT CHECK (billing_override IN ('package','extra') OR billing_override IS NULL),
  manual_reason TEXT, include INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS risks (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL, prob_pct REAL NOT NULL, impact INTEGER NOT NULL, include INTEGER NOT NULL DEFAULT 1);

CREATE TABLE IF NOT EXISTS external_costs (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL, amount INTEGER NOT NULL, include INTEGER NOT NULL DEFAULT 1);

CREATE TABLE IF NOT EXISTS quote_versions (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version INTEGER NOT NULL, status TEXT NOT NULL CHECK (status IN ('draft','pending','approved','rejected')),
  quote_code TEXT NOT NULL, valid_until TEXT, payment_terms TEXT, snapshot_json TEXT NOT NULL, result_json TEXT NOT NULL,
  input_hash TEXT NOT NULL, created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now')),
  submitted_by INTEGER REFERENCES users(id), submitted_at TEXT, approved_by INTEGER REFERENCES users(id), approved_at TEXT,
  review_note TEXT, UNIQUE(project_id, version));

CREATE TABLE IF NOT EXISTS actuals (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  quote_version_id INTEGER REFERENCES quote_versions(id), code TEXT, title TEXT NOT NULL, grp TEXT,
  hours_estimated REAL NOT NULL DEFAULT 0, hours_actual REAL NOT NULL DEFAULT 0,
  scope TEXT NOT NULL DEFAULT 'original' CHECK (scope IN ('original','change','bugfix','rework')), cause TEXT, note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));

-- Hàng đợi quét (v2). analysis_runs chỉ còn là trạng thái hiển thị; việc nhận job đi qua bảng này,
-- để tiến trình chạy code cũ (chỉ biết analysis_runs.status='queued') không thể giành job.
CREATE TABLE IF NOT EXISTS job_queue (
  run_id INTEGER PRIMARY KEY REFERENCES analysis_runs(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  attempts INTEGER NOT NULL DEFAULT 0, locked_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));

-- Ảnh chụp dẫn chứng (lưu trong CSDL để chạy được trên máy chủ không có ổ đĩa cố định)
CREATE TABLE IF NOT EXISTS assets (
  path TEXT PRIMARY KEY, content_type TEXT NOT NULL, data BLOB NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));

-- Dữ liệu cấu hình dạng khóa–giá trị (ví dụ bảng giá gói matbao.ws sau khi đồng bộ)
CREATE TABLE IF NOT EXISTS app_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY, project_id INTEGER, entity TEXT NOT NULL, entity_id INTEGER, user_id INTEGER,
  action TEXT NOT NULL, before_json TEXT, after_json TEXT, reason TEXT, at TEXT NOT NULL DEFAULT (datetime('now')));
`;

// SQLite → Postgres: khóa tự tăng, số thực, nhị phân; hàm datetime('now') được tạo sẵn trong Postgres.
const PG_PRELUDE = `CREATE OR REPLACE FUNCTION datetime(t text) RETURNS text LANGUAGE sql STABLE AS $$ SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') $$;`;
const pgSchema = (s) => s.replace(/\bid INTEGER PRIMARY KEY\b/g, 'id SERIAL PRIMARY KEY').replace(/\bREAL\b/g, 'DOUBLE PRECISION').replace(/\bBLOB\b/g, 'BYTEA');

// Đổi tham số ? → $1, $2… (bỏ qua dấu ? nằm trong chuỗi '...')
function toPgParams(sql) {
  let i = 0; let out = ''; let inStr = false;
  for (const ch of sql) {
    if (ch === "'") inStr = !inStr;
    out += !inStr && ch === '?' ? '$' + (++i) : ch;
  }
  return out;
}
const isRead = (sql) => /^\s*(select|with)\b/i.test(sql);
const NO_ID_TABLES = new Set(['job_queue', 'assets', 'app_kv']); // bảng không có cột id

// ---------- Trình điều khiển ----------
async function makeDriver() {
  if (DRIVER === 'sqlite') {
    const { DatabaseSync } = await import('node:sqlite');
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const db = new DatabaseSync(path.join(DATA_DIR, 'quote.db'));
    db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
    return {
      async exec(sql) { db.exec(sql); },
      async query(sql, params, client) {
        const st = db.prepare(sql);
        const p = params.map(norm);
        if (isRead(sql) || /\breturning\b/i.test(sql)) { const rows = st.all(...p); return { rows, changes: rows.length, lastId: rows[0]?.id }; }
        const r = st.run(...p); return { rows: [], changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
      },
      async begin() { db.exec('BEGIN IMMEDIATE'); return null; },
      async commit() { db.exec('COMMIT'); },
      async rollback() { db.exec('ROLLBACK'); },
      async close() { db.close(); },
      raw: db,
    };
  }
  // Postgres (pg) hoặc PGlite
  let pool; let pglite;
  if (DRIVER === 'pglite') {
    const { PGlite } = await import('@electric-sql/pglite');
    pglite = new PGlite(process.env.PGLITE_DIR || undefined);
  } else {
    const pg = (await import('pg')).default;
    pg.types.setTypeParser(20, (v) => parseInt(v, 10)); // COUNT(*) (bigint) → số
    pool = new pg.Pool({ connectionString: PG_URL, max: Number(process.env.PG_POOL_MAX || 3), ssl: /sslmode=disable/.test(PG_URL) || /localhost|127\.0\.0\.1/.test(PG_URL) ? false : { rejectUnauthorized: false } });
  }
  const fixRow = (r) => { for (const k in r) if (typeof r[k] === 'bigint') r[k] = Number(r[k]); return r; };
  const q = async (sql, params, client) => {
    let text = toPgParams(sql);
    const table = (sql.match(/^\s*insert\s+into\s+(\w+)/i) || [])[1];
    if (table && !NO_ID_TABLES.has(table) && !/\breturning\b/i.test(sql)) text += ' RETURNING id';
    const p = params.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
    const res = pglite ? await (client || pglite).query(text, p) : await (client || pool).query(text, p);
    const rows = (res.rows || []).map(fixRow);
    return { rows, changes: res.rowCount ?? res.affectedRows ?? rows.length, lastId: rows[0]?.id };
  };
  return {
    async exec(sql) { if (pglite) await pglite.exec(sql); else await pool.query(sql); },
    query: q,
    async begin() {
      if (pglite) { // PGlite: một kết nối; dùng transaction() và chờ fn kết thúc bên trong
        return null;
      }
      const c = await pool.connect(); await c.query('BEGIN'); return c;
    },
    async commit(c) { if (c) { await c.query('COMMIT'); c.release(); } },
    async rollback(c) { if (c) { try { await c.query('ROLLBACK'); } finally { c.release(); } } },
    async close() { if (pool) await pool.end(); if (pglite) await pglite.close(); },
    pglite,
  };
}

const als = new AsyncLocalStorage();
let driver; let readyPromise;
// SQLite chỉ có 1 kết nối: khi đang có giao dịch thì truy vấn từ ngữ cảnh khác phải chờ
let sqliteTxChain = Promise.resolve();
let sqliteTxActive = null;

async function exec(sql, params) {
  await ready();
  const ctx = als.getStore();
  if (DRIVER === 'sqlite' && sqliteTxActive && !ctx?.inTx) await sqliteTxActive;
  return driver.query(sql, params, ctx?.client);
}
export const one = async (sql, ...a) => (await exec(sql, a)).rows[0];
export const all = async (sql, ...a) => (await exec(sql, a)).rows;
export const run = async (sql, ...a) => { const r = await exec(sql, a); return { changes: r.changes, lastInsertRowid: r.lastId }; };

/** Chạy fn trong một giao dịch; mọi one/all/run bên trong (kể cả qua await) dùng chung giao dịch. */
export async function tx(fn) {
  await ready();
  const ctx = als.getStore();
  if (ctx?.inTx) return fn(); // lồng nhau → dùng giao dịch ngoài
  if (DRIVER === 'sqlite') {
    const prev = sqliteTxChain;
    let release;
    const mine = new Promise((r) => { release = r; });
    sqliteTxChain = prev.then(() => mine);
    await prev;
    sqliteTxActive = mine;
    try {
      await driver.begin();
      const r = await als.run({ inTx: true }, fn);
      await driver.commit();
      return r;
    } catch (e) { try { await driver.rollback(); } catch {} throw e; } finally { sqliteTxActive = null; release(); }
  }
  if (DRIVER === 'pglite') {
    return driver.pglite.transaction((t) => als.run({ inTx: true, client: t }, fn));
  }
  const c = await driver.begin();
  try { const r = await als.run({ inTx: true, client: c }, fn); await driver.commit(c); return r; } catch (e) { await driver.rollback(c); throw e; }
}

export async function audit({ project_id = null, entity, entity_id = null, user_id = null, action, before = null, after = null, reason = null }) {
  await run('INSERT INTO audit_log (project_id, entity, entity_id, user_id, action, before_json, after_json, reason) VALUES (?,?,?,?,?,?,?,?)',
    project_id, entity, entity_id, user_id, action, before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after), reason);
}

export function loadJson(rel) { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')); }

export async function activeSetting(kind, at = new Date().toISOString().slice(0, 10)) {
  return one(`SELECT * FROM settings_versions WHERE kind=? AND effective_from<=? AND (effective_to IS NULL OR effective_to>=?) ORDER BY effective_from DESC, id DESC LIMIT 1`, kind, at, at);
}

// ---------- Khởi tạo: tạo bảng + dữ liệu mẫu (chạy 1 lần mỗi tiến trình) ----------
export function ready() {
  if (!readyPromise) readyPromise = (async () => {
    driver = await makeDriver();
    // Postgres dùng chung (Vercel nhiều máy khởi động cùng lúc): khóa advisory để chỉ một máy tạo bảng / dữ liệu mẫu tại một thời điểm
    let c = null;
    if (DRIVER === 'pg') { c = await driver.begin(); await c.query('SELECT pg_advisory_xact_lock(727201)'); }
    try {
    if (c) { await c.query(PG_PRELUDE); await c.query(pgSchema(SCHEMA)); } else if (IS_PG) { await driver.exec(PG_PRELUDE); await driver.exec(pgSchema(SCHEMA)); } else await driver.exec(SCHEMA);
    const q1 = async (sql, ...a) => (await driver.query(sql, a, c || undefined)).rows[0];
    const r1 = async (sql, ...a) => driver.query(sql, a, c || undefined);
    if (!Number((await q1('SELECT COUNT(*) n FROM users')).n)) {
      for (const [name, role] of [['Sales A', 'sales'], ['Kỹ thuật B', 'tech'], ['Quản lý giá C', 'pricing_manager'], ['Quản trị', 'admin']]) await r1('INSERT INTO users (name, role) VALUES (?,?)', name, role);
    }
    if (!Number((await q1("SELECT COUNT(*) n FROM settings_versions WHERE kind='rate_card'")).n)) {
      await r1(`INSERT INTO settings_versions (kind, version, data_json, effective_from, approved_by, note) VALUES ('rate_card','RC-2026.1',?, '2026-01-01', 3, ?)`,
        JSON.stringify({ PM: 200000, DESIGN: 200000, FE: 200000, BE: 200000, DATA: 150000, QA: 150000 }),
        'Đơn giá chi phí nội bộ/giờ ĐÃ gồm chi phí chung. Giá trị giả định theo ví dụ tài liệu — thay bằng số đã duyệt.');
    }
    if (!Number((await q1("SELECT COUNT(*) n FROM settings_versions WHERE kind='policy'")).n)) {
      await r1(`INSERT INTO settings_versions (kind, version, data_json, effective_from, approved_by, note) VALUES ('policy','POL-2026.1',?, '2026-01-01', 3, ?)`,
        JSON.stringify({ target_margin_pct: 30, min_margin_pct: 25, overhead_pct: 0, package_cost_pct: 60, rounding_step: 1000, rounding_mode: 'up', vat_pct: 10, sales_max_discount_pct: 5, hosting_gb_price_year: 500000, extra_language_pct: 30, quote_valid_days: 30, default_payment_terms: '50% khi ký hợp đồng, 50% khi nghiệm thu bàn giao' }),
        'Biên mục tiêu 30%, tối thiểu 25%, VAT 10% (cần kế toán xác nhận theo hạng mục). Sales được giảm tối đa 5%, vượt mức cần quản lý giá duyệt. package_cost_pct=60: GIẢ ĐỊNH chi phí nội bộ của gói chuẩn bằng 60% giá niêm yết — cần xác nhận. hosting_gb_price_year=500.000đ: GIẢ ĐỊNH giá thêm 1 GB hosting/năm (matbao.ws chưa niêm yết).');
    }
    if (c) await driver.commit(c);
    } catch (e) { if (c) await driver.rollback(c); throw e; }
  })().catch((e) => { readyPromise = null; throw e; });
  return readyPromise;
}

export async function closeDb() { if (driver) await driver.close(); driver = null; readyPromise = null; }

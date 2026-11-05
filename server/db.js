import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'storage');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'quote.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
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

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY, project_id INTEGER, entity TEXT NOT NULL, entity_id INTEGER, user_id INTEGER,
  action TEXT NOT NULL, before_json TEXT, after_json TEXT, reason TEXT, at TEXT NOT NULL DEFAULT (datetime('now')));
`);

export const one = (sql, ...a) => db.prepare(sql).get(...a);
export const all = (sql, ...a) => db.prepare(sql).all(...a);
export const run = (sql, ...a) => db.prepare(sql).run(...a);

export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export function audit({ project_id = null, entity, entity_id = null, user_id = null, action, before = null, after = null, reason = null }) {
  run('INSERT INTO audit_log (project_id, entity, entity_id, user_id, action, before_json, after_json, reason) VALUES (?,?,?,?,?,?,?,?)',
    project_id, entity, entity_id, user_id, action, before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after), reason);
}

export function loadJson(rel) { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')); }

// ---------- Seed ----------
if (!one('SELECT COUNT(*) n FROM users').n) {
  for (const [name, role] of [['Sales A', 'sales'], ['Kỹ thuật B', 'tech'], ['Quản lý giá C', 'pricing_manager'], ['Quản trị', 'admin']]) run('INSERT INTO users (name, role) VALUES (?,?)', name, role);
}
if (!one("SELECT COUNT(*) n FROM settings_versions WHERE kind='rate_card'").n) {
  run(`INSERT INTO settings_versions (kind, version, data_json, effective_from, approved_by, note) VALUES ('rate_card','RC-2026.1',?, '2026-01-01', 3, ?)`,
    JSON.stringify({ PM: 200000, DESIGN: 200000, FE: 200000, BE: 200000, DATA: 150000, QA: 150000 }),
    'Đơn giá chi phí nội bộ/giờ ĐÃ gồm chi phí chung. Giá trị giả định theo ví dụ tài liệu — thay bằng số đã duyệt.');
}
if (!one("SELECT COUNT(*) n FROM settings_versions WHERE kind='policy'").n) {
  run(`INSERT INTO settings_versions (kind, version, data_json, effective_from, approved_by, note) VALUES ('policy','POL-2026.1',?, '2026-01-01', 3, ?)`,
    JSON.stringify({ target_margin_pct: 30, min_margin_pct: 25, overhead_pct: 0, package_cost_pct: 60, rounding_step: 1000, rounding_mode: 'up', vat_pct: 10, sales_max_discount_pct: 5, quote_valid_days: 30, default_payment_terms: '50% khi ký hợp đồng, 50% khi nghiệm thu bàn giao' }),
    'Biên mục tiêu 30%, tối thiểu 25%, VAT 10% (cần kế toán xác nhận theo hạng mục). Sales được giảm tối đa 5%, vượt mức cần quản lý giá duyệt. package_cost_pct=60: GIẢ ĐỊNH chi phí nội bộ của gói chuẩn bằng 60% giá niêm yết — cần xác nhận.');
}

export function activeSetting(kind, at = new Date().toISOString().slice(0, 10)) {
  return one(`SELECT * FROM settings_versions WHERE kind=? AND effective_from<=? AND (effective_to IS NULL OR effective_to>=?) ORDER BY effective_from DESC, id DESC LIMIT 1`, kind, at, at);
}

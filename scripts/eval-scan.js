// Đo độ chính xác bộ quét trên web thật, so với đáp án đã kiểm tra tay trong test/scan-truth.json.
// Chạy: npm run eval:scan            (tất cả web trong đáp án)
//       npm run eval:scan -- https://web-bat-ky.vn   (chỉ in kết quả quét, không chấm)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const truthFile = path.join(ROOT, 'test', 'scan-truth.json');
const args = process.argv.slice(2);
const MAX_URLS = Number(process.env.EVAL_MAX_URLS || 8);
const BUDGET = Number(process.env.EVAL_BUDGET_MS || 180000);
const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mbws-eval-'));

function runWorker(url, idx) {
  const dir = path.join(outRoot, String(idx));
  fs.mkdirSync(dir, { recursive: true });
  const cfgFile = path.join(dir, 'config.json');
  const outFile = path.join(dir, 'result.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ url, maxUrls: MAX_URLS, budgetMs: BUDGET, outFile, assetDir: dir }));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'server/crawler/worker.js'), cfgFile], { stdio: ['ignore', 'ignore', 'ignore'], env: process.env });
    child.on('exit', () => resolve(fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : { ok: false, fatal: 'không có kết quả' }));
  });
}

const RANK = { observed: 3, inferred: 2, unverified: 1 };
export function summarize(res) {
  const feats = {};
  for (const p of res.pages || []) {
    if (p.error || p.blocked) continue;
    for (const f of p.features || []) {
      if (!f.feature) continue;
      const cur = feats[f.feature];
      if (!cur || RANK[f.verification] > RANK[cur.v]) feats[f.feature] = { v: f.verification, detail: f.detail, url: p.url };
    }
  }
  return feats;
}

async function main() {
  const truth = fs.existsSync(truthFile) ? JSON.parse(fs.readFileSync(truthFile, 'utf8')) : [];
  const sites = args.length ? args.map((url) => ({ url })) : truth;
  let tp = 0, fp = 0, fn = 0, tn = 0; const problems = [];
  for (const [i, site] of sites.entries()) {
    const t0 = Date.now();
    const res = await runWorker(site.url, i);
    const feats = summarize(res);
    console.log(`\n=== ${site.url}  (${Math.round((Date.now() - t0) / 1000)}s, đọc ${res.coverage?.read ?? 0} trang, nền tảng ${res.generator || '?'}) ${res.ok ? '' : '⛔ ' + (res.fatal || '')}`);
    for (const p of res.pages || []) console.log(`   ${p.error ? '✗' : p.blocked ? '⊘' : '·'} ${p.template.padEnd(16)} ${p.status ?? ''} ${p.url}${p.error ? '  ' + p.error : ''}`);
    const names = new Set([...Object.keys(feats), ...Object.keys(site.expect || {})]);
    for (const f of [...names].sort()) {
      const got = feats[f]; const exp = site.expect?.[f];
      // "tick sẵn" = observed. Chấm đúng/sai dựa trên việc tick sẵn có khớp đáp án không.
      const ticked = got?.v === 'observed';
      let mark = '  ';
      if (exp === true) { if (ticked) { tp++; mark = '✓ '; } else { fn++; mark = '✗ thiếu'; problems.push(`${site.url} thiếu ${f} (${got ? 'chỉ suy luận' : 'không thấy'})`); } }
      else if (exp === false) { if (ticked) { fp++; mark = '✗ thừa'; problems.push(`${site.url} thừa ${f}: ${got.detail}`); } else { tn++; mark = '✓ '; } }
      console.log(`   ${mark.padEnd(8)} ${f.padEnd(16)} ${got ? got.v.padEnd(10) : '—'.padEnd(10)} ${got ? got.detail.slice(0, 90) : ''}`);
    }
  }
  if (truth.length && !args.length) {
    const prec = tp + fp ? tp / (tp + fp) : 1; const rec = tp + fn ? tp / (tp + fn) : 1;
    console.log(`\nTỔNG: tick đúng ${tp}, tick thừa ${fp}, bỏ sót ${fn}, bỏ trống đúng ${tn}`);
    console.log(`Độ chính xác (tick sẵn đúng): ${(prec * 100).toFixed(1)}%   Độ phủ (có mà tick được): ${(rec * 100).toFixed(1)}%`);
    if (problems.length) console.log('Sai:\n - ' + problems.join('\n - '));
  }
  fs.rmSync(outRoot, { recursive: true, force: true });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

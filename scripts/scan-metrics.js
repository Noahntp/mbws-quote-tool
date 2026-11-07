// In số liệu độ phức tạp của các web mẫu (để hiệu chỉnh ngưỡng đánh giá mức may đo).
// Chạy: node scripts/scan-metrics.js https://a.vn https://b.vn ...
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessComplexity } from '../server/complexity.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'mbws-metrics-'));
const CONC = Number(process.env.CONC || 3);

function scan(url, i) {
  const dir = path.join(out, String(i)); fs.mkdirSync(dir, { recursive: true });
  const cfg = { url, maxUrls: Number(process.env.MAX_URLS || 8), budgetMs: 150000, outFile: path.join(dir, 'r.json'), assetDir: dir, shotMaxHeight: 1200 };
  fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify(cfg));
  return new Promise((res) => {
    const ch = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'server/crawler/worker.js'), path.join(dir, 'c.json')], { stdio: 'ignore', env: process.env });
    ch.on('exit', () => res(fs.existsSync(cfg.outFile) ? JSON.parse(fs.readFileSync(cfg.outFile, 'utf8')) : { ok: false }));
  });
}

const urls = process.argv.slice(2);
const results = new Array(urls.length);
let next = 0;
await Promise.all(Array.from({ length: CONC }, async () => { while (next < urls.length) { const i = next++; results[i] = await scan(urls[i], i); } }));
for (const [i, r] of results.entries()) {
  const feats = new Set((r.pages || []).filter((p) => !p.error).flatMap((p) => (p.features || []).filter((f) => f.verification === 'observed').map((f) => f.feature)));
  const a = assessComplexity({ discovered: r.coverage?.discovered || 0, estimatedUrls: r.coverage?.estimated_urls || 0, templateGroups: r.coverage?.template_groups || 0, observed: feats, metrics: r.metrics || {}, productCount: r.sitemap?.product_urls || 0 });
  console.log(`\n${urls[i]}  ok=${r.ok} ${r.fatal || ''}`);
  console.log(`  URL ${r.coverage?.discovered} | nhóm ${r.coverage?.template_groups} | SP sitemap ${r.sitemap?.product_urls || 0} | tính năng: ${[...feats].join(',')}`);
  console.log(`  chỉ số: ${JSON.stringify(r.metrics)}`);
  console.log(`  → điểm ${a.score}/${a.max} → M${a.level} ${a.name}${a.enterprise ? ' · VƯỢT QUY MÔ (Enterprise)' : ''} (${a.reasons.join('; ')}) | sitemap con: ${r.sitemap?.child_sitemaps || 0}, ước lượng URL: ${r.coverage?.estimated_urls}`);
}
fs.rmSync(out, { recursive: true, force: true });

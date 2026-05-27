// Reproduces the user's reported scenario: load a scan, then leave the app
// idle. Samples heap every few seconds and reports the trend.
//
// If heap climbs while the app is truly idle (no clicks, no key events),
// something on a timer or in the render loop is allocating and retaining.

import { _electron } from '@playwright/test';
import { existsSync, mkdirSync, createWriteStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

const DURATION_S = parseInt(process.env.DURATION_S ?? '60', 10);
const FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tree.xyz');
const OUT_DIR = join(repoRoot, 'tmp', 'heap');
mkdirSync(OUT_DIR, { recursive: true });

const app = await _electron.launch({
  args: ['.'],
  cwd: repoRoot,
  timeout: 60_000,
  env: { ...process.env, PHYTOGRAPH_E2E: '1' },
});
const page = await app.firstWindow();

{
  const start = Date.now();
  while (Date.now() - start < 120_000) {
    try {
      const res = await fetch('http://127.0.0.1:8008/version', { signal: AbortSignal.timeout(2_000) });
      if (res.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

const cdp = await page.context().newCDPSession(page);
await cdp.send('HeapProfiler.enable');

async function gc() {
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('HeapProfiler.collectGarbage');
}
async function heap() {
  await gc();
  return (await cdp.send('Runtime.getHeapUsage')).usedSize;
}
const fmt = (b) => `${(b / 1024 / 1024).toFixed(2)} MB`;

await page.getByTestId('nav-viewer').click();
await page.getByTestId('import-menu-button').click();
const [chooser] = await Promise.all([
  page.waitForEvent('filechooser'),
  page.getByTestId('import-menu-auto').click(),
]);
await chooser.setFiles(FIXTURE);
await page.locator('[data-testid="scan-row"][data-scan-name="tree.xyz"]').waitFor({ timeout: 30_000 });

// Settle.
await page.waitForTimeout(2000);

const baseline = await heap();
console.log(`baseline (cloud loaded, settled): ${fmt(baseline)}`);

const samples = [{ t: 0, used: baseline }];
const t0 = Date.now();

while ((Date.now() - t0) / 1000 < DURATION_S) {
  await page.waitForTimeout(5000);
  const t = (Date.now() - t0) / 1000;
  const used = await heap();
  samples.push({ t, used });
  console.log(`t=${t.toFixed(0)}s: ${fmt(used)}  (Δ ${fmt(used - baseline)})`);
}

const last = samples[samples.length - 1];
const totalDelta = last.used - baseline;
const rateMBps = (totalDelta / 1024 / 1024) / last.t;
console.log(`\nidle for ${last.t.toFixed(0)}s`);
console.log(`total Δ: ${fmt(totalDelta)}`);
console.log(`rate:    ${rateMBps.toFixed(3)} MB/s`);

if (rateMBps > 0.05) {
  const outPath = join(OUT_DIR, `idle-snapshot-${Date.now()}.heapsnapshot`);
  console.log(`\nIdle growth > 50 KB/s — dumping snapshot to ${outPath}`);
  const stream = createWriteStream(outPath);
  cdp.on('HeapProfiler.addHeapSnapshotChunk', ({ chunk }) => stream.write(chunk));
  await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
  stream.end();
  await new Promise((r) => stream.on('finish', r));
  console.log(`Wrote ${outPath}`);
}

await app.close();

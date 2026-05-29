// Reproduces the multi-cloud crop OOM the user hit after the agent's
// crop refactor. Loads two large synthetic clouds, selects both, clicks
// the multi-cloud Crop button, and watches heap during the window where
// the user's app freezes for ~20s then dies.
//
// Pass criterion: peak heap stays well under V8's 4 GB old-space limit
// even with two ~25M-point clouds selected.

import { _electron } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const FIXTURE_A = process.env.FIXTURE_A
  ? join(repoRoot, process.env.FIXTURE_A)
  : join(repoRoot, 'tmp', 'big.xyz');
const FIXTURE_B = process.env.FIXTURE_B
  ? join(repoRoot, process.env.FIXTURE_B)
  : join(repoRoot, 'tmp', 'big2.xyz');

if (!existsSync(FIXTURE_A) || !existsSync(FIXTURE_B)) {
  console.error('Missing fixtures. Run:');
  console.error('  N=10000000 node scripts/make-big-xyz.mjs');
  console.error('  N=10000000 OUT=tmp/big2.xyz node scripts/make-big-xyz.mjs');
  process.exit(1);
}

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
async function rawHeap() {
  return (await cdp.send('Runtime.getHeapUsage')).usedSize;
}
async function settledHeap() {
  await gc();
  return (await cdp.send('Runtime.getHeapUsage')).usedSize;
}
const fmt = (b) => `${(b / 1024 / 1024).toFixed(1)} MB`;

await page.getByTestId('nav-viewer').click();

async function importFixture(path, displayName) {
  console.log(`importing ${displayName}...`);
  await page.getByTestId('import-menu-button').click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByTestId('import-menu-auto').click(),
  ]);
  await chooser.setFiles(path);
  const row = page.locator(`[data-testid="scan-row"][data-scan-name="${displayName}"]`);
  await row.waitFor({ timeout: 180_000 });
  return row;
}

const rowA = await importFixture(FIXTURE_A, FIXTURE_A.split('/').pop());
const rowB = await importFixture(FIXTURE_B, FIXTURE_B.split('/').pop());
console.log('both clouds loaded.');

await page.waitForTimeout(2000);
const baseline = await settledHeap();
console.log(`baseline (both clouds loaded, settled): ${fmt(baseline)}`);

// Select both rows.
await rowA.click();
await rowB.click({ modifiers: ['Meta'] });
await page.waitForTimeout(500);
console.log('both clouds selected.');

// Multi-cloud Crop tool button.
const cropMulti = page.getByTestId('tool-crop-multi');
await cropMulti.waitFor({ timeout: 5_000 });

// Sample heap rapidly during the click and the freeze that follows.
let stop = false;
let peak = baseline;
const sampler = (async () => {
  const t0 = Date.now();
  while (!stop) {
    const used = await rawHeap();
    if (used > peak) peak = used;
    if (used > 3 * 1024 * 1024 * 1024) {
      // bail before we OOM ourselves
      console.error(`!! heap ${fmt(used)} at t=${((Date.now() - t0) / 1000).toFixed(1)}s — bailing`);
      stop = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
})();

console.log('clicking multi-crop...');
const clickAt = Date.now();
await cropMulti.click({ timeout: 60_000 }).catch((e) => console.error('click failed:', e.message));
await page.waitForTimeout(4_000);
const peakAfterOpen = peak;
console.log(`peak after Crop open: ${fmt(peakAfterOpen)}`);

// Resize the X dimension — this is the exact step that OOM'd the user.
// Reads the current crop box from the panel, then sets X size to roughly
// half so the crop becomes a real filter (not a no-op).
console.log('resizing X dimension to force a real filter pass...');
const xInput = page.getByTestId('crop-dim-x');
await xInput.waitFor({ timeout: 5_000 });
const currentMax = await page.getByTestId('crop-panel').getAttribute('data-crop-max');
const currentMin = await page.getByTestId('crop-panel').getAttribute('data-crop-min');
const [maxX] = (currentMax ?? '0,0,0').split(',').map(parseFloat);
const [minX] = (currentMin ?? '0,0,0').split(',').map(parseFloat);
const halfSize = (maxX - minX) / 2;
await xInput.click();
await xInput.fill(String(halfSize.toFixed(2)));
await xInput.press('Tab');
await page.waitForTimeout(8_000);
const peakAfterResize = peak;
console.log(`peak after X resize: ${fmt(peakAfterResize)}`);

console.log('clicking Apply button to apply the resized crop...');
const applyAt = Date.now();
await page.getByTestId('crop-apply').click();
await page.waitForTimeout(20_000);

stop = true;
await sampler;

const settled = await settledHeap().catch(() => -1);
const elapsedOpen = ((applyAt - clickAt) / 1000).toFixed(1);
const elapsedApply = ((Date.now() - applyAt) / 1000).toFixed(1);
console.log(`\nelapsed open+resize: ${elapsedOpen}s, apply: ${elapsedApply}s`);
console.log(`peak heap (whole window): ${fmt(peak)}`);
console.log(`peak heap during apply phase Δ: ${fmt(peak - peakAfterResize)}`);
console.log(`peak heap from open to resize Δ: ${fmt(peakAfterResize - peakAfterOpen)}`);
if (settled >= 0) console.log(`settled after GC: ${fmt(settled)}`);
console.log(`peak Δ vs baseline: ${fmt(peak - baseline)}`);

const peakGB = peak / 1024 / 1024 / 1024;
if (peakGB > 2.5) {
  console.error(`\nFAIL: peak heap > 2.5 GB on two 10M-point clouds with multi-crop + apply.`);
}

await app.close();

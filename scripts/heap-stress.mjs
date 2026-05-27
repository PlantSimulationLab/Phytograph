// JS-heap stress test for the renderer. Boots the packaged Electron app,
// runs a long sequence of operations a user might do during a session, and
// samples performance.memory.usedJSHeapSize after a forced GC at each step.
//
// If the heap grows monotonically across N cycles of the same workflow,
// something is being retained that shouldn't be. We then take a heap
// snapshot via CDP and dump the top objects-by-count and biggest retainers
// for manual inspection.
//
// This is a *probe*, not a regression test — it prints data; it doesn't
// pass/fail on a threshold by default.

import { _electron } from '@playwright/test';
import { existsSync, mkdirSync, createWriteStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

const CYCLES = parseInt(process.env.CYCLES ?? '15', 10);
const FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tree.xyz');
const OUT_DIR = join(repoRoot, 'tmp', 'heap');
mkdirSync(OUT_DIR, { recursive: true });

function check(path, hint) {
  if (!existsSync(path)) throw new Error(`Missing ${path}. ${hint}`);
}
check(join(repoRoot, 'dist-main', 'main.js'), 'Run `npm run build`.');
check(join(repoRoot, 'resources', 'phytograph_backend', 'phytograph_backend'), 'Run `npm run build:backend`.');

const app = await _electron.launch({
  args: ['.'],
  cwd: repoRoot,
  timeout: 60_000,
  env: { ...process.env, PHYTOGRAPH_E2E: '1' },
});
const page = await app.firstWindow();

// Wait for backend.
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
  const u = await cdp.send('Runtime.getHeapUsage');
  return u.usedSize;
}

function fmt(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

await page.getByTestId('nav-viewer').click();

// Helper: import a fixture cloud, return its row locator.
async function importTree(name) {
  await page.getByTestId('import-menu-button').click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByTestId('import-menu-auto').click(),
  ]);
  await chooser.setFiles(FIXTURE);
  const row = page.locator(`[data-testid="scan-row"][data-scan-name="${name}"]`).first();
  await row.waitFor({ timeout: 30_000 });
  return row;
}

// Helper: delete a cloud via its row's delete button + confirm.
async function deleteRow(row) {
  const scanId = await row.getAttribute('data-scan-id');
  await page.getByTestId(`scan-delete-${scanId}`).click();
  const confirm = page.getByTestId('confirm-delete');
  if (await confirm.isVisible().catch(() => false)) await confirm.click();
}

// Pre-warm: one full import to settle React + three.js + backend, so the
// baseline isn't dominated by first-mount allocations.
{
  const row = await importTree('tree.xyz');
  await page.waitForTimeout(500);
  await deleteRow(row);
  await page.waitForTimeout(300);
}

const baseline = await heap();
console.log(`baseline (after warmup): ${fmt(baseline)}`);

const samples = [baseline];

for (let i = 0; i < CYCLES; i++) {
  const row = await importTree('tree.xyz');

  // Touch some real state: select, toggle visibility a few times, change
  // color mode through commands. This exercises edit-state initialisation
  // (line ~2070 effect) and the cloud-mounted code paths.
  await row.click();
  const visToggle = row.locator('button[title="Hide"], button[title="Show"]');
  for (let k = 0; k < 3; k++) {
    await visToggle.click();
    await page.waitForTimeout(40);
  }
  // ensure visible at end
  if ((await visToggle.getAttribute('title')) === 'Show') {
    await visToggle.click();
  }

  await deleteRow(row);
  await page.waitForTimeout(150);

  const used = await heap();
  samples.push(used);
  console.log(`cycle ${i + 1}/${CYCLES}: ${fmt(used)}  (delta vs baseline ${fmt(used - baseline)})`);
}

const last = samples[samples.length - 1];
const delta = last - baseline;
const perCycle = delta / CYCLES;
console.log(`\nbaseline: ${fmt(baseline)}`);
console.log(`final:    ${fmt(last)}`);
console.log(`total Δ:  ${fmt(delta)}`);
console.log(`per cycle: ${fmt(perCycle)}`);

// If we leaked more than ~2 MB per cycle of import+delete, dump a snapshot
// so we can pick over retainers.
if (perCycle > 2 * 1024 * 1024) {
  const outPath = join(OUT_DIR, `snapshot-${Date.now()}.heapsnapshot`);
  console.log(`\nGrowth is significant — dumping heap snapshot to ${outPath}`);
  const stream = createWriteStream(outPath);
  cdp.on('HeapProfiler.addHeapSnapshotChunk', ({ chunk }) => stream.write(chunk));
  await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
  stream.end();
  await new Promise((r) => stream.on('finish', r));
  console.log(`Wrote ${outPath}`);
}

await app.close();

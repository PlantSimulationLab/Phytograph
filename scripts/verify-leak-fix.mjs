// One-off verification for the three.js geometry/material dispose fix in
// src/renderer/components/PointCloudViewer.tsx + ScannerMarker.tsx.
//
// Boots the packaged Electron app the same way the e2e suite does, imports
// a fixture scan, then toggles its visibility N times. Each toggle unmounts
// and re-mounts the PointCloud component, which re-allocates a
// THREE.BufferGeometry + PointsMaterial under the hood.
//
// We instrument WebGL2RenderingContext.createBuffer / deleteBuffer via an
// initScript BEFORE the page boots so we see every GL buffer that three.js
// allocates and (post-fix) releases. We also sample the JS heap via CDP.
//
// Pass criteria after fix: live buffer count returns near baseline after
// each remount cycle — i.e. created ≈ deleted at the end. Pre-fix would
// show `deleted = 0` and `live` growing linearly with toggle count.

import { _electron } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

const TOGGLES = 30;
const FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tree.xyz');

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

// Patch WebGL2RenderingContext BEFORE renderer code runs. addInitScript
// only fires on subsequent navigations, so we reload the renderer below.
await page.addInitScript(() => {
  const proto = WebGL2RenderingContext.prototype;
  const origCreate = proto.createBuffer;
  const origDelete = proto.deleteBuffer;
  let created = 0;
  let deleted = 0;
  proto.createBuffer = function () {
    created++;
    return origCreate.apply(this, arguments);
  };
  proto.deleteBuffer = function () {
    deleted++;
    return origDelete.apply(this, arguments);
  };
  /** @type {any} */ (window).__webglStats = () => ({
    created,
    deleted,
    live: created - deleted,
  });
});

// Wait for backend (same poll the e2e helper uses).
{
  const start = Date.now();
  while (Date.now() - start < 120_000) {
    try {
      const res = await fetch('http://127.0.0.1:8008/version', {
        signal: AbortSignal.timeout(2_000),
      });
      if (res.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

// Reload so the init script runs at document start of the fresh load.
await page.reload();
await page.waitForFunction(() => typeof /** @type {any} */ (window).__webglStats === 'function', null, { timeout: 30_000 });

const cdp = await page.context().newCDPSession(page);
await cdp.send('HeapProfiler.enable');

async function gcAndMeasure(label) {
  // Force three rounds: HeapProfiler.collectGarbage + a Runtime.evaluate that
  // triggers a major GC. CDP's collectGarbage runs major+minor.
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('HeapProfiler.collectGarbage');
  const usage = await cdp.send('Runtime.getHeapUsage');
  const webgl = await page.evaluate(() => /** @type {any} */ (window).__webglStats());
  console.log(
    `[${label}] heap used=${(usage.usedSize / 1024 / 1024).toFixed(1)}MB`,
    `webgl buffers created=${webgl.created} deleted=${webgl.deleted} live=${webgl.live}`,
  );
  return { heapUsed: usage.usedSize, ...webgl };
}

await page.getByTestId('nav-viewer').click();

// Import via the menu → file chooser.
await page.getByTestId('import-menu-button').click();
const [chooser] = await Promise.all([
  page.waitForEvent('filechooser'),
  page.getByTestId('import-menu-auto').click(),
]);
await chooser.setFiles(FIXTURE);

const row = page.locator('[data-testid="scan-row"][data-scan-name="tree.xyz"]');
await row.waitFor({ timeout: 30_000 });

// Find the visibility toggle (the button with title="Hide" / "Show" inside
// the scan row). It has no data-testid in the current code, so we locate
// by title attribute.
const visToggle = row.locator('button[title="Hide"], button[title="Show"]');

// Let three.js render at least one frame so initial buffers are allocated
// before we sample the baseline.
await page.waitForTimeout(800);
const baseline = await gcAndMeasure('baseline (cloud loaded)');

for (let i = 0; i < TOGGLES; i++) {
  await visToggle.click();
  // small delay so React commits + r3f reconciles + three renders the new
  // (or empty) scene before the next toggle.
  await page.waitForTimeout(60);
}
// Leave it ending in the visible state so the final mount matches baseline.
const visibilityNow = await visToggle.getAttribute('title');
if (visibilityNow === 'Show') {
  await visToggle.click();
  await page.waitForTimeout(200);
}

const after = await gcAndMeasure(`after ${TOGGLES} toggles`);

console.log('\n--- summary ---');
console.log(`heap delta:    ${((after.heapUsed - baseline.heapUsed) / 1024 / 1024).toFixed(1)} MB`);
console.log(`buffers delta: created +${after.created - baseline.created} / deleted +${after.deleted - baseline.deleted}`);
console.log(`final live:    ${after.live} (baseline live: ${baseline.live})`);

const churn = after.created - baseline.created;
const released = after.deleted - baseline.deleted;
const retainRate = churn > 0 ? ((churn - released) / churn) : 0;
console.log(`retention:     ${(retainRate * 100).toFixed(1)}% of churned buffers retained`);

await app.close();

if (retainRate > 0.20 && churn > 5) {
  console.error('\nFAIL: more than 20% of churned buffers were retained — dispose path likely still broken.');
  process.exit(1);
}
console.log('\nPASS: buffer churn is being released.');

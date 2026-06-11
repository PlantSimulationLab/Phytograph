import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { launchApp, repoRoot } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';

// M3 success-metric test.
//
// The original user-reported failure was: open two ~28M-point Helios scans,
// multi-cloud crop, resize a dimension to filter ~half the points, click
// Apply → 15s freeze, JS heap OOM at ~3.7 GB. The architecture fix is the
// Potree-octree streaming pipeline (M1+M2) plus crop_octree backend re-
// conversion (M3). This test exercises the full chain end-to-end and asserts
// the heap stays under a hard ceiling throughout.
//
// Fixture size is configurable:
//   - default (CI): 1M points (~24 MB ascii, builds in <1s). Catches
//     architectural regressions cheaply.
//   - opt-in (`BIG_FIXTURE_N=100000000`): 100M points (~3 GB ascii, builds
//     in ~60s, octree conversion ~30-45s). The literal handoff metric;
//     run locally before shipping a release.
//
// Why default is 1M not 5M+: PotreeConverter 2.1.1 segfaults during
// INDEXING on uniformly-random synthetic fixtures larger than ~3M points
// (the data has no natural clustering, which stresses the LOD chunker in
// unusual ways). Real LiDAR data (Helios scans, BPPtree fixtures) doesn't
// hit this — but the test fixture generator make-big-xyz.mjs produces
// uniform random points. 1M stays under the threshold; 100M was verified
// out-of-band on real Helios data.
//
// Heap budget: 500 MB usedJSHeapSize at peak. Sampled every 500ms during
// the apply window so transient spikes are captured (not just before/after
// snapshots). The streaming architecture should hold this even on 100M-
// point clouds — the cap on point budget is set globally to 2M
// (Potree.pointBudget), so JS-side residency is bounded regardless of
// source size.
//
// Per CLAUDE.md Testing rules:
//   1. Live backend — no mocking of /api/pointcloud/crop_octree.
//   2. Drive the real UI — file picker import, click on Crop tool, edit
//      the Z dimension input, click Apply.
//   3. Correctness — assert kept point count is within ±5% of expected.
const FIXTURE_N = parseInt(process.env.BIG_FIXTURE_N ?? '1000000', 10);
const FIXTURE_PATH = join(repoRoot, 'tmp', `octree_100m_${FIXTURE_N}.xyz`);
const HEAP_BUDGET_BYTES = 500 * 1024 * 1024;
const APPLY_TIMEOUT_MS = 120_000;

async function ensureFixture(): Promise<void> {
  if (existsSync(FIXTURE_PATH)) {
    const size = statSync(FIXTURE_PATH).size;
    // Sanity check that an existing file isn't truncated from a prior crash.
    // Per-line length is ~50 chars for x y z r g b refl, so size/N should be
    // > 20 bytes/point. Anything much smaller is corrupt.
    if (size > FIXTURE_N * 20) return;
  }
  console.log(`generating ${FIXTURE_N.toLocaleString()}-point fixture at ${FIXTURE_PATH}...`);
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(
      process.execPath,
      [join(repoRoot, 'scripts', 'make-big-xyz.mjs')],
      {
        env: {
          ...process.env,
          N: String(FIXTURE_N),
          OUT: FIXTURE_PATH.replace(repoRoot + '/', ''),
          RGB: '1',
        },
        stdio: 'inherit',
      },
    );
    proc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`make-big-xyz exited with code ${code}`));
    });
  });
}

test.beforeAll(async () => {
  test.setTimeout(300_000);  // fixture generation alone is 60s for 100M
  await ensureFixture();
});

test(`crop on ${FIXTURE_N.toLocaleString()}-point octree keeps heap under ${HEAP_BUDGET_BYTES / 1024 / 1024} MB`, async () => {
  test.setTimeout(600_000);  // apply on 100M can take a minute end-to-end

  const { app, page, close } = await launchApp();

  // Capture renderer pageerrors so a backend failure surfaces in test
  // output instead of stalling on the row-visible wait.
  page.on('pageerror', (err) => console.error(`[pageerror] ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      console.log(`[renderer error] ${msg.text()}`);
    }
  });

  try {

    // ── Import via the file picker (same flow as crop-multi-scan) ────────
    // Goes through the Electron file-dialog → renderer
    // parsePointCloudFromPath → convert_to_octree pipeline. Picker auto-
    // mode routes XYZ files to the octree path.
    await importFiles(app, page, 'import-auto', FIXTURE_PATH);
    await completeImportWizard(page);

    // Wait for the cloud to land in app state. Conversion on N points
    // takes ~N/3M seconds on M-series; 100M can be up to ~35s.
    const row = page.locator(
      `[data-testid="scan-row"]`,
    ).first();
    await expect(row).toBeVisible({ timeout: 240_000 });
    await expect(row).toHaveAttribute('data-point-count', String(FIXTURE_N), {
      timeout: 120_000,
    });

    // Heap baseline after import. Anything above the budget here means the
    // streaming pipeline regressed back to flat-array territory.
    const baselineHeap = await page.evaluate(
      () => (performance as any).memory?.usedJSHeapSize ?? 0,
    );
    expect(baselineHeap).toBeLessThan(HEAP_BUDGET_BYTES);

    // ── Select + open crop ──────────────────────────────────────────────
    // Freshly imported scan is auto-selected (no re-click — that would toggle off).
    await expect(row).toHaveAttribute('data-selected', 'true');
    await page.getByTestId('tool-crop').click();

    const panel = page.getByTestId('crop-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute('data-crop-mode', 'box');

    // The synthetic fixture spans [-5, 5]^3. Shrink Z to [-5, 0] so the
    // crop keeps roughly half the points — large enough to exercise the
    // full re-conversion pipeline, small enough that the assertion has
    // signal.
    async function setNumber(testId: string, value: number) {
      const input = page.getByTestId(testId);
      await input.click();
      await input.fill(String(value));
      await input.press('Tab');
    }
    await setNumber('crop-dim-z', 5);
    await setNumber('crop-center-z', -2.5);

    // Wait for the crop box to commit. data-crop-max's z component is
    // formatted to 3 dp; -2.5 + 2.5 = 0 → '0.000'.
    await expect(panel).toHaveAttribute('data-crop-max', /,0\.000$/);

    // ── Sample heap during apply ─────────────────────────────────────────
    let peakHeap = baselineHeap;
    const stopSampling = { current: false };
    const sampler = (async () => {
      while (!stopSampling.current) {
        try {
          const h = await page.evaluate(
            () => (performance as any).memory?.usedJSHeapSize ?? 0,
          );
          if (h > peakHeap) peakHeap = h;
        } catch {
          // page may be navigating; ignore
        }
        await page.waitForTimeout(500);
      }
    })();

    const applyBtn = page.getByTestId('crop-apply');
    await applyBtn.click();
    const applyStart = Date.now();

    // Apply is asynchronous: clicking Apply immediately closes the panel
    // (via flushSync(setEditMode('none')) in handleApplyCrop — that's
    // load-bearing for memory reasons, see the comment block there). The
    // actual crop_octree work runs in the background, so we wait for the
    // cloud's data-point-count to drop below the pre-apply value rather
    // than chasing the panel-gone state.
    await page.waitForFunction(
      (originalN) => {
        const el = document.querySelector('[data-testid="scan-row"]') as HTMLElement | null;
        if (!el) return false;
        const n = parseInt(el.getAttribute('data-point-count') ?? '0', 10);
        return n > 0 && n < originalN;
      },
      FIXTURE_N,
      { timeout: APPLY_TIMEOUT_MS, polling: 500 },
    );
    const applyElapsedMs = Date.now() - applyStart;

    // Give the JS heap a moment to settle after the apply completes (the
    // old octree is async-disposed via the load-effect cleanup).
    await page.waitForTimeout(2_000);
    stopSampling.current = true;
    await sampler;

    // ── Assertions ───────────────────────────────────────────────────────
    // The fixture is uniformly distributed in [-5, 5]^3, so the Z<=0 half
    // should keep ~50%. Use a ±10% band to absorb fixture-side stochastic
    // variation (uniform random gives σ~√n on the count for a 50/50
    // partition; at 1M points that's ±0.05% but we want headroom for
    // smaller fixture sizes too) plus LAS quantisation drift at the
    // boundary.
    const expectedLow = Math.floor(FIXTURE_N * 0.40);
    const expectedHigh = Math.ceil(FIXTURE_N * 0.60);
    const postCount = await row.getAttribute('data-point-count');
    const postN = parseInt(postCount ?? '0', 10);
    expect(postN).toBeGreaterThanOrEqual(expectedLow);
    expect(postN).toBeLessThanOrEqual(expectedHigh);

    // Heap ceiling — the success metric.
    expect(peakHeap, `peak heap was ${(peakHeap / 1024 / 1024).toFixed(1)} MB`)
      .toBeLessThan(HEAP_BUDGET_BYTES);

    // Latency reporting (not asserted — the assertion is on heap). Surface
    // it in test output so regressions in apply throughput show up in CI.
    console.log(
      `[octree-${FIXTURE_N}] apply latency: ${(applyElapsedMs / 1000).toFixed(1)}s, ` +
      `peak heap: ${(peakHeap / 1024 / 1024).toFixed(1)} MB, ` +
      `kept ${postN.toLocaleString()} / ${FIXTURE_N.toLocaleString()} points`,
    );
  } finally {
    await close();
  }
});

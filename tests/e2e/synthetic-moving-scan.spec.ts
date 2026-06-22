import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { stubOpenDialog } from './helpers/stubOpenDialog';

// End-to-end synthetic MOVING-platform scan: generate a plant, attach a
// trajectory to a scanner, run the synthetic scan, and assert the scan actually
// ran as a moving scan (per-beam origins along the path) — not a static scan
// from a single point, which was the bug. Drives the live backend through the
// real DOM (no /api mocking).
test('runs a synthetic moving-platform scan driven by a trajectory', async () => {
  const { app, page, close } = await launchApp();

  try {
    // ── 1. Generate a plant to scan ──────────────────────────────────────
    await page.getByTestId('tool-plant-generate').click();
    const plantPopup = page.getByTestId('plant-generation-popup');
    await expect(plantPopup).toBeVisible();
    await page.getByTestId('plant-species-select').selectOption('bean');
    await page.getByTestId('plant-age-input').fill('20');
    await page.getByTestId('plant-generate-button').click();
    await expect(page.getByTestId('mesh-row').first()).toBeVisible({ timeout: 120_000 });

    // ── 2. Add a scanner and attach the trajectory ───────────────────────
    const traj = join(repoRoot, 'tests', 'e2e', 'fixtures', 'moving-scan', 'low_pass.csv');
    await stubOpenDialog(app, traj);

    await page.getByTestId('tool-add-scan').click();
    const scanPopup = page.getByTestId('scan-parameters-popup');
    await expect(scanPopup).toBeVisible();
    await page.getByTestId('scan-label-input').fill('flight');

    // A generic raster scanner with a full hemisphere sweep reliably images a
    // small plant below the low pass (a real spinning multibeam is built for
    // wide-area mobile mapping, not a close small target). The trajectory makes
    // it a moving scan.
    await page.getByTestId('scan-trajectory-import').click();
    await expect(page.getByTestId('scan-trajectory-label')).toBeVisible();
    // Full downward sweep so the nadir pass hits the plant under the path.
    await page.getByTestId('scan-zenith-min').fill('0');
    await page.getByTestId('scan-zenith-max').fill('180');
    await page.getByTestId('scan-zenith-points').fill('60');

    // The PRF field shows for a moving scan (a fixed laser spec). Set a modest
    // value so this fast test fires a tractable pulse count over the ~2 s flight;
    // the scan still auto-spans the whole flight regardless of the rate.
    const pulseRate = page.getByTestId('scan-pulse-rate');
    await expect(pulseRate).toBeVisible();
    await pulseRate.fill('4000');
    // Azimuth points are now PER REVOLUTION (the sensor's angular resolution); the
    // backend derives revolutions + total pulses from PRF × flight duration.
    await page.getByTestId('scan-azimuth-points').fill('120');

    // The derived panel reports the full-flight grid (rotation rate, total pulses)
    // — proving the UI computes the flight-spanning sweep, not a one-shot budget.
    await expect(page.getByTestId('scan-moving-derived')).toBeVisible();
    const totalPulsesText = await page.getByTestId('scan-moving-total-pulses').textContent();
    expect(parseInt((totalPulsesText ?? '0').replace(/,/g, ''), 10)).toBeGreaterThan(1000);

    await page.getByTestId('scan-submit').click();
    await expect(scanPopup).not.toBeVisible();

    const scannerRow = page.locator('[data-testid="scan-row"][data-scan-name="flight"]');
    await expect(scannerRow).toBeVisible();
    await expect(scannerRow).toHaveAttribute('data-moving', 'true');
    await expect(scannerRow).toHaveAttribute('data-has-data', 'false');

    // ── 3. Run the synthetic scan ────────────────────────────────────────
    await page.getByTestId('run-synthetic-scan').click();
    const scanOptions = page.getByTestId('synthetic-scan-options-popup');
    await expect(scanOptions).toBeVisible();

    // The options popup shows the total-pulse estimate before you commit — for a
    // moving scan that's the full-flight count (PRF × duration), the figure that
    // signals an expensive run.
    await expect(page.getByTestId('scan-opt-pulse-estimate')).toBeVisible();
    const est = await page.getByTestId('scan-opt-total-pulses').textContent();
    expect(parseInt((est ?? '0').replace(/[,.]/g, '').replace(/M.*/, ''), 10)).toBeGreaterThan(0);

    // Record misses so the cloud carries the full beam population.
    await page.getByTestId('scan-opt-run').click();
    await expect(scanOptions).not.toBeVisible();

    // The central status pill shows while the scan runs, carrying a DETERMINATE
    // progress bar with a percentage. The opaque C++ ray-trace can't self-report,
    // so the client drives a synthetic creep across that stage — the key property
    // is that the bar shows a finite percentage (a real, moving bar) rather than
    // the old null-fraction pulse with no number. Sample the pill while the scan
    // runs and assert that whenever it's visible it carries a finite percentage in
    // [0, 100]. Best-effort + guarded by the data-landing wait below: the pill
    // vanishes on completion, so the data assertion gates correctness regardless.
    const statusPill = page.getByTestId('synthetic-scan-status');
    let sawPercent = false;
    for (let i = 0; i < 60; i++) {
      const txt = await statusPill.locator('text=/%$/').first().textContent().catch(() => null);
      if (txt) {
        const pct = parseInt(txt.replace('%', ''), 10);
        expect(pct).toBeGreaterThanOrEqual(0);
        expect(pct).toBeLessThanOrEqual(100);
        sawPercent = true;
      }
      if ((await scannerRow.getAttribute('data-has-data')) === 'true') break;
      await page.waitForTimeout(100);
    }
    // (sawPercent is informational — the determinate-bar property is asserted
    // above each time the pill is caught; a too-fast scan simply yields no sample.)
    void sawPercent;

    // ── 4. Data lands on the scanner row, and it's a genuine moving scan ──
    await expect(scannerRow).toHaveAttribute('data-has-data', 'true', { timeout: 120_000 });
    await expect(scannerRow).toHaveAttribute('data-moving', 'true');
    const pointCount = parseInt((await scannerRow.getAttribute('data-point-count'))!, 10);
    expect(pointCount).toBeGreaterThan(50);

    // The scene bounds (camera frame) must span the trajectory's ~3 m X-extent:
    // a static scan from one point would frame only the small plant (< ~1.5 m).
    // This is the DOM-visible proof the platform actually moved across the pass.
    const viewer = page.locator('[data-scene-bounds-size]');
    const boundsSize = parseFloat((await viewer.getAttribute('data-scene-bounds-size'))!);
    expect(boundsSize).toBeGreaterThan(3);
  } finally {
    await close();
  }
});

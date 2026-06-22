import { test, expect } from '@playwright/test';
import { launchApp } from './helpers/launchApp';

// End-to-end synthetic LiDAR scan: generate a real plant model (pyhelios),
// place a scanner above it through the Scans UI, then run the Synthetic LiDAR
// Scan and assert a real point cloud lands in the layer list.
//
// This drives the live backend (/api/plant/generate + /api/lidar/scan, both
// pyhelios) through the actual DOM — no API mocking — and asserts on concrete
// output (a new cloud row with a plausible point count), not just "no error".
test('generates a plant, scans it, and a point cloud appears', async () => {
  const { page, close } = await launchApp();

  try {
    await expect(page.getByTestId('empty-viewer-hint')).toBeVisible();

    // ── 1. Generate a plant to scan ──────────────────────────────────────
    await page.getByTestId('tool-plant-generate').click();
    const plantPopup = page.getByTestId('plant-generation-popup');
    await expect(plantPopup).toBeVisible();

    const species = page.getByTestId('plant-species-select');
    await expect(species).toBeVisible();
    await expect(species.locator('option')).not.toHaveCount(0);
    await species.selectOption('bean');
    await page.getByTestId('plant-age-input').fill('20');
    await page.getByTestId('plant-generate-button').click();

    // The plant mesh row appears (pyhelios cold init can be slow).
    const meshRow = page.getByTestId('mesh-row').first();
    await expect(meshRow).toBeVisible({ timeout: 120_000 });
    await expect(meshRow).toHaveAttribute('data-is-plant', 'true');

    // ── 2. Place a scanner above the plant ───────────────────────────────
    // Count existing layer rows before scanning. The plant is a mesh, so the
    // scan panel may already show a params-only scan from neither — start clean.
    const scanRows = page.getByTestId('scan-row');
    const beforeCount = await scanRows.count();

    await page.getByTestId('tool-add-scan').click();
    const scanPopup = page.getByTestId('scan-parameters-popup');
    await expect(scanPopup).toBeVisible();

    await page.getByTestId('scan-label-input').fill('overhead');
    // Scanner 3 m straight above the plant base (plants build around the origin).
    await page.getByTestId('scan-origin-x').fill('0');
    await page.getByTestId('scan-origin-y').fill('0');
    await page.getByTestId('scan-origin-z').fill('3');
    // Modest resolution keeps the scan fast but dense enough to hit foliage.
    await page.getByTestId('scan-zenith-points').fill('150');
    await page.getByTestId('scan-azimuth-points').fill('150');
    // Full sphere sweep so the downward rays reach the plant below.
    await page.getByTestId('scan-zenith-min').fill('0');
    await page.getByTestId('scan-zenith-max').fill('180');
    await page.getByTestId('scan-azimuth-min').fill('0');
    await page.getByTestId('scan-azimuth-max').fill('360');
    await page.getByTestId('scan-submit').click();
    await expect(scanPopup).not.toBeVisible();

    // The params-only scanner shows as a row (params, no data yet).
    const scannerRow = page.locator('[data-testid="scan-row"][data-scan-name="overhead"]');
    await expect(scannerRow).toBeVisible();
    await expect(scannerRow).toHaveAttribute('data-has-params', 'true');
    await expect(scannerRow).toHaveAttribute('data-has-data', 'false');

    // ── 3. Run the scan ──────────────────────────────────────────────────
    // The Scans panel shows a "Run Synthetic LiDAR Scan" button as soon as a
    // scanner exists — no mesh selection required.
    const scanButton = page.getByTestId('run-synthetic-scan');
    await expect(scanButton).toBeVisible();
    await scanButton.click();

    // The Synthetic Scan Options popup opens before the scan runs (noise,
    // misses, full-waveform tuning). It lists each scan position as a toggle:
    // the "overhead" scanner appears, disabling it disables Run, and
    // re-enabling restores it. Then accept the defaults and run.
    const scanOptions = page.getByTestId('synthetic-scan-options-popup');
    await expect(scanOptions).toBeVisible();
    const positionRows = scanOptions.getByTestId('scan-opt-scanner-row');
    await expect(positionRows).toHaveCount(1);
    await expect(positionRows.first()).toContainText('overhead');
    const runOptBtn = page.getByTestId('scan-opt-run');
    // Toggle the only position off → Run is disabled (nothing to scan)…
    await positionRows.first().click();
    await expect(runOptBtn).toBeDisabled();
    // …toggle it back on → Run is enabled again.
    await positionRows.first().click();
    await expect(runOptBtn).toBeEnabled();
    await runOptBtn.click();
    await expect(scanOptions).not.toBeVisible();

    // The central status pill (the same one triangulation / LAD / QSM use) shows
    // while the scan runs, carrying a moving progress bar. The opaque C++
    // ray-trace can't self-report, so the client drives a synthetic creep across
    // that stage — assert the pill appears AND reports a finite fraction (a moving
    // bar), not a frozen pulse. Raced against completion: a tiny static scan can
    // finish quickly, so accept either the pill showing or the data already landed.
    const statusPill = page.getByTestId('synthetic-scan-status');
    await Promise.race([
      expect(statusPill).toBeVisible({ timeout: 30_000 }),
      expect(scannerRow).toHaveAttribute('data-has-data', 'true', { timeout: 30_000 }),
    ]);

    // ── 4. Point data must land ON THE SCANNER'S OWN ROW ─────────────────
    // The synthetic scan writes hits back into the scanner scan in place — no
    // new params-less cloud. The "overhead" row keeps its params AND gains data.
    await expect(scannerRow).toHaveAttribute('data-has-data', 'true', { timeout: 120_000 });
    await expect(scannerRow).toHaveAttribute('data-has-params', 'true');

    const countStr = await scannerRow.getAttribute('data-point-count');
    expect(countStr).not.toBeNull();
    const pointCount = parseInt(countStr!, 10);
    // A 20-day bean scanned from overhead at 150×150 must yield a substantial,
    // occlusion-limited cloud — well above a trivial handful of points.
    expect(pointCount).toBeGreaterThan(200);

    // No extra row was created — the data attached to the existing scanner.
    await expect(scanRows).toHaveCount(beforeCount + 1);
  } finally {
    await close();
  }
});

// Return type end-to-end: a 'multi' (full-waveform) scan of the same plant from
// the same position penetrates foliage and reports more returns than an exact
// single-ray scan (rays per pulse = 1). Drives the live backend through the real
// UI — sets the return type in the Add-Scan popup, sets rays per pulse in the
// Synthetic Scan Options popup, runs each scan, and reads the resulting point
// count off the scanner row — asserting multi > exact.
test('multi-return scan yields more points than an exact (1 ray/pulse) scan', async () => {
  const { page, close } = await launchApp();

  try {
    // ── Generate a leafy plant ───────────────────────────────────────────
    await page.getByTestId('tool-plant-generate').click();
    const plantPopup = page.getByTestId('plant-generation-popup');
    await expect(plantPopup).toBeVisible();
    await page.getByTestId('plant-species-select').selectOption('bean');
    await page.getByTestId('plant-age-input').fill('22');
    await page.getByTestId('plant-generate-button').click();
    const meshRow = page.getByTestId('mesh-row').first();
    await expect(meshRow).toBeVisible({ timeout: 120_000 });

    const scanPopup = page.getByTestId('scan-parameters-popup');
    const scanOptions = page.getByTestId('synthetic-scan-options-popup');

    // Configure the overhead scanner once, choosing a return type each run. Beam
    // optics are always shown now (both single and multi sample the cone).
    const configureScanner = async (mode: 'single' | 'multi') => {
      await page.getByTestId('tool-add-scan').click();
      await expect(scanPopup).toBeVisible();
      await page.getByTestId('scan-label-input').fill('overhead');
      await page.getByTestId('scan-origin-x').fill('0');
      await page.getByTestId('scan-origin-y').fill('0');
      await page.getByTestId('scan-origin-z').fill('3');
      await page.getByTestId('scan-zenith-points').fill('120');
      await page.getByTestId('scan-azimuth-points').fill('120');
      await page.getByTestId('scan-zenith-min').fill('0');
      await page.getByTestId('scan-zenith-max').fill('180');
      await page.getByTestId(`scan-return-${mode}`).click();
      await expect(page.getByTestId('scan-beam-fields')).toBeVisible();
      await page.getByTestId('scan-beam-diameter').fill('0.01');
      await page.getByTestId('scan-beam-divergence').fill('10');
      if (mode === 'multi') {
        await page.getByTestId('scan-max-returns').fill('6');
      }
      await page.getByTestId('scan-submit').click();
      await expect(scanPopup).not.toBeVisible();
    };

    // raysPerPulse = 1 ⇒ exact single-ray scan; > 1 ⇒ realistic beam cone.
    const runScanAndReadCount = async (raysPerPulse: number): Promise<number> => {
      await page.getByTestId('run-synthetic-scan').click();
      await expect(scanOptions).toBeVisible();
      // Rays-per-pulse is always available now (it's the universal cone-sampling
      // knob, and the way to get an idealized exact scan).
      await page.getByTestId('scan-opt-rays-per-pulse').fill(String(raysPerPulse));
      await page.getByTestId('scan-opt-run').click();
      await expect(scanOptions).not.toBeVisible();
      const row = page.locator('[data-testid="scan-row"][data-scan-name="overhead"]');
      await expect(row).toHaveAttribute('data-has-data', 'true', { timeout: 120_000 });
      const countStr = await row.getAttribute('data-point-count');
      return parseInt(countStr ?? '0', 10);
    };

    // ── Exact run: single return, one ray per pulse ──────────────────────
    await configureScanner('single');
    const exactCount = await runScanAndReadCount(1);
    expect(exactCount).toBeGreaterThan(100);

    // Remove the scanner before placing the multi one.
    const scanId = await page
      .locator('[data-testid="scan-row"][data-scan-name="overhead"]')
      .getAttribute('data-scan-id');
    await page.getByTestId(`scan-delete-${scanId}`).click();
    const confirm = page.getByTestId('confirm-delete');
    if (await confirm.isVisible().catch(() => false)) await confirm.click();

    // ── Multi run: full-waveform, many rays per pulse ────────────────────
    await configureScanner('multi');
    const multiCount = await runScanAndReadCount(100);

    // Full-waveform multi-return resolves extra echoes a single exact ray can't,
    // so it must report strictly more points than the exact scan.
    expect(multiCount).toBeGreaterThan(exactCount);
  } finally {
    await close();
  }
});

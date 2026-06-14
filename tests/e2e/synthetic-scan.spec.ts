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
    // misses, full-waveform tuning). Accept the defaults and run.
    const scanOptions = page.getByTestId('synthetic-scan-options-popup');
    await expect(scanOptions).toBeVisible();
    await page.getByTestId('scan-opt-run').click();
    await expect(scanOptions).not.toBeVisible();

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

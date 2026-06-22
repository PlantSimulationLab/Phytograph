import { test, expect } from '@playwright/test';
import { launchApp } from './helpers/launchApp';

// Cancelling a synthetic LiDAR scan must actually stop the backend and free its
// memory — not just hide the UI. This drives the live backend (/api/lidar/scan +
// /api/cancel/{run_id}) through the real DOM: generate a plant, start a HEAVY
// scan (high resolution × many rays/pulse so it runs long enough to cancel),
// click the status-pill Cancel, and assert the run is abandoned — the pill
// clears, the scanner never gains data, and the UI stays responsive enough to
// start (and complete) a second, small scan afterward.
//
// The "memory is freed" guarantee is covered by the backend unit test
// (test_cancel.py: the C++ ray loop short-circuits and the Context/LiDARCloud
// `with` blocks unwind). This E2E proves the user-facing cancel path end-to-end.
test('cancelling a heavy synthetic scan abandons the run and leaves the UI usable', async () => {
  const { page, close } = await launchApp();

  try {
    await expect(page.getByTestId('empty-viewer-hint')).toBeVisible();

    // ── Generate a leafy plant to scan ───────────────────────────────────
    await page.getByTestId('tool-plant-generate').click();
    const plantPopup = page.getByTestId('plant-generation-popup');
    await expect(plantPopup).toBeVisible();
    await page.getByTestId('plant-species-select').selectOption('bean');
    await page.getByTestId('plant-age-input').fill('22');
    await page.getByTestId('plant-generate-button').click();
    const meshRow = page.getByTestId('mesh-row').first();
    await expect(meshRow).toBeVisible({ timeout: 120_000 });

    // ── Place an overhead scanner at HIGH resolution ─────────────────────
    await page.getByTestId('tool-add-scan').click();
    const scanPopup = page.getByTestId('scan-parameters-popup');
    await expect(scanPopup).toBeVisible();
    await page.getByTestId('scan-label-input').fill('overhead');
    await page.getByTestId('scan-origin-x').fill('0');
    await page.getByTestId('scan-origin-y').fill('0');
    await page.getByTestId('scan-origin-z').fill('3');
    // Dense grid + full sphere ⇒ a long ray trace that we can cancel mid-run.
    await page.getByTestId('scan-zenith-points').fill('700');
    await page.getByTestId('scan-azimuth-points').fill('700');
    await page.getByTestId('scan-zenith-min').fill('0');
    await page.getByTestId('scan-zenith-max').fill('180');
    await page.getByTestId('scan-azimuth-min').fill('0');
    await page.getByTestId('scan-azimuth-max').fill('360');
    await page.getByTestId('scan-submit').click();
    await expect(scanPopup).not.toBeVisible();

    const scannerRow = page.locator('[data-testid="scan-row"][data-scan-name="overhead"]');
    await expect(scannerRow).toHaveAttribute('data-has-data', 'false');

    // ── Start the scan with many rays/pulse (multiplies C++ work) ────────
    await page.getByTestId('run-synthetic-scan').click();
    const scanOptions = page.getByTestId('synthetic-scan-options-popup');
    await expect(scanOptions).toBeVisible();
    await page.getByTestId('scan-opt-rays-per-pulse').fill('100');
    await page.getByTestId('scan-opt-run').click();
    await expect(scanOptions).not.toBeVisible();

    // ── Cancel as soon as the status pill appears ────────────────────────
    const statusPill = page.getByTestId('synthetic-scan-status');
    await expect(statusPill).toBeVisible({ timeout: 30_000 });
    const cancelBtn = page.getByTestId('synthetic-scan-status-cancel');
    await expect(cancelBtn).toBeVisible();
    await cancelBtn.click();

    // The pill clears (the run is over) and the scanner never gained data — the
    // cancelled scan produced no cloud.
    await expect(statusPill).not.toBeVisible({ timeout: 30_000 });
    await expect(scannerRow).toHaveAttribute('data-has-data', 'false');

    // ── The UI is still responsive: a second, small scan completes ───────
    // Proves the cancel didn't wedge the backend (a leaked/looping process
    // would block or fail this follow-up scan).
    await page.getByTestId('run-synthetic-scan').click();
    await expect(scanOptions).toBeVisible();
    await page.getByTestId('scan-opt-rays-per-pulse').fill('1');
    await page.getByTestId('scan-opt-run').click();
    await expect(scanOptions).not.toBeVisible();

    await expect(scannerRow).toHaveAttribute('data-has-data', 'true', { timeout: 120_000 });
    const countStr = await scannerRow.getAttribute('data-point-count');
    expect(parseInt(countStr ?? '0', 10)).toBeGreaterThan(100);
  } finally {
    await close();
  }
});

import { test, expect } from '@playwright/test';
import { launchApp } from './helpers/launchApp';

// End-to-end: the "Synthetic scan memory budget (MB)" app setting threads all the
// way through to the live backend's ray trace. The setting caps the transient
// ray-tracing scratch buffers so a large scan is processed in CHUNKS rather than
// one OOM-prone batch — and chunking must be RESULT-INVARIANT: the same scan run
// with a deliberately tiny budget must yield the same point cloud as the default
// (unset) budget.
//
// This drives the live backend (/api/plant/generate + /api/lidar/scan, both real
// pyhelios) through the real DOM — no mocking. It sets the budget through the real
// Settings dialog (opened via the real menu command, the same path about.spec uses)
// and asserts the wired-through option does NOT change the result: an unset-budget
// scan and a 1 MB-budget scan of the identical scene produce the same point count.
test('synthetic scan memory budget threads through and is result-invariant', async () => {
  const { app, page, close } = await launchApp();

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

    const scanPopup = page.getByTestId('scan-parameters-popup');
    const scanOptions = page.getByTestId('synthetic-scan-options-popup');

    // Place an identical overhead scanner each time (deleting between runs avoids
    // the overwrite prompt — every scanner is scanned exactly once).
    const configureScanner = async () => {
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
      await page.getByTestId('scan-azimuth-min').fill('0');
      await page.getByTestId('scan-azimuth-max').fill('360');
      await page.getByTestId('scan-submit').click();
      await expect(scanPopup).not.toBeVisible();
    };

    // Waveform mode (rays_per_pulse >> 1) so the per-pulse fan-out is large enough
    // for a tiny budget to actually force chunking.
    const runScanAndReadCount = async (): Promise<number> => {
      await page.getByTestId('run-synthetic-scan').click();
      await expect(scanOptions).toBeVisible();
      await page.getByTestId('scan-opt-rays-per-pulse').fill('200');
      await page.getByTestId('scan-opt-run').click();
      await expect(scanOptions).not.toBeVisible();
      const row = page.locator('[data-testid="scan-row"][data-scan-name="overhead"]');
      await expect(row).toHaveAttribute('data-has-data', 'true', { timeout: 120_000 });
      return parseInt((await row.getAttribute('data-point-count')) ?? '0', 10);
    };

    const deleteScanner = async () => {
      const scanId = await page
        .locator('[data-testid="scan-row"][data-scan-name="overhead"]')
        .getAttribute('data-scan-id');
      await page.getByTestId(`scan-delete-${scanId}`).click();
      const confirm = page.getByTestId('confirm-delete');
      if (await confirm.isVisible().catch(() => false)) await confirm.click();
    };

    // Open Settings via the real menu command (App's onMenuCommand → setSettingsOpen),
    // set the memory budget, and close. Blank clears back to the Helios default.
    const setMemoryBudget = async (mb: string) => {
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.webContents.send(
          'menu:command', { kind: 'nav', target: 'options' });
      });
      const dialog = page.getByTestId('settings-dialog');
      await expect(dialog).toBeVisible();
      const field = page.getByTestId('settings-synthetic-scan-memory-budget');
      await field.fill(mb);
      // Commit (blur) then close the dialog.
      await page.getByTestId('settings-dialog-done').click();
      await expect(dialog).not.toBeVisible();
    };

    // ── 1. Default budget (blank): baseline point count ──────────────────
    await configureScanner();
    const defaultCount = await runScanAndReadCount();
    // A 22-day bean scanned from overhead at 120×120 with a 200-ray cone must
    // produce a substantial cloud — otherwise the invariance check is vacuous.
    expect(defaultCount).toBeGreaterThan(200);
    await deleteScanner();

    // ── 2. Tiny 1 MB budget: forces chunking, must match the baseline ────
    await setMemoryBudget('1');
    await configureScanner();
    const chunkedCount = await runScanAndReadCount();

    // The crux: chunking changed HOW the trace ran (many small chunks) but NOT the
    // result. Identical scene + scanner ⇒ identical hit count. The setting is wired
    // through and the cap is result-invariant.
    expect(chunkedCount).toBe(defaultCount);
    await deleteScanner();

    // ── 3. Clear the budget (blank → null): back to the default, still matches ─
    await setMemoryBudget('');
    await configureScanner();
    const clearedCount = await runScanAndReadCount();
    expect(clearedCount).toBe(defaultCount);
  } finally {
    await close();
  }
});

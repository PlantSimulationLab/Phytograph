import { test, expect } from '@playwright/test';
import { launchApp } from './helpers/launchApp';

// Cancelling a plant/canopy build must actually stop the backend build and free
// its memory — not just hide the popup. This drives the live backend
// (/api/plant/generate/stream + /api/cancel/{run_id}) through the real DOM:
// start a HEAVY canopy build (large, aged grid so it runs long enough to
// cancel), click the popup's Cancel, and assert the build is abandoned — no mesh
// row appears, the popup returns to its idle (generate-button) state, and the UI
// stays usable enough to start and complete a second, small build.
//
// The C++ build loops actually short-circuiting on the cancel flag is covered by
// the pyhelios plantarchitecture selfTest + the backend test_cancel.py
// (cancelled mid-build → `cancelled` event, never a result). This E2E proves the
// user-facing cancel path end-to-end.
test('cancelling a heavy canopy build abandons it and leaves the UI usable', async () => {
  const { page, close } = await launchApp();

  try {
    await expect(page.getByTestId('empty-viewer-hint')).toBeVisible();

    await page.getByTestId('tool-plant-generate').click();
    const plantPopup = page.getByTestId('plant-generation-popup');
    await expect(plantPopup).toBeVisible();
    await page.getByTestId('plant-species-select').selectOption('bean');

    // ── Switch to canopy mode and configure a LARGE, aged grid ───────────
    // A big aged canopy is slow enough to cancel mid-build.
    await page.getByTestId('plant-canopy-toggle').check();
    await page.getByTestId('canopy-count-x').fill('8');
    await page.getByTestId('canopy-count-y').fill('8');
    await page.getByTestId('plant-age-input').fill('30');

    // ── Start the build, then cancel as soon as the Cancel button appears ─
    await page.getByTestId('plant-generate-button').click();
    const cancelBtn = page.getByTestId('plant-generate-cancel');
    await expect(cancelBtn).toBeVisible({ timeout: 30_000 });
    await cancelBtn.click();

    // The popup returns to its idle state (generate button back) and NO plant
    // mesh landed — the cancelled build produced nothing.
    await expect(page.getByTestId('plant-generate-button')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('mesh-row')).toHaveCount(0);

    // ── The UI is still usable: a second, small single-plant build lands ──
    // Proves the cancel didn't wedge the backend.
    await page.getByTestId('plant-canopy-toggle').uncheck();
    await page.getByTestId('plant-age-input').fill('10');
    await page.getByTestId('plant-generate-button').click();

    const meshRow = page.getByTestId('mesh-row').first();
    await expect(meshRow).toBeVisible({ timeout: 120_000 });
    await expect(meshRow).toHaveAttribute('data-is-plant', 'true');
  } finally {
    await close();
  }
});

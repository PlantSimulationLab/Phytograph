import { test, expect } from '@playwright/test';
import { launchApp } from './helpers/launchApp';

// Canceling a plant/canopy build must actually stop the backend build and free
// its memory — not just hide the popup. This drives the live backend
// (/api/plant/generate/stream + /api/cancel/{run_id}) through the real DOM:
// start a HEAVY canopy build (large, aged grid so it runs long enough to
// cancel), click the popup's Cancel, and assert the build is abandoned — no mesh
// row appears, the popup returns to its idle (generate-button) state, and the UI
// stays usable enough to start and complete a second, small build.
//
// The C++ build loops actually short-circuiting on the cancel flag is covered by
// the pyhelios plantarchitecture selfTest + the backend test_cancel.py
// (canceled mid-build → `canceled` event, never a result). This E2E proves the
// user-facing cancel path end-to-end.
test('canceling a heavy canopy build abandons it and leaves the UI usable', async () => {
  // The mesh-row wait below allows 180 s, which is exactly playwright.config.ts's
  // per-test cap — so that inner timeout could never actually fire. The global
  // one always won first, and this test could only ever die as an opaque "Test
  // timeout of 180000ms exceeded" instead of failing on its own assertion with a
  // usable message. That is precisely how it reported when CI contention slowed
  // the canopy build (run 32987547865).
  //
  // Give the test real headroom above its longest internal wait. This does not
  // make a genuine hang pass — it makes a genuine hang fail as the assertion it
  // belongs to.
  test.setTimeout(300_000);

  const { page, close } = await launchApp();

  try {
    await expect(page.getByTestId('empty-viewer-hint')).toBeVisible();

    await page.getByTestId('tool-plant-generate').click();
    const plantPopup = page.getByTestId('plant-generation-popup');
    await expect(plantPopup).toBeVisible();
    await page.getByTestId('plant-species-select').selectOption('bean');

    // ── Switch to canopy mode and configure a HEAVY, aged grid ───────────
    // Big enough to still be building when Cancel is clicked, which is all this
    // test needs — the Cancel button only has to appear and be clicked while the
    // build is in flight.
    //
    // 4x4 at age 20 stays comfortably longer than Cancel takes to appear.
    await page.getByTestId('plant-canopy-toggle').check();
    await page.getByTestId('canopy-count-x').fill('4');
    await page.getByTestId('canopy-count-y').fill('4');
    await page.getByTestId('plant-age-input').fill('20');

    // ── Start the build, then cancel as soon as the Cancel button appears ─
    await page.getByTestId('plant-generate-button').click();
    const cancelBtn = page.getByTestId('plant-generate-cancel');
    await expect(cancelBtn).toBeVisible({ timeout: 30_000 });
    await cancelBtn.click();

    // The popup returns to its idle state (generate button back) and NO plant
    // mesh landed — the canceled build produced nothing.
    await expect(page.getByTestId('plant-generate-button')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('mesh-row')).toHaveCount(0);

    // ── The UI is still usable: a second, small single-plant build lands ──
    // Proves the cancel didn't wedge the backend.
    await page.getByTestId('plant-canopy-toggle').uncheck();
    await page.getByTestId('plant-age-input').fill('10');
    await page.getByTestId('plant-generate-button').click();

    // The two builds overlap here: the canceled one is still unwinding when this
    // one starts. That is the regression this guards. PyHelios's process-wide
    // chdir moved under the new build, which failed at once with "Could not
    // resolve asset file" (main.py `_pin_helios_build`). That was reported for a
    // long time as a slow runner, because the toast went unread while the wait
    // for a mesh ran out, so an error now fails here and says what it was.
    const meshRow = page.getByTestId('mesh-row').first();
    const errorToast = page.getByTestId('toast-error');
    await expect(
      page.getByTestId('mesh-row').or(errorToast).first(),
      'the second, small build produced neither a mesh nor an error: the cancel '
        + 'wedged the backend, or the runner was too loaded to finish it in 180 s',
    ).toBeVisible({ timeout: 180_000 });
    if (await errorToast.count()) {
      throw new Error(`the second build failed: ${await errorToast.first().innerText()}`);
    }
    await expect(meshRow).toHaveAttribute('data-is-plant', 'true');
  } finally {
    await close();
  }
});

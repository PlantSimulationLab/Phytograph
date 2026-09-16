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
    // It used to be 8x8 at age 30: 16x the plants of the largest passing canopy
    // spec (plant-generate.spec.ts runs 2x2 at age 15) at double the age. That
    // cost is not free once cancelled — the SECOND build below starts while the
    // backend is still unwinding the first, on a runner already shared with a
    // second Playwright worker, and that is what pushed the small follow-up
    // build past its own 180 s wait in CI. 4x4 at age 20 keeps the build
    // comfortably longer than the time it takes Cancel to appear, at ~a quarter
    // of the abandoned work.
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
    // mesh landed — the cancelled build produced nothing.
    await expect(page.getByTestId('plant-generate-button')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('mesh-row')).toHaveCount(0);

    // ── The UI is still usable: a second, small single-plant build lands ──
    // Proves the cancel didn't wedge the backend.
    await page.getByTestId('plant-canopy-toggle').uncheck();
    await page.getByTestId('plant-age-input').fill('10');
    await page.getByTestId('plant-generate-button').click();

    const meshRow = page.getByTestId('mesh-row').first();
    // 180 s: this small single-plant build is normally seconds, but it runs
    // right after cancelling a canopy — the backend may still be unwinding that
    // work — and CI runs two Playwright workers on a shared runner. It timed out
    // at 120 s once in four CI runs, then again at 180 s against the old 8x8
    // age-30 grid, which is why that grid is now 4x4 at age 20 (see above): the
    // fix is to abandon less work, not to keep raising the ceiling.
    //
    // Report WHY it timed out. A bare toBeVisible() failure here says only
    // "element(s) not found", which cannot distinguish a wedged backend (the
    // thing this test exists to catch) from a slow one — and that ambiguity cost
    // a full diagnosis pass on the CI failure this replaced.
    await expect(
      meshRow,
      'the second, small build never produced a mesh — either the cancel wedged '
        + 'the backend (the regression this test guards) or the runner was too '
        + 'loaded to finish it in 180 s; check whether the popup returned to its '
        + 'idle state above',
    ).toBeVisible({ timeout: 180_000 });
    await expect(meshRow).toHaveAttribute('data-is-plant', 'true');
  } finally {
    await close();
  }
});

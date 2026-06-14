import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';

const UTM = join(repoRoot, 'tests', 'e2e', 'fixtures', 'utm-tree.xyz');

// Layer 2 verification: import a UTM-scale cloud KEEPING large coordinates
// (global shift disabled), confirm the scene frames and the render-only
// displayOffset is active, then box-crop in WORLD space and assert the exact
// kept count — the crop must operate on true world coordinates despite the
// render offset.
//
// Fixture utm-tree.xyz: 16 z-layers × 12 ring points at X~545000, Y~4183000,
// z ∈ [100.0, 101.5]. A box crop keeping z ∈ [100.35, 101.05] (center 100.7,
// size 0.7) keeps 7 layers × 12 = 84 points.
test('Layer2: UTM cloud frames with displayOffset and crops in world space', async () => {
  const { app, page, close } = await launchApp();
  try {
    // ── Import the wizard, DISABLE the global shift (keep large coords) ──────
    await importFiles(app, page, 'import-auto', UTM);
    const wizard = page.getByTestId('import-wizard');
    await expect(wizard).toBeVisible({ timeout: 30_000 });

    // The shift is auto-suggested + ON for large coords; turn it OFF.
    const shiftToggle = page.getByTestId('import-wizard-shift-enabled');
    if (await shiftToggle.count()) {
      if (await shiftToggle.isChecked()) await shiftToggle.uncheck();
      await expect(shiftToggle).not.toBeChecked();
    }
    const importBtn = page.getByTestId('import-wizard-import');
    await expect(importBtn).toBeEnabled({ timeout: 30_000 });
    await importBtn.click();
    await expect(wizard).toBeHidden({ timeout: 30_000 });

    const row = page.locator('[data-testid="scan-row"][data-scan-name="utm-tree.xyz"]');
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row).toHaveAttribute('data-point-count', '192');

    // ── (2) Camera framing: bounds WORLD, camera/target DISPLAY, reconcilable
    //     via displayOffset. Poll until the auto-frame has run. ───────────────
    const cam = await page.waitForFunction(() => {
      const s = (window as any).__getCameraState?.();
      // Wait until the cloud's UTM bounds have registered AND the auto-frame ran,
      // so the displayOffset has propagated to the controller.
      return s && s.framedContent && Math.abs(s.bounds.min[0]) > 1e4 ? s : null;
    }, null, { timeout: 20_000 }).then(h => h.jsonValue());

    // displayOffset must be non-zero on the large axes (X≈545000, Y≈4183000)
    // and the bounds must be at world (UTM) magnitude.
    expect(Math.abs(cam.displayOffset[0])).toBeGreaterThan(1e4);
    expect(Math.abs(cam.displayOffset[1])).toBeGreaterThan(1e4);
    expect(cam.bounds.min[0]).toBeGreaterThan(5e5 - 10); // world X ~545000
    expect(cam.bounds.min[1]).toBeGreaterThan(4e6);       // world Y ~4183000

    // The orbit target is in DISPLAY space (= world center − offset), so it must
    // be SMALL (near origin) even though bounds are at UTM magnitude. This is
    // the whole point: the scene renders near the origin.
    const worldCenter = [
      (cam.bounds.min[0] + cam.bounds.max[0]) / 2,
      (cam.bounds.min[1] + cam.bounds.max[1]) / 2,
      (cam.bounds.min[2] + cam.bounds.max[2]) / 2,
    ];
    const targetReconciled = [
      cam.target[0] + cam.displayOffset[0],
      cam.target[1] + cam.displayOffset[1],
      cam.target[2] + cam.displayOffset[2],
    ];
    // target + offset must reconcile back to the world center (within framing tol).
    expect(Math.abs(targetReconciled[0] - worldCenter[0])).toBeLessThan(1);
    expect(Math.abs(targetReconciled[1] - worldCenter[1])).toBeLessThan(1);
    // And the raw display target must be near the origin (not at UTM magnitude).
    expect(Math.abs(cam.target[0])).toBeLessThan(1e3);
    expect(Math.abs(cam.target[1])).toBeLessThan(1e3);

    // ── (3) World-space box crop. cropBox state is WORLD; the predicate runs in
    //     world space; the render offset must not perturb which points match. ─
    await expect(row).toHaveAttribute('data-selected', 'true');
    await page.getByTestId('tool-crop').click();
    const panel = page.getByTestId('crop-panel');
    await expect(panel).toBeVisible();

    // The initial crop box is the WORLD bounds union — confirm it's at UTM
    // magnitude (not display-shifted), proving cropBox lives in world space.
    const initialMin = await panel.getAttribute('data-crop-min');
    expect(initialMin).not.toBeNull();
    const minX = parseFloat(initialMin!.split(',')[0]);
    expect(minX).toBeGreaterThan(5e5 - 10);

    async function setNumber(testId: string, value: number) {
      const input = page.getByTestId(testId);
      await input.click();
      await input.fill(String(value));
      await input.press('Tab');
    }
    // Keep z ∈ [100.35, 101.05]: center 100.7, size 0.7.
    await setNumber('crop-dim-z', 0.7);
    await setNumber('crop-center-z', 100.7);

    // The committed crop max Z must be ~101.05 (world coords).
    await expect(panel).toHaveAttribute('data-crop-max', /,101\.050$/, { timeout: 5_000 });

    const applyBtn = page.getByTestId('crop-apply');
    await expect(applyBtn).toBeEnabled();
    await applyBtn.click();
    await expect(panel).toHaveCount(0, { timeout: 10_000 });
    await expect(page.getByText('Cropping…')).toHaveCount(0, { timeout: 10_000 });

    // 7 z-layers × 12 = 84 points kept. If the crop had desynced by the
    // displayOffset, the predicate would reject every point (cropBox at UTM
    // world coords vs points shifted to the origin) → count would be 0 or wrong.
    await expect(row).toHaveAttribute('data-point-count', '84', { timeout: 5_000 });
  } finally {
    await close();
  }
});

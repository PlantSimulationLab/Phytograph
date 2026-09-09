import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { stubOpenDialog } from './helpers/stubOpenDialog';
import { completeImportWizard } from './helpers/importWizard';

const FIX = join(repoRoot, 'tests', 'e2e', 'fixtures', 'georef-moving');

// A GEOREFERENCED moving-platform scan must actually DRAW its trajectory.
//
// The regression this pins: `params.origin` / `params.trajectory` are world-frame
// by contract, and each consumer converts on its own — the marker group renders at
// `-displayOffset - worldShift`, LAD calls `shiftPoseStream(traj, ws)`. The
// single-file import path ALSO pre-shifted the poses, so both conversions fired on
// already-shifted data. On this fixture (UTM zone 10N, ellipsoidal height) the
// trajectory was drawn at (-605445, -4266619, 0) — 4.3 million metres from the
// cloud, i.e. invisible — and LAD received doubly-shifted per-beam origins. The
// bulk-import path never pre-shifted, which is why every existing trajectory spec
// passed: they all run with worldShift = 0.
//
// Asserting via a MARKER-LAYER PIXEL DIFF rather than a scene-graph poke: with the
// cloud hidden, toggling the Display panel's scan-markers checkbox is the only
// thing that changes, so a non-trivial pixel difference proves the path is drawn
// where the camera can see it. A scene-bounds assertion could NOT catch this — the
// bounds were correct the whole time; only the render was displaced.
test('a georeferenced moving-platform scan draws its trajectory in the viewport', async () => {
  test.setTimeout(300_000);
  const { app, page, close } = await launchApp();
  try {
    await expect(page.getByTestId('backend-splash')).toHaveCount(0, { timeout: 90_000 });

    await importFiles(app, page, 'import-point-cloud', join(FIX, 'canopy_utm.xyz'));
    await expect(page.getByTestId('import-wizard')).toBeVisible({ timeout: 60_000 });

    await stubOpenDialog(app, join(FIX, 'flight.out'));
    await page.getByTestId('import-wizard-trajectory-import').click();
    await expect(page.getByTestId('import-wizard-trajectory-label'))
      .toHaveText(/flight\.out/, { timeout: 30_000 });
    await completeImportWizard(page);

    const row = page.locator('[data-testid="scan-row"]').first();
    await expect(row).toBeVisible({ timeout: 90_000 });
    await expect(row).toHaveAttribute('data-moving', 'true');
    await page.waitForTimeout(5000);

    // The cloud is imported in a SHIFTED frame — that is the precondition for the
    // bug, so assert it rather than assume it. Bounds are in the stored frame, so
    // a UTM easting of 605k must not appear here.
    const viewer = page.locator('[data-scene-bounds-size]');
    const centre = (await viewer.getAttribute('data-scene-center'))!;
    const [cx, cy] = centre.split(',').map(Number);
    expect(Math.abs(cx)).toBeLessThan(1000);
    expect(Math.abs(cy)).toBeLessThan(1000);

    // The default scene origin (orbit pivot / look-at) must sit ON the cloud.
    // It is laterally `staticBounds.contentCenter`, which excludes the scanner
    // markers and the trajectory: this fixture's flight runs to y=157 while the
    // cloud ends at y=67, and folding that into the midpoint put the pivot at
    // y=78.7 — outside the footprint, so orbiting swung the plot around a point
    // beside it. The camera still FRAMES the whole path (data-scene-center stays
    // at the union midpoint); only the pivot is content-anchored.
    await page.getByTestId('tool-set-scene-origin').click();
    await expect(page.getByTestId('scene-origin-panel')).toBeVisible();
    const originY = Number(await page.getByTestId('scene-origin-input-y').inputValue());
    const originX = Number(await page.getByTestId('scene-origin-input-x').inputValue());
    expect(originY).toBeGreaterThan(0);
    expect(originY).toBeLessThan(67);          // inside the cloud's y footprint
    expect(originX).toBeGreaterThan(0);
    expect(originX).toBeLessThan(144);
    // The union midpoint (with the trajectory) is ~78.7 — assert we are not that.
    expect(Math.abs(originY - 78.7)).toBeGreaterThan(5);
    // ...while the camera's framing bounds DO still include the flight path.
    const sceneCentreY = Number(
      (await page.locator('[data-scene-bounds-size]').getAttribute('data-scene-center'))!
        .split(',')[1],
    );
    expect(sceneCentreY).toBeGreaterThan(67);
    await page.getByTestId('scene-origin-close').click();

    // Hide the point cloud so the markers are the only thing that can change.
    await page.evaluate(() => { (globalThis as any).__hideCloudForPixelTest = true; });
    await page.waitForTimeout(2000);

    const canvas = page.locator('canvas');
    const withMarkers = await canvas.screenshot();

    // Toggle the marker layer off through the real Display panel.
    await page.getByText('Display', { exact: true }).click();
    const checkbox = page.getByTestId('display-scan-markers');
    await expect(checkbox).toBeChecked();
    await checkbox.uncheck();
    await page.waitForTimeout(2000);
    const withoutMarkers = await canvas.screenshot();

    // With the bug the two frames are identical: nothing was ever drawn on screen.
    expect(withMarkers.equals(withoutMarkers)).toBe(false);

    // And the difference must be substantial — a 1700-pose path plus 24 pose
    // glyphs, not a stray antialiased pixel.
    const differing = (() => {
      const n = Math.min(withMarkers.length, withoutMarkers.length);
      let d = 0;
      for (let i = 0; i < n; i++) if (withMarkers[i] !== withoutMarkers[i]) d++;
      return d;
    })();
    expect(differing).toBeGreaterThan(500);
  } finally {
    await close();
  }
});

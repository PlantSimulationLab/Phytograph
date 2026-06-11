import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';

const TINY = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tiny.xyz');

// Erase brush end-to-end — octree screen-space square-stamp model.
//
// Fixture:
//   tiny.xyz — vertical cylinder at origin, r=0.3 h=1.5, 5 z-layers × 12 pts
//   = 60 pts. Imported as an octree (all path-backed clouds are), so erase
//   uses the square-stamp path.
//
// The brush is a screen-space square that extrudes through the cloud along the
// view direction (like the polygon/rect crop, pre-shaped as a square).
//
// UX: the toolbar button (or pressing E) toggles erase mode, which FREEZES the
// viewport; the user then CLICKS or click-drags on the cloud to stamp squares.
// The live GPU preview clips the points behind each stamp; Apply removes the
// union on the backend (crop_octree squares_union region, invert=true). Because
// the test is depth-independent, a stamp punches all the way through the cloud.
//
// These tests drive the REAL interaction per the E2E rules: orient the camera
// so the cloud fills the viewport, enter erase mode, click-drag to stamp,
// assert the painted-stamp counter climbs, then Apply and assert the persisted
// point count drops. "Didn't throw" is not the bar.

test('erase brush: painting square stamps and applying removes points (octree)', async () => {
  const { app, page, close } = await launchApp();

  try {
    await importFiles(app, page, 'import-auto', TINY);
    await completeImportWizard(page);

    const row = page.locator('[data-testid="scan-row"][data-scan-name="tiny.xyz"]');
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row).toHaveAttribute('data-point-count', '60');

    // Freshly imported scan is auto-selected (no re-click — that would toggle off).
    await expect(row).toHaveAttribute('data-selected', 'true');

    // Frame the cloud so it fills the viewport — look down +Y at the cylinder's
    // side (height along Z, width along X), maximizing the screen area covered
    // by points so a cursor sweep is guaranteed to pass over them.
    await page.waitForFunction(() => typeof (window as any).__orientToAxis === 'function');
    await page.evaluate(() => (window as any).__orientToAxis({ x: 0, y: 1, z: 0 }));

    // Open the erase tool — the panel appears but the view stays interactive
    // and erase mode is OFF until toggled.
    await page.getByTestId('tool-erase').click();
    const panel = page.getByTestId('erase-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute('data-stamp-count', '0');
    await expect(panel).toHaveAttribute('data-erase-active', 'false');

    // Toggle erase mode ON (freezes the view, clicks now stamp).
    await page.getByTestId('erase-mode-toggle').click();
    await expect(panel).toHaveAttribute('data-erase-active', 'true');
    // Let the orthographic projection override settle before stamping.
    await page.waitForTimeout(300);

    // Enlarge the brush to the slider max so a sweep removes an unambiguous
    // chunk (not a thin strip that could miss between point rings). Range input
    // can't be .fill()'d; drive React's native setter so onChange fires.
    const slider = panel.locator('input[type="range"]');
    const maxPx = await slider.getAttribute('max');
    await slider.evaluate((el, v) => {
      const input = el as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value',
      )!.set!;
      setter.call(input, v);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, maxPx ?? '150');

    const canvas = page.locator('canvas').first();
    const box = await canvas.boundingBox();
    if (!box) throw new Error('viewer canvas has no bounding box');

    // Click-drag a short swath across the CENTER of the viewport, where the
    // centered cylinder projects. With a large brush each stamp cuts a square
    // through the cloud; the drag removes a strict subset (not a full wipe).
    const cx = box.x + box.width * 0.5;
    const cy = box.y + box.height * 0.5;
    await page.mouse.move(cx - box.width * 0.08, cy);
    await page.mouse.down();
    await page.mouse.move(cx, cy);
    await page.mouse.move(cx + box.width * 0.08, cy);
    await page.mouse.up();

    // Painted-stamp counter must have climbed above zero — the core fix.
    await expect
      .poll(async () => Number(await panel.getAttribute('data-stamp-count')), { timeout: 5_000 })
      .toBeGreaterThan(0);

    // The painted frame must use an ORTHOGRAPHIC projection — the signature that
    // the cleared region is a straight prism matching the square outline, not a
    // center-biased perspective trapezoid.
    await expect(panel).toHaveAttribute('data-erase-projection-kind', 'orthographic');

    // Apply: the backend removes the union of the painted squares and the
    // persisted cloud drops to a strict subset (a sweep, not a full wipe).
    // crop_octree re-runs PotreeConverter, so allow a generous cold-start window.
    await page.getByTestId('erase-apply').click();
    await expect
      .poll(async () => {
        if ((await row.count()) === 0) return -1; // emptied → treat as failure
        return Number(await row.getAttribute('data-point-count'));
      }, { timeout: 60_000 })
      .toBeLessThan(60);
    const kept = Number(await row.getAttribute('data-point-count'));
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(60);
  } finally {
    await close();
  }
});

// Clear Strokes discards the painted preview without touching the cloud — the
// stamp counter returns to 0 and the point count is unchanged.
test('erase brush: Clear Strokes discards the preview without erasing', async () => {
  const { app, page, close } = await launchApp();

  try {
    await importFiles(app, page, 'import-auto', TINY);
    await completeImportWizard(page);

    const row = page.locator('[data-testid="scan-row"][data-scan-name="tiny.xyz"]');
    await expect(row).toBeVisible({ timeout: 20_000 });
    // Freshly imported scan is auto-selected (no re-click — that would toggle off).
    await expect(row).toHaveAttribute('data-selected', 'true');

    await page.waitForFunction(() => typeof (window as any).__orientToAxis === 'function');
    await page.evaluate(() => (window as any).__orientToAxis({ x: 0, y: 1, z: 0 }));

    await page.getByTestId('tool-erase').click();
    const panel = page.getByTestId('erase-panel');
    await expect(panel).toBeVisible();

    // Toggle erase mode ON so clicks stamp.
    await page.getByTestId('erase-mode-toggle').click();
    await expect(panel).toHaveAttribute('data-erase-active', 'true');

    const canvas = page.locator('canvas').first();
    const box = await canvas.boundingBox();
    if (!box) throw new Error('viewer canvas has no bounding box');

    // Click the centre of the viewport (where the cylinder projects) to stamp.
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);

    await expect
      .poll(async () => Number(await panel.getAttribute('data-stamp-count')), { timeout: 5_000 })
      .toBeGreaterThan(0);

    await page.getByTestId('erase-restore').click(); // "Clear Strokes"
    await expect(panel).toHaveAttribute('data-stamp-count', '0');
    // Cloud untouched.
    await expect(row).toHaveAttribute('data-point-count', '60');
  } finally {
    await close();
  }
});

// The Erase tool opens with the view interactive (erase mode OFF). The 'E' key
// toggles erase MODE within the open tool (not the tool itself): ON freezes the
// view and clicks stamp; OFF leaves the panel open so the user can reframe.
test('erase brush: E toggles erase mode within the open tool', async () => {
  const { app, page, close } = await launchApp();

  try {
    await importFiles(app, page, 'import-auto', TINY);
    await completeImportWizard(page);

    const row = page.locator('[data-testid="scan-row"][data-scan-name="tiny.xyz"]');
    await expect(row).toBeVisible({ timeout: 20_000 });
    // Freshly imported scan is auto-selected (no re-click — that would toggle off).
    await expect(row).toHaveAttribute('data-selected', 'true');

    await page.waitForFunction(() => typeof (window as any).__orientToAxis === 'function');
    await page.evaluate(() => (window as any).__orientToAxis({ x: 0, y: 1, z: 0 }));

    // Open the tool — panel visible, erase mode OFF.
    await page.getByTestId('tool-erase').click();
    const panel = page.getByTestId('erase-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute('data-erase-active', 'false');

    const canvas = page.locator('canvas').first();
    const box = await canvas.boundingBox();
    if (!box) throw new Error('viewer canvas has no bounding box');

    // Press E to turn erase mode ON (the toggle button reflects it).
    await canvas.click({ position: { x: 5, y: 5 } }); // focus the canvas
    await page.keyboard.press('e');
    await expect(panel).toHaveAttribute('data-erase-active', 'true');

    // A click on the cloud stamps (view frozen → click erases, not orbit).
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await expect
      .poll(async () => Number(await panel.getAttribute('data-stamp-count')), { timeout: 5_000 })
      .toBeGreaterThan(0);

    // Press E again to turn erase mode OFF — the tool stays OPEN (panel still
    // visible) so the user can reframe without losing painted strokes.
    await page.keyboard.press('e');
    await expect(panel).toHaveAttribute('data-erase-active', 'false');
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute('data-stamp-count', '1');
  } finally {
    await close();
  }
});

// Regression: toggling erase mode OFF then ON (without reframing) must KEEP the
// already-painted stamps and ACCUMULATE new ones — not reset them, which made
// previously-erased points reappear. Stamps live in the parent across the
// brush component's unmount/remount and resume because the camera matches.
test('erase brush: toggling mode off and on accumulates stamps (no reset)', async () => {
  const { app, page, close } = await launchApp();

  try {
    await importFiles(app, page, 'import-auto', TINY);
    await completeImportWizard(page);

    const row = page.locator('[data-testid="scan-row"][data-scan-name="tiny.xyz"]');
    await expect(row).toBeVisible({ timeout: 20_000 });
    // Freshly imported scan is auto-selected (no re-click — that would toggle off).
    await expect(row).toHaveAttribute('data-selected', 'true');
    await page.waitForFunction(() => typeof (window as any).__orientToAxis === 'function');
    await page.evaluate(() => (window as any).__orientToAxis({ x: 0, y: 1, z: 0 }));

    await page.getByTestId('tool-erase').click();
    const panel = page.getByTestId('erase-panel');
    await expect(panel).toBeVisible();
    await page.getByTestId('erase-mode-toggle').click();
    await page.waitForTimeout(300);

    const box = (await page.locator('canvas').first().boundingBox())!;
    const cx = box.x + box.width * 0.5, cy = box.y + box.height * 0.5;

    // First stamp.
    await page.mouse.click(cx, cy);
    await expect(panel).toHaveAttribute('data-stamp-count', '1');

    // Toggle mode OFF then ON in place (no camera change).
    await page.getByTestId('erase-mode-toggle').click();
    await expect(panel).toHaveAttribute('data-erase-active', 'false');
    await page.getByTestId('erase-mode-toggle').click();
    await expect(panel).toHaveAttribute('data-erase-active', 'true');
    await page.waitForTimeout(300);

    // Second stamp must ADD to the first (count = 2), not reset to 1.
    await page.mouse.click(cx + box.width * 0.04, cy);
    await expect
      .poll(async () => Number(await panel.getAttribute('data-stamp-count')), { timeout: 5_000 })
      .toBe(2);
  } finally {
    await close();
  }
});

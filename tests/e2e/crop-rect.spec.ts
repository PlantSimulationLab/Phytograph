import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';

const TINY = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tiny.xyz');

// Rectangle crop end-to-end.
//
// Fixture:
//   tiny.xyz — cylinder at origin, r=0.3 h=1.5, 5 z-layers × 12 pts = 60 pts.
//
// Rect is the screen-space rectangle path: a click-drag in the viewport that
// works from ANY camera angle (unlike the world-space Box, which only makes
// sense top-down). It commits its four corners into the same camera-frozen
// region the polygon lasso uses, so it must exercise the identical
// project-then-point-in-polygon predicate against the live camera.
//
// These tests assert each step visibly takes effect and that the predicate
// actually discriminates — correctness, not error-absence:
//
//   1. Selecting Rect flips data-crop-mode and mounts the SVG overlay with
//      pointer events ENABLED (the gate for the drag).
//   2. A full-viewport drag + Keep Inside retains all 60 points.
//   3. A half-viewport drag keeps a STRICT SUBSET — would fail if the rect's
//      pixel space and the crop projection's pixel space diverged.

test('rect crop: full-viewport drag keeps all enclosed points', async () => {
  const { page, close } = await launchApp();

  try {
    await page.getByTestId('import-menu-button').click();
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByTestId('import-menu-auto').click(),
    ]);
    await chooser.setFiles(TINY);

    const row = page.locator('[data-testid="scan-row"][data-scan-name="tiny.xyz"]');
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row).toHaveAttribute('data-point-count', '60');

    await row.click();
    await expect(row).toHaveAttribute('data-selected', 'true');
    await page.getByTestId('tool-crop').click();

    const panel = page.getByTestId('crop-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute('data-crop-mode', 'box');

    // ── Switch to Rect shape ───────────────────────────────────────────────
    await page.getByTestId('crop-shape-rect').click();
    await expect(panel).toHaveAttribute('data-crop-mode', 'rect');

    // The overlay mounts and must accept pointer events while drawing — if it
    // were 'none', the drag would fall through to the canvas (orbit) and the
    // rectangle would never form: the any-view equivalent of the original
    // "nothing happens" symptom.
    const overlay = page.getByTestId('crop-rect-overlay');
    await expect(overlay).toBeVisible();
    await expect(overlay).toHaveCSS('pointer-events', 'auto');

    const box = await overlay.boundingBox();
    if (!box) throw new Error('crop-rect-overlay has no bounding box');

    // Apply is disabled until a rectangle is committed.
    const applyBtn = page.getByTestId('crop-apply');
    await expect(applyBtn).toBeDisabled();

    // ── Drag a near-full-viewport rectangle ────────────────────────────────
    const inset = 8;
    await page.mouse.move(box.x + inset, box.y + inset);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.move(box.x + box.width - inset, box.y + box.height - inset);
    await page.mouse.up();

    // Committing the rectangle enables Apply and draws the 4 corner markers.
    await expect(applyBtn).toBeEnabled();
    await expect(overlay.locator('circle')).toHaveCount(4);

    // ── Apply (Keep Inside) ────────────────────────────────────────────────
    // The rectangle covers the whole viewport, so every projected point is
    // enclosed → all 60 survive.
    await applyBtn.click();

    await expect(panel).toHaveCount(0, { timeout: 10_000 });
    await expect(page.getByText('Cropping…')).toHaveCount(0, { timeout: 10_000 });

    await expect(row).toHaveAttribute('data-point-count', '60', { timeout: 5_000 });
  } finally {
    await close();
  }
});

// The regression guard for the perspective-trapezoid bug. The fix draws the
// Rect under an ORTHOGRAPHIC projection so the screen rectangle extrudes as a
// straight prism (true rectangle footprint from any view) instead of a
// perspective frustum (trapezoid footprint). The crop freezes the projection
// matrix into the saved region, so the deterministic signature of the fix is:
// a committed Rect region carries an orthographic projection, while a Polygon
// (unchanged, still perspective) carries a perspective one. The panel exposes
// this via data-crop-projection-kind, derived from the frozen matrix.
//
// This is asserted directly rather than via surviving point counts: with only
// 12 discrete points per ring the count near a boundary is too coarse to
// separate trapezoid from rectangle reliably, but the projection matrix is
// exact.
test('rect crop: committed region uses an orthographic projection (no perspective trapezoid)', async () => {
  const { page, close } = await launchApp();

  try {
    await page.getByTestId('import-menu-button').click();
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByTestId('import-menu-auto').click(),
    ]);
    await chooser.setFiles(TINY);

    const row = page.locator('[data-testid="scan-row"][data-scan-name="tiny.xyz"]');
    await expect(row).toBeVisible({ timeout: 20_000 });

    await row.click();
    await page.getByTestId('tool-crop').click();
    const panel = page.getByTestId('crop-panel');
    await expect(panel).toBeVisible();

    // Look down the +X axis — the view under which the trapezoid was visible.
    await page.waitForFunction(() => typeof (window as any).__orientToAxis === 'function');
    await page.evaluate(() => (window as any).__orientToAxis({ x: 1, y: 0, z: 0 }));

    // ── Rect: must commit an ORTHOGRAPHIC region ───────────────────────────
    await page.getByTestId('crop-shape-rect').click();
    await expect(panel).toHaveAttribute('data-crop-mode', 'rect');
    // Nothing committed yet → kind is empty.
    await expect(panel).toHaveAttribute('data-crop-projection-kind', '');

    const rectOverlay = page.getByTestId('crop-rect-overlay');
    const rbox = await rectOverlay.boundingBox();
    if (!rbox) throw new Error('crop-rect-overlay has no bounding box');
    const inset = 8;
    await page.mouse.move(rbox.x + inset, rbox.y + inset);
    await page.mouse.down();
    await page.mouse.move(rbox.x + rbox.width - inset, rbox.y + rbox.height - inset);
    await page.mouse.up();

    // The committed rect's frozen projection is orthographic — the direct
    // signature of the fix. A perspective projection here is the bug.
    await expect(panel).toHaveAttribute('data-crop-projection-kind', 'orthographic');

    // ── Polygon control: still PERSPECTIVE ─────────────────────────────────
    // Proves the ortho override is scoped to Rect (and that the attribute
    // genuinely discriminates rather than always reporting 'orthographic').
    await page.getByTestId('crop-shape-polygon').click();
    await expect(panel).toHaveAttribute('data-crop-mode', 'polygon');
    await expect(panel).toHaveAttribute('data-crop-projection-kind', '');

    const polyOverlay = page.getByTestId('crop-polygon-overlay');
    const pbox = await polyOverlay.boundingBox();
    if (!pbox) throw new Error('crop-polygon-overlay has no bounding box');
    const corners = [
      { x: pbox.x + inset, y: pbox.y + inset },
      { x: pbox.x + pbox.width - inset, y: pbox.y + inset },
      { x: pbox.x + pbox.width - inset, y: pbox.y + pbox.height - inset },
    ];
    for (let i = 0; i < corners.length; i++) {
      await page.mouse.click(corners[i].x, corners[i].y);
      await expect(polyOverlay.locator('circle')).toHaveCount(i + 1);
    }
    await page.keyboard.press('Enter');
    await expect(panel).toHaveAttribute('data-crop-projection-kind', 'perspective');
  } finally {
    await close();
  }
});

// The strong one: a rectangle over only the LEFT half of the viewport must
// keep a STRICT SUBSET — neither all 60 nor 0. The cylinder straddles the
// viewport centre, so a half-cut splits it. This is what would fail if the
// rect's pixel space and the crop projection's pixel space diverged.
test('rect crop: half-viewport drag keeps a strict subset of points', async () => {
  const { page, close } = await launchApp();

  try {
    await page.getByTestId('import-menu-button').click();
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByTestId('import-menu-auto').click(),
    ]);
    await chooser.setFiles(TINY);

    const row = page.locator('[data-testid="scan-row"][data-scan-name="tiny.xyz"]');
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row).toHaveAttribute('data-point-count', '60');

    await row.click();
    await page.getByTestId('tool-crop').click();

    const panel = page.getByTestId('crop-panel');
    await expect(panel).toBeVisible();
    await page.getByTestId('crop-shape-rect').click();
    await expect(panel).toHaveAttribute('data-crop-mode', 'rect');

    const overlay = page.getByTestId('crop-rect-overlay');
    await expect(overlay).toBeVisible();
    const box = await overlay.boundingBox();
    if (!box) throw new Error('crop-rect-overlay has no bounding box');

    // Left half of the viewport, full height. The crop panel floats over the
    // right edge (z-20, above the overlay), so cutting the LEFT half keeps the
    // drag well clear of it.
    const inset = 8;
    const midX = box.x + box.width / 2;
    await page.mouse.move(box.x + inset, box.y + inset);
    await page.mouse.down();
    await page.mouse.move(midX, box.y + box.height / 2);
    await page.mouse.move(midX, box.y + box.height - inset);
    await page.mouse.up();

    const applyBtn = page.getByTestId('crop-apply');
    await expect(applyBtn).toBeEnabled();
    await expect(overlay.locator('circle')).toHaveCount(4);
    await applyBtn.click();

    await expect(panel).toHaveCount(0, { timeout: 10_000 });
    await expect(page.getByText('Cropping…')).toHaveCount(0, { timeout: 10_000 });

    // Strict subset: 0 < kept < 60. A half-plane through a centred cloud
    // can't keep everything or nothing unless projection broke.
    await expect
      .poll(async () => {
        if ((await row.count()) === 0) return -1; // emptied → treated as failure
        return Number(await row.getAttribute('data-point-count'));
      }, { timeout: 8_000 })
      .toBeGreaterThan(0);
    const kept = Number(await row.getAttribute('data-point-count'));
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(60);
  } finally {
    await close();
  }
});

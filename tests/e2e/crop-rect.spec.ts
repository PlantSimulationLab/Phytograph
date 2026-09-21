import { test, expect, type Page } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';
import { resetToFreshScene } from './helpers/resetApp';

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
//
// Shared session: one app + backend for the whole file; File → New resets the
// scene between tests (see helpers/resetApp.ts).

let session: LaunchedApp;
test.beforeAll(async () => {
  session = await launchApp();
});
test.afterAll(async () => {
  await session?.close();
});
test.beforeEach(async () => {
  await resetToFreshScene(session.app, session.page);
});

test('rect crop: full-viewport drag keeps all enclosed points', async () => {
  const { app, page } = session;

  await importFiles(app, page, 'import-auto', TINY);
  await completeImportWizard(page);

  const row = page.locator('[data-testid="scan-row"][data-scan-name="tiny"]');
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row).toHaveAttribute('data-point-count', '60');

  // Freshly imported scan is auto-selected — don't re-click it (a plain click
  // on the sole selection toggles it off). Crop operates on the selection.
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
  const { app, page } = session;

  await importFiles(app, page, 'import-auto', TINY);
  await completeImportWizard(page);

  const row = page.locator('[data-testid="scan-row"][data-scan-name="tiny"]');
  await expect(row).toBeVisible({ timeout: 20_000 });

  // Freshly imported scan is auto-selected (no re-click — that would toggle off).
  await expect(row).toHaveAttribute('data-selected', 'true');
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
});

// The strong one: a rectangle over only the LEFT half of the viewport must
// keep a STRICT SUBSET — neither all 60 nor 0. The cylinder straddles the
// viewport centre, so a half-cut splits it. This is what would fail if the
// rect's pixel space and the crop projection's pixel space diverged.
test('rect crop: half-viewport drag keeps a strict subset of points', async () => {
  const { app, page } = session;

  await importFiles(app, page, 'import-auto', TINY);
  await completeImportWizard(page);

  const row = page.locator('[data-testid="scan-row"][data-scan-name="tiny"]');
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row).toHaveAttribute('data-point-count', '60');

  // Freshly imported scan is auto-selected (no re-click — that would toggle off).
  await expect(row).toHaveAttribute('data-selected', 'true');
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
});

// ── The two ways a drawn rectangle used to stop matching what it cropped ──
//
// Both bugs were purely in the DISPLAY, which is what made them dangerous: the
// committed region is frozen against the draw-time camera and the apply was
// always right, while the outline on screen drifted away from the points it
// had selected. The user reads that as the crop having grabbed the wrong area.
//
//   1. ROTATION AFTER COMMIT. The camera stayed live once the drag committed,
//      but the outline is redrawn at fixed draw-time pixels forever, so any
//      orbit slid the points out from under it. Fixed by locking the camera
//      while a region is live (`rectRegionLive`).
//   2. THE PROJECTION FLIP. The orthographic override used to mount only for
//      the duration of the drag, so the view flattened the instant the user
//      began drawing (data sliding under a rectangle already being aimed) and
//      snapped back to perspective on commit (frozen ortho region vs a
//      perspective viewport). Fixed by holding ortho across all of Rect mode.

type RectCameraState = {
  position: number[];
  target: number[] | null;
  projectionKind: 'orthographic' | 'perspective';
};

/**
 * The projection the viewport is rendering with RIGHT NOW.
 *
 * Deliberately the live camera, not the panel's data-crop-projection-kind —
 * that one reports the matrix FROZEN into a committed region, which is empty
 * before the first drag and is exactly what bug 2 left disagreeing with the
 * viewport. Only the live matrix can tell the two apart.
 */
async function readProjectionKind(page: Page): Promise<string> {
  return (await readRectCamera(page)).projectionKind;
}

function readRectCamera(page: Page): Promise<RectCameraState> {
  return page.evaluate(() => {
    const get = (window as unknown as { __getCameraState?: () => RectCameraState }).__getCameraState;
    if (!get) throw new Error('__getCameraState not registered');
    const s = get();
    return { position: s.position, target: s.target, projectionKind: s.projectionKind };
  });
}

/** Import tiny.xyz, open Crop, and switch to Rect. Returns the live locators. */
async function openCropRect() {
  const { app, page } = session;

  await importFiles(app, page, 'import-auto', TINY);
  await completeImportWizard(page);

  const row = page.locator('[data-testid="scan-row"][data-scan-name="tiny"]');
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row).toHaveAttribute('data-point-count', '60');
  await expect(row).toHaveAttribute('data-selected', 'true');

  await page.getByTestId('tool-crop').click();
  const panel = page.getByTestId('crop-panel');
  await expect(panel).toBeVisible();
  await page.getByTestId('crop-shape-rect').click();
  await expect(panel).toHaveAttribute('data-crop-mode', 'rect');

  return { page, row, panel, overlay: page.getByTestId('crop-rect-overlay') };
}

test('rect crop: the view is locked while a rectangle is committed, so the outline keeps matching the region', async () => {
  const { page, panel, overlay } = await openCropRect();

  // Orbit is live BEFORE anything is drawn — the lock must be scoped to a
  // committed region, not to the whole tool, or framing the shot is impossible.
  // (Asserted first so a lock that is simply always-on can't pass this test.)
  await expect(panel).toHaveAttribute('data-crop-camera-locked', 'false');

  const box = await overlay.boundingBox();
  if (!box) throw new Error('crop-rect-overlay has no bounding box');
  const inset = 8;
  await page.mouse.move(box.x + inset, box.y + inset);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.up();

  // Committed → locked.
  await expect(overlay.locator('circle')).toHaveCount(4);
  await expect(panel).toHaveAttribute('data-crop-camera-locked', 'true');

  // The outline's four corners, and the camera, as committed.
  const cornersBefore = await overlay.locator('polygon').evaluate(
    (el) => (el as SVGPolygonElement).getAttribute('points') ?? '',
  );
  const camBefore = await readRectCamera(page);

  // Now try hard to orbit: a left-drag across the middle of the viewport is
  // exactly the gesture that used to turn the view under the frozen outline.
  await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.6);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.35, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(300);

  const camAfter = await readRectCamera(page);
  const cornersAfter = await overlay.locator('polygon').evaluate(
    (el) => (el as SVGPolygonElement).getAttribute('points') ?? '',
  );

  // The camera did not move — this is the assertion the old code fails. The
  // outline is checked too: it must be the SAME pixels, i.e. the alignment
  // held because nothing moved, not because both drifted together.
  for (let i = 0; i < 3; i++) {
    expect(Math.abs(camAfter.position[i] - camBefore.position[i])).toBeLessThan(1e-6);
  }
  expect(cornersAfter).toBe(cornersBefore);

  // The lock is escapable and says so, or a frozen view reads as a hang.
  await expect(page.getByTestId('crop-rect-lock-hint')).toBeVisible();

  // Escape clears the region and leaves Crop OPEN, re-armed for another
  // rectangle, so re-aiming costs one keystroke instead of the whole tool.
  await page.keyboard.press('Escape');
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('data-crop-mode', 'rect');
  await expect(panel).toHaveAttribute('data-crop-camera-locked', 'false');
  // Re-armed, not idle: the overlay takes pointer events again and there is no
  // committed region left to apply.
  await expect(page.getByTestId('crop-apply')).toBeDisabled();
  await expect(overlay.locator('circle')).toHaveCount(0);

  // The region-lock really is released. The camera stays under the DRAWING
  // gate here (a left-drag is the rectangle gesture, not an orbit, for as long
  // as Rect is armed), so the release is shown by leaving Rect: the view moves
  // freely again and the ortho override is gone with it.
  await page.getByTestId('crop-shape-box').click();
  await expect(panel).toHaveAttribute('data-crop-mode', 'box');
  await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.6);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.35, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(300);

  const camUnlocked = await readRectCamera(page);
  const moved = Math.max(
    ...[0, 1, 2].map((i) => Math.abs(camUnlocked.position[i] - camBefore.position[i])),
  );
  expect(moved).toBeGreaterThan(1e-3);
});

test('rect crop: the projection is already orthographic before the drag starts', async () => {
  const { page, panel, overlay } = await openCropRect();

  // The signature of bug 2. Selecting Rect must flatten the view immediately,
  // so the data does not shift under a rectangle the user has begun aiming.
  // Read from the LIVE camera (nothing is committed yet, so the panel's
  // frozen-matrix attribute is still empty).
  await expect(panel).toHaveAttribute('data-crop-projection-kind', '');
  expect(await readProjectionKind(page)).toBe('orthographic');

  // It also stays ortho AFTER the commit: the frozen region is orthographic,
  // so a viewport that snapped back to perspective would disagree with the
  // outline it is drawing even with the camera untouched.
  const box = await overlay.boundingBox();
  if (!box) throw new Error('crop-rect-overlay has no bounding box');
  const inset = 8;
  await page.mouse.move(box.x + inset, box.y + inset);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.up();
  await expect(panel).toHaveAttribute('data-crop-projection-kind', 'orthographic');

  expect(await readProjectionKind(page)).toBe('orthographic');

  // Leaving Rect restores perspective — the override must not leak into the
  // rest of the app.
  await page.getByTestId('crop-shape-box').click();
  await expect(panel).toHaveAttribute('data-crop-mode', 'box');
  await page.waitForTimeout(200);
  expect(await readProjectionKind(page)).toBe('perspective');
});

// The camera lock must never outlive the Crop tool.
//
// Regression for a bug the lock itself introduced: `cropDrawState` is shared
// with the label lasso and was NOT reset on all of crop's exits — the
// Escape-while-drawing path closed the tool with the state still at
// 'drawing-rect'. The camera gate read that state directly, so the view stayed
// frozen with the panel gone and nothing on screen to explain it. Total,
// silent loss of camera control; the only recovery was restarting the app.
//
// Exercised through BOTH exits (the panel's × and Escape), since they are
// separate code paths and it was the Escape one that broke.
for (const exit of ['close-button', 'escape'] as const) {
  test(`rect crop: the view unlocks after leaving Crop via the ${exit}`, async () => {
    const { page, panel, overlay } = await openCropRect();

    const box = await overlay.boundingBox();
    if (!box) throw new Error('crop-rect-overlay has no bounding box');

    // Commit a rectangle, so the lock is genuinely engaged before we leave.
    const inset = 8;
    await page.mouse.move(box.x + inset, box.y + inset);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await page.mouse.up();
    await expect(panel).toHaveAttribute('data-crop-camera-locked', 'true');

    // Leave Crop entirely.
    if (exit === 'close-button') {
      await page.getByTestId('crop-close').click();
    } else {
      // Escape clears the region first (re-arming Rect), so this takes two:
      // one for the rectangle, one to close the tool. The second is the path
      // that used to strand the camera.
      await page.keyboard.press('Escape');
      await expect(panel).toHaveAttribute('data-crop-camera-locked', 'false');
      await page.keyboard.press('Escape');
    }
    await expect(panel).toHaveCount(0);

    // The view must respond again. A left-drag across the viewport is the
    // ordinary orbit gesture — with the tool gone there is nothing left that
    // should be intercepting it.
    const camBefore = await readRectCamera(page);
    await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.6);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.35, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    const camAfter = await readRectCamera(page);
    const moved = Math.max(
      ...[0, 1, 2].map((i) => Math.abs(camAfter.position[i] - camBefore.position[i])),
    );
    expect(moved).toBeGreaterThan(1e-3);

    // And the orthographic override went with the tool — a viewport left flat
    // after Crop closed would be the same class of leak.
    expect(await readProjectionKind(page)).toBe('perspective');
  });
}

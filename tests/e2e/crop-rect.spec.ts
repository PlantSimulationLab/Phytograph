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
  await expect(overlay).toHaveAttribute('data-crop-rect-committed', 'true');

  // ── Apply (Keep Inside) ────────────────────────────────────────────────
  // The rectangle covers the whole viewport, so every projected point is
  // enclosed → all 60 survive.
  await applyBtn.click();

  await expect(panel).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByText('Cropping…')).toHaveCount(0, { timeout: 10_000 });

  await expect(row).toHaveAttribute('data-point-count', '60', { timeout: 5_000 });
});

// Rect and Polygon are both aimed and frozen under the ordinary PERSPECTIVE
// view: the crop cuts exactly what was on screen, a wedge / cone from the eye.
//
// Rect used to flatten the view to orthographic so its footprint would be a
// true rectangle at every depth. That was reverted: a parallel projection can
// agree with the perspective view it replaces at one depth only, so entering
// the tool moved or rescaled whatever the user had just lined up. The crop
// freezes the projection matrix into the saved region and the panel exposes
// its kind via data-crop-projection-kind, so both halves — the live view never
// flattens, and the frozen region is perspective — are asserted directly.
test('rect + polygon crop: the view is never flattened, and the committed region is perspective', async () => {
  const { app, page } = session;

  await importFiles(app, page, 'import-auto', TINY);
  await completeImportWizard(page);

  const row = page.locator('[data-testid="scan-row"][data-scan-name="tiny"]');
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row).toHaveAttribute('data-selected', 'true');
  await page.getByTestId('tool-crop').click();
  const panel = page.getByTestId('crop-panel');
  await expect(panel).toBeVisible();

  // ── Rect ───────────────────────────────────────────────────────────────
  const camBox = await readRectCamera(page);
  await page.getByTestId('crop-shape-rect').click();
  await expect(panel).toHaveAttribute('data-crop-mode', 'rect');
  await expect(panel).toHaveAttribute('data-crop-projection-kind', '');
  // Selecting the shape changes nothing about the view: same projection, same
  // eye, same orbit target.
  await page.waitForTimeout(300);
  const camRect = await readRectCamera(page);
  expect(camRect.projectionKind).toBe('perspective');
  for (let i = 0; i < 3; i++) {
    expect(Math.abs(camRect.position[i] - camBox.position[i])).toBeLessThan(1e-9);
    expect(Math.abs(camRect.target![i] - camBox.target![i])).toBeLessThan(1e-9);
  }

  const rectOverlay = page.getByTestId('crop-rect-overlay');
  const rbox = await rectOverlay.boundingBox();
  if (!rbox) throw new Error('crop-rect-overlay has no bounding box');
  const inset = 8;
  await page.mouse.move(rbox.x + inset, rbox.y + inset);
  await page.mouse.down();
  await page.mouse.move(rbox.x + rbox.width / 2, rbox.y + rbox.height / 2);
  await page.mouse.move(rbox.x + rbox.width - inset, rbox.y + rbox.height - inset);
  await page.mouse.up();
  await expect(panel).toHaveAttribute('data-crop-projection-kind', 'perspective');
  expect(await readProjectionKind(page)).toBe('perspective');

  // ── Polygon ────────────────────────────────────────────────────────────
  await page.getByTestId('crop-shape-polygon').click();
  await expect(panel).toHaveAttribute('data-crop-mode', 'polygon');
  await expect(panel).toHaveAttribute('data-crop-projection-kind', '');
  expect(await readProjectionKind(page)).toBe('perspective');

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
// viewport center, so a half-cut splits it. This is what would fail if the
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
  await expect(overlay).toHaveAttribute('data-crop-rect-committed', 'true');
  await applyBtn.click();

  await expect(panel).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByText('Cropping…')).toHaveCount(0, { timeout: 10_000 });

  // Strict subset: 0 < kept < 60. A half-plane through a centered cloud
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

// ── A committed rectangle leaves the view FREE, and stays pinned to the world ──
//
// The committed region used to be redrawn as a 2-D outline at its draw-time
// PIXELS, which is only true from the draw pose, so the camera was locked for
// as long as a rectangle was set. It is now drawn in the scene as the volume it
// selects (ScreenRegionOutline), which is true from every angle — so there is
// no lock, and what these tests pin is the other half: moving the view must
// not move the REGION.

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

test('rect crop: the view stays free while a rectangle is committed, and the region stays where it was drawn', async () => {
  const { page, row, panel, overlay } = await openCropRect();

  const box = await overlay.boundingBox();
  if (!box) throw new Error('crop-rect-overlay has no bounding box');
  // The left half of the viewport: splits the cylinder, which straddles center.
  const inset = 8;
  const midX = box.x + box.width / 2;
  await page.mouse.move(box.x + inset, box.y + inset);
  await page.mouse.down();
  await page.mouse.move(midX, box.y + box.height / 2);
  await page.mouse.move(midX, box.y + box.height - inset);
  await page.mouse.up();

  await expect(overlay).toHaveAttribute('data-crop-rect-committed', 'true');
  await expect(panel.getByText('Rectangle ready')).toBeVisible();
  await expect(page.getByTestId('crop-rect-view-hint')).toBeVisible();

  // Orbit with the region set — the gesture the old lock refused.
  const camBefore = await readRectCamera(page);
  await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.6);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.75, box.y + box.height * 0.3, { steps: 12 });
  await page.mouse.up();
  // Then pan the cloud well off to the right (right-drag). The orbit alone
  // cannot tell a frozen region from a live one here — the cylinder is
  // symmetric about its axis, so "the left half" is ~30 points from any angle.
  // After the pan the cylinder sits wholly right of the viewport's center line,
  // so the same pixels re-read against the LIVE camera would enclose nothing.
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.5, { steps: 12 });
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(300);
  const camAfter = await readRectCamera(page);
  const moved = Math.max(
    ...[0, 1, 2].map((i) => Math.abs(camAfter.position[i] - camBefore.position[i])),
  );
  expect(moved).toBeGreaterThan(0.2);

  // The region survived the move, still frozen at the same draw-time corners.
  await expect(overlay).toHaveAttribute('data-crop-rect-committed', 'true');

  // …and still cuts what it cut when it was drawn: the points left of the
  // DRAW-time view's center plane (tiny.xyz: 5 z-layers x 12 points on a
  // r=0.3 circle about the origin).
  const fwd = camBefore.target!.map((t, i) => t - camBefore.position[i]);
  const right = [fwd[1], -fwd[0]]; // forward x up, for a z-up camera
  let left = 0;
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * 2 * Math.PI;
    const side =
      (0.3 * Math.cos(a) - camBefore.position[0]) * right[0] +
      (0.3 * Math.sin(a) - camBefore.position[1]) * right[1];
    if (side < 0) left++;
  }
  const expected = left * 5;

  await page.getByTestId('crop-apply').click();
  await expect(panel).toHaveCount(0, { timeout: 10_000 });
  await expect
    .poll(async () => ((await row.count()) === 0 ? -1 : Number(await row.getAttribute('data-point-count'))), { timeout: 8_000 })
    .toBeLessThan(60);
  const kept = Number(await row.getAttribute('data-point-count'));
  // Points lying on the center plane itself can fall either way by a pixel.
  expect(Math.abs(kept - expected), `kept ${kept}, expected ~${expected}`).toBeLessThanOrEqual(10);
  expect(kept).toBeGreaterThan(0);
});

test('rect crop: Escape clears a committed rectangle and re-arms the drag', async () => {
  const { page, panel, overlay } = await openCropRect();
  const box = await overlay.boundingBox();
  if (!box) throw new Error('crop-rect-overlay has no bounding box');
  await page.mouse.move(box.x + 8, box.y + 8);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.up();
  await expect(overlay).toHaveAttribute('data-crop-rect-committed', 'true');

  // Escape clears the region and leaves Crop OPEN, re-armed for another
  // rectangle, so re-aiming costs one keystroke instead of the whole tool.
  await page.keyboard.press('Escape');
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('data-crop-mode', 'rect');
  await expect(page.getByTestId('crop-apply')).toBeDisabled();
  await expect(overlay).toHaveAttribute('data-crop-rect-committed', 'false');
  await expect(overlay).toHaveCSS('pointer-events', 'auto');
});

// The camera gate held while a rectangle is being DRAWN must never outlive the
// Crop tool.
//
// Regression: `cropDrawState` is shared
// with the label lasso and was NOT reset on all of crop's exits — the
// Escape-while-drawing path closed the tool with the state still at
// 'drawing-rect'. The camera gate read that state directly, so the view stayed
// frozen with the panel gone and nothing on screen to explain it. Total,
// silent loss of camera control; the only recovery was restarting the app.
//
// Exercised through BOTH exits (the panel's × and Escape), since they are
// separate code paths and it was the Escape one that broke.
for (const exit of ['close-button', 'escape'] as const) {
  test(`rect crop: the view responds after leaving Crop via the ${exit}`, async () => {
    const { page, panel, overlay } = await openCropRect();

    const box = await overlay.boundingBox();
    if (!box) throw new Error('crop-rect-overlay has no bounding box');

    const inset = 8;
    await page.mouse.move(box.x + inset, box.y + inset);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await page.mouse.up();
    await expect(overlay).toHaveAttribute('data-crop-rect-committed', 'true');

    // Leave Crop entirely.
    if (exit === 'close-button') {
      await page.getByTestId('crop-close').click();
    } else {
      // Escape clears the region first (re-arming Rect), so this takes two:
      // one for the rectangle, one to close the tool. The second is the path
      // that used to strand the camera.
      await page.keyboard.press('Escape');
      await expect(overlay).toHaveAttribute('data-crop-rect-committed', 'false');
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

    expect(await readProjectionKind(page)).toBe('perspective');
  });
}

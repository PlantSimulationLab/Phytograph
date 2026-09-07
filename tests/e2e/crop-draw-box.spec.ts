import { test, expect, type Page } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';
import { resetToFreshScene } from './helpers/resetApp';
import { dismissToasts, expectPointsHitCanvas } from './helpers/canvasClick';

// "Draw box in viewport" — the two-click world-space crop box.
//
// Fixture:
//   depth-layers.xyz — two parallel planes, both spanning x,z ∈ [-1,1]:
//     a NEAR plane of 25 points at y=0, and a FAR plane of 1681 at y=8.
//
// That 8 m separation in Y with identical X/Z is why this fixture fits here: it
// makes "how deep did the corner land?" a question with well-separated answers,
// which is the axis the bug got wrong.
//
// The bugs guarded, all three user-visible:
//
//   1. Entering draw mode left the COMMITTED box on screen — its wireframe AND
//      its GPU clip — so you drew the new box over the old one while the old
//      one's clip hid the points you were aiming at.
//   2. Every click was projected onto one flat plane at the scene floor. From
//      any view but near-top-down that sends a corner aimed at geometry
//      carrying on past it to the ground. Corners now land on the SURFACE
//      under the cursor, with the ground plane as the fallback.
//   3. The camera stayed orbitable during the draw, so an orbit drag that
//      ended over the pick plane registered as a corner placement.
//
// Shared session: one app + backend for the whole file; File → New resets the
// scene between tests (see helpers/resetApp.ts).

const DEPTH_LAYERS = join(repoRoot, 'tests', 'e2e', 'fixtures', 'depth-layers.xyz');

// The fixture's two planes, and its total point count.
const NEAR_Y = 0;
const FAR_Y = 8;
const TOTAL_POINTS = '1706';

// Canvas fractions that land on the FAR plane under the oblique camera set by
// `orientOblique` below. Measured against the running app (the shipped point
// picker reports Y=7.999 at each), not guessed: the fixture renders small at
// the default framing, so most of the viewport is empty background where a
// click has no surface to hit and would fall through to the ground plane —
// making the test pass for the wrong reason.
const ON_FAR_PLANE_A = { fx: 0.500, fy: 0.440 };
const ON_FAR_PLANE_B = { fx: 0.530, fy: 0.470 };

type CameraState = { position: number[]; target: number[] | null };

function readCamera(page: Page): Promise<CameraState> {
  return page.evaluate(() => {
    const get = (window as unknown as { __getCameraState?: () => CameraState }).__getCameraState;
    if (!get) throw new Error('__getCameraState not registered');
    const s = get();
    return { position: s.position, target: s.target };
  });
}

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

/** Import the fixture, confirm it's selected, and open Crop in Box mode. */
async function openCropBox() {
  const { app, page } = session;

  await importFiles(app, page, 'import-auto', DEPTH_LAYERS);
  await completeImportWizard(page);

  const row = page.locator('[data-testid="scan-row"][data-scan-name="depth-layers"]');
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row).toHaveAttribute('data-point-count', TOTAL_POINTS);
  // The cloud must be octree-backed or there is no surface to pick against and
  // test 2 would silently degrade into testing the ground-plane fallback.
  await expect(row).toHaveAttribute('data-octree', 'true');
  // Freshly imported scan is auto-selected — re-clicking the sole selection
  // would toggle it off. Crop operates on the selection.
  await expect(row).toHaveAttribute('data-selected', 'true');

  await page.getByTestId('tool-crop').click();
  const panel = page.getByTestId('crop-panel');
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('data-crop-mode', 'box');

  return { page, row, panel };
}

/**
 * Look at the planes obliquely.
 *
 * Deliberately off-axis. Dead-on along -Y the view ray is parallel to the
 * ground plane, so the OLD code's ray/plane intersect returned null and placed
 * no corner at all — a test from that camera would pass without discriminating.
 * Off-axis the old code does place a corner, just in the wrong place, which is
 * the comparison worth making.
 */
async function orientOblique(page: Page) {
  await page.waitForFunction(() => typeof (window as any).__orientToAxis === 'function');
  await page.evaluate(() => (window as any).__orientToAxis({ x: 0.15, y: -1, z: 0.5 }));
  // Let the camera settle before any pixel is computed from it.
  await page.waitForTimeout(500);
}

/** Parse a `data-crop-min` / `data-crop-max` attribute into numbers. */
function parseCorner(v: string | null): { x: number; y: number; z: number } {
  if (!v) throw new Error('crop box attribute missing');
  const [x, y, z] = v.split(',').map(Number);
  return { x, y, z };
}

async function cropBounds(page: Page) {
  const panel = page.getByTestId('crop-panel');
  return {
    min: parseCorner(await panel.getAttribute('data-crop-min')),
    max: parseCorner(await panel.getAttribute('data-crop-max')),
  };
}

/**
 * Place both corners of a box by clicking two canvas fractions.
 *
 * Asserts the state machine advances at each click, which also catches a
 * regression of the stale-closure bug: were the second click read through
 * stale state it would re-record corner 1, and the button would never return
 * to its idle label.
 */
async function drawBoxAt(
  page: Page,
  a: { fx: number; fy: number },
  b: { fx: number; fy: number },
) {
  const button = page.getByTestId('crop-draw-box');
  await button.click();
  await expect(button).toContainText('Click first corner');

  const box = await page.locator('canvas').first().boundingBox();
  if (!box) throw new Error('canvas has no bounding box');
  const p1 = { x: box.x + box.width * a.fx, y: box.y + box.height * a.fy };
  const p2 = { x: box.x + box.width * b.fx, y: box.y + box.height * b.fy };

  await dismissToasts(page);
  await expectPointsHitCanvas(page, [p1, p2], 'crop box corners');

  await page.mouse.click(p1.x, p1.y);
  await expect(button).toContainText('Click second corner');
  await page.mouse.click(p2.x, p2.y);
  await expect(button).toContainText('Draw box in viewport');
}

// ── 1. The box being replaced stops clipping while you aim ────────────────
//
// The visible symptom was two boxes at once; the consequence assertable on real
// output is the CLIP. While corners are being placed the old box must stop
// clipping, because it hides exactly the points the new box is being aimed at.
//
// The assertion has to depend on the clip, which is subtler than it first
// looks. Clipping to the near plane and redrawing from a TOP-DOWN view does
// NOT work as a test: the ground-plane fallback still reports a position for a
// clipped-away point, so the redrawn box reaches the far plane either way and
// the test passes even with the clip left live. (Verified — that version
// passed under sabotage.)
//
// What actually distinguishes the two is a SURFACE pick on the clipped-away
// geometry. `pickOutsideClipRegion` is false, so a clipped point is
// unpickable by construction. So: clip the far plane away, view obliquely, and
// click exactly where the far plane sits. Fixed, the clip has stood down and
// the corner lands on it at y≈8. Sabotaged, the far plane is still clipped,
// the pick misses, and the corner falls through to the ground plane — which
// from this camera overshoots well past y=8.
test('draw box: the box being replaced stops clipping the cloud while you aim', async () => {
  const { page, row } = await openCropBox();

  // Tab-commits, never Enter: Enter also bubbles to the global
  // Enter-applies-crop handler, with stale state. Mirrors crop-multi-scan.
  const setNumber = async (testId: string, value: number) => {
    const input = page.getByTestId(testId);
    await input.click();
    await input.fill(String(value));
    await input.press('Tab');
  };

  // Shrink the default (full-bounds) box onto the NEAR plane only.
  await setNumber('crop-dim-y', 1);
  await setNumber('crop-center-y', NEAR_Y);
  await expect(page.getByTestId('crop-panel'))
    .toHaveAttribute('data-crop-max', /,0\.500,/);

  const clipped = await cropBounds(page);
  expect(clipped.max.y).toBeLessThan(FAR_Y - 1);
  void row;

  // Same oblique camera and the same on-the-far-plane pixels as test 2, so the
  // ONLY difference between the two tests is that here the far plane starts out
  // clipped away.
  await orientOblique(page);
  await drawBoxAt(page, ON_FAR_PLANE_A, ON_FAR_PLANE_B);

  const redrawn = await cropBounds(page);

  // The corner landed ON the far plane, so the clip must have stood down for
  // the duration of the draw: a clipped point cannot be picked
  // (pickOutsideClipRegion is false). Still clipping ⇒ the pick misses and the
  // ground-plane fallback overshoots past 8.75.
  expect(redrawn.max.y).toBeLessThan(FAR_Y + 0.75);
  // …and it really did reach the far plane, rather than staying inside the old
  // near-plane box.
  expect(redrawn.max.y).toBeGreaterThan(FAR_Y - 1);
});

// ── 2. Corners land on the surface, not on the floor plane ────────────────
//
// THE core regression, and the one the user actually reported.
//
// Both corners are clicked on the FAR plane (y=8). A surface pick returns that
// plane; the old ground-plane projection ignores the geometry and returns
// wherever the ray crosses the scene floor, which from this oblique camera
// overshoots it. Measured against the real code at these exact fractions:
//
//     fixed → max.y = 7.999   (on the plane)
//     old   → max.y = 9.249   (1.25 m past it)
//
// so the FAR_Y + 0.75 bound below sits between the two with margin on each
// side. It is a measured separation, not a guessed tolerance.
test('draw box: a corner lands on the surface under the cursor, not on the ground plane', async () => {
  const { page } = await openCropBox();

  const full = await cropBounds(page);
  await orientOblique(page);

  await drawBoxAt(page, ON_FAR_PLANE_A, ON_FAR_PLANE_B);

  const after = await cropBounds(page);

  // The corners hit the planes, so the box's Y span must lie within the range
  // the planes occupy. This is what rejects the ground-plane overshoot.
  const pad = 0.75;
  expect(after.min.y).toBeGreaterThan(NEAR_Y - pad);
  expect(after.max.y).toBeLessThan(FAR_Y + pad);

  // A real region, and strictly tighter than the full-bounds default we started
  // from — so this cannot pass by the box simply never changing.
  expect(after.max.x - after.min.x).toBeGreaterThan(0.05);
  expect(after.max.x - after.min.x).toBeLessThan(full.max.x - full.min.x);

  // Z always spans the full data extent regardless of where the corners landed
  // (corners only ever supply X/Y), so the box is immediately usable.
  expect(after.max.z - after.min.z).toBeGreaterThan(1.5);
});

// ── 3. The camera is frozen between the two clicks ────────────────────────
//
// Without this an orbit drag that ends over the pick plane registers as a
// corner placement, and the box lands somewhere the user never clicked.
test('draw box: dragging the viewport while placing corners does not orbit', async () => {
  const { page } = await openCropBox();
  await orientOblique(page);

  const button = page.getByTestId('crop-draw-box');
  await button.click();
  await expect(button).toContainText('Click first corner');

  const box = await page.locator('canvas').first().boundingBox();
  if (!box) throw new Error('canvas has no bounding box');
  // Left of the crop panel, which occupies roughly the right half of the
  // viewport — expectPointsHitCanvas below fails loudly if that ever shifts.
  const start = { x: box.x + box.width * 0.20, y: box.y + box.height * 0.5 };
  const end = { x: box.x + box.width * 0.50, y: box.y + box.height * 0.5 };

  await dismissToasts(page);
  await expectPointsHitCanvas(page, [start, end], 'orbit-drag attempt');

  const before = await readCamera(page);

  // A drag across ~30% of the viewport width — plenty to orbit visibly.
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move((start.x + end.x) / 2, start.y, { steps: 5 });
  await page.mouse.move(end.x, end.y, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(300);

  expect(await readCamera(page)).toEqual(before);

  // Esc leaves the draw cleanly and the tool stays usable.
  await page.keyboard.press('Escape');
  await expect(button).toContainText('Draw box in viewport');
});

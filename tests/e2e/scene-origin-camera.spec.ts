import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';
import { resetToFreshScene } from './helpers/resetApp';

const FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tiny.xyz');

// The scene origin is both the orbit pivot AND the camera's default look-at.
// Two behaviors are asserted here:
//
//   1. The DEFAULT origin is ground-anchored: laterally the bounds center
//      (X/Y), but vertically at the bounds FLOOR (min.z), not the mid-height.
//      These scenes stand on the ground, so a mid-height pivot puts the
//      rotation center in empty air above the floor.
//   2. Zoom converges on that origin. OrbitControls dollies along
//      camera→controls.target, so the framing code aims the target at the
//      origin — meaning a zoom walks the camera toward the origin rather than
//      toward the bounds mid-height. A PAN deliberately breaks that link, so
//      you can still zoom into an off-origin detail you panned to.
//
// Shared session: one app + backend for the whole file; File → New resets the
// scene between tests (helpers/resetApp.ts).

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

// Import the fixture and wait until the camera controller's hooks are live and
// the initial auto-frame has run.
async function loadFramedScene(session: LaunchedApp) {
  const { app, page } = session;
  await importFiles(app, page, 'import-auto', FIXTURE);
  await completeImportWizard(page);

  const cloudRow = page.locator('[data-testid="scan-row"][data-scan-name="tiny.xyz"]');
  await expect(cloudRow).toBeVisible({ timeout: 20_000 });

  await page.waitForFunction(
    () => typeof (window as any).__getCameraState === 'function'
      && (window as any).__getCameraState()?.framedContent === true,
    { timeout: 20_000 },
  );
}

// camera/target come back in DISPLAY space, bounds in WORLD; reconcile via the
// reported displayOffset so assertions can be written in world coordinates.
function toWorld(state: any, v: number[]): number[] {
  const o = state.displayOffset;
  return [v[0] + o[0], v[1] + o[1], v[2] + o[2]];
}

test('default camera look-at is the ground-anchored scene origin, not the bounds mid-height', async () => {
  const { page } = session;
  await loadFramedScene(session);

  const state = await page.evaluate(() => (window as any).__getCameraState());
  const { min, max } = state.bounds;
  const targetWorld = toWorld(state, state.target);

  const centerX = (min[0] + max[0]) / 2;
  const centerY = (min[1] + max[1]) / 2;
  const centerZ = (min[2] + max[2]) / 2;
  const height = max[2] - min[2];

  // Laterally centered.
  expect(targetWorld[0]).toBeCloseTo(centerX, 3);
  expect(targetWorld[1]).toBeCloseTo(centerY, 3);

  // Vertically at the FLOOR. Asserted against the bounds floor directly, plus a
  // separate check that it is genuinely distinct from the mid-height — on a
  // fixture with real Z extent those differ by half the height, so a regression
  // back to center.z fails loudly rather than sliding under a loose tolerance.
  expect(height).toBeGreaterThan(0.1);
  expect(targetWorld[2]).toBeCloseTo(min[2], 3);
  expect(Math.abs(targetWorld[2] - centerZ)).toBeGreaterThan(height * 0.25);
});

test('zoom converges on the scene origin until the user pans', async () => {
  const { page } = session;
  await loadFramedScene(session);

  const canvas = page.locator('canvas').first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('viewport canvas has no bounding box');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  const readState = () => page.evaluate(() => (window as any).__getCameraState());
  const distance = (s: any) => Math.hypot(
    s.position[0] - s.target[0],
    s.position[1] - s.target[1],
    s.position[2] - s.target[2],
  );

  const before = await readState();
  const originBefore = toWorld(before, before.target);
  const distBefore = distance(before);

  // Scroll-wheel zoom in over the viewport centre — the real gesture, through
  // OrbitControls, not a camera write.
  await page.mouse.move(cx, cy);
  for (let i = 0; i < 5; i++) await page.mouse.wheel(0, -120);
  await page.waitForTimeout(150);

  const after = await readState();
  const originAfter = toWorld(after, after.target);
  const distAfter = distance(after);

  // The zoom actually did something...
  expect(distAfter).toBeLessThan(distBefore * 0.95);
  // ...and it converged on the origin: the look-at point never moved, so the
  // camera walked straight toward the scene origin.
  expect(originAfter[0]).toBeCloseTo(originBefore[0], 3);
  expect(originAfter[1]).toBeCloseTo(originBefore[1], 3);
  expect(originAfter[2]).toBeCloseTo(originBefore[2], 3);

  // Now PAN (right-drag). This is the explicit "look over here" gesture and it
  // detaches zoom from the origin.
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(cx + 120, cy + 80, { steps: 10 });
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(150);

  const panned = await readState();
  const originPanned = toWorld(panned, panned.target);

  // The pan moved the look-at away from the origin — zoom now follows the view,
  // which is what makes zooming into an off-origin detail possible.
  const panShift = Math.hypot(
    originPanned[0] - originBefore[0],
    originPanned[1] - originBefore[1],
    originPanned[2] - originBefore[2],
  );
  expect(panShift).toBeGreaterThan(0.01);
});

test('rotation still pivots about the scene origin after a pan', async () => {
  const { page } = session;
  await loadFramedScene(session);

  const canvas = page.locator('canvas').first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('viewport canvas has no bounding box');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  const readState = () => page.evaluate(() => (window as any).__getCameraState());

  const before = await readState();
  const originWorld = toWorld(before, before.target);
  const radiusBefore = Math.hypot(
    before.position[0] - before.target[0],
    before.position[1] - before.target[1],
    before.position[2] - before.target[2],
  );

  // Pan away first, so the orbit pivot and the OrbitControls target genuinely
  // disagree — that separation is the whole point of the pivot-orbit path.
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(cx + 100, cy + 60, { steps: 10 });
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(150);

  const afterPan = await readState();

  // Left-drag = orbit. It must still swing about the SCENE ORIGIN, not the
  // panned target: the camera's distance to the origin is preserved.
  const originDisplay = [
    originWorld[0] - afterPan.displayOffset[0],
    originWorld[1] - afterPan.displayOffset[1],
    originWorld[2] - afterPan.displayOffset[2],
  ];
  const camToOriginBefore = Math.hypot(
    afterPan.position[0] - originDisplay[0],
    afterPan.position[1] - originDisplay[1],
    afterPan.position[2] - originDisplay[2],
  );

  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 90, cy, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(150);

  const rotated = await readState();
  const camToOriginAfter = Math.hypot(
    rotated.position[0] - originDisplay[0],
    rotated.position[1] - originDisplay[1],
    rotated.position[2] - originDisplay[2],
  );

  // The drag actually rotated the view...
  const moved = Math.hypot(
    rotated.position[0] - afterPan.position[0],
    rotated.position[1] - afterPan.position[1],
    rotated.position[2] - afterPan.position[2],
  );
  expect(moved).toBeGreaterThan(0.01);
  // ...as a rigid turn about the origin: radius to the origin is unchanged.
  expect(camToOriginAfter).toBeCloseTo(camToOriginBefore, 2);
  expect(radiusBefore).toBeGreaterThan(0);
});

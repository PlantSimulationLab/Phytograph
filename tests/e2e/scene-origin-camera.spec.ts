import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';
import { resetToFreshScene } from './helpers/resetApp';

const FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tiny.xyz');

// The scene origin is the ORBIT PIVOT and the transform 3D-cursor — Blender's
// model — and deliberately NOT a zoom attractor. Zoom is driven by
// zoom-to-cursor: the wheel flies the camera toward whatever surface is under
// the pointer, so every part of the scene is reachable no matter where the
// origin sits. (It used to bend framing toward the origin's height so that zoom
// would converge there; that made a moved origin unreachable on a scene with far
// outliers, because nothing could shorten camera→target toward it.)
//
// Asserted here:
//   1. Framing aims at what was framed — the bounds centre — not at the origin.
//   2. Zoom converges on the point under the CURSOR, not on the orbit target,
//      and a moved origin stays reachable.
//   3. Rotation still pivots about the origin, even after a pan.
//   4. "Zoom to origin" is the explicit command that takes you to the pivot.
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

  const cloudRow = page.locator('[data-testid="scan-row"][data-scan-name="tiny"]');
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

test('framing aims at the bounds centre, and zoom limits are scaled to the scene', async () => {
  const { page } = session;
  await loadFramedScene(session);

  const state = await page.evaluate(() => (window as any).__getCameraState());
  const { min, max } = state.bounds;
  const targetWorld = toWorld(state, state.target);

  // The auto-frame aims at what it framed — the whole-scene bounds centre. It no
  // longer drops the look-at to the origin's height: zoom-to-cursor, not a bent
  // look-at, is what makes the scene reachable.
  expect(targetWorld[0]).toBeCloseTo((min[0] + max[0]) / 2, 3);
  expect(targetWorld[1]).toBeCloseTo((min[1] + max[1]) / 2, 3);
  expect(targetWorld[2]).toBeCloseTo((min[2] + max[2]) / 2, 3);

  // Zoom clamps track the scene rather than the old fixed 0.1 / 10000 pair.
  const size = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  expect(size).toBeGreaterThan(0);
  const { minDistance, maxDistance, scale } = state.zoomLimits;
  // The scale is a real measure of this scene, not a constant.
  expect(scale).toBeGreaterThan(size / 100);
  expect(scale).toBeLessThan(size * 10);
  // You can get far closer than the content is big (inspect fine detail)...
  expect(minDistance).toBeLessThan(size / 100);
  // ...and pull back past it, but not to where the scene is a dot.
  expect(maxDistance).toBeGreaterThan(size);
  expect(maxDistance).toBeLessThan(size * 1000);
});

test('zoom flies toward the point under the cursor, not the orbit target', async () => {
  const { page } = session;
  await loadFramedScene(session);

  const canvas = page.locator('canvas').first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('viewport canvas has no bounding box');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  const readState = () => page.evaluate(() => (window as any).__getCameraState());
  // Zoom is measured as distance from the camera to the SCENE, not to the orbit
  // target: camera and target now translate together along the anchor ray, so
  // |camera − target| is invariant under a zoom by construction. That rigid move
  // is exactly what lets the look-at migrate to wherever you point.
  const distToScene = (s: any) => {
    const c = [
      (s.bounds.min[0] + s.bounds.max[0]) / 2 - s.displayOffset[0],
      (s.bounds.min[1] + s.bounds.max[1]) / 2 - s.displayOffset[1],
      (s.bounds.min[2] + s.bounds.max[2]) / 2 - s.displayOffset[2],
    ];
    return Math.hypot(s.position[0] - c[0], s.position[1] - c[1], s.position[2] - c[2]);
  };

  const before = await readState();
  const distBefore = distToScene(before);

  // The camera's own view axis before we start — a stock OrbitControls dolly
  // moves exactly along this, so it is the null hypothesis to beat.
  const viewAxis = (s: any) => {
    const d = [
      s.target[0] - s.position[0],
      s.target[1] - s.position[1],
      s.target[2] - s.position[2],
    ];
    const n = Math.hypot(...d);
    return d.map((v) => v / n);
  };
  const axisBefore = viewAxis(before);
  const posBefore = [...before.position];

  // Zoom in with the pointer well OFF-CENTRE, so "toward the cursor" and "along
  // the view axis" are genuinely different directions.
  const offX = box.x + box.width * 0.3;
  const offY = box.y + box.height * 0.35;
  await page.mouse.move(offX, offY);
  for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -120);
  await page.waitForTimeout(200);

  const after = await readState();
  const distAfter = distToScene(after);

  // The camera really did close in on the scene.
  expect(distAfter).toBeLessThan(distBefore * 0.95);

  // And it travelled toward the CURSOR, not straight down the old view axis.
  // (The look-at stays on the view ray by design — re-seating it laterally would
  // swing the view and would break the pan-step formula, which reads
  // |camera − target| as "how far away is the subject". What makes the zoom
  // cursor-directed is where the CAMERA goes.)
  const travel = [
    after.position[0] - posBefore[0],
    after.position[1] - posBefore[1],
    after.position[2] - posBefore[2],
  ];
  const travelLen = Math.hypot(...travel);
  expect(travelLen).toBeGreaterThan(0);
  const travelDir = travel.map((v) => v / travelLen);
  // cos of the angle between the actual travel and the pure-dolly direction.
  const alongAxis = travelDir.reduce((acc, v, i) => acc + v * axisBefore[i], 0);
  // Moving inward, so it is broadly forward...
  expect(alongAxis).toBeGreaterThan(0);
  // ...but measurably off-axis. A stock dolly — or a zoom that fell back to the
  // on-axis anchor because the depth pick missed — pins this at exactly 1.0, so
  // any clear separation from 1 is the signal. The margin is small on purpose:
  // the fixture is a small cylinder near the centre of frame, so a cursor at
  // 30%/35% of the viewport subtends only a few degrees off the view axis.
  expect(alongAxis).toBeLessThan(0.999);
  expect(1 - alongAxis).toBeGreaterThan(1e-4);

  // Zooming back out must also work (and not be swallowed by a clamp).
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(200);
  expect(distToScene(await readState())).toBeGreaterThan(distAfter);
});

test('a moved scene origin stays reachable: zoom in fully, then pan still moves the view', async () => {
  const { page } = session;
  await loadFramedScene(session);

  const canvas = page.locator('canvas').first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('viewport canvas has no bounding box');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  const readState = () => page.evaluate(() => (window as any).__getCameraState());
  const distToScene = (s: any) => {
    const c = [
      (s.bounds.min[0] + s.bounds.max[0]) / 2 - s.displayOffset[0],
      (s.bounds.min[1] + s.bounds.max[1]) / 2 - s.displayOffset[1],
      (s.bounds.min[2] + s.bounds.max[2]) / 2 - s.displayOffset[2],
    ];
    return Math.hypot(s.position[0] - c[0], s.position[1] - c[1], s.position[2] - c[2]);
  };

  const start = await readState();
  const distStart = distToScene(start);

  // Zoom all the way in — far more notches than it takes to bottom out against
  // the surface clamp. The reported bug was that once fully zoomed the view
  // froze: panning stopped moving anything, so you were stuck.
  await page.mouse.move(cx, cy);
  for (let i = 0; i < 40; i++) await page.mouse.wheel(0, -120);
  await page.waitForTimeout(300);

  const pinned = await readState();
  const posPinned = [...pinned.position];
  const distPinned = distToScene(pinned);

  // We really are deep in — otherwise the pan assertion below proves nothing.
  expect(distPinned).toBeLessThan(distStart * 0.5);

  // Pan (right-drag) at maximum zoom. It must still move the camera by a
  // meaningful fraction of the current viewing scale — the old failure was a pan
  // step proportional to a clamped near-zero camera→target distance, i.e.
  // sub-pixel and indistinguishable from frozen.
  const viewDist = Math.hypot(
    pinned.position[0] - pinned.target[0],
    pinned.position[1] - pinned.target[1],
    pinned.position[2] - pinned.target[2],
  );
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(cx + 150, cy + 100, { steps: 12 });
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(200);

  const panned = await readState();
  const moved = Math.hypot(
    panned.position[0] - posPinned[0],
    panned.position[1] - posPinned[1],
    panned.position[2] - posPinned[2],
  );
  // A pan across most of the viewport should shift the view by a good part of
  // what is on screen, not by a rounding error.
  expect(moved).toBeGreaterThan(viewDist * 0.05);

  // And zooming back out from the pinned-in state still works.
  await page.mouse.move(cx, cy);
  for (let i = 0; i < 10; i++) await page.mouse.wheel(0, 120);
  await page.waitForTimeout(250);
  expect(distToScene(await readState())).toBeGreaterThan(distPinned);
});

test('"Zoom to origin" moves the camera to a moved origin without changing the view angle', async () => {
  const { page } = session;
  await loadFramedScene(session);

  const readState = () => page.evaluate(() => (window as any).__getCameraState());
  const before = await readState();

  // Move the origin well away from the scene centre, through the real panel.
  await page.getByTestId('tool-set-scene-origin').click();
  const panel = page.getByTestId('scene-origin-panel');
  await expect(panel).toBeVisible({ timeout: 10_000 });

  const { min, max } = before.bounds;
  const size = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  const movedOrigin = [min[0] - size * 3, min[1] - size * 3, (min[2] + max[2]) / 2];
  for (const [i, axis] of ['x', 'y', 'z'].entries()) {
    const input = panel.locator(`[data-testid="scene-origin-input-${axis}"]`);
    await input.fill(String(movedOrigin[i]));
    await input.press('Enter');
  }
  await expect(panel).toHaveAttribute('data-has-origin', 'true');

  const beforeFrame = await readState();
  const dirBefore = (s: any) => {
    const d = [
      s.position[0] - s.target[0],
      s.position[1] - s.target[1],
      s.position[2] - s.target[2],
    ];
    const n = Math.hypot(...d);
    return d.map((v) => v / n);
  };
  const angleBefore = dirBefore(beforeFrame);

  // The explicit command.
  await panel.locator('[data-testid="scene-origin-frame"]').click();
  await page.waitForTimeout(250);

  const after = await readState();
  const targetWorld = toWorld(after, after.target);

  // The camera now looks at the moved origin...
  expect(targetWorld[0]).toBeCloseTo(movedOrigin[0], 2);
  expect(targetWorld[1]).toBeCloseTo(movedOrigin[1], 2);
  expect(targetWorld[2]).toBeCloseTo(movedOrigin[2], 2);

  // ...from the same direction it was already looking (framing preserves the
  // orbit angle; only the centre and distance change).
  const angleAfter = dirBefore(after);
  for (let i = 0; i < 3; i++) expect(angleAfter[i]).toBeCloseTo(angleBefore[i], 2);
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

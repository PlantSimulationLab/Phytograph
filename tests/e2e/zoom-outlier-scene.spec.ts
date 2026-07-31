import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';
import { resetToFreshScene } from './helpers/resetApp';

// The reported failure, reproduced on the scene shape that caused it: a small
// dense plot plus a handful of stray returns ~500 m out.
//
// Two symptoms, one root cause. Zoom used to dolly along camera→orbit-target
// only, and nothing could move that target toward what you were looking at
// (pan slides sideways, perpendicular to the view). With far outliers the
// target sat at the inflated bounding-box centre, so:
//   1. Zooming in bottomed out against a fixed minDistance with the content
//      still far away, and panning at that range moved the view by a
//      sub-pixel amount — the view read as frozen.
//   2. A user-placed origin near the real content was unreachable: zoom went
//      to the box centre, and panning never got you closer.
//
// Zoom-to-cursor plus scene-scaled limits fix both. These tests assert against
// the CONTENT, which is what the user cares about, not the outlier-inflated box.

const FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'outlier-extent.xyz');

// The dense plot occupies roughly this volume; the outliers are ~500 m out.
const CONTENT_MIN = [0, 0, 0];
const CONTENT_MAX = [6, 6, 3];
const CONTENT_CENTRE = [3, 3, 1.5];

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

async function loadFramedScene() {
  const { app, page } = session;
  await importFiles(app, page, 'import-auto', FIXTURE);
  await completeImportWizard(page);
  await expect(
    page.locator('[data-testid="scan-row"][data-scan-name="outlier-extent.xyz"]'),
  ).toBeVisible({ timeout: 20_000 });
  await page.waitForFunction(
    () => (window as any).__getCameraState?.()?.framedContent === true,
    { timeout: 20_000 },
  );
}

const readState = () => session.page.evaluate(() => (window as any).__getCameraState());

// Distance from the camera to the real content centre (world coords).
function distToContent(s: any): number {
  const c = CONTENT_CENTRE.map((v, i) => v - s.displayOffset[i]);
  return Math.hypot(s.position[0] - c[0], s.position[1] - c[1], s.position[2] - c[2]);
}

test('zoom limits come from the content, not from the outlier-inflated bounding box', async () => {
  await loadFramedScene();
  const s = await readState();

  // The raw bounds ARE inflated — otherwise this fixture proves nothing.
  const rawSpan = Math.max(
    s.bounds.max[0] - s.bounds.min[0],
    s.bounds.max[1] - s.bounds.min[1],
    s.bounds.max[2] - s.bounds.min[2],
  );
  expect(rawSpan).toBeGreaterThan(500);

  // Yet the derived scale tracks the ~6 m content, not the ~1000 m box. This is
  // the whole point of the robust estimate: two orders of magnitude apart.
  const { scale, minDistance, maxDistance } = s.zoomLimits;
  expect(scale).toBeLessThan(50);
  expect(scale).toBeGreaterThan(1);

  // So you can get close enough to inspect a stem...
  expect(minDistance).toBeLessThan(0.01);
  // ...and the far limit is not parked inside the content the way a fixed
  // 10000 would have been relative to a scene this size.
  expect(maxDistance).toBeGreaterThan(rawSpan / 100);
  expect(maxDistance).toBeLessThan(rawSpan * 10);
});

test('import frames the content, not the empty space between the outliers', async () => {
  await loadFramedScene();
  const s = await readState();

  // The camera lands a short way off the CONTENT — a few times its size — rather
  // than hundreds of metres out where the raw bounding box's corners are. This
  // is the framing half of the fix: a dolly moves along the view ray and can
  // never correct a lateral offset, so if import aims the camera at the empty
  // space between the strays, no amount of zooming or panning recovers it.
  const d = distToContent(s);
  const contentSpan = Math.max(...CONTENT_MAX.map((v, i) => v - CONTENT_MIN[i]));
  expect(d).toBeLessThan(contentSpan * 5);
  expect(d).toBeGreaterThan(0);

  // And it is aimed at the content, not at the raw box centre — with these
  // outliers the two are hundreds of metres apart.
  const targetWorld = s.target.map((v: number, i: number) => v + s.displayOffset[i]);
  const offAxis = Math.hypot(...CONTENT_CENTRE.map((v, i) => targetWorld[i] - v));
  expect(offAxis).toBeLessThan(contentSpan);
});

test('you can zoom right into the content and still pan — the view never freezes', async () => {
  await loadFramedScene();
  const { page } = session;

  const canvas = page.locator('canvas').first();
  const box = (await canvas.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  const start = await readState();
  const distStart = distToContent(start);

  // Zoom hard, aimed at the middle of the viewport where the plot is drawn.
  await page.mouse.move(cx, cy);
  for (let i = 0; i < 30; i++) await page.mouse.wheel(0, -120);
  await page.waitForTimeout(300);

  const zoomed = await readState();
  const distZoomed = distToContent(zoomed);

  // The camera genuinely closed on the CONTENT — the old behavior stalled with
  // the content still far off because the target was out at the box centre.
  expect(distZoomed).toBeLessThan(distStart * 0.25);
  // And it did not fly through and out the other side.
  expect(distZoomed).toBeGreaterThan(0);

  // Pan at full zoom must move the view by a visible amount, not a rounding
  // error. This is symptom 1 from the bug report.
  const viewScale = Math.hypot(
    zoomed.position[0] - zoomed.target[0],
    zoomed.position[1] - zoomed.target[1],
    zoomed.position[2] - zoomed.target[2],
  );
  const posBefore = [...zoomed.position];
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(cx + 160, cy + 110, { steps: 12 });
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(200);

  const panned = await readState();
  const moved = Math.hypot(
    panned.position[0] - posBefore[0],
    panned.position[1] - posBefore[1],
    panned.position[2] - posBefore[2],
  );
  expect(moved).toBeGreaterThan(viewScale * 0.05);
});

test('pan sensitivity scales with zoom — a drag moves the same fraction of the screen at any depth', async () => {
  await loadFramedScene();
  const { page } = session;

  const canvas = page.locator('canvas').first();
  const box = (await canvas.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // How far a fixed 100 px right-drag moves the camera, and how far away the
  // subject is at that moment. OrbitControls derives its pan step from
  // |camera − target|, so the two must stay proportional: that is what makes a
  // drag move the same FRACTION of the viewport whether you are surveying the
  // whole plot or inspecting one stem.
  const sample = async () => {
    const before = await readState();
    const subjectDist = Math.hypot(
      before.position[0] - before.target[0],
      before.position[1] - before.target[1],
      before.position[2] - before.target[2],
    );
    const p0 = [...before.position];
    await page.mouse.move(cx, cy);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(cx + 100, cy, { steps: 8 });
    await page.mouse.up({ button: 'right' });
    await page.waitForTimeout(150);
    const after = await readState();
    const moved = Math.hypot(
      after.position[0] - p0[0],
      after.position[1] - p0[1],
      after.position[2] - p0[2],
    );
    return { subjectDist, moved, ratio: moved / subjectDist };
  };

  const wide = await sample();

  // Zoom well in, then sample again.
  await page.mouse.move(cx, cy);
  for (let i = 0; i < 20; i++) await page.mouse.wheel(0, -120);
  await page.waitForTimeout(250);
  const close = await sample();

  // We really did get closer to the subject — otherwise this proves nothing.
  expect(close.subjectDist).toBeLessThan(wide.subjectDist * 0.5);

  // The pan step shrank with it. Before this was fixed, zoom translated camera
  // and target rigidly, so |camera − target| was INVARIANT under zoom and the
  // pan step stayed at its wide-view value — a 100 px drag threw the view
  // metres while you were centimetres from a leaf.
  expect(close.moved).toBeLessThan(wide.moved * 0.5);

  // And it shrank proportionally: the same drag covers the same fraction of the
  // screen at both depths, which is the property that makes panning feel 1:1
  // with the cursor at every scale.
  expect(close.ratio).toBeGreaterThan(wide.ratio * 0.5);
  expect(close.ratio).toBeLessThan(wide.ratio * 2);
});

test('an origin placed near the scanners is reachable: "Zoom to origin" gets you there', async () => {
  await loadFramedScene();
  const { page } = session;

  // Put the origin on the real content — the "somewhere near where the scanners
  // were" case, far from the outlier-inflated box centre.
  await page.getByTestId('tool-set-scene-origin').click();
  const panel = page.getByTestId('scene-origin-panel');
  await expect(panel).toBeVisible({ timeout: 10_000 });

  const placed = [4.5, 4.5, 1.0];
  for (const [i, axis] of ['x', 'y', 'z'].entries()) {
    const input = panel.getByTestId(`scene-origin-input-${axis}`);
    await input.fill(String(placed[i]));
    await input.press('Enter');
  }
  await expect(panel).toHaveAttribute('data-has-origin', 'true');

  await panel.getByTestId('scene-origin-frame').click();
  await page.waitForTimeout(300);

  const s = await readState();
  const targetWorld = [
    s.target[0] + s.displayOffset[0],
    s.target[1] + s.displayOffset[1],
    s.target[2] + s.displayOffset[2],
  ];

  // The camera is looking at the placed origin...
  for (let i = 0; i < 3; i++) expect(targetWorld[i]).toBeCloseTo(placed[i], 2);

  // ...and is genuinely near it, i.e. inside the content volume rather than
  // parked out by the outliers. The old behavior left you stranded here.
  const camWorld = s.position.map((v: number, i: number) => v + s.displayOffset[i]);
  const camToOrigin = Math.hypot(...placed.map((v, i) => camWorld[i] - v));
  const contentSpan = Math.max(...CONTENT_MAX.map((v, i) => v - CONTENT_MIN[i]));
  expect(camToOrigin).toBeLessThan(contentSpan * 3);
});

test('zooming at empty sky converges on the scene instead of flying off', async () => {
  await loadFramedScene();
  const { page } = session;

  const canvas = page.locator('canvas').first();
  const box = (await canvas.boundingBox())!;

  const start = await readState();
  const distStart = distToContent(start);

  // Aim at a corner, well away from the drawn plot, so the depth pick misses and
  // the fallback anchor is what drives the motion. That fallback must still
  // converge on the content — an early version flew straight through the scene
  // and accelerated away, because its anchor sat a fixed distance ahead forever.
  await page.mouse.move(box.x + box.width * 0.06, box.y + box.height * 0.08);
  for (let i = 0; i < 30; i++) await page.mouse.wheel(0, -120);
  await page.waitForTimeout(300);

  const after = await readState();
  const distAfter = distToContent(after);

  // Closer than it started, and never overshooting past the content.
  expect(distAfter).toBeLessThan(distStart);
  expect(distAfter).toBeGreaterThan(0);
});

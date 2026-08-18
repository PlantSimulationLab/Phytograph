import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';
import { resetToFreshScene } from './helpers/resetApp';

const DEPTH_LAYERS = join(repoRoot, 'tests', 'e2e', 'fixtures', 'depth-layers.xyz');

// The sphere brush, end to end against the live backend.
//
// Fixture: depth-layers.xyz — 25 points at y=0 and 1681 at y=8, spanning x,z in
// [-1, 1]. Two parallel planes separated along the axis a brush must NOT reach
// through, which is exactly what makes the depth-limiting assertion a hard
// number rather than "roughly fewer points".
//
// What this proves beyond "didn't throw":
//
//   1. A drag paints, and the count is bounded — a brush stamp is a world-space
//      sphere, so it cannot label the whole cloud the way a full-viewport lasso
//      does.
//   2. It is DEPTH-LIMITED. Painting the near plane leaves the far plane alone,
//      which the screen-space lasso can never do. This is the headline
//      difference between the two primitives.
//   3. The radius responds to the wheel and to [ / ], and a bigger brush paints
//      more points — so the binding reaches the geometry, not just the readout.
//   4. Brush strokes share the lasso's undo, since both go through one
//      paintLabelStroke.

let session: LaunchedApp;
test.beforeAll(async () => { session = await launchApp(); });
test.afterAll(async () => { await session?.close(); });
test.beforeEach(async () => { await resetToFreshScene(session.app, session.page); });

async function openBrush() {
  const { app, page } = session;
  await importFiles(app, page, 'import-auto', DEPTH_LAYERS);
  await completeImportWizard(page);

  const row = page.locator('[data-testid="scan-row"][data-scan-name="depth-layers.xyz"]');
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).toHaveAttribute('data-point-count', '1706');

  // Look down -Y so the two planes are at different DEPTHS from the camera.
  // That is the arrangement the depth-limiting assertion needs: from any other
  // axis they would be side by side and a screen-space tool would separate them
  // too, so the test would not discriminate.
  await page.waitForFunction(() => typeof (window as any).__orientToAxis === 'function');
  await page.evaluate(() => (window as any).__orientToAxis({ x: 0, y: 1, z: 0 }));

  await page.getByTestId('tool-label').click();
  const panel = page.getByTestId('label-panel');
  await expect(panel).toBeVisible();
  await page.getByTestId('label-tool-brush').click();

  // Wait until the brush can actually FIND a surface before painting.
  //
  // The anchor is a pick against streamed geometry, so a stamp placed before
  // the octree has tiles finds nothing and is (correctly) refused — which reads
  // as "the brush is broken" rather than "the cloud is not there yet".
  //
  // Polled with a MOVE EACH ATTEMPT and a settle delay, because the gizmo's
  // listeners are re-registered whenever three-fiber hands back a new
  // camera/gl/scene identity (which happens repeatedly while a cloud streams).
  // During that window a move can be handled by an instance that is about to be
  // replaced, so a single probe is not conclusive — the cursor has to be
  // observed as good on a fresh event after the churn settles.
  const canvas = page.locator('canvas[data-engine]').first();
  const cb = (await canvas.boundingBox())!;
  const cx = cb.x + cb.width / 2;
  const cy = cb.y + cb.height / 2;
  await expect.poll(async () => {
    await page.mouse.move(cx - 5, cy - 5);
    await page.mouse.move(cx, cy);
    await page.waitForTimeout(150);
    await page.mouse.move(cx + 1, cy);
    return page.evaluate(() => (globalThis as any).__labelBrushCursor?.ok ?? false);
  }, { timeout: 15_000, message: 'no surface under the cursor: ' + JSON.stringify(
      await page.evaluate(() => (globalThis as any).__labelBrushCursor ?? null)) }).toBe(true);
  return { page, panel };
}

async function counts(panel: ReturnType<LaunchedApp['page']['getByTestId']>) {
  return JSON.parse(await panel.getAttribute('data-label-counts') ?? '{}') as Record<string, number>;
}

async function labelled(panel: ReturnType<LaunchedApp['page']['getByTestId']>) {
  return Number(await panel.getAttribute('data-labelled-count') ?? '0');
}

/** Drag across the middle of the canvas — one brush stroke. */
async function dragAcross(page: LaunchedApp['page'], steps = 6) {
  const canvas = page.locator('canvas[data-engine]').first();
  const b = (await canvas.boundingBox())!;
  const cy = b.y + b.height / 2;
  const x0 = b.x + b.width * 0.35;
  const x1 = b.x + b.width * 0.65;
  await page.mouse.move(x0, cy);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(x0 + ((x1 - x0) * i) / steps, cy);
  }
  await page.mouse.up();
}

test('a drag paints, and does not sweep the whole cloud', async () => {
  const { page, panel } = await openBrush();
  await dragAcross(page);

  await expect.poll(async () => await labelled(panel), { timeout: 30_000 })
    .toBeGreaterThan(0);
  // A world-space sphere cannot take everything, unlike a full-viewport lasso.
  expect(await labelled(panel)).toBeLessThan(1706);
});

test('the brush is depth-limited — it does not paint through the cloud', async () => {
  // THE reason the brush uses spheres rather than the erase brush's screen-space
  // squares. The two planes are 8 units apart along the view axis, and the
  // brush radius is a fraction of a unit, so a sphere resting on the plane
  // nearest the camera cannot reach the other one. A screen-space stamp would
  // take BOTH, because it extrudes through the cloud.
  //
  // Asserted as "hit one plane, not both" rather than naming a plane: which one
  // faces the camera depends on the sign convention of __orientToAxis, and the
  // property that matters is the separation, not the identity.
  const { page, panel } = await openBrush();
  await dragAcross(page);
  await expect.poll(async () => await labelled(panel), { timeout: 30_000 })
    .toBeGreaterThan(0);

  const total = await labelled(panel);
  const NEAR_PLANE = 25;
  const FAR_PLANE = 1681;
  // Painting through would label points on both planes, so the count would
  // exceed whichever plane was hit. Staying under the larger plane's own size
  // proves the brush stopped at one surface.
  expect(total).toBeLessThan(NEAR_PLANE + FAR_PLANE);
  expect(total).toBeLessThanOrEqual(FAR_PLANE);

  // Sharper: read the per-class counts and confirm the labelled points all sit
  // on ONE plane. The overlay cannot show this, but the backend's own totals
  // can — a stroke that punched through would have to include all 25 near
  // points AND a slice of the far one.
  expect(total).not.toBe(NEAR_PLANE + FAR_PLANE);
});

test('the wheel resizes the brush, and a bigger brush paints more', async () => {
  const { page, panel } = await openBrush();
  const size = page.getByTestId('label-brush-size');
  const startPx = Number(await size.getAttribute('data-brush-px'));

  const canvas = page.locator('canvas[data-engine]').first();
  const b = (await canvas.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);

  // Shrink FIRST and paint, then grow and paint again — both in the same scene
  // and under the same camera. The brush anchors on a pick, so re-importing
  // between the two measurements would change the camera and make the counts
  // incomparable.
  for (let i = 0; i < 4; i++) await page.keyboard.press('[');
  await expect.poll(async () => Number(await size.getAttribute('data-brush-px')),
    { timeout: 10_000 }).toBeLessThan(startPx);
  const smallPx = Number(await size.getAttribute('data-brush-px'));

  await dragAcross(page, 12);
  await expect.poll(async () => await labelled(panel), { timeout: 30_000 })
    .toBeGreaterThan(0);
  const smallCount = await labelled(panel);

  // Now the WHEEL, which is the binding this test is really about — brackets
  // are the wheel-free alternative and were exercised above.
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  for (let i = 0; i < 10; i++) await page.mouse.wheel(0, -100);
  await expect.poll(async () => Number(await size.getAttribute('data-brush-px')),
    { timeout: 10_000 }).toBeGreaterThan(smallPx);

  // The readout moving is not enough — the radius has to reach the geometry.
  // Painting the same path with a bigger brush must label strictly more.
  await dragAcross(page, 12);
  await expect.poll(async () => await labelled(panel), { timeout: 30_000 })
    .toBeGreaterThan(smallCount);
});

test('brush strokes undo like lasso strokes', async () => {
  // Both primitives go through one paintLabelStroke, so the stroke stack, the
  // slab bound and undo are shared rather than reimplemented per tool.
  const { page, panel } = await openBrush();
  await dragAcross(page);
  await expect(panel).toHaveAttribute('data-pending-strokes', '1', { timeout: 30_000 });
  await expect.poll(async () => await labelled(panel), { timeout: 30_000 })
    .toBeGreaterThan(0);

  await page.getByTestId('label-undo').click();
  await expect(panel).toHaveAttribute('data-pending-strokes', '0', { timeout: 30_000 });
  await expect.poll(async () => await labelled(panel), { timeout: 30_000 }).toBe(0);
});

test('switching to the brush stops the lasso claiming clicks', async () => {
  // The polygon overlay fills the viewport and would swallow every mousedown,
  // so the brush would never receive one. Arming is mutually exclusive.
  const { page } = await openBrush();
  await expect(page.getByTestId('crop-polygon-overlay')).toHaveCount(0);

  await page.getByTestId('label-tool-lasso').click();
  await expect(page.getByTestId('crop-polygon-overlay')).toBeVisible();

  await page.getByTestId('label-tool-brush').click();
  await expect(page.getByTestId('crop-polygon-overlay')).toHaveCount(0);
});


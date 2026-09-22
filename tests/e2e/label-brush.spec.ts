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
const pageErrors: string[] = [];
test.beforeAll(async () => {
  session = await launchApp();
  session.page.on('pageerror', (e) => pageErrors.push(String(e?.message ?? e)));
  session.page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push('console: ' + m.text().slice(0, 300));
  });
});
test.afterAll(async () => { await session?.close(); });
test.beforeEach(async () => { await resetToFreshScene(session.app, session.page); });

async function openBrush() {
  const { app, page } = session;
  await importFiles(app, page, 'import-auto', DEPTH_LAYERS);
  await completeImportWizard(page);

  const row = page.locator('[data-testid="scan-row"][data-scan-name="depth-layers"]');
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).toHaveAttribute('data-point-count', '1706');

  // Look down -Y so the two planes are at different DEPTHS from the camera.
  // That is the arrangement the depth-limiting assertion needs: from any other
  // axis they would be side by side and a screen-space tool would separate them
  // too, so the test would not discriminate.
  await page.waitForFunction(() => typeof (window as any).__orientToAxis === 'function');
  // Issued until it STICKS. __orientToAxis starts a camera move, but the
  // viewer's own auto-frame can land afterwards and overwrite it — on the
  // second test in a file that left the camera at [9.6,-5.6,8.0] instead of
  // top-down, so every pick anchored outside a fixture spanning x,z in [-1,1]
  // and the stroke correctly selected nothing.
  await expect.poll(async () => {
    await page.evaluate(() => (window as any).__orientToAxis({ x: 0, y: 1, z: 0 }));
    await page.waitForTimeout(250);
    return page.evaluate(() => {
      const p = (window as any).__getCameraState?.()?.position as number[] | undefined;
      if (!p) return false;
      // Top-down: the vertical axis dominates.
      return Math.abs(p[1]) > Math.abs(p[0]) * 10 && Math.abs(p[1]) > Math.abs(p[2]) * 10;
    });
  }, { timeout: 20_000, message: 'camera never oriented top-down' }).toBe(true);
  // Wait for the framing to SETTLE. __orientToAxis starts a camera move, and a
  // pick taken while it is still animating anchors wherever the camera happened
  // to be — on the second test in a file that landed 2.16,1.84,1.80, well
  // outside a fixture spanning x,z in [-1,1], so the stroke correctly selected
  // nothing and read as a dead brush.
  await expect.poll(async () => {
    const read = () => page.evaluate(() => {
      const c = (window as any).__getCameraState?.();
      return c?.position ? (c.position as number[]).map(n => n.toFixed(3)).join(',') : null;
    });
    const a = await read();
    await page.waitForTimeout(200);
    const b = await read();
    return a !== null && a === b;
  }, { timeout: 20_000, message: 'camera never settled' }).toBe(true);

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
  // The canvas is remounted while the scene settles, so a boundingBox() taken
  // the instant the panel appears can race the swap and time out on a detached
  // element. Wait for it to be attached and laid out first.
  try {
    await expect(canvas).toBeVisible({ timeout: 12_000 });
  } catch (err) {
    const state = await page.evaluate(() => ({
      canvases: document.querySelectorAll('canvas').length,
      withEngine: document.querySelectorAll('canvas[data-engine]').length,
      splash: !!document.querySelector('[data-testid="backend-splash"]'),
      hint: !!document.querySelector('[data-testid="empty-viewer-hint"]'),
      rows: document.querySelectorAll('[data-testid="scan-row"]').length,
      panel: !!document.querySelector('[data-testid="label-panel"]'),
      body: document.body.innerText.slice(0, 200),
    }));
    throw new Error('canvas absent at timeout: ' + JSON.stringify(state)
      + ' ERRORS: ' + JSON.stringify(pageErrors.slice(-5)));
  }
  const cb = (await canvas.boundingBox())!;
  const cx = cb.x + cb.width / 2;
  const cy = cb.y + cb.height / 2;
  let jitter = 0;
  await expect.poll(async () => {
    // A DIFFERENT pixel each attempt. React StrictMode mounts this gizmo twice
    // (mount1 → cleanup1 → mount2), so the surviving listener set can register
    // AFTER the probe moves have already fired. Re-using the same coordinates
    // emits no mousemove at all — the browser suppresses a move to the pixel the
    // pointer already occupies — so the new listeners would never see one and
    // the cursor would stay unresolved forever.
    jitter = (jitter + 1) % 7;
    await page.mouse.move(cx - 6 + jitter, cy - 3 + jitter);
    await page.waitForTimeout(120);
    await page.mouse.move(cx + jitter, cy);
    return page.evaluate(() => (globalThis as any).__labelBrushCursor?.ok ?? false);
  }, { timeout: 20_000, message: 'brush never found a surface to anchor on' }).toBe(true);
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

/** The brush's world-space anchor right now, once it has resolved one. */
async function cursorAt(page: LaunchedApp['page'], x: number, y: number) {
  await page.mouse.move(x, y);
  await expect.poll(
    () => page.evaluate(() => (globalThis as any).__labelBrushCursor?.ok ?? false),
    { timeout: 10_000, message: `brush found no surface at ${x},${y}` },
  ).toBe(true);
  return page.evaluate(() => (globalThis as any).__labelBrushCursor as
    { ok: boolean; r: number; c: [number, number, number] });
}

test('the cursor follows the pointer, and the wheel resizes it in place', async () => {
  // The two halves of "the brush tracks the mouse", and both were broken at
  // once by causes that look nothing alike.
  //
  // FOLLOWING: `rayForNdc` returned the camera's forward axis as the direction
  // under perspective as well as ortho, so every pick ray was the same ray —
  // the one through the middle of the screen. The anchor was therefore whatever
  // sat at the view centre, identical to 1e-7 across the whole canvas, and the
  // sphere hung motionless in the scene while the pointer moved around it.
  // Nothing already here could see it: every other assertion in this file is
  // satisfied by a stroke that paints SOMETHING, and a centre-anchored stroke
  // on a centred fixture does.
  //
  // RESIZING: the world radius was only ever recomputed inside the mousemove
  // handler, so a wheel notch moved the number in the panel and left the sphere
  // on screen at its old size until the pointer happened to move. The wheel is
  // the primary size control and it does not emit a mousemove, so in practice
  // that was "scrolling does nothing".
  const { page } = await openBrush();
  const canvas = page.locator('canvas[data-engine]').first();
  const b = (await canvas.boundingBox())!;
  const cy = b.y + b.height / 2;

  // Both samples stay in the LEFT half: the label panel floats over the right
  // of the viewport, and a pointer parked on it is off the canvas (the brush
  // correctly reports no anchor there).
  const left = await cursorAt(page, b.x + b.width * 0.40, cy);
  const right = await cursorAt(page, b.x + b.width * 0.52, cy);
  const moved = Math.hypot(
    left.c[0] - right.c[0], left.c[1] - right.c[1], left.c[2] - right.c[2],
  );
  // The fixture spans 2 world units across a viewport it fills, so 16% of the
  // canvas is a good fraction of a unit. The bug gives EXACTLY zero, so the
  // threshold only has to be clear of pick jitter between adjacent points.
  expect(moved).toBeGreaterThan(0.2);

  // Now hold the pointer still and scroll. No mouse.move between the readings —
  // that is the whole point.
  const sizeEl = page.getByTestId('label-brush-size');
  const beforePx = Number(await sizeEl.getAttribute('data-brush-px'));
  const before = (await page.evaluate(() => (globalThis as any).__labelBrushCursor)).r;
  for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -100);
  await expect.poll(async () => Number(await sizeEl.getAttribute('data-brush-px')),
    { timeout: 10_000 }).toBeGreaterThan(beforePx);
  // The SPHERE, not just the readout: the radius the viewer is drawing has to
  // track the pixel size it was told about.
  await expect.poll(
    () => page.evaluate(() => (globalThis as any).__labelBrushCursor?.r ?? 0),
    { timeout: 10_000, message: 'the drawn radius never followed the wheel' },
  ).toBeGreaterThan(before * 1.2);
});

test('a drag paints, and does not sweep the whole cloud', async () => {
  const { page, panel } = await openBrush();
  await dragAcross(page);

  await expect.poll(async () => await labelled(panel), { timeout: 30_000 })
    .toBeGreaterThan(0);
  // A world-space sphere cannot take everything, unlike a full-viewport lasso.
  expect(await labelled(panel)).toBeLessThan(1706);
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


import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';
import { resetToFreshScene } from './helpers/resetApp';
import { clickCanvasAt, dismissToasts, expectPointsHitCanvas } from './helpers/canvasClick';
import { wheelNotches } from './helpers/wheel';

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
//
// Shared session: one app + backend for the whole file; File → New resets the
// scene between tests (see helpers/resetApp.ts). Each test frames the camera
// explicitly via __orientToAxis, so no test depends on launch-default framing.

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

test('erase brush: painting square stamps and applying removes points (octree)', async () => {
  const { app, page } = session;

  await importFiles(app, page, 'import-auto', TINY);
  await completeImportWizard(page);

  const row = page.locator('[data-testid="scan-row"][data-scan-name="tiny"]');
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
  // Every point of the swath must land on the canvas: a toast or panel over any
  // of them silently eats that stamp. See helpers/canvasClick.ts.
  await dismissToasts(page);
  await expectPointsHitCanvas(page, [
    { x: cx - box.width * 0.08, y: cy },
    { x: cx, y: cy },
    { x: cx + box.width * 0.08, y: cy },
  ], 'erase brush swath');
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
});

// Clear Strokes discards the painted preview without touching the cloud — the
// stamp counter returns to 0 and the point count is unchanged.
test('erase brush: Clear Strokes discards the preview without erasing', async () => {
  const { app, page } = session;

  await importFiles(app, page, 'import-auto', TINY);
  await completeImportWizard(page);

  const row = page.locator('[data-testid="scan-row"][data-scan-name="tiny"]');
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

  // Click the center of the viewport (where the cylinder projects) to stamp.
  await clickCanvasAt(page, { x: box.x + box.width * 0.5, y: box.y + box.height * 0.5 }, 'erase stamp');

  await expect
    .poll(async () => Number(await panel.getAttribute('data-stamp-count')), { timeout: 5_000 })
    .toBeGreaterThan(0);

  await page.getByTestId('erase-restore').click(); // "Clear Strokes"
  await expect(panel).toHaveAttribute('data-stamp-count', '0');
  // Cloud untouched.
  await expect(row).toHaveAttribute('data-point-count', '60');
});

// The Erase tool opens with the view interactive (erase mode OFF). The 'E' key
// toggles erase MODE within the open tool (not the tool itself): ON freezes the
// view and clicks stamp; OFF leaves the panel open so the user can reframe.
test('erase brush: E toggles erase mode within the open tool', async () => {
  const { app, page } = session;

  await importFiles(app, page, 'import-auto', TINY);
  await completeImportWizard(page);

  const row = page.locator('[data-testid="scan-row"][data-scan-name="tiny"]');
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
  await clickCanvasAt(page, { x: box.x + box.width * 0.5, y: box.y + box.height * 0.5 }, 'erase stamp');
  await expect
    .poll(async () => Number(await panel.getAttribute('data-stamp-count')), { timeout: 5_000 })
    .toBeGreaterThan(0);

  // Press E again to turn erase mode OFF — the tool stays OPEN (panel still
  // visible) so the user can reframe without losing painted strokes.
  await page.keyboard.press('e');
  await expect(panel).toHaveAttribute('data-erase-active', 'false');
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('data-stamp-count', '1');
});

// Regression: toggling erase mode OFF then ON (without reframing) must KEEP the
// already-painted stamps and ACCUMULATE new ones — not reset them, which made
// previously-erased points reappear. Stamps live in the parent across the
// brush component's unmount/remount and resume because the camera matches.
test('erase brush: toggling mode off and on accumulates stamps (no reset)', async () => {
  const { app, page } = session;

  await importFiles(app, page, 'import-auto', TINY);
  await completeImportWizard(page);

  const row = page.locator('[data-testid="scan-row"][data-scan-name="tiny"]');
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
});

// Erase is a PICKER tool: it lists every cloud and erases the CHECKED ones —
// the Scans-pane selection only seeds that set when the tool opens (nothing
// selected → nothing checked). A painted square extrudes straight through the
// scene, so it cuts every checked cloud behind it and leaves unchecked ones
// alone. Viewed down +X, tiny (x≈0) and tiny-offset (x≈1) project onto the SAME
// screen footprint, so one stroke lies over both.
const TINY_OFFSET = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tiny-offset.xyz');

test('erase brush: one stroke cuts every CHECKED cloud behind it, and only those', async () => {
  const { app, page } = session;
  await importFiles(app, page, 'import-auto', TINY);
  await completeImportWizard(page);
  const tiny = page.locator('[data-testid="scan-row"][data-scan-name="tiny"]');
  await expect(tiny).toHaveAttribute('data-point-count', '60', { timeout: 20_000 });
  await importFiles(app, page, 'import-auto', TINY_OFFSET);
  await completeImportWizard(page);
  const offset = page.locator('[data-testid="scan-row"][data-scan-name="tiny-offset"]');
  await expect(offset).toHaveAttribute('data-point-count', '60', { timeout: 20_000 });

  await page.getByTestId('scans-panel').getByTitle('Deselect All').click();
  await page.waitForFunction(() => typeof (window as any).__orientToAxis === 'function');
  await page.evaluate(() => (window as any).__orientToAxis({ x: 1, y: 0, z: 0 }));

  // Available with nothing selected; opens with nothing checked.
  await expect(page.getByTestId('tool-erase')).toBeEnabled();
  await page.getByTestId('tool-erase').click();
  const panel = page.getByTestId('erase-panel');
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('data-target-count', '0');
  await expect(page.getByTestId('erase-none-checked')).toBeVisible();
  await expect(page.getByTestId('erase-mode-toggle')).toHaveCount(0);

  const row = (label: string) =>
    page.locator(`[data-testid="erase-target-row"][data-label="${label}"]`);

  async function strokeAndApply() {
    await page.getByTestId('erase-mode-toggle').click();
    await expect(panel).toHaveAttribute('data-erase-active', 'true');
    await page.waitForTimeout(300);
    const slider = panel.locator('input[type="range"]');
    const maxPx = await slider.getAttribute('max');
    await slider.evaluate((el, v) => {
      const input = el as HTMLInputElement;
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, v);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, maxPx ?? '150');
    const box = (await page.locator('canvas').first().boundingBox())!;
    const cx = box.x + box.width * 0.5;
    const cy = box.y + box.height * 0.5;
    const pts = [{ x: cx - box.width * 0.05, y: cy }, { x: cx, y: cy }, { x: cx + box.width * 0.05, y: cy }];
    await dismissToasts(page);
    await expectPointsHitCanvas(page, pts, 'erase stroke');
    await page.mouse.move(pts[0].x, pts[0].y);
    await page.mouse.down();
    await page.mouse.move(pts[1].x, pts[1].y);
    await page.mouse.move(pts[2].x, pts[2].y);
    await page.mouse.up();
    await expect.poll(async () => Number(await panel.getAttribute('data-stamp-count'))).toBeGreaterThan(0);
    await page.getByTestId('erase-apply').click();
    await expect(panel).toHaveAttribute('data-stamp-count', '0', { timeout: 30_000 });
  }

  // 1) Only tiny-offset checked: the stroke lies over BOTH, cuts only it.
  await row('tiny-offset').click();
  await expect(panel).toHaveAttribute('data-target-count', '1');
  await strokeAndApply();
  await expect.poll(async () => Number(await offset.getAttribute('data-point-count')), { timeout: 30_000 })
    .toBeLessThan(60);
  await expect(tiny).toHaveAttribute('data-point-count', '60');
  const offsetAfterFirst = Number(await offset.getAttribute('data-point-count'));

  // 2) Check tiny as well: one stroke now cuts both.
  await row('tiny').click();
  await expect(panel).toHaveAttribute('data-target-count', '2');
  await strokeAndApply();
  await expect.poll(async () => Number(await tiny.getAttribute('data-point-count')), { timeout: 30_000 })
    .toBeLessThan(60);
  expect(Number(await tiny.getAttribute('data-point-count'))).toBeGreaterThan(0);
  // The same strip again removes nothing new from tiny-offset (already cut), so
  // its count must not have grown back either.
  expect(Number(await offset.getAttribute('data-point-count'))).toBeLessThanOrEqual(offsetAfterFirst);
});

// ── Turning erase mode on must not throw the view ────────────────────────
//
// Erase flattens the view to orthographic (OrthoProjectionOverride) so a
// painted square cuts a straight prism. A parallel projection can agree with
// the perspective view it replaces at one depth only; content at any other
// depth slides toward or away from the screen center by the ratio of the two.
// The override sizes its frustum from the distance to the ORBIT TARGET, so the
// target has to sit at the depth of what is on screen — and after an ordinary
// zoom it does not. The zoom handler re-seats the target at the distance of its
// ANCHOR, measured along the cursor ray, so a scroll with the pointer away from
// the middle of the viewport leaves the target well beyond the content. The
// override therefore re-seats the target, along the view axis, at the depth of
// the visible content when it mounts (lib/visibleDepth.ts).
//
// tiny.xyz is a cylinder r=0.3 h=1.5 standing on the origin, so its depth along
// the view axis is known from the camera alone: (center − eye) · forward, give
// or take its 0.81 half-diagonal.
test('erase brush: turning erase on re-seats the orbit target at the depth of the visible cloud, without moving the camera', async () => {
  const { app, page } = session;

  await importFiles(app, page, 'import-auto', TINY);
  await completeImportWizard(page);

  const row = page.locator('[data-testid="scan-row"][data-scan-name="tiny"]');
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row).toHaveAttribute('data-selected', 'true');

  type Cam = { position: number[]; target: number[] | null; projectionKind: string };
  const readCamera = () => page.evaluate(() => {
    const s = (window as unknown as { __getCameraState: () => Cam }).__getCameraState();
    return { position: s.position, target: s.target, projectionKind: s.projectionKind };
  });
  const CENTER = [0, 0, 0.75];
  const HALF_DIAGONAL = Math.hypot(0.3, 0.75);
  const depthState = (cam: Cam) => {
    if (!cam.target) throw new Error('camera has no orbit target');
    const toTarget = cam.target.map((t, i) => t - cam.position[i]);
    const targetDistance = Math.hypot(...toTarget);
    const forward = toTarget.map((c) => c / targetDistance);
    const cloudDepth = CENTER.reduce((acc, c, i) => acc + (c - cam.position[i]) * forward[i], 0);
    return { targetDistance, cloudDepth, forward };
  };

  const canvas = page.locator('canvas').first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('viewer canvas has no bounding box');

  // Zoom out with the pointer off to one side of the viewport — the everyday
  // gesture that leaves the target off the content's depth (see above).
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.8);
  await wheelNotches(page, 12);

  // The precondition, asserted so this test cannot pass vacuously: the orbit
  // target is NOT at the cloud's depth going in. Polled, since the wheel is
  // applied on a later frame than the one that acknowledges it.
  await expect
    .poll(async () => {
      const st = depthState(await readCamera());
      return Math.abs(st.targetDistance - st.cloudDepth);
    }, { message: "setup must leave the orbit target off the cloud's depth" })
    .toBeGreaterThan(1.5 * HALF_DIAGONAL);
  await page.waitForTimeout(600); // let the zoom gesture end
  const before = await readCamera();
  const b = depthState(before);

  await page.getByTestId('tool-erase').click();
  const panel = page.getByTestId('erase-panel');
  await expect(panel).toBeVisible();
  await page.getByTestId('erase-mode-toggle').click();
  await expect(panel).toHaveAttribute('data-erase-active', 'true');
  await expect.poll(async () => (await readCamera()).projectionKind).toBe('orthographic');

  const after = await readCamera();
  const a = depthState(after);
  const diag = JSON.stringify({ before, after, b, a });

  // The eye did not move and did not turn: nothing changes on screen until the
  // projection flattens.
  for (let i = 0; i < 3; i++) {
    expect(Math.abs(after.position[i] - before.position[i]), diag).toBeLessThan(1e-6);
    expect(Math.abs(a.forward[i] - b.forward[i]), diag).toBeLessThan(1e-6);
  }
  // The frustum is now sized for the cloud, not for the stale target.
  expect(Math.abs(a.targetDistance - a.cloudDepth), diag).toBeLessThan(HALF_DIAGONAL);
});

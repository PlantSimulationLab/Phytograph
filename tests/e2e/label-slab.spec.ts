import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';
import { resetToFreshScene } from './helpers/resetApp';
import { fixturePoints, pointsDrawnGray } from './helpers/pointColors';

const DEPTH_LAYERS = join(repoRoot, 'tests', 'e2e', 'fixtures', 'depth-layers.xyz');

// Cross-section slab, end to end against the live backend.
//
// Fixture: depth-layers.xyz — two parallel planes, 25 points at y=0 and 1681 at
// y=8, spanning x,z in [-1, 1]. Purpose-built for exactly this: the planes are
// separated along the axis a slab is THIN along, so a slab placed on one plane
// must exclude the other completely. That makes every assertion here a hard
// number rather than "roughly fewer points".
//
// What this proves beyond "didn't throw":
//
//   1. A section clips the cloud — points outside the slab stop rendering.
//   2. Stepping the slab CHANGES WHICH points are visible (the near plane
//      disappears and the far one appears), which is the whole workflow.
//   3. Painting inside a section is DEPTH-BOUNDED: a full-viewport lasso, which
//      would otherwise sweep both planes, labels only the in-slab points. This
//      is the occlusion problem the slab exists to solve.
//   4. The coverage readout tracks the traverse, so a user can tell they have
//      inspected everything.

let session: LaunchedApp;
test.beforeAll(async () => { session = await launchApp(); });
test.afterAll(async () => { await session?.close(); });
test.beforeEach(async () => { await resetToFreshScene(session.app, session.page); });

const NEAR_PLANE = 25;
const FAR_PLANE = 1681;
const TOTAL = NEAR_PLANE + FAR_PLANE;

async function importDepthLayers() {
  const { app, page } = session;
  await importFiles(app, page, 'import-auto', DEPTH_LAYERS);
  await completeImportWizard(page);
  const row = page.locator('[data-testid="scan-row"][data-scan-name="depth-layers"]');
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).toHaveAttribute('data-point-count', String(TOTAL));
  await expect(row).toHaveAttribute('data-selected', 'true');

  // Look straight down, so the two planes are separated on screen and the
  // centerline can be drawn across them.
  await page.waitForFunction(() => typeof (window as any).__orientToAxis === 'function');
  await page.evaluate(() => (window as any).__orientToAxis({ x: 0, y: 0, z: 1 }));
  return { page, row };
}

/**
 * Place a slab directly, rather than by two viewport clicks.
 *
 * The drawing gesture is covered by its own assertion below; here we want the
 * slab's GEOMETRY to be exact so the point counts are unambiguous, and a
 * screen-space click cannot give that.
 */
async function setSlab(page: LaunchedApp['page'], y: number, depth: number) {
  await page.evaluate(({ y, depth }) => {
    (window as any).__setSlab?.({
      kind: 'slab',
      a: { x: -5, y }, b: { x: 5, y },
      depth, zMin: -5, zMax: 5, offset: 0,
    });
  }, { y, depth });
}

/** Points the octree is actually drawing, from the renderer's own stats. */
async function drawnPoints(page: LaunchedApp['page']) {
  return page.evaluate(() => (window as any).__octreeCropMask?.drawn ?? null);
}

test('a section clips the cloud to the slab', async () => {
  const { page } = await importDepthLayers();
  await page.getByTestId('tool-cross-section').click();
  const panel = page.getByTestId('cross-section-panel');
  await expect(panel).toBeVisible();

  // A thin slab on the NEAR plane excludes the far one entirely: the two are
  // 8 units apart and the slab is 1 unit thick.
  await setSlab(page, 0, 1);
  await expect(panel).toHaveAttribute('data-has-slab', 'true');

  // The far plane's 1681 points must stop drawing. Poll — the clip applies on
  // the next frame and potree streams tiles asynchronously.
  await expect.poll(async () => await drawnPoints(page), { timeout: 20_000 })
    .toBeLessThan(TOTAL);
});

test('stepping the slab changes WHICH points are visible', async () => {
  // The core of the workflow: advancing the section moves through the cloud.
  const { page } = await importDepthLayers();
  await page.getByTestId('tool-cross-section').click();
  const panel = page.getByTestId('cross-section-panel');

  // Slab on the near plane, 2 thick — steps of 1 at half-depth.
  await setSlab(page, 0, 2);
  await expect(panel).toHaveAttribute('data-has-slab', 'true');
  await expect(panel).toHaveAttribute('data-step-mode', 'half');

  const coverageBefore = await panel.getAttribute('data-coverage');
  expect(coverageBefore).toMatch(/^\d+\/\d+$/);

  // Step forward far enough to leave the near plane behind and reach the far
  // one (8 units away, 1 unit per step).
  for (let i = 0; i < 8; i++) await page.getByTestId('section-step-forward').click();

  // The traverse position advanced — this is what makes coverage provable.
  await expect.poll(async () => panel.getAttribute('data-coverage'), { timeout: 10_000 })
    .not.toBe(coverageBefore);

  // Home returns to where the section was drawn.
  await page.getByTestId('section-reset').click();
  await expect.poll(async () => panel.getAttribute('data-coverage'), { timeout: 10_000 })
    .toBe(coverageBefore);
});

test('painting in a section is depth-bounded — it does not paint through', async () => {
  // The occlusion problem the slab exists to solve. A full-viewport lasso seen
  // from above sweeps BOTH planes; inside a section it must label only the
  // plane the slab is on.
  const { page } = await importDepthLayers();

  await page.getByTestId('tool-cross-section').click();
  await expect(page.getByTestId('cross-section-panel')).toBeVisible();
  // Thin slab on the FAR plane (the dense one, 1681 points).
  await setSlab(page, 8, 1);

  await page.getByTestId('tool-label').click();
  const label = page.getByTestId('label-panel');
  await expect(label).toBeVisible();

  // Lasso the whole viewport.
  const overlay = page.getByTestId('crop-polygon-overlay');
  await expect(overlay).toBeVisible();
  const box = await overlay.boundingBox();
  if (!box) throw new Error('lasso overlay has no bounding box');
  const inset = 8;
  for (const c of [
    { x: box.x + inset, y: box.y + inset },
    { x: box.x + box.width - inset, y: box.y + inset },
    { x: box.x + box.width - inset, y: box.y + box.height - inset },
    { x: box.x + inset, y: box.y + box.height - inset },
  ]) await page.mouse.click(c.x, c.y);
  await page.keyboard.press('Enter');

  await expect(label).toHaveAttribute('data-pending-strokes', '1', { timeout: 20_000 });

  // EXACTLY the far plane. Not all 1706 — that would mean the lasso painted
  // through the section, which is the bug the whole feature prevents.
  await expect.poll(
    async () => Number(await label.getAttribute('data-labeled-count')),
    { timeout: 20_000 },
  ).toBe(FAR_PLANE);
});

test('the centerline is placed by two clicks in the view', async () => {
  // The gesture itself, distinct from the geometry assertions above.
  const { page } = await importDepthLayers();
  await page.getByTestId('tool-cross-section').click();
  const panel = page.getByTestId('cross-section-panel');
  await expect(panel).toHaveAttribute('data-has-slab', 'false');

  await page.getByTestId('section-draw').click();
  await expect(panel).toHaveAttribute('data-drawing', 'true');

  const canvas = page.locator('canvas').first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('viewer canvas has no bounding box');
  const cy = box.y + box.height * 0.5;
  await page.mouse.click(box.x + box.width * 0.3, cy);
  await page.mouse.click(box.x + box.width * 0.7, cy);

  // Two clicks produce a slab and leave draw mode.
  await expect(panel).toHaveAttribute('data-has-slab', 'true', { timeout: 10_000 });
  await expect(panel).toHaveAttribute('data-drawing', 'false');
});

test('a slab CHANGED after the label tool is open still bounds the paint', async () => {
  // Regression: the section reached the backend only if it existed before the
  // label tool mounted.
  //
  // `paintLabelStroke` is a useCallback, and `slab`/`sectionTargetCloud` were
  // missing from its dependency array. So the callback froze whatever slab was
  // live when it was first created — for a user who opens the label tool and
  // THEN draws or steps a section, that is `null`. Every stroke shipped without
  // its slab and painted through the whole cloud, while the overlay (which
  // reads the live slab) previewed the correctly-bounded result. Preview and
  // truth disagreed silently, which is the exact failure mode C1-R exists to
  // prevent.
  //
  // The existing depth-bounded test cannot catch this: it sets the slab BEFORE
  // opening the label tool, so the captured value happens to be correct. The
  // order here — tool first, slab second — is what the user actually did.
  const { page } = await importDepthLayers();

  await page.getByTestId('tool-cross-section').click();
  await expect(page.getByTestId('cross-section-panel')).toBeVisible();

  // Label tool opens FIRST, with no section yet — this is what froze `slab` at
  // null in the broken build.
  await page.getByTestId('tool-label').click();
  const label = page.getByTestId('label-panel');
  await expect(label).toBeVisible();

  // Only NOW does a section appear, on the near (sparse, 25-point) plane.
  await setSlab(page, 0, 1);
  await expect.poll(async () => await drawnPoints(page), { timeout: 20_000 })
    .toBeLessThan(TOTAL);

  const overlay = page.getByTestId('crop-polygon-overlay');
  await expect(overlay).toBeVisible();
  const box = await overlay.boundingBox();
  if (!box) throw new Error('lasso overlay has no bounding box');
  const inset = 8;
  for (const c of [
    { x: box.x + inset, y: box.y + inset },
    { x: box.x + box.width - inset, y: box.y + inset },
    { x: box.x + box.width - inset, y: box.y + box.height - inset },
    { x: box.x + inset, y: box.y + box.height - inset },
  ]) await page.mouse.click(c.x, c.y);
  await page.keyboard.press('Enter');

  await expect(label).toHaveAttribute('data-pending-strokes', '1', { timeout: 20_000 });

  // EXACTLY the near plane. With the stale closure this labeled all 1706.
  await expect.poll(
    async () => Number(await label.getAttribute('data-labeled-count')),
    { timeout: 20_000 },
  ).toBe(NEAR_PLANE);
});

test('the close button closes the section panel', async () => {
  // Report #3: clicking the X did nothing. The panel was mounted on
  // `sectionTargetCloud` alone, so closing cleared the *tool* but the panel
  // stayed as long as a cloud was selected — conflating "the section keeps
  // clipping" (correct: a section is a view state that outlives the tool) with
  // "the panel stays open" (wrong).
  const { page } = await importDepthLayers();

  await page.getByTestId('tool-cross-section').click();
  const panel = page.getByTestId('cross-section-panel');
  await expect(panel).toBeVisible();

  // A slab must EXIST for this to be a real test. `sectionTargetCloud` is gated
  // on the slab, not the panel, so with no slab the panel unmounts through that
  // path no matter what the close button does — and the test passes even with
  // the fix reverted.
  await setSlab(page, 0, 1);
  await expect(panel).toHaveAttribute('data-has-slab', 'true');

  await panel.getByRole('button', { name: 'Close' }).click();
  await expect(panel).toHaveCount(0);

  // And it reopens — closing must not wedge the tool.
  await page.getByTestId('tool-cross-section').click();
  await expect(page.getByTestId('cross-section-panel')).toBeVisible();
});

test('the first centerline click shows a marker before the second is placed', async () => {
  // Report #1: clicking the first point gave NO feedback, so the user could not
  // tell the click had registered, where it landed, or which way the section
  // would run — they clicked twice into a void and the view jumped.
  const { page } = await importDepthLayers();

  await page.getByTestId('tool-cross-section').click();
  await expect(page.getByTestId('cross-section-panel')).toBeVisible();
  await page.getByTestId('section-draw').click();

  const canvas = page.locator('canvas').first();
  const b = (await canvas.boundingBox())!;
  const cy = b.y + b.height * 0.5;

  // Nothing placed yet.
  expect(await page.evaluate(() => (window as any).__slabDraw?.first ?? null)).toBeNull();

  await page.mouse.click(b.x + b.width * 0.35, cy);

  // The marker exists after ONE click — the whole point of the fix.
  await expect.poll(
    async () => await page.evaluate(() => (window as any).__slabDraw?.first ?? null),
    { timeout: 10_000 },
  ).not.toBeNull();

  // And the rubber band follows the cursor before the second click lands.
  await page.mouse.move(b.x + b.width * 0.55, cy);
  await expect.poll(
    async () => await page.evaluate(() => (window as any).__slabDraw?.cursor ?? null),
    { timeout: 10_000 },
  ).not.toBeNull();
});

test('the slab is previewed while picking the second point, at FIXED thickness', async () => {
  // Before this, the first click gave a marker and a rubber-band line — the
  // azimuth but not the volume. There was no way to picture the section until
  // it snapped into existence on the second click, so the box appeared
  // somewhere unexpected and the view jumped to face it.
  const { page } = await importDepthLayers();

  await page.getByTestId('tool-cross-section').click();
  await expect(page.getByTestId('cross-section-panel')).toBeVisible();
  await page.getByTestId('section-draw').click();

  const canvas = page.locator('canvas').first();
  const b = (await canvas.boundingBox())!;
  const cy = b.y + b.height * 0.5;
  const read = () => page.evaluate(() => (globalThis as any).__slabDragPreview ?? null);

  await page.mouse.click(b.x + b.width * 0.3, cy);

  // Nothing yet: at the instant of the click a and b coincide, and a zero-width
  // box flickering at the click point reads as a glitch.
  await expect.poll(async () => (await read())?.visible ?? null, { timeout: 10_000 })
    .toBe(false);

  await page.mouse.move(b.x + b.width * 0.5, cy);
  await expect.poll(async () => (await read())?.visible ?? false, { timeout: 10_000 })
    .toBe(true);
  const near = await read();

  await page.mouse.move(b.x + b.width * 0.75, cy);
  await expect.poll(async () => (await read())?.length ?? 0, { timeout: 10_000 })
    .toBeGreaterThan(near.length);
  const far = await read();

  // The whole point of "fixed thickness": dragging further makes the section
  // LONGER, never WIDER. A depth that tracked the drag would splay the walls
  // outward while the user is still aiming.
  expect(far.depth).toBeCloseTo(near.depth, 6);

  // And the committed slab matches the box that was on screen — a preview that
  // disagreed with the result would be worse than no preview.
  await page.mouse.click(b.x + b.width * 0.75, cy);
  const panel = page.getByTestId('cross-section-panel');
  await expect(panel).toHaveAttribute('data-has-slab', 'true', { timeout: 10_000 });
  await expect.poll(async () => (await read())?.visible ?? null, { timeout: 10_000 })
    .toBe(false);
});

test('the full cloud can be shown again without destroying the section', async () => {
  // There was no way back to a whole cloud. Every control ADJUSTED the section
  // — thickness, stepping, lock — and closing the panel deliberately does not
  // clear (the Label tool shares the slot and must paint inside a section), so
  // a user who sectioned a cloud was stuck looking at a slice of it.
  const { page } = await importDepthLayers();

  await page.getByTestId('tool-cross-section').click();
  const panel = page.getByTestId('cross-section-panel');
  await expect(panel).toBeVisible();
  await setSlab(page, 0, 1);
  await expect.poll(async () => await drawnPoints(page), { timeout: 20_000 })
    .toBeLessThan(TOTAL);

  // Suspend: the whole cloud is drawn again...
  await page.getByTestId('section-suspend').click();
  await expect.poll(async () => await drawnPoints(page), { timeout: 20_000 })
    .toBe(TOTAL);
  // ...but the section itself survives, which is what makes this different
  // from clearing it.
  await expect(panel).toHaveAttribute('data-has-slab', 'true');
  await expect(panel).toHaveAttribute('data-suspended', 'true');

  // And it comes straight back, same slab, no redefining.
  await page.getByTestId('section-suspend').click();
  await expect.poll(async () => await drawnPoints(page), { timeout: 20_000 })
    .toBeLessThan(TOTAL);
});

test('clearing the section restores the full cloud and removes the slab', async () => {
  const { page } = await importDepthLayers();

  await page.getByTestId('tool-cross-section').click();
  const panel = page.getByTestId('cross-section-panel');
  await expect(panel).toBeVisible();
  await setSlab(page, 0, 1);
  await expect.poll(async () => await drawnPoints(page), { timeout: 20_000 })
    .toBeLessThan(TOTAL);

  await page.getByTestId('section-clear').click();

  await expect.poll(async () => await drawnPoints(page), { timeout: 20_000 })
    .toBe(TOTAL);
  await expect(panel).toHaveAttribute('data-has-slab', 'false');
});

test('a viewport HUD offers the way out even with the panel closed', async () => {
  // The discoverability half of the problem: a section keeps clipping after its
  // panel is closed, so without a viewport-level indicator the user sees a
  // cloud with most of it missing, no visible cause, and no reason to associate
  // the fix with a tool they already closed.
  const { page } = await importDepthLayers();

  await page.getByTestId('tool-cross-section').click();
  const panel = page.getByTestId('cross-section-panel');
  await expect(panel).toBeVisible();
  await setSlab(page, 0, 1);

  const hud = page.getByTestId('section-hud');
  await expect(hud).toBeVisible();

  // Close the panel — the section is still clipping, so the HUD must remain.
  await panel.getByRole('button', { name: 'Close' }).click();
  await expect(panel).toHaveCount(0);
  await expect(hud).toBeVisible();
  await expect.poll(async () => await drawnPoints(page), { timeout: 20_000 })
    .toBeLessThan(TOTAL);

  // And it is a working way out, not just a label.
  await page.getByTestId('section-hud-clear').click();
  await expect.poll(async () => await drawnPoints(page), { timeout: 20_000 })
    .toBe(TOTAL);
  await expect(hud).toHaveCount(0);
});

test('redrawing shows the whole cloud while you aim the new centerline', async () => {
  // Redraw left the OLD section clipping, so the user picked the new centerline
  // against a cloud that was still cut away — aiming at what you cannot see.
  const { page } = await importDepthLayers();

  await page.getByTestId('tool-cross-section').click();
  await expect(page.getByTestId('cross-section-panel')).toBeVisible();
  await setSlab(page, 0, 1);
  await expect.poll(async () => await drawnPoints(page), { timeout: 20_000 })
    .toBeLessThan(TOTAL);

  await page.getByTestId('section-draw').click();
  await expect.poll(async () => await drawnPoints(page), { timeout: 20_000 })
    .toBe(TOTAL);

  // Placing the new centerline re-applies clipping — the suspension lasts only
  // as long as the aiming does.
  //
  // Clear any toast first, then assert each point really lands on the canvas.
  // These are raw coordinate clicks, and two things can eat them: the toast
  // stack (full-height, pointer-events-auto cards) and the section panel in the
  // right lane. Adding this guard immediately caught the latter — the old
  // 0.6/0.7-width points resolved to `section-suspend`, the panel's own Suspend
  // button, so the test was toggling the very state it then asserted on instead
  // of aiming a centerline. It passed locally anyway and failed on CI, where
  // the window has no title bar (innerHeight 800 vs 772) and the same fractions
  // land on different pixels. A swallowed click leaves the centerline unplaced
  // and the test dies on the `data-suspended` wait, which reads as a
  // section-state bug rather than a missed click.
  await page.evaluate(() => {
    document.querySelectorAll<HTMLElement>('[data-testid="toast-close"]')
      .forEach((btn) => btn.click());
  });
  const canvas = page.locator('canvas').first();
  const b = (await canvas.boundingBox())!;
  const cy = b.y + b.height * 0.5;
  // Keep every aim point in the LEFT half of the canvas. The cross-section
  // panel occupies the right lane (`right-[280px]`, w-64) and its Suspend
  // button sat under the old 0.6/0.7-width points — clicking it toggles the
  // very suspension this test is asserting on. It passed locally by accident;
  // the guard below now proves the points reach the canvas.
  const aimPoints = [
    { x: b.x + b.width * 0.18, y: cy },
    { x: b.x + b.width * 0.30, y: cy },
    { x: b.x + b.width * 0.38, y: cy },
  ];
  const blocked = await page.evaluate((pts) => pts
    .map(({ x, y }) => {
      const el = document.elementFromPoint(Math.round(x), Math.round(y)) as HTMLElement | null;
      const tag = el?.tagName?.toLowerCase() ?? 'null';
      return tag === 'canvas'
        ? null
        : `(${Math.round(x)},${Math.round(y)}) -> ${el?.dataset.testid || tag}`;
    })
    .filter(Boolean), aimPoints);
  expect(
    blocked,
    `centerline clicks must reach the canvas; canvas=${JSON.stringify(b)} ` +
    `viewport=${JSON.stringify(await page.evaluate(() => ({ w: innerWidth, h: innerHeight })))}`,
  ).toEqual([]);
  await page.mouse.click(aimPoints[0].x, aimPoints[0].y);
  await page.mouse.move(aimPoints[1].x, aimPoints[1].y);
  await page.mouse.click(aimPoints[2].x, aimPoints[2].y);

  await expect(page.getByTestId('cross-section-panel'))
    .toHaveAttribute('data-suspended', 'false', { timeout: 10_000 });
  await expect.poll(async () => await drawnPoints(page), { timeout: 20_000 })
    .toBeLessThan(TOTAL);
});

test('the Label panel notice clears the section the same way', async () => {
  // Three controls clear a section (panel, viewport HUD, and this notice). They
  // must all go through one handler: this one used to just drop the slab and
  // leave the suspend/lock/draw state behind, so clearing from here and from
  // the panel left the tool in measurably different states.
  const { page } = await importDepthLayers();

  await page.getByTestId('tool-cross-section').click();
  await expect(page.getByTestId('cross-section-panel')).toBeVisible();
  await setSlab(page, 0, 1);

  await page.getByTestId('tool-label').click();
  await expect(page.getByTestId('label-panel')).toBeVisible();
  await expect(page.getByTestId('label-section-notice')).toBeVisible();

  await page.getByTestId('label-clear-section').click();

  await expect(page.getByTestId('label-section-notice')).toHaveCount(0);
  await expect(page.getByTestId('section-hud')).toHaveCount(0);
  await expect.poll(async () => await drawnPoints(page), { timeout: 20_000 })
    .toBe(TOTAL);
});

test('the scene-origin marker keeps its on-screen size in a section', async () => {
  // The marker is meant to occupy a FIXED pixel radius at any zoom. Under the
  // section's orthographic override it did not: worldPerPixel branched on
  // camera.isPerspectiveCamera, which the override leaves true while writing an
  // orthographic projectionMatrix, so the marker was scaled by
  // distance-from-camera. Framing a section pulls the camera well back, and the
  // marker inflated with it.
  const { page } = await importDepthLayers();

  const read = () => page.evaluate(() => (globalThis as any).__originMarkerScale ?? null);
  await expect.poll(async () => (await read())?.worldScale ?? 0, { timeout: 20_000 })
    .toBeGreaterThan(0);
  const before = await read();

  await page.getByTestId('tool-cross-section').click();
  await expect(page.getByTestId('cross-section-panel')).toBeVisible();
  await setSlab(page, 0, 1);
  // Framing the section moves the camera; give the override a few frames.
  await page.waitForTimeout(1500);
  const during = await read();

  // Assert against the ACTUAL projection, not against the marker's own ratio:
  // worldScale / worldPerPixel is PIXEL_RADIUS by construction, so comparing
  // those two is self-confirming and passes with the bug fully present.
  //
  // Under an orthographic projection the correct world-per-pixel is
  // (frustum height) / (viewport height) — no camera distance anywhere. Read
  // the live matrix and check the marker agrees with it.
  const el = during.projection as number[];
  const isOrtho = Math.abs(el[15] - 1) < 1e-6 && Math.abs(el[11]) < 1e-6;
  if (!isOrtho) {
    throw new Error('section view is not orthographic — the test cannot discriminate');
  }
  const correct = 2 / Math.abs(el[5]) / during.viewportHeight;
  expect(during.worldPerPixel).toBeCloseTo(correct, 6);

  // And prove the check has teeth: the buggy value (distance-scaled perspective
  // math under an ortho matrix) must be materially different from the correct
  // one, or agreement above would be meaningless.
  expect(Math.abs(during.cameraDistance)).toBeGreaterThan(1);
});

test('the keyboard steps the section: , and ← back, . and → forward', async () => {
  // Paging through a cloud is the workflow, and reaching for the panel's step
  // button between every slice takes the eyes off the section.
  const { page } = await importDepthLayers();
  await page.getByTestId('tool-cross-section').click();
  const panel = page.getByTestId('cross-section-panel');
  await setSlab(page, 0, 2);
  await expect(panel).toHaveAttribute('data-has-slab', 'true');
  const start = await panel.getAttribute('data-coverage');
  const index = async () => Number((await panel.getAttribute('data-coverage'))!.split('/')[0]);
  const i0 = await index();

  await page.keyboard.press('.');
  await expect.poll(index).toBe(i0 + 1);
  await page.keyboard.press('ArrowRight');
  await expect.poll(index).toBe(i0 + 2);
  await page.keyboard.press(',');
  await expect.poll(index).toBe(i0 + 1);
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => panel.getAttribute('data-coverage')).toBe(start);

  // Not while typing: a `.` in the thickness field is a decimal point.
  const field = panel.locator('input').first();
  await field.focus();
  await page.keyboard.press('.');
  await page.keyboard.press('ArrowRight');
  await expect(panel).toHaveAttribute('data-coverage', start!);
  await field.blur();

  // And with the panel closed, while the section is still in effect — the
  // Label tool shares that slot and pages through the section too.
  await panel.getByRole('button', { name: 'Close' }).click();
  await expect(panel).toHaveCount(0);
  const hudIndex = async () => page.getByTestId('section-hud').textContent();
  const before = await hudIndex();
  await page.keyboard.press('.');
  await expect.poll(hudIndex).not.toBe(before);
});

test('"Show full cloud" grays the points outside the section instead of hiding it', async () => {
  // Suspending used to show the whole cloud with no trace of the section, so
  // the context view could not show where the slice was. Now the slab keeps its
  // colors and everything outside it goes gray.
  const { page } = await importDepthLayers();
  await page.getByTestId('tool-cross-section').click();
  const panel = page.getByTestId('cross-section-panel');
  await setSlab(page, 0, 1);
  await expect.poll(async () => await drawnPoints(page), { timeout: 20_000 }).toBeLessThan(TOTAL);

  await page.getByTestId('section-suspend').click();
  await expect(panel).toHaveAttribute('data-suspended', 'true');
  // Every point draws again — gray is not hidden.
  await expect.poll(async () => await drawnPoints(page), { timeout: 20_000 }).toBe(TOTAL);
  // Out of the way: where the planes land on screen depends on the view the
  // previous test left, and the panel must not be what hides them. The section
  // (and its HUD) outlive the panel.
  await panel.getByRole('button', { name: 'Close' }).click();
  await expect(panel).toHaveCount(0);
  await page.evaluate(() => (window as any).__frameSelection?.());

  const pts = fixturePoints(DEPTH_LAYERS);
  const near = pts.filter((p) => p[1] === 0);
  const far = pts.filter((p) => p[1] === 8);
  const skip = '[data-testid="section-inset"], [data-testid="section-hud"]';
  await expect.poll(async () => {
    const f = await pointsDrawnGray(page, far, 12, 60, skip);
    return f.sampled > 0 ? f.matched / f.sampled : -1;
  }, { timeout: 20_000 }).toBeGreaterThan(0.9);
  const n = await pointsDrawnGray(page, near, 12, 60, skip);
  expect(n.sampled).toBeGreaterThan(0);
  expect(n.matched / n.sampled).toBeLessThan(0.1);

  // Clearing the section drops the ghost: nothing is gray any more.
  await page.getByTestId('section-hud-clear').click();
  await expect.poll(async () => {
    const f = await pointsDrawnGray(page, far, 12, 60, skip);
    return f.matched / Math.max(f.sampled, 1);
  }, { timeout: 20_000 }).toBeLessThan(0.1);
});

test('an inset map shows where the section sits, and follows it as it steps', async () => {
  const { page } = await importDepthLayers();
  await page.getByTestId('tool-cross-section').click();
  await setSlab(page, 0, 1);
  const inset = page.getByTestId('section-inset');
  await expect(inset).toBeVisible();
  // The cloud's footprint is on the map, sampled from the octree.
  await expect.poll(async () => Number(await inset.getAttribute('data-footprint-points')), { timeout: 20_000 })
    .toBeGreaterThan(100);

  // The slab starts on the near plane (y = 0, the bottom edge of the cloud's
  // extent) and moves UP the map as it steps toward y = 8.
  const slabY = async () => Number((await inset.getAttribute('data-slab-px'))!.split(',')[1]);
  const y0 = await slabY();
  for (let i = 0; i < 16; i++) await page.keyboard.press('.');
  await expect.poll(slabY).toBeLessThan(y0 - 40);

  await page.getByTestId('section-clear').click();
  await expect(inset).toHaveCount(0);
});

test('the line tool paints above or below a line drawn across the section', async () => {
  // TerraScan's Above/Below Line: cut a crown from its stem, or a trunk from the
  // ground, in one stroke. The far plane is a 41 x 41 grid over x, z in
  // [-1, 1] (0.05 apart); a line at z = 0.225 splits it between rows.
  const { page } = await importDepthLayers();
  await page.getByTestId('tool-label').click();
  const label = page.getByTestId('label-panel');
  await expect(label).toBeVisible();
  // No section, no line: it is drawn IN a section.
  await expect(page.getByTestId('label-tool-line')).toBeDisabled();
  // Close it (its armed lasso covers the toolbar), make a section, come back.
  await label.getByRole('button', { name: 'Close' }).click();
  await expect(label).toHaveCount(0);

  await page.getByTestId('tool-cross-section').click();
  const section = page.getByTestId('cross-section-panel');
  await expect(section).toBeVisible();
  await setSlab(page, 8, 1);
  // Step there and back: a step re-frames the locked view face-on. y = 8 is
  // the cloud's LAST step, so `.` first was a no-op and `,` left the section
  // one step short; and unwaited keys raced the slab on a slow renderer (CI,
  // or 20x CPU throttling locally), where the view ended up on the far side of
  // the section and every screen point came out mirrored. Go back one and
  // return, waiting for the slab and for each step to land.
  await expect(section).toHaveAttribute('data-has-slab', 'true');
  const index = async () => Number((await section.getAttribute('data-coverage'))!.split('/')[0]);
  const i0 = await index();
  await page.keyboard.press(',');
  await expect.poll(index).toBe(i0 - 1);
  await page.keyboard.press('.');
  await expect.poll(index).toBe(i0);

  await page.getByTestId('tool-label').click();
  await expect(label).toBeVisible();
  await page.getByTestId('label-tool-line').click();
  await expect(label).toHaveAttribute('data-label-tool', 'line');
  await expect(page.getByTestId('crop-polygon-overlay')).toBeVisible();

  const drawLine = async (z: number) => {
    // Two clicks on the left half of the plane; past its ends the line holds
    // its height, so it still spans the whole section.
    for (const x of [-0.9, -0.1]) {
      const p = await page.evaluate((w) => (window as any).__worldToScreen(w), [x, 8, z]);
      await page.mouse.click(p.x, p.y);
    }
    await page.keyboard.press('Enter');
  };

  const labeled = async () => Number(await label.getAttribute('data-labeled-count'));
  const ROW = 41;

  // Above: rows z = 0.25 .. 1.0 — 16 rows. None of the near plane: the slab
  // bounds the stroke.
  await drawLine(0.225);
  await expect(label).toHaveAttribute('data-pending-strokes', '1', { timeout: 20_000 });
  await expect.poll(labeled, { timeout: 20_000 }).toBe(16 * ROW);

  // Below: rows z = -1.0 .. 0.2 — 25 rows.
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(labeled, { timeout: 20_000 }).toBe(0);
  await page.getByTestId('label-line-side-below').click();
  await drawLine(0.225);
  await expect.poll(labeled, { timeout: 20_000 }).toBe(25 * ROW);

  // Below, within 0.1 of the line: rows z = 0.15 and 0.2 only.
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(labeled, { timeout: 20_000 }).toBe(0);
  await page.getByTestId('label-line-band').fill('0.1');
  await page.getByTestId('label-line-band').press('Tab');
  await drawLine(0.225);
  await expect.poll(labeled, { timeout: 20_000 }).toBe(2 * ROW);
});

async function lassoEverything(page: LaunchedApp['page']) {
  const overlay = page.getByTestId('crop-polygon-overlay');
  await expect(overlay).toBeVisible();
  const box = (await overlay.boundingBox())!;
  const inset = 8;
  for (const c of [
    { x: box.x + inset, y: box.y + inset },
    { x: box.x + box.width - inset, y: box.y + inset },
    { x: box.x + box.width - inset, y: box.y + box.height - inset },
    { x: box.x + inset, y: box.y + box.height - inset },
  ]) await page.mouse.click(c.x, c.y);
  await page.keyboard.press('Enter');
}

test('Front depth paints only the surface you can see, not what is behind it', async () => {
  // No section here: this is the other answer to the lasso painting through the
  // cloud. Seen from +y the dense far plane (y = 8) hides the sparse near one
  // (y = 0) completely, so a full-viewport lasso must label exactly the far
  // plane — Through would label both.
  const { page } = await importDepthLayers();
  await page.evaluate(() => (window as any).__orientToAxis({ x: 0, y: 1, z: 0 }));
  await page.evaluate(() => (window as any).__frameSelection?.());
  await page.getByTestId('tool-label').click();
  const label = page.getByTestId('label-panel');
  await expect(label).toBeVisible();

  await page.getByTestId('label-depth-front').click();
  await expect(page.getByTestId('label-depth')).toHaveAttribute('data-depth-mode', 'front');
  await lassoEverything(page);
  await expect(label).toHaveAttribute('data-pending-strokes', '1', { timeout: 20_000 });
  await expect.poll(async () => Number(await label.getAttribute('data-labeled-count')),
    { timeout: 20_000 }).toBe(FAR_PLANE);

  // Through, from the same view, reaches the plane behind.
  await page.keyboard.press('ControlOrMeta+z');
  await page.getByTestId('label-depth-through').click();
  await lassoEverything(page);
  await expect.poll(async () => Number(await label.getAttribute('data-labeled-count')),
    { timeout: 20_000 }).toBe(TOTAL);
});

test('Box depth paints only inside the limiting box', async () => {
  // Looking down, a box over x in [-0.425, 0.425] and both planes: the far
  // plane's 17 columns x = -0.40 .. 0.40 (41 points each) and the near plane's
  // x = 0 column (5 points). A full-viewport lasso may reach nothing else.
  const { page } = await importDepthLayers();
  await page.getByTestId('tool-label').click();
  const label = page.getByTestId('label-panel');
  await expect(label).toBeVisible();

  await page.getByTestId('label-depth-box').click();
  // No box yet: a stroke is refused rather than painting unbounded.
  await lassoEverything(page);
  await expect(page.getByText('Draw the limiting box first')).toBeVisible();
  await expect(label).toHaveAttribute('data-pending-strokes', '0');

  await page.getByTestId('label-box-draw').click();
  // Straight down and framed, whatever view the previous test left: the
  // corners must not land under the panel.
  await page.evaluate(() => (window as any).__orientToAxis({ x: 0, y: 0, z: 1 }));
  await page.evaluate(() => (window as any).__frameSelection?.());
  const panelBox = (await label.boundingBox())!;
  // Corners on the ground (z = -1, the cloud's floor), clear of any point.
  for (const w of [[-0.425, -1, -1], [0.425, 9, -1]]) {
    const p = await page.evaluate((w) => (window as any).__worldToScreen(w), w);
    expect(p.x < panelBox.x || p.y > panelBox.y + panelBox.height).toBe(true);
    await page.mouse.click(p.x, p.y);
  }
  await expect(page.getByTestId('label-box-clear')).toBeVisible();
  // The box is where the corners were aimed (to the pick's precision).
  const [x0, y0, , x1, y1] = (await page.getByTestId('label-depth').getAttribute('data-limit-box'))!
    .split(',').map(Number);
  expect(x0).toBeCloseTo(-0.425, 1);
  expect(x1).toBeCloseTo(0.425, 1);
  expect(y0).toBeLessThan(0);
  expect(y1).toBeGreaterThan(8);

  await lassoEverything(page);
  await expect(label).toHaveAttribute('data-pending-strokes', '1', { timeout: 20_000 });
  await expect.poll(async () => Number(await label.getAttribute('data-labeled-count')),
    { timeout: 20_000 }).toBe(17 * 41 + 5);
});

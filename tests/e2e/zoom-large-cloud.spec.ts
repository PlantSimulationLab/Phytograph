import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';

// The user-reported bug was found on a real 13M-point tree, not on a fixture.
// That scale is the whole point: the depth probe's CPU raycast walks every
// loaded point, so on this cloud it routinely overruns its 8 ms budget and
// backs off for 250 ms — which is exactly the condition that used to feed
// far-away fallback anchors into the dolly and invert the scroll direction.
// The small committed fixtures never trip that guard, so they cannot reproduce
// it. This spec is skipped when the dataset isn't present (it is far too large
// to commit); it is here so the real path can be re-run on demand.
const CLOUD = join(repoRoot, 'example-datasets', 'BPP_tree_000.xyz');

let session: LaunchedApp;
test.beforeAll(async () => { session = await launchApp(); });
test.afterAll(async () => { await session?.close(); });

test('a scroll burst on a 13M-point cloud converges without reversing', async () => {
  test.skip(!existsSync(CLOUD), 'example-datasets/BPP_tree_000.xyz not present');
  test.setTimeout(300_000);
  const { app, page } = session;

  await importFiles(app, page, 'import-auto', CLOUD);
  await completeImportWizard(page);
  await expect(
    page.locator('[data-testid="scan-row"][data-scan-name="BPP_tree_000.xyz"]'),
  ).toBeVisible({ timeout: 180_000 });
  await page.waitForFunction(
    () => (window as any).__getCameraState?.()?.framedContent === true,
    { timeout: 180_000 },
  );
  // Let the octree stream in, so the probe is under realistic load.
  await page.waitForTimeout(5_000);

  const state = () => page.evaluate(() => (window as any).__getCameraState());
  const s0 = await state();
  const centre = s0.contentCenter.map((v: number, i: number) => v - s0.displayOffset[i]);
  const distTo = (s: any) => Math.hypot(
    s.position[0] - centre[0], s.position[1] - centre[1], s.position[2] - centre[2],
  );

  const box = (await page.locator("canvas").first().boundingBox())!;

  // Both reported spots: middle of the scene, and the periphery.
  for (const [label, fx, fy] of [
    ['centre', 0.5, 0.5],
    ['periphery', 0.30, 0.82],
  ] as const) {
    // Start each case from the framed view. Without this the second case begins
    // wherever the first left the camera — inside the tree — where "distance to
    // the content centre" no longer means "how zoomed in am I".
    await page.evaluate(() => (window as any).__resetPointCloudCamera?.());
    await page.waitForTimeout(300);

    const px = box.x + box.width * fx;
    const py = box.y + box.height * fy;
    await page.mouse.move(px, py);
    // The viewport is NOT the whole window — the sidebar and floating panels
    // overlap it. A wheel event over one of those scrolls a DOM list and never
    // reaches the canvas, which looks exactly like a frozen camera. Assert we
    // are actually over the canvas before trusting anything this burst measures.
    const over = await page.evaluate(([x, y]) => {
      const e = document.elementFromPoint(x as number, y as number);
      return e ? e.tagName : 'NONE';
    }, [px, py]);
    expect(over, `${label}: pointer is over ${over}, not the viewport`).toBe('CANVAS');

    const d: number[] = [];
    const pos: number[][] = [];
    for (let i = 0; i < 20; i++) {
      await page.mouse.wheel(0, -120);
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
      const s = await state();
      d.push(distTo(s));
      pos.push(s.position);
    }

    // ── Pacing: no stall, no lurch, no over-zoom ────────────────────────────
    //
    // Deliberately NOT "distance to the content centre falls every notch".
    // That distance is a projection of the real motion onto a single axis, so
    // with the cursor off to one side, flying at what it points to legitimately
    // increases it — asserting otherwise would assert zoom-to-cursor away.
    //
    // Monotonicity alone would also miss the second reported symptom, which
    // lived entirely inside a monotonic sequence: zoom decayed to imperceptible
    // steps (a "momentary freeze"), the user kept scrolling, and then it lurched
    // and buried the camera in the tree. So judge the CAMERA's own travel, and
    // require consecutive notches to stay within a bounded ratio: a stall
    // (ratio → 0) and a lurch (ratio ≫ 1) both fail.
    const steps = pos.slice(1).map((p, i) => Math.hypot(
      p[0] - pos[i][0], p[1] - pos[i][1], p[2] - pos[i][2],
    ));
    // Trailing no-op notches are CORRECT once the approach floor engages — the
    // camera has arrived and refuses to fly further into the subject. What must
    // not happen is stalling in the MIDDLE of the approach.
    const moving = steps.filter((s) => s > 1e-6);
    expect(moving.length, `${label}: the burst barely moved the camera`)
      .toBeGreaterThanOrEqual(5);
    for (let i = 1; i < moving.length; i++) {
      expect(
        moving[i] / moving[i - 1],
        `${label}: step ${i} jumped (${moving[i - 1].toFixed(4)} → ${moving[i].toFixed(4)})`,
      ).toBeLessThan(3);
    }

    // The camera must end up somewhere new, and NOT inside the subject: flying
    // through the middle of the tree leaves an empty viewport, which is the
    // "over-zooms so no points are visible" report.
    expect(d[d.length - 1], `${label}: burst made no progress`).toBeLessThan(d[0]);
    const extent = Math.max(...(s0.framingBounds.size as number[]));
    expect(d[d.length - 1], `${label}: camera ended up inside the content`)
      .toBeGreaterThan(extent * 0.01);

    // Scrolling back out must work immediately — no orbit needed to unstick it.
    const before = distTo(await state());
    for (let i = 0; i < 8; i++) await page.mouse.wheel(0, 120);
    await page.waitForTimeout(200);
    expect(distTo(await state()), `${label}: zoom-out froze`).toBeGreaterThan(before);
  }
});

// ── Regression: fast in past the ground, then straight back out ─────────────
//
// The reported gesture that still froze after the pacing fix. Its cause was a
// positive feedback loop on zoom-OUT: step size is proportional to the distance
// from the content, and zooming out increases that distance, so each notch was
// larger than the last. Measured stepping 84 → 102 → 124 → 150 → 182 world
// units, ending ~1000 units from a 41 m tree — where the scene is a sub-pixel
// dot and no further notch can recover the view. Reads exactly as a freeze, and
// only an orbit (which reframes the camera/target relationship) got it back.
//
// `maxDistance` could not catch it: the outer clamp is applied to the ANCHOR
// gap, which under a rigid camera+target translation says nothing about how far
// the camera is from the scene.
test('a hard zoom in past the ground then back out never escapes the scene', async () => {
  test.skip(!existsSync(CLOUD), 'example-datasets/BPP_tree_000.xyz not present');
  test.setTimeout(300_000);
  const { page } = session;

  const state = () => page.evaluate(() => (window as any).__getCameraState());
  // This spec shares one app across its tests (the import is slow), so the cloud
  // is already loaded — but the previous test may have left a panel or dialog
  // over the viewport. Press Escape and confirm the canvas is actually under the
  // pointer below; a wheel event landing on an overlay is indistinguishable from
  // a frozen camera, and has already caused one false result in this suite.
  await page.keyboard.press('Escape');
  await page.evaluate(() => (window as any).__resetPointCloudCamera?.());
  await page.waitForTimeout(300);

  const s0 = await state();
  const centre = s0.contentCenter.map((v: number, i: number) => v - s0.displayOffset[i]);
  const distTo = (s: any) => Math.hypot(
    s.position[0] - centre[0], s.position[1] - centre[1], s.position[2] - centre[2],
  );
  const scale = s0.zoomLimits.scale;

  const box = (await page.locator('canvas').first().boundingBox())!;
  // Low in the frame — aimed at/below the ground, as reported.
  const px = box.x + box.width * 0.5;
  const py = box.y + box.height * 0.72;
  await page.mouse.move(px, py);
  const over = await page.evaluate(([x, y]) => {
    const e = document.elementFromPoint(x as number, y as number);
    return e ? e.tagName : 'NONE';
  }, [px, py]);
  expect(over, `pointer is over ${over}, not the viewport`).toBe('CANVAS');

  // Fast flick in — no frame yield between notches, driving past the ground.
  for (let i = 0; i < 40; i++) await page.mouse.wheel(0, -120);
  await page.waitForTimeout(400);
  // Then hard back out, long enough to run the old feedback loop away.
  for (let i = 0; i < 80; i++) await page.mouse.wheel(0, 120);
  await page.waitForTimeout(400);

  // The camera is still in the same world as the scene. Before the fix this
  // reached ~24x the scene scale and kept climbing.
  const after = await state();
  expect(
    distTo(after) / scale,
    'the camera escaped the scene on zoom-out',
  ).toBeLessThan(15);

  // And zoom still works, both ways, WITHOUT an orbit to unstick it — the
  // actual complaint.
  const a = (await state()).position;
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, -120); await page.waitForTimeout(30); }
  await page.waitForTimeout(300);
  const b = (await state()).position;
  expect(
    Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]),
    'zoom-in was frozen after the in/out gesture',
  ).toBeGreaterThan(scale * 0.01);

  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 120); await page.waitForTimeout(30); }
  await page.waitForTimeout(300);
  const c = (await state()).position;
  expect(
    Math.hypot(c[0] - b[0], c[1] - b[1], c[2] - b[2]),
    'zoom-out was frozen after the in/out gesture',
  ).toBeGreaterThan(scale * 0.01);
});

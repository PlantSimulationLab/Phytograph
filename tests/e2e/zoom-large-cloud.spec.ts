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

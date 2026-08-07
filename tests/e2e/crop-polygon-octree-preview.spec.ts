import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';
import { resetToFreshScene } from './helpers/resetApp';

// Closing a polygon (or an off-axis rect) must PREVIEW the crop on an octree
// cloud — the points that Apply would remove disappear immediately, the way the
// box gizmo already previews through the GPU clip volume.
//
// Why this needed its own mechanism: potree's shader clips against AABBs, and a
// lasso is not an AABB. Its only vertex-kill is `use_filter_by_normal`, wired to
// the `normal` attribute, so there is no per-point discard to drive. The
// preview instead runs the same predicate the Apply sends to the backend over
// the loaded tiles and hides rejected points with an index buffer
// (renderers/octreeCropMask.ts). Unit tests cover that module's geometry; this
// spec covers the part only the real app can answer — that the mask reaches a
// live streaming octree, survives LOD streaming, and is fully reverted on
// cancel.
//
// The assertions read RENDERED point counts out of the live three.js scene
// (draw counts per tile), not DOM state: "the tool didn't throw" would say
// nothing about whether anything was actually hidden.

const LAZ = join(repoRoot, 'example-datasets', 'ALS-on_BR04_2019-07-05_140m.laz');

let session: LaunchedApp;
test.beforeAll(async () => {
  session = await launchApp();
});
test.afterAll(async () => {
  await session?.close();
});
test.beforeEach(async () => {
  // Clear the pixel-test seam first: a test that failed mid-diff would
  // otherwise leave the cloud hidden for the next one.
  await session.page.evaluate(() => { (window as any).__hideCloudForPixelTest = false; });
  await resetToFreshScene(session.app, session.page);
});

/**
 * Points the loaded octree tiles will actually draw (`drawn`) against how many
 * they hold (`full`), plus how many carry a mask — published by the mask module
 * itself on `window.__octreeCropMask`.
 *
 * A masked tile draws `index.count` instead of its full position count, so
 * `drawn` falls by exactly the number of points the predicate rejected: the
 * quantity the preview exists to change.
 */
async function readDrawState(page: LaunchedApp['page']) {
  return page.evaluate(() => {
    const s = (window as any).__octreeCropMask;
    return s ?? { drawn: 0, full: 0, maskedTiles: 0, tiles: 0 };
  });
}

async function waitForTiles(page: LaunchedApp['page']) {
  await expect
    .poll(async () => (await readDrawState(page)).tiles, { timeout: 60_000 })
    .toBeGreaterThan(0);
}

/**
 * The page-space bounding box of the CLOUD's own pixels, found by differencing
 * two screenshots of the same frame — one normal, one with the cloud hidden.
 *
 * A single screenshot cannot answer this. The crop overlay tints its interior
 * and the panels carry their own blues, so an absolute colour threshold counts
 * chrome as cloud (it reported a "leftover" that was really the overlay fill).
 * Differencing cancels everything that is not the cloud, whatever its colour.
 *
 * `limit` restricts the comparison to a page-space rect. Pass the open part of
 * the viewport: the floating panels are translucent, so hiding the cloud also
 * changes the pixels showing through them, which would otherwise be counted as
 * cloud hundreds of px away from the polygon.
 *
 * Returns null when the cloud contributes no pixels at all.
 */
async function cloudPixelBounds(
  page: LaunchedApp['page'],
  limit: { x0: number; y0: number; x1: number; y1: number },
): Promise<{ x0: number; y0: number; x1: number; y1: number; n: number } | null> {
  const withCloud = await page.screenshot();
  await page.evaluate(() => { (window as any).__hideCloudForPixelTest = true; });
  // Two frames: one to apply the flag, one to present the result.
  await page.waitForTimeout(600);
  const withoutCloud = await page.screenshot();
  await page.evaluate(() => { (window as any).__hideCloudForPixelTest = false; });
  // Wait for the tiles to actually come back — returning while they are still
  // hidden leaks the blank state into whatever the caller measures next.
  await expect
    .poll(async () => page.evaluate(() => (window as any).__octreeCropMask?.tiles ?? 0), { timeout: 30_000 })
    .toBeGreaterThan(0);

  return page.evaluate(async ([a, b, lim]: any) => {
    const decode = async (bytes: number[]) => {
      const bmp = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
      const c = document.createElement('canvas');
      c.width = bmp.width; c.height = bmp.height;
      c.getContext('2d')!.drawImage(bmp, 0, 0);
      return c.getContext('2d')!.getImageData(0, 0, c.width, c.height);
    };
    const A = await decode(a), B = await decode(b);
    const dpr = window.devicePixelRatio || 1;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, n = 0;
    for (let y = Math.round(lim.y0 * dpr); y < Math.min(A.height, Math.round(lim.y1 * dpr)); y++) {
      for (let x = Math.round(lim.x0 * dpr); x < Math.min(A.width, Math.round(lim.x1 * dpr)); x++) {
        const i = (y * A.width + x) * 4;
        // Any channel differing meaningfully means the cloud drew here.
        if (Math.abs(A.data[i] - B.data[i]) > 12 ||
            Math.abs(A.data[i + 1] - B.data[i + 1]) > 12 ||
            Math.abs(A.data[i + 2] - B.data[i + 2]) > 12) {
          n++;
          const cx = x / dpr, cy = y / dpr;
          if (cx < x0) x0 = cx; if (cx > x1) x1 = cx;
          if (cy < y0) y0 = cy; if (cy > y1) y1 = cy;
        }
      }
    }
    return n === 0 ? null : { x0, y0, x1, y1, n };
  }, [Array.from(withCloud), Array.from(withoutCloud), limit] as const);
}

test('closing a polygon does not thin the rest of the cloud', async () => {
  const { app, page } = session;

  // Regression: the preview used to inherit the CLIP-VOLUME preview's cost
  // controls — the 150k point budget and the level-4 LOD cap. Both exist for a
  // dragging box gizmo (potree's fragment `discard` defeats early-Z, so a live
  // clip volume overdraws quadratically). A mask preview has neither problem:
  // its hidden points are dropped by an index buffer, never submitted.
  //
  // Charged anyway, the cloud collapsed from 1.7M loaded points across 186
  // tiles to 143k across 3 the instant the polygon closed. That reads as the
  // crop having deleted most of the cloud, and it survived the sibling test
  // below because `drawn < full` stays true when `full` itself collapses —
  // so this asserts on the LOADED total, which the crop must not touch.
  await importFiles(app, page, 'import-auto', LAZ);
  await completeImportWizard(page);
  await expect(page.locator('[data-testid="scan-row"]').first()).toBeVisible({ timeout: 120_000 });
  await waitForTiles(page);
  // Let streaming settle so the baseline is the cloud's real resident set.
  await expect
    .poll(async () => (await readDrawState(page)).tiles, { timeout: 30_000 })
    .toBeGreaterThan(20);
  const before = await readDrawState(page);

  await page.getByTestId('tool-crop').click();
  await page.getByTestId('crop-shape-polygon').click();
  await page.getByRole('button', { name: 'Keep Outside' }).click();

  // Crop opens in Box mode, which legitimately drops the budget for its clip
  // volume and evicts tiles. Selecting Polygon must hand the budget straight
  // back — wait for the cloud to re-stream before measuring, so what follows
  // tests the polygon preview rather than box mode's leftovers.
  await expect
    .poll(async () => await page.evaluate(() => (window as any).__pointBudget), { timeout: 30_000 })
    .toBe(2_000_000);
  await expect
    .poll(async () => (await readDrawState(page)).tiles, { timeout: 60_000 })
    .toBeGreaterThanOrEqual(before.tiles * 0.9);

  // A small polygon in the middle of the cloud body — the case where thinning
  // the whole cloud is most visible, and most easily mistaken for the crop.
  const box = await page.getByTestId('crop-polygon-overlay').boundingBox();
  if (!box) throw new Error('no overlay box');
  const cx = box.x + box.width * 0.5;
  const cy = box.y + box.height * 0.56;
  const r = Math.min(box.width, box.height) * 0.09;
  for (const [dx, dy] of [[-r, -r], [r, -r], [r, r], [-r, r]] as const) {
    await page.mouse.click(cx + dx, cy + dy);
  }
  await page.keyboard.press('Enter');

  await expect
    .poll(async () => (await readDrawState(page)).maskedTiles, { timeout: 30_000 })
    .toBeGreaterThan(0);

  const after = await readDrawState(page);
  // The resident cloud must not shrink: same tiles, same loaded points. A
  // small tolerance absorbs ordinary LOD churn, not a 92% collapse.
  expect(after.tiles).toBeGreaterThanOrEqual(before.tiles * 0.9);
  expect(after.full).toBeGreaterThanOrEqual(before.full * 0.9);
  // The full-detail budget stays in force — the mask needs no overdraw guard.
  expect(await page.evaluate(() => (window as any).__pointBudget)).toBe(2_000_000);
  // And the crop really did hide the polygon's interior.
  expect(after.drawn).toBeLessThan(after.full);

  await page.keyboard.press('Escape');
});

test('the cloud draws only inside the polygon, in both Keep modes', async () => {
  const { app, page } = session;

  // Asserts on the RENDERED IMAGE, not on point counts. Counts stay
  // self-consistent even when the wrong pixels are lit (a stale camera or an
  // unmasked draw would keep the arithmetic right), so this measures where the
  // cloud actually appears and compares it to the polygon the user drew.
  await importFiles(app, page, 'import-auto', LAZ);
  await completeImportWizard(page);
  await expect(page.locator('[data-testid="scan-row"]').first()).toBeVisible({ timeout: 120_000 });
  await waitForTiles(page);

  await page.getByTestId('tool-crop').click();
  await page.getByTestId('crop-shape-polygon').click();

  const ob = await page.getByTestId('crop-polygon-overlay').boundingBox();
  if (!ob) throw new Error('no overlay box');
  // Polygon over the middle of the cloud body, so there are points on every
  // side of it — otherwise "nothing leaked outside" is vacuously true.
  const cx = ob.x + ob.width * 0.5;
  const cy = ob.y + ob.height * 0.56;
  const r = Math.min(ob.width, ob.height) * 0.09;
  for (const [dx, dy] of [[-r, -r], [r, -r], [r, r], [-r, r]] as const) {
    await page.mouse.click(cx + dx, cy + dy);
  }
  await page.keyboard.press('Enter');
  await expect
    .poll(async () => (await readDrawState(page)).maskedTiles, { timeout: 30_000 })
    .toBeGreaterThan(0);

  // Keep Inside: every cloud pixel must fall within the polygon. Tolerance is
  // a few px for the point splat and the polygon's own 2px stroke.
  const pad = 6;
  // The crop panel starts around 58% of the viewport width; stay clear of it
  // and of the left toolbar.
  const panel = await page.getByTestId('crop-panel').boundingBox();
  if (!panel) throw new Error('no crop panel box');
  // Everything left of the crop panel, inset past the left toolbar. The
  // polygon sits inside this window, so a leak on either side is visible.
  const openArea = { x0: ob.x + 160, y0: ob.y + 10, x1: panel.x - 8, y1: ob.y + ob.height - 10 };
  expect(cx + r + 8).toBeLessThan(openArea.x1); // polygon must fit in the window
  const inside = await cloudPixelBounds(page, openArea);
  expect(inside).not.toBeNull();
  expect(inside!.n).toBeGreaterThan(500);
  expect(inside!.x0).toBeGreaterThanOrEqual(cx - r - pad);
  expect(inside!.x1).toBeLessThanOrEqual(cx + r + pad);
  expect(inside!.y0).toBeGreaterThanOrEqual(cy - r - pad);
  expect(inside!.y1).toBeLessThanOrEqual(cy + r + pad);

  // Keep Outside: the complement. The cloud must now extend well beyond the
  // polygon, and must not fill its interior.
  const insideDrawn = (await readDrawState(page)).drawn;
  await page.getByRole('button', { name: 'Keep Outside' }).click();
  await expect
    .poll(async () => (await readDrawState(page)).drawn, { timeout: 30_000 })
    .toBeGreaterThan(insideDrawn);
  const outside = await cloudPixelBounds(page, openArea);
  expect(outside).not.toBeNull();
  expect(outside!.x0).toBeLessThan(cx - r - pad);

  // Toggling back must restore exactly the Keep Inside framing, not leave a
  // half-applied mask — the reported symptom was points surviving outside.
  await page.getByRole('button', { name: 'Keep Inside' }).click();
  await expect
    .poll(async () => (await readDrawState(page)).drawn, { timeout: 30_000 })
    .toBe(insideDrawn);
  const again = await cloudPixelBounds(page, openArea);
  expect(again).not.toBeNull();
  expect(again!.x0).toBeGreaterThanOrEqual(cx - r - pad);
  expect(again!.x1).toBeLessThanOrEqual(cx + r + pad);

  await page.keyboard.press('Escape');
});

test('a closed polygon hides exactly the points it excludes, and cancel restores them', async () => {
  const { app, page } = session;

  await importFiles(app, page, 'import-auto', LAZ);
  await completeImportWizard(page);
  const row = page.locator('[data-testid="scan-row"]').first();
  await expect(row).toBeVisible({ timeout: 120_000 });
  await expect(row).toHaveAttribute('data-selected', 'true');

  // This must be a genuine octree cloud, or the test proves nothing about the
  // path under test (flat clouds preview through getDisplayIndices instead).
  await waitForTiles(page);
  const before = await readDrawState(page);
  expect(before.maskedTiles).toBe(0);
  expect(before.drawn).toBe(before.full);

  await page.getByTestId('tool-crop').click();
  const panel = page.getByTestId('crop-panel');
  await expect(panel).toBeVisible();
  await page.getByTestId('crop-shape-polygon').click();
  await expect(panel).toHaveAttribute('data-crop-mode', 'polygon');

  // Draw a polygon over a sub-region of the viewport, well clear of the
  // right-hand panel stack so every click lands on the draw overlay.
  const overlay = page.getByTestId('crop-polygon-overlay');
  const box = await overlay.boundingBox();
  if (!box) throw new Error('no overlay box');
  const cx = box.x + box.width * 0.32;
  const cy = box.y + box.height * 0.5;
  const r = Math.min(box.width, box.height) * 0.16;
  // A quadrilateral — small enough that it must exclude a real fraction of the
  // cloud, large enough to still contain some points.
  for (const [dx, dy] of [[-r, -r], [r, -r], [r, r], [-r, r]] as const) {
    await page.mouse.click(cx + dx, cy + dy);
  }
  await expect(panel).toContainText('Vertices: 4');
  await page.keyboard.press('Enter');
  await expect(panel).toContainText('Polygon (4 vertices)');

  // The preview must now be hiding points: some tiles carry a mask, and the
  // rendered total dropped. Poll — the mask is applied as tiles stream.
  await expect
    .poll(async () => (await readDrawState(page)).maskedTiles, { timeout: 30_000 })
    .toBeGreaterThan(0);

  const masked = await readDrawState(page);
  // Strictly fewer points drawn than exist in the loaded tiles: the polygon
  // covers a fraction of the view, so this is the crop actually previewing.
  expect(masked.drawn).toBeLessThan(masked.full);
  // And not everything vanished — a preview that hides the whole cloud would
  // also satisfy "fewer", and would be the empty-result bug instead.
  expect(masked.drawn).toBeGreaterThan(0);

  // Escape cancels the crop: every masked tile must be restored to full draw.
  // A leftover index buffer here is the failure mode that would silently
  // shrink the cloud for the rest of the session.
  await page.keyboard.press('Escape');
  await expect
    .poll(async () => (await readDrawState(page)).maskedTiles, { timeout: 30_000 })
    .toBe(0);
  const after = await readDrawState(page);
  expect(after.drawn).toBe(after.full);
});

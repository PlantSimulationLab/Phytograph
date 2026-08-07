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

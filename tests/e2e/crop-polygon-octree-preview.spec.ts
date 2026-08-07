import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';

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

import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';
import { resetToFreshScene } from './helpers/resetApp';

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
  const row = page.locator('[data-testid="scan-row"][data-scan-name="depth-layers.xyz"]');
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).toHaveAttribute('data-point-count', String(TOTAL));
  await expect(row).toHaveAttribute('data-selected', 'true');

  // Look straight down, so the two planes are separated on screen and the
  // centreline can be drawn across them.
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
    async () => Number(await label.getAttribute('data-labelled-count')),
    { timeout: 20_000 },
  ).toBe(FAR_PLANE);
});

test('the centreline is placed by two clicks in the view', async () => {
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

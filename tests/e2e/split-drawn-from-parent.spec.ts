import { test, expect, type Page } from '@playwright/test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readdirSync, rmSync } from 'node:fs';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';
import { resetToFreshScene } from './helpers/resetApp';
import { clickCanvasAt } from './helpers/canvasClick';
import { stubSaveDialog } from './helpers/stubSaveDialog';
import { stubOpenDialog } from './helpers/stubOpenDialog';
import { stubMessageBox } from './helpers/stubMessageBox';

const FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'ground_plants.xyz');

// Split by class without converting the children.
//
// A ground split used to build an octree per child (~N points converted while
// the user waited) and then rebuild the hidden parent in the background (~N
// more): on the 45.7 M-point test scan that was the most expensive edit in the
// app. Now the parent's octree is built once, carrying ground_class, and each
// child is DRAWN FROM IT through a per-tile class mask until an edit gives it
// an octree of its own. These tests pin what the user sees:
//   - each child shows exactly its own class (1600 ground / 600 plant of 2200)
//     while both share the parent's octree;
//   - editing a child builds it its own octree and drops the class mask;
//   - the mask and the shared octree survive a .phyto save and reopen on a
//     machine with an empty octree cache.
//
// Shared session: one app + backend for the whole file; File → New resets the
// scene between tests (see helpers/resetApp.ts).
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

const row = (page: Page, name: string) =>
  page.locator(`[data-testid="scan-row"][data-scan-name="${name}"]`);

/** Mask stats the renderer publishes for one drawn cloud (see `octreeMaskStatsKey`). */
async function maskStats(page: Page, key: string) {
  return page.evaluate((k) => {
    const s = (window as { __octreeMaskByCloud?: Record<string, { drawn: number; full: number }> })
      .__octreeMaskByCloud?.[k];
    return s ? { drawn: s.drawn, full: s.full } : null;
  }, key);
}

async function segmentAndSplit(page: Page, app: LaunchedApp['app']) {
  await importFiles(app, page, 'import-point-cloud', FIXTURE);
  await completeImportWizard(page);
  const parent = row(page, 'ground_plants');
  await expect(parent).toBeVisible({ timeout: 20_000 });
  await expect(parent).toHaveAttribute('data-selected', 'true');
  const importedCacheId = (await parent.getAttribute('data-octree-cache-id'))!;

  await page.getByTestId('tool-ground-segment').click();
  await expect(page.getByTestId('ground-segment-panel')).toBeVisible();
  await page.getByTestId('ground-cloth-resolution').fill('0.1');
  await page.getByTestId('ground-auto-class-threshold').uncheck();
  await page.getByTestId('ground-class-threshold').fill('0.05');
  await page.getByTestId('ground-split-clouds').check();
  await page.getByTestId('ground-segment-run-button').click();

  const ground = row(page, 'ground_plants (ground)');
  const plant = row(page, 'ground_plants (non-ground)');
  await expect(ground).toBeVisible({ timeout: 60_000 });
  await expect(plant).toBeVisible({ timeout: 60_000 });
  // Neither the segmentation nor the split rebuilt anything: ground_class is
  // shown on the IMPORTED octree by row lookup (octreeOverlayColumns.ts), and
  // the children are drawn from that same octree.
  await expect(parent).toHaveAttribute('data-octree-cache-id', importedCacheId);
  return { parent, ground, plant };
}

/** Both children drawn from the parent's octree, each masked to its own class. */
async function expectDrawnFromParent(page: Page, parentCacheId: string, ground: ReturnType<typeof row>,
  plant: ReturnType<typeof row>) {
  for (const [r, kept] of [[ground, 1600], [plant, 600]] as const) {
    await expect(r).toHaveAttribute('data-octree-cache-id', parentCacheId);
    expect(Number(await r.getAttribute('data-point-count'))).toBe(kept);
    const key = `${parentCacheId}#${await r.getAttribute('data-scan-id')}`;
    // The whole 2200-point parent is loaded and exactly the child's class is
    // drawn — not "fewer points", which a wrong class would also give.
    await expect.poll(() => maskStats(page, key), { timeout: 30_000 })
      .toEqual({ drawn: kept, full: 2200 });
  }
}

test('split children are drawn from the parent octree, masked to their class', async () => {
  const { app, page } = session;
  const { parent, ground, plant } = await segmentAndSplit(page, app);

  // One octree for all three: nothing was converted for the children.
  const parentCacheId = (await parent.getAttribute('data-octree-cache-id'))!;
  expect(parentCacheId).toMatch(/^[0-9a-f]{40}$/);
  await expect(parent).toHaveAttribute('data-visible', 'false');
  await expectDrawnFromParent(page, parentCacheId, ground, plant);

  // Edit the ground child: an erase, then "Permanently apply deletions". That
  // rebuild is the child's first octree of its own, and once it is drawn the
  // class mask has nothing left to hide.
  if ((await ground.getAttribute('data-selected')) !== 'true') await ground.click();
  if ((await plant.getAttribute('data-selected')) === 'true') await plant.click();
  await expect(ground).toHaveAttribute('data-selected', 'true');
  await expect(plant).toHaveAttribute('data-selected', 'false');

  await page.waitForFunction(() => typeof (window as any).__orientToAxis === 'function');
  await page.evaluate(() => (window as any).__orientToAxis({ x: 0, y: 0, z: 1 }));
  await page.getByTestId('tool-erase').click();
  const panel = page.getByTestId('erase-panel');
  await page.getByTestId('erase-mode-toggle').click();
  await expect(panel).toHaveAttribute('data-erase-active', 'true');
  await page.waitForTimeout(300);
  const box = (await page.locator('canvas').first().boundingBox())!;
  await clickCanvasAt(page, { x: box.x + box.width * 0.5, y: box.y + box.height * 0.5 }, 'erase stamp');
  await expect.poll(async () => Number(await panel.getAttribute('data-stamp-count')), { timeout: 5_000 })
    .toBeGreaterThan(0);
  await page.getByTestId('erase-apply').click();
  await expect.poll(async () => Number(await ground.getAttribute('data-point-count')), { timeout: 8_000 })
    .toBeLessThan(1600);
  const afterErase = Number(await ground.getAttribute('data-point-count'));
  expect(afterErase).toBeGreaterThan(0);
  // The other child is untouched by an edit to its sibling.
  expect(Number(await plant.getAttribute('data-point-count'))).toBe(600);

  await page.getByTestId('erase-bake').click();
  await expect.poll(async () => ground.getAttribute('data-octree-cache-id'), { timeout: 60_000 })
    .not.toBe(parentCacheId);
  const ownCacheId = (await ground.getAttribute('data-octree-cache-id'))!;
  // Its own octree holds exactly its survivors, drawn unmasked under its own
  // key (the shared-octree key is only for a cloud still drawn from the parent).
  await expect.poll(() => maskStats(page, ownCacheId), { timeout: 30_000 })
    .toEqual({ drawn: afterErase, full: afterErase });
  await expect(ground).toHaveAttribute('data-point-count', String(afterErase));
  // The sibling still shares the parent's octree, still masked to its class.
  await expect(plant).toHaveAttribute('data-octree-cache-id', parentCacheId);
  await expect.poll(
    async () => maskStats(page, `${parentCacheId}#${await plant.getAttribute('data-scan-id')}`),
    { timeout: 30_000 },
  ).toEqual({ drawn: 600, full: 2200 });
});

test('the class mask and the shared octree survive save and reopen', async () => {
  test.setTimeout(4 * 60_000);
  const { app, page } = session;
  const { parent, ground, plant } = await segmentAndSplit(page, app);
  const parentCacheId = (await parent.getAttribute('data-octree-cache-id'))!;
  await expectDrawnFromParent(page, parentCacheId, ground, plant);

  const projectPath = join(tmpdir(), `phyto-split-${Date.now()}.phyto`);
  try {
    await stubSaveDialog(app, projectPath);
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('menu:command', { kind: 'save-project' });
    });
    await expect(page.locator('[data-testid="toast-success"]').filter({ hasText: 'Project Saved' }))
      .toBeVisible({ timeout: 120_000 });

    // Another machine: no octree cache. The shared octree must come back from
    // the file under the SAME id, or the children have nothing to draw.
    const octreeDirs = () => readdirSync(session.octreeCacheRoot).filter((n) => /^[0-9a-f]{40}$/.test(n));
    for (const d of octreeDirs()) rmSync(join(session.octreeCacheRoot, d), { recursive: true, force: true });

    // File → New first: it frees the saved sessions, as a backend restart
    // would, so the reopened children can only find their parent's column
    // under the parent's NEW session id.
    await resetToFreshScene(app, page);
    await stubMessageBox(app, 0);
    await stubOpenDialog(app, projectPath);
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('menu:command', { kind: 'open-project' });
    });
    await expect(page.locator('[data-testid="toast-success"]').filter({ hasText: 'Project Opened' }))
      .toBeVisible({ timeout: 120_000 });

    await expect(row(page, 'ground_plants (ground)')).toHaveCount(1, { timeout: 30_000 });
    await expectDrawnFromParent(page, parentCacheId,
      row(page, 'ground_plants (ground)'), row(page, 'ground_plants (non-ground)'));
    // ...and still are a moment later: a lookup that failed would have rebuilt
    // each child its own octree by now.
    await page.waitForTimeout(3_000);
    await expect(row(page, 'ground_plants (ground)')).toHaveAttribute('data-octree-cache-id', parentCacheId);
    await expect(row(page, 'ground_plants (non-ground)')).toHaveAttribute('data-octree-cache-id', parentCacheId);
  } finally {
    rmSync(projectPath, { force: true });
  }
});

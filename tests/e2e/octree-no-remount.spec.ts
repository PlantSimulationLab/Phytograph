import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';

// Regression: splitting a segmented cloud into one child per instance made every
// child cloud REMOUNT right after it appeared.
//
// The cure for a potree-core material bug (a cloud that mounts before its
// material effect runs paints with potree's default elevation gradient) used to
// be delivered as a remount: the viewer bumped a per-cacheId "paint generation"
// when a cloud's first tiles painted, and that generation fed the octree
// component's React key. One cloud, one ~10ms remount — invisible. But a
// per-tree split adds many clouds at once, each painting its first tiles at a
// different moment, so each remount landed separately. A remount unregisters the
// octree from the shared per-frame driver, disposes it, and re-streams its
// nodes, so the user watched trees appear and disappear in no particular order
// before the scene finally settled. Measured on a real 3.6M-point orchard block
// (example-datasets/Mission1_1_crop.las, 109 trees): 112 of 112 octrees
// remounted, clouds flickering across ~1.4s. After the fix: 0 remounts.
//
// The fix moved the cure inside OctreePointCloud, which now rebuilds its
// material IN PLACE when its own tiles first paint — the cloud never leaves the
// scene. This spec pins the property that actually matters to the user: each
// octree is loaded into the scene EXACTLY ONCE.
//
// Uses the committed multi_tree fixture (a voxel-downsampled excerpt of TreeIso's
// MIT demo plot) rather than the 72MB dataset, so it runs in seconds; the
// mechanism is per-cloud and does not depend on the tree count.
const FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'multi_tree.xyz');

let session: LaunchedApp;
test.beforeAll(async () => {
  session = await launchApp();
});
test.afterAll(async () => {
  await session?.close();
});

test('per-tree split loads each octree exactly once (no remount flicker)', async () => {
  const { app, page } = session;

  await importFiles(app, page, 'import-point-cloud', FIXTURE);
  await completeImportWizard(page);

  const cloudRow = page.locator('[data-testid="scan-row"][data-scan-name="multi_tree"]');
  await expect(cloudRow).toBeVisible({ timeout: 20_000 });
  await expect(cloudRow).toHaveAttribute('data-selected', 'true');

  await page.getByTestId('tool-tree-segment').click();
  await expect(page.getByTestId('tree-segment-panel')).toBeVisible();
  await page.getByTestId('tree-split-clouds').check();
  await page.getByTestId('tree-segment-run-button').click();

  // Parent recoloured, then one child cloud per tree.
  await expect(page.getByTestId('scalar-overlay'))
    .toHaveAttribute('data-active-scalar', 'tree_instance', { timeout: 120_000 });

  const childRows = page.locator('[data-testid="scan-row"][data-scan-name*="(tree "]');
  await expect(async () => {
    expect(await childRows.count()).toBeGreaterThan(1);
  }).toPass({ timeout: 120_000 });
  const childCount = await childRows.count();

  // Let every child finish streaming its first tiles — that is precisely when
  // the old code fired its remount, so the assertion below would be vacuous if
  // it ran before the clouds had painted.
  await expect(async () => {
    const counts = await page.evaluate(
      () => (window as any).__octreeLoadCounts as Record<string, number> | undefined,
    );
    // parent + children have all loaded at least once
    expect(Object.keys(counts ?? {}).length).toBeGreaterThanOrEqual(childCount + 1);
  }).toPass({ timeout: 120_000 });
  await page.waitForTimeout(3_000);

  const counts = await page.evaluate(
    () => (window as any).__octreeLoadCounts as Record<string, number> | undefined,
  );
  const loaded = Object.entries(counts ?? {});
  expect(loaded.length).toBeGreaterThanOrEqual(childCount + 1);

  // The assertion: nothing was loaded twice. Before the fix every one of these
  // was 2 (mount, then the first-paint remount).
  const remounted = loaded.filter(([, n]) => n > 1);
  expect(
    remounted,
    `these octrees were loaded more than once (remount flicker): ${remounted.map(([id, n]) => `${id.slice(0, 8)}=${n}`).join(', ')}`,
  ).toEqual([]);
});

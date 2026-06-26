import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { launchApp, repoRoot } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';

const FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'multi_tree.xyz');

// multi_tree.xyz is a voxel-downsampled excerpt of TreeIso's MIT demo plot
// (plain "x y z" rows) — a handful of distinct trees standing apart. TreeIso
// (cut-pursuit) segments it into multiple individual trees. Imports become
// octree-backed, so this drives the real `/api/segment/trees/apply` path:
// import → select → open Tree Segmentation → run → assert the cloud is
// re-coloured by the discrete `tree_instance` attribute (no legend is shown for
// tree instances — see below), exercising the live backend end-to-end (no mocks).
const EXPECTED_POINTS = readFileSync(FIXTURE, 'utf8')
  .split('\n')
  .filter((l) => l.trim().length > 0).length;

test('segments individual trees and colours by the tree_instance attribute', async () => {
  const { app, page, close } = await launchApp();

  try {
    await importFiles(app, page, 'import-point-cloud', FIXTURE);
    await completeImportWizard(page);

    const cloudRow = page.locator('[data-testid="scan-row"][data-scan-name="multi_tree.xyz"]');
    await expect(cloudRow).toBeVisible({ timeout: 20_000 });
    expect(parseInt((await cloudRow.getAttribute('data-point-count')) ?? '0', 10)).toBe(EXPECTED_POINTS);

    // Freshly imported scan is auto-selected (no re-click — that would toggle off).
    await expect(cloudRow).toHaveAttribute('data-selected', 'true');

    // Open the Tree Segmentation panel via its toolbar button.
    await page.getByTestId('tool-tree-segment').click();
    await expect(page.getByTestId('tree-segment-panel')).toBeVisible();

    // Run TreeIso. The backend re-converts the octree carrying tree_instance.
    await page.getByTestId('tree-segment-run-button').click();

    // The cloud becomes coloured by the tree_instance scalar — proof the
    // segmentation ran and its labels drive colour. We read the active scalar
    // from the always-present overlay container rather than the legend, because
    // tree_instance deliberately shows NO legend (one entry per tree would fill
    // the viewport; the ids are arbitrary nominal labels).
    const overlay = page.getByTestId('scalar-overlay');
    await expect(overlay).toHaveAttribute('data-active-scalar', 'tree_instance', { timeout: 120_000 });

    // And the per-tree legend is suppressed for tree_instance (the regression
    // this asserts: no full-height Tree 1…Tree N list, no colorbar).
    await expect(page.getByTestId('class-legend')).toHaveCount(0);
    await expect(page.getByTestId('colorbar')).toHaveCount(0);
  } finally {
    await close();
  }
});

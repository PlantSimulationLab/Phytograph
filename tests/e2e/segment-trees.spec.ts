import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { launchApp, repoRoot } from './helpers/launchApp';

const FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'multi_tree.xyz');

// multi_tree.xyz is a voxel-downsampled excerpt of TreeIso's MIT demo plot
// (plain "x y z" rows) — a handful of distinct trees standing apart. TreeIso
// (cut-pursuit) segments it into multiple individual trees. Imports become
// octree-backed, so this drives the real `/api/segment/trees/apply` path:
// import → select → open Tree Segmentation → run → assert the cloud is
// re-coloured by the discrete `tree_instance` attribute (legend shows per-tree
// classes), exercising the live backend end-to-end (no mocks).
const EXPECTED_POINTS = readFileSync(FIXTURE, 'utf8')
  .split('\n')
  .filter((l) => l.trim().length > 0).length;

test('segments individual trees and colours by the tree_instance attribute', async () => {
  const { page, close } = await launchApp();

  try {
    await page.getByTestId('import-menu-button').click();
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByTestId('import-menu-pointcloud').click(),
    ]);
    await chooser.setFiles(FIXTURE);

    const cloudRow = page.locator('[data-testid="scan-row"][data-scan-name="multi_tree.xyz"]');
    await expect(cloudRow).toBeVisible({ timeout: 20_000 });
    expect(parseInt((await cloudRow.getAttribute('data-point-count')) ?? '0', 10)).toBe(EXPECTED_POINTS);

    await cloudRow.click();
    await expect(cloudRow).toHaveAttribute('data-selected', 'true');

    // Open the Tree Segmentation panel via its toolbar button.
    await page.getByTestId('tool-tree-segment').click();
    await expect(page.getByTestId('tree-segment-panel')).toBeVisible();

    // Run TreeIso. The backend re-converts the octree carrying tree_instance.
    await page.getByTestId('tree-segment-run-button').click();

    // Once tree_instance is the active scalar, the discrete class legend appears
    // — proof the cloud is coloured per-tree (categorical), not by a gradient.
    const legend = page.getByTestId('class-legend');
    await expect(legend).toBeVisible({ timeout: 120_000 });
    await expect(legend).toHaveAttribute('data-legend-attribute', 'tree_instance');
    // At least two distinct trees were found and labelled.
    await expect(legend.getByText('Tree 1', { exact: true })).toBeVisible();
    await expect(legend.getByText('Tree 2', { exact: true })).toBeVisible();
  } finally {
    await close();
  }
});

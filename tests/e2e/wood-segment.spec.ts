import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';

const FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tree_wood_leaf.xyz');
const FIXTURE2 = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tree_wood_leaf2.xyz');

// tree_wood_leaf.xyz is a synthetic woody plant: a vertical trunk + two angled
// branches (1380 compact "wood" points) and 11 scattered leaf blobs (2860
// "leaf" points), shuffled in z. The geometric classifier separates these
// cleanly (~0.90 accuracy). The 4th column is a ground-truth label, irrelevant
// to the workflow — segmentation computes its own `wood_class`.
//
// Drives the real DOM against the live backend: import (→ octree) → select →
// open the Wood/Leaf panel → run → assert the cloud is re-coloured by the
// discrete `wood_class` attribute, and that the Split and Remove-wood output
// modes produce the expected child cloud / reduced point count.

test('segments wood vs leaf and colours by the wood_class attribute', async () => {
  const { app, page, close } = await launchApp();

  try {
    await importFiles(app, page, 'import-point-cloud', FIXTURE);
    await completeImportWizard(page);

    const cloudRow = page.locator('[data-testid="scan-row"][data-scan-name="tree_wood_leaf.xyz"]');
    await expect(cloudRow).toBeVisible({ timeout: 20_000 });
    expect(parseInt((await cloudRow.getAttribute('data-point-count')) ?? '0', 10)).toBe(4240);
    await expect(cloudRow).toHaveAttribute('data-selected', 'true');

    // Open the Wood/Leaf panel via its toolbar button.
    await page.getByTestId('tool-wood-segment').click();
    const panel = page.getByTestId('wood-segment-panel');
    await expect(panel).toBeVisible();

    // Split mode: also emit wood-only + leaf-only child clouds.
    await page.getByTestId('wood-mode').selectOption('split');
    await page.getByTestId('wood-segment-run-button').click();

    // The discrete class legend proves the cloud is coloured categorically by
    // wood_class (wood vs leaf), not a continuous gradient or solid colour.
    const legend = page.getByTestId('class-legend');
    await expect(legend).toBeVisible({ timeout: 60_000 });
    await expect(legend).toHaveAttribute('data-legend-attribute', 'wood_class');
    await expect(legend.getByText('Wood', { exact: true })).toBeVisible();
    await expect(legend.getByText('Leaf', { exact: true })).toBeVisible();

    // Split produced two child clouds. Their point counts should partition the
    // original (wood + leaf = 4240) with wood the minority — concrete output,
    // not "didn't error". Bounds allow for the classifier's real error rate.
    const woodRow = page.locator('[data-testid="scan-row"][data-scan-name="tree_wood_leaf.xyz (wood)"]');
    const leafRow = page.locator('[data-testid="scan-row"][data-scan-name="tree_wood_leaf.xyz (leaf)"]');
    await expect(woodRow).toBeVisible({ timeout: 60_000 });
    await expect(leafRow).toBeVisible({ timeout: 60_000 });
    const woodN = parseInt((await woodRow.getAttribute('data-point-count')) ?? '0', 10);
    const leafN = parseInt((await leafRow.getAttribute('data-point-count')) ?? '0', 10);
    expect(woodN + leafN).toBe(4240);
    // ~33% of points are wood; the classifier predicts a similar minority.
    expect(woodN).toBeGreaterThan(700);
    expect(woodN).toBeLessThan(2000);
    expect(leafN).toBeGreaterThan(woodN);
  } finally {
    await close();
  }
});

test('removes wood, leaving a leaf-only cloud', async () => {
  const { app, page, close } = await launchApp();

  try {
    await importFiles(app, page, 'import-point-cloud', FIXTURE);
    await completeImportWizard(page);

    const cloudRow = page.locator('[data-testid="scan-row"][data-scan-name="tree_wood_leaf.xyz"]');
    await expect(cloudRow).toBeVisible({ timeout: 20_000 });
    await expect(cloudRow).toHaveAttribute('data-selected', 'true');
    expect(parseInt((await cloudRow.getAttribute('data-point-count')) ?? '0', 10)).toBe(4240);

    await page.getByTestId('tool-wood-segment').click();
    await page.getByTestId('wood-mode').selectOption('remove');
    await page.getByTestId('wood-segment-run-button').click();

    // Remove-wood replaces the cloud in place with just the leaf points: the
    // same row's point count drops to the leaf count (~2860, minus a few wood
    // points that bleed into leaf). Wood is the majority removed → a clear drop.
    await expect(async () => {
      const n = parseInt((await cloudRow.getAttribute('data-point-count')) ?? '0', 10);
      expect(n).toBeGreaterThan(2200);   // kept the leaves
      expect(n).toBeLessThan(3600);      // dropped the wood
    }).toPass({ timeout: 60_000 });
  } finally {
    await close();
  }
});

test('segments two selected scans together and labels both', async () => {
  const { app, page, close } = await launchApp();

  try {
    // Import two distinct tree scans at once.
    await importFiles(app, page, 'import-point-cloud', [FIXTURE, FIXTURE2]);
    await completeImportWizard(page);

    const row1 = page.locator('[data-testid="scan-row"][data-scan-name="tree_wood_leaf.xyz"]');
    const row2 = page.locator('[data-testid="scan-row"][data-scan-name="tree_wood_leaf2.xyz"]');
    await expect(row1).toBeVisible({ timeout: 20_000 });
    await expect(row2).toBeVisible({ timeout: 20_000 });

    // Select both: click the first, then meta-click the second to add it.
    await row1.click();
    await row2.click({ modifiers: ['Meta'] });
    await expect(row1).toHaveAttribute('data-selected', 'true');
    await expect(row2).toHaveAttribute('data-selected', 'true');

    // Open the panel; with >1 scan selected the multi-mode chooser appears.
    await page.getByTestId('tool-wood-segment').click();
    await expect(page.getByTestId('wood-segment-panel')).toBeVisible();
    const multi = page.getByTestId('wood-multi-mode');
    await expect(multi).toBeVisible();
    await page.getByTestId('wood-mode-aggregate').check();

    await page.getByTestId('wood-segment-run-button').click();

    // Both scans should be labelled by wood_class (the discrete legend appears,
    // and neither scan was deleted — aggregate writes labels back in place).
    const legend = page.getByTestId('class-legend');
    await expect(legend).toBeVisible({ timeout: 60_000 });
    await expect(legend).toHaveAttribute('data-legend-attribute', 'wood_class');
    await expect(legend.getByText('Wood', { exact: true })).toBeVisible();
    await expect(legend.getByText('Leaf', { exact: true })).toBeVisible();
    // Both original scans survive with their original point counts (labelled,
    // not split or removed).
    expect(parseInt((await row1.getAttribute('data-point-count')) ?? '0', 10)).toBe(4240);
    expect(parseInt((await row2.getAttribute('data-point-count')) ?? '0', 10)).toBe(3360);
  } finally {
    await close();
  }
});

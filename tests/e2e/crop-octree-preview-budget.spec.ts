import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';

const TINY = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tiny.xyz');

// Mirror of the constants in src/renderer/lib/displayPointBudget.ts.
const DEFAULT_POINT_BUDGET = 2_000_000;
// The preview budget is a FRACTION of the display budget (1/4), floored at
// MIN_DISPLAY_POINT_BUDGET. At the default 2M that is 500k — deliberately NOT
// the old flat 150k, which sat below the 250k floor and made Box mode's
// preview "almost non-viewable" on a large cloud.
const MIN_DISPLAY_POINT_BUDGET = 250_000;
const CROP_PREVIEW_POINT_BUDGET = 500_000;

// Regression: a partial crop ("keep inside" with a moderate box) on a large
// octree cloud pegged the GPU during the live preview — potree clips with a
// fragment `discard` that disables early-Z, so occluded points still run the
// shader and overdraw dominates the frame. The fix lowers the octree point
// budget while a crop box is being previewed (far fewer points ⇒ far fewer
// fragment invocations), restoring it on exit. Apply re-converts at full res,
// so the saved result is unaffected.
//
// This asserts the budget LIFECYCLE (the load-bearing perf guard): it engages
// when crop opens and restores when it closes. Per CLAUDE.md: live backend,
// real import + real crop UI, concrete state asserted.
test('crop preview lowers the octree point budget and restores it on exit', async () => {
  const { app, page, close } = await launchApp();

  try {
    await importFiles(app, page, 'import-auto', TINY);
    await completeImportWizard(page);

    const row = page.locator('[data-testid="scan-row"]').first();
    await expect(row).toBeVisible({ timeout: 60_000 });
    await expect(row).toHaveAttribute('data-octree', 'true');
    await expect(row).toHaveAttribute('data-selected', 'true');

    const budget = () => page.evaluate(() => (window as { __pointBudget?: number }).__pointBudget);

    // Before crop: full budget.
    await expect.poll(budget, { timeout: 10_000 }).toBe(DEFAULT_POINT_BUDGET);

    // Open crop → preview budget engages. Box is the default shape, and it is
    // the only one that uses a clip volume, so this is the reduced path.
    await page.getByTestId('tool-crop').click();
    await expect(page.getByTestId('crop-panel')).toBeVisible();
    await expect(page.getByTestId('crop-panel')).toHaveAttribute('data-crop-mode', 'box');
    await expect.poll(budget, { timeout: 10_000 }).toBe(CROP_PREVIEW_POINT_BUDGET);

    // It is a real reduction, but it must stay ABOVE the floor below which the
    // app's own docs say a large cloud degrades to scattered dots. Both halves
    // matter: the guard has to bite, and it has to leave something viewable.
    const previewBudget = await budget();
    expect(previewBudget).toBeLessThan(DEFAULT_POINT_BUDGET);
    expect(previewBudget).toBeGreaterThanOrEqual(MIN_DISPLAY_POINT_BUDGET);

    // Rect and Polygon reject points with an index buffer — no clip volume, no
    // fragment `discard`, no overdraw to guard against — so they preview at the
    // FULL budget. This is the asymmetry the user sees between the sub-tools,
    // and it is deliberate; charging them the reduced budget was a past bug
    // that looked like the crop having deleted most of the cloud.
    await page.getByTestId('crop-shape-rect').click();
    await expect(page.getByTestId('crop-panel')).toHaveAttribute('data-crop-mode', 'rect');
    await expect.poll(budget, { timeout: 10_000 }).toBe(DEFAULT_POINT_BUDGET);

    await page.getByTestId('crop-shape-polygon').click();
    await expect(page.getByTestId('crop-panel')).toHaveAttribute('data-crop-mode', 'polygon');
    await expect.poll(budget, { timeout: 10_000 }).toBe(DEFAULT_POINT_BUDGET);

    // Back to Box → reduced again.
    await page.getByTestId('crop-shape-box').click();
    await expect.poll(budget, { timeout: 10_000 }).toBe(CROP_PREVIEW_POINT_BUDGET);

    // Close crop (toggling the tool exits crop mode) → full budget restored.
    await page.getByTestId('tool-crop').click();
    await expect(page.getByTestId('crop-panel')).toBeHidden();
    await expect.poll(budget, { timeout: 10_000 }).toBe(DEFAULT_POINT_BUDGET);
  } finally {
    await close();
  }
});

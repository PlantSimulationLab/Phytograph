import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';

const TINY = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tiny.xyz');

// Mirror of the constants in src/renderer/components/viewer/potreeManager.ts.
const DEFAULT_POINT_BUDGET = 2_000_000;
const CROP_PREVIEW_POINT_BUDGET = 150_000;

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

    // Open crop → preview budget engages.
    await page.getByTestId('tool-crop').click();
    await expect(page.getByTestId('crop-panel')).toBeVisible();
    await expect.poll(budget, { timeout: 10_000 }).toBe(CROP_PREVIEW_POINT_BUDGET);

    // Close crop (toggling the tool exits crop mode) → full budget restored.
    await page.getByTestId('tool-crop').click();
    await expect(page.getByTestId('crop-panel')).toBeHidden();
    await expect.poll(budget, { timeout: 10_000 }).toBe(DEFAULT_POINT_BUDGET);
  } finally {
    await close();
  }
});

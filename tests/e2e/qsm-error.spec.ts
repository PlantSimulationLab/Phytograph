import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { completeImportWizard } from './helpers/importWizard';

// sparse.xyz has 30 points — below the QSM 50-point floor — so the live backend
// returns a deterministic build failure. Used to drive the QSM error UI.
const SPARSE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'sparse.xyz');

// A failed single-scan QSM build must show its error inline, and that error must
// NOT linger after the panel is closed and re-opened (a regression the user hit:
// a stale failure message survived a close/re-open even after re-importing).
// Drives the LIVE backend (the 50-point floor is a real backend check).
test('shows a QSM build error and clears it when the panel re-opens', async () => {
  const { page, close } = await launchApp();

  try {
    await expect(page.getByTestId('backend-splash')).toHaveCount(0, { timeout: 60_000 });

    await page.getByTestId('import-menu-button').click();
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByTestId('import-menu-pointcloud').click(),
    ]);
    await chooser.setFiles(SPARSE);
    await completeImportWizard(page);

    const row = page.locator('[data-testid="scan-row"][data-scan-name="sparse.xyz"]');
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row).toHaveAttribute('data-selected', 'true');

    // Build — the backend rejects the 30-point cloud, surfacing an inline error.
    await page.getByTestId('tool-qsm').click();
    await expect(page.getByTestId('qsm-panel')).toBeVisible();
    await page.getByTestId('qsm-build-button').click();

    const err = page.getByTestId('qsm-error');
    await expect(err).toBeVisible({ timeout: 60_000 });
    await expect(err).toContainText('50 points');
    // No QSM was produced.
    await expect(page.getByTestId('qsm-row')).toHaveCount(0);

    // Close the panel, then re-open it: the stale error must be gone.
    await page.getByTestId('tool-qsm').click();          // toggles panel closed
    await expect(page.getByTestId('qsm-panel')).toBeHidden();
    await page.getByTestId('tool-qsm').click();          // re-open
    await expect(page.getByTestId('qsm-panel')).toBeVisible();
    await expect(page.getByTestId('qsm-error')).toHaveCount(0);
  } finally {
    await close();
  }
});

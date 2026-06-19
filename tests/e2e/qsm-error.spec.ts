import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';

// sparse.xyz has 30 points — below the QSM 50-point floor — so the live backend
// returns a deterministic build failure. Used to drive the QSM error UI.
const SPARSE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'sparse.xyz');

// A failed single-scan QSM build must surface an error, and that error must NOT
// linger inside the modal after it's re-opened (a regression the user hit: a
// stale failure message survived a close/re-open even after re-importing).
// Drives the LIVE backend (the 50-point floor is a real backend check).
test('shows a QSM build error and clears it when the modal re-opens', async () => {
  const { app, page, close } = await launchApp();

  try {
    await expect(page.getByTestId('backend-splash')).toHaveCount(0, { timeout: 60_000 });

    await importFiles(app, page, 'import-point-cloud', SPARSE);
    await completeImportWizard(page);

    const row = page.locator('[data-testid="scan-row"][data-scan-name="sparse.xyz"]');
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row).toHaveAttribute('data-selected', 'true');

    // Open the modal (scan pre-checked) and build — the backend rejects the
    // 30-point cloud. The modal closes on start and the failure surfaces as an
    // error toast.
    await page.getByTestId('tool-qsm').click();
    await expect(page.getByTestId('qsm-panel')).toBeVisible();
    await page.getByTestId('qsm-build-button').click();
    await expect(page.getByTestId('qsm-panel')).toBeHidden();

    const errToast = page.locator('[data-testid="toast-error"]').last();
    await expect(errToast.getByTestId('toast-title')).toContainText(/QSM build failed/i, { timeout: 60_000 });
    // No QSM was produced.
    await expect(page.getByTestId('qsm-row')).toHaveCount(0);

    // Re-open the modal: it stores the last error (qsmError), but the open-effect
    // clears it, so no stale failure message is shown inline.
    await page.getByTestId('tool-qsm').click();
    await expect(page.getByTestId('qsm-panel')).toBeVisible();
    await expect(page.getByTestId('qsm-error')).toHaveCount(0);
  } finally {
    await close();
  }
});

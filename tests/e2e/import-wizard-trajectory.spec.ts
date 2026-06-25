import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { stubOpenDialog } from './helpers/stubOpenDialog';
import { completeImportWizard } from './helpers/importWizard';

const FIXTURES = join(repoRoot, 'tests', 'e2e', 'fixtures');

// The import wizard lets the user attach a mobile-platform trajectory file while
// importing point-cloud data, so an MLS/drone scan becomes a moving-platform
// acquisition without a second trip through the Scan Parameters popup. This drives
// the real DOM: import a cloud, attach a text trajectory via the wizard's file
// picker (parsed in the renderer), import, then re-open the scan and assert the
// PoseStream rode through onto the scan's parameters.
test('attaches a trajectory file to an imported cloud through the wizard', async () => {
  const { app, page, close } = await launchApp();
  try {
    const cloud = join(FIXTURES, 'lad-leafcube-moving', 'leafcube_moving.xyz');
    const trajectory = join(FIXTURES, 'lad-leafcube-moving', 'trajectory.csv');

    // Wait out the backend-starting splash (z-100 overlay) so it can't intercept
    // clicks on the wizard underneath.
    await expect(page.getByTestId('backend-splash')).toHaveCount(0, { timeout: 60_000 });

    // Import the point cloud — the wizard intercepts every path-backed import.
    await importFiles(app, page, 'import-point-cloud', cloud);
    const wizard = page.getByTestId('import-wizard');
    await expect(wizard).toBeVisible({ timeout: 30_000 });

    // The optional trajectory section offers an import button for static-by-default
    // scans.
    const trajSection = page.getByTestId('import-wizard-trajectory');
    await expect(trajSection).toBeVisible();
    const importTrajBtn = page.getByTestId('import-wizard-trajectory-import');
    await expect(importTrajBtn).toBeVisible();

    // Re-point the open dialog at the CSV trajectory (importFiles consumed the
    // first prompt), then attach it. The two-pose fixture proves the renderer
    // parsed the file end-to-end (no backend needed for a text trajectory).
    await stubOpenDialog(app, trajectory);
    await importTrajBtn.click();
    const trajLabel = page.getByTestId('import-wizard-trajectory-label');
    await expect(trajLabel).toBeVisible({ timeout: 15_000 });
    await expect(trajLabel).toHaveText(/trajectory\.csv/);
    await expect(trajSection).toContainText('2 poses');

    // Finish the import.
    await completeImportWizard(page);

    const row = page.locator('[data-testid="scan-row"][data-scan-name="leafcube_moving.xyz"]');
    await expect(row).toBeVisible({ timeout: 30_000 });
    const scanId = await row.getAttribute('data-scan-id');

    // Re-open the scan's parameters — the trajectory should be attached, proving
    // the wizard's choice rode through onto the Scan's params (the moving-platform
    // flag the LAD inversion keys on).
    await page.getByTestId(`scan-edit-${scanId}`).click();
    const popup = page.getByTestId('scan-parameters-popup');
    await expect(popup).toBeVisible();
    const scanTrajLabel = page.getByTestId('scan-trajectory-label');
    await expect(scanTrajLabel).toBeVisible({ timeout: 15_000 });
    await expect(scanTrajLabel).toHaveText(/trajectory\.csv/);
    await expect(popup).toContainText('2 poses');
  } finally {
    await close();
  }
});

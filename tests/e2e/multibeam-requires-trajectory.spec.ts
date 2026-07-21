import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { stubOpenDialog } from './helpers/stubOpenDialog';

// A spinning-multibeam sensor rotates continuously, so it only makes sense as a
// moving-platform scan — there is no coherent stationary "free-spinning" capture
// without a time element. The Add Scan popup must therefore require a trajectory
// for a multibeam scan: block submit + explain, until a trajectory is imported.
test('spinning-multibeam scan requires a trajectory before it can be added', async () => {
  const { app, page, close } = await launchApp();

  try {
    await page.getByTestId('tool-add-scan').click();
    const popup = page.getByTestId('scan-parameters-popup');
    await expect(popup).toBeVisible();

    // Pick the Velodyne (a spinning-multibeam instrument). Origin fields exist, no
    // trajectory yet.
    await page.getByTestId('scan-model-select').selectOption('velodyne_hdl32e');

    // Multibeam with no trajectory: submit is blocked and the popup explains why.
    await expect(page.getByTestId('scan-multibeam-needs-trajectory')).toBeVisible();
    await expect(page.getByTestId('scan-submit')).toBeDisabled();

    // The azimuth min/max sweep fields are NOT shown for a spinning sensor (it
    // rotates a full 360° per revolution; azimuth is a resolution, not a range).
    await expect(page.getByTestId('scan-azimuth-min')).toHaveCount(0);
    await expect(page.getByTestId('scan-azimuth-max')).toHaveCount(0);

    // Import a trajectory → the requirement is satisfied, submit becomes enabled.
    const traj = join(repoRoot, 'tests', 'e2e', 'fixtures', 'drone_pass_trajectory.csv');
    await stubOpenDialog(app, traj);
    await page.getByTestId('scan-trajectory-import').click();
    await expect(page.getByTestId('scan-trajectory-label')).toBeVisible();
    await expect(page.getByTestId('scan-multibeam-needs-trajectory')).toHaveCount(0);
    await expect(page.getByTestId('scan-submit')).toBeEnabled();

    // And it actually adds the (moving multibeam) scan.
    await page.getByTestId('scan-submit').click();
    await expect(popup).not.toBeVisible();
    const row = page.locator('[data-testid="scan-row"]').first();
    await expect(row).toHaveAttribute('data-moving', 'true');
  } finally {
    await close();
  }
});

import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { stubOpenDialog } from './helpers/stubOpenDialog';
import { completeImportWizard } from './helpers/importWizard';

// End-to-end MOVING-PLATFORM leaf area density through the Phytograph UI against
// the live backend. The committed leafcube-moving fixture is a synthetic scan of
// the LAI=2 spherical leaf cube taken while the platform translates ~2 m along
// +x at z=5 (true per-voxel LAD=2.0 m²/m³, G(theta)=0.5). Each return carries its
// own per-pulse timestamp; the trajectory CSV supplies the platform path.
//
// The flow exercises the whole moving-platform pipeline through the real UI:
//   1. import the scan (data + params) from XML,
//   2. attach the trajectory file via the Add Scan popup's trajectory import,
//   3. run LAD — the backend joins each return to the trajectory, reconstructs a
//      per-beam origin, and runs the beam-based (Gtheta) inversion (no
//      triangulation),
// then asserts the recovered LAD reads near the true 2.0 m²/m³ in the UI.
test('Computes moving-platform leaf area density from a trajectory + scan', async () => {
  const { app, page, close } = await launchApp();

  try {
    const dir = join(repoRoot, 'tests', 'e2e', 'fixtures', 'lad-leafcube-moving');
    const xmlFixture = join(dir, 'leafcube_moving.xml');
    const trajFixture = join(dir, 'trajectory.csv');
    // Two sequential file dialogs: first the scan XML, then the trajectory CSV.
    await stubOpenDialog(app, [xmlFixture, trajFixture]);

    // --- Import the scan from XML (data + per-scan params) ------------------
    await page.getByTestId('tool-add-scan').click();
    const popup = page.getByTestId('scan-parameters-popup');
    await expect(popup).toBeVisible();
    await page.getByTestId('scan-import-xml').click();
    await expect(popup).not.toBeVisible({ timeout: 20_000 });
    await completeImportWizard(page);

    const scansPanel = page.getByTestId('scans-panel');
    const scanRows = scansPanel.locator('[data-testid="scan-row"]');
    await expect(scanRows).toHaveCount(1, { timeout: 40_000 });
    await expect(scanRows.nth(0)).toHaveAttribute('data-has-data', 'true');
    await expect(scanRows.nth(0)).toHaveAttribute('data-has-params', 'true');
    const scanId = await scanRows.nth(0).getAttribute('data-scan-id');

    // --- Attach the trajectory: edit the scan, import the CSV --------------
    await page.getByTestId(`scan-edit-${scanId}`).click();
    await expect(popup).toBeVisible();
    await page.getByTestId('scan-trajectory-import').click();
    // The trajectory summary appears once parsed (2 poses) — proves the file was
    // read and parsed, not just that a dialog opened.
    await expect(page.getByTestId('scan-trajectory-label')).toBeVisible();
    await page.getByTestId('scan-submit').click();
    await expect(popup).not.toBeVisible();

    // --- Build the required voxel grid (1×1×1 m box raised to z=0.5) --------
    await page.getByTestId('tool-create-voxel').click();
    const posZ = page.getByTestId('mesh-pos-z');
    await expect(posZ).toBeVisible();
    await posZ.fill('0.5');
    await posZ.press('Enter');

    // Refocus the scan (creating the box left a mixed selection).
    await scanRows.nth(0).getByTestId('scan-row-name').click();
    await expect(scanRows.nth(0)).toHaveAttribute('data-selected', 'true');

    // --- Run LAD -----------------------------------------------------------
    await page.getByTestId('tool-compute-lad').click();
    const ladPopup = page.getByTestId('lad-popup');
    await expect(ladPopup).toBeVisible();

    // The G(theta) field is shown ONLY because the selected scan is moving —
    // its presence proves the UI recognized the trajectory and will take the
    // beam-based path. Pin it to the spherical 0.5 for the uniform cube.
    await expect(page.getByTestId('lad-gtheta-section')).toBeVisible();
    await page.getByTestId('lad-preset-spherical').click();
    await expect(page.getByTestId('lad-input-gtheta')).toHaveValue('0.5');

    await page.getByTestId('lad-input-min-hits').fill('1');
    await page.getByTestId('lad-preset-broadleaf').click();

    await page.getByTestId('lad-compute-button').click();

    const ladRow = page.getByTestId('lad-row').first();
    await expect(ladRow).toBeVisible({ timeout: 120_000 });

    const voxelCount = parseInt((await ladRow.getAttribute('data-voxel-count'))!, 10);
    expect(voxelCount).toBeGreaterThanOrEqual(1);

    // The per-voxel LAD should land near the true 2.0 m²/m³. A wide band accounts
    // for the coarse committed raster + finite-beam sampling.
    const ladMax = parseFloat((await ladRow.getAttribute('data-lad-max'))!);
    expect(ladMax).toBeGreaterThan(1.4);
    expect(ladMax).toBeLessThan(2.7);

    const colorbar = page.getByTestId('lad-colorbar');
    await expect(colorbar).toBeVisible();
    await expect(colorbar).toHaveAttribute('data-colorbar-label', /LAD/);
  } finally {
    await close();
  }
});

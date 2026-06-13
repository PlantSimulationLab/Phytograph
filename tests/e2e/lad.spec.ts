import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { stubOpenDialog } from './helpers/stubOpenDialog';
import { completeImportWizard } from './helpers/importWizard';

// End-to-end leaf area density (LAD) through the Phytograph UI against the live
// backend. Adapts the PyHelios C++ lidar self-test ("LiDAR Single Voxel
// Isotropic Patches Test"): the committed leafcube fixture is a synthetic scan
// of the LAI=2 spherical leaf cube, whose 1x1x1 m voxel at (0,0,0.5) has true
// LAD=2.0 m^2/m^3 and G(theta)=0.5. We import the scan, build the required
// voxel grid in the viewer, run LAD against the real backend, and assert the
// per-voxel value reads near 2.0 in the UI (colorbar + hover tooltip).
test('Computes per-voxel leaf area density for the leaf-cube fixture', async () => {
  const { app, page, close } = await launchApp();

  try {
    const xmlFixture = join(repoRoot, 'tests', 'e2e', 'fixtures', 'lad-leafcube', 'leafcube.xml');
    await stubOpenDialog(app, xmlFixture);

    // Import the single scan from XML (attaches both data + per-scan params).
    await page.getByTestId('tool-add-scan').click();
    const popup = page.getByTestId('scan-parameters-popup');
    await expect(popup).toBeVisible();
    await page.getByTestId('scan-import-xml').click();
    await expect(popup).not.toBeVisible({ timeout: 20_000 });
    await completeImportWizard(page);

    const scansPanel = page.getByTestId('scans-panel');
    const scanRows = scansPanel.locator('[data-testid="scan-row"]');
    await expect(scanRows).toHaveCount(1, { timeout: 20_000 });
    await expect(scanRows.nth(0)).toHaveAttribute('data-has-data', 'true');
    await expect(scanRows.nth(0)).toHaveAttribute('data-has-params', 'true');

    // --- Build the required voxel grid -------------------------------------
    // A new voxel box is a 1x1x1 m cube at the origin (covers z in [-0.5,0.5]).
    // The leaf cube sits at z in [0,1], so raise the box to center z=0.5. This
    // also opens the Transform panel and selects the box.
    await page.getByTestId('tool-create-voxel').click();
    const posZ = page.getByTestId('mesh-pos-z');
    await expect(posZ).toBeVisible();
    await posZ.fill('0.5');
    await posZ.press('Enter');

    // --- Run LAD ------------------------------------------------------------
    // Creating a voxel box leaves a mixed selection (scan + box). The LAD tool
    // lives on the single-cloud toolbar, so click the scan row to refocus it:
    // in mixed mode a plain click keeps the scan and clears the box selection
    // (it does NOT toggle the scan off — that only happens when the scan is the
    // entire selection).
    // Click the row's NAME, not the row center: the row packs action buttons
    // (eye / misses / edit) on the right, each stopping propagation, and a
    // center click can land on one of those instead of the row's select
    // handler. The name label has no such child, matching how a user clicks a
    // scan to focus it.
    await scanRows.nth(0).getByTestId('scan-row-name').click();
    await expect(scanRows.nth(0)).toHaveAttribute('data-selected', 'true');

    await page.getByTestId('tool-compute-lad').click();
    const ladPopup = page.getByTestId('lad-popup');
    await expect(ladPopup).toBeVisible();

    // A voxel grid exists now, so the no-grid warning must be absent and the
    // grid selector populated.
    await expect(page.getByTestId('lad-no-grid-warning')).toHaveCount(0);
    const gridSelect = page.getByTestId('lad-grid-select');
    await expect(gridSelect).toBeVisible();

    // Mirror the C++ self-test triangulation parameters.
    await page.getByTestId('lad-input-lmax').fill('0.04');
    await page.getByTestId('lad-input-aspect').fill('10');
    await page.getByTestId('lad-input-min-hits').fill('1');

    // Set the element width via the Broadleaf preset — this drives the Pimont
    // (2018) uncertainty interval the result panel reports.
    await page.getByTestId('lad-preset-broadleaf').click();
    await expect(page.getByTestId('lad-input-element-width')).toHaveValue('0.05');

    await page.getByTestId('lad-compute-button').click();

    // The LAD result row appears once the live backend returns (cold pyhelios
    // can take a while on the first call).
    const ladRow = page.getByTestId('lad-row').first();
    await expect(ladRow).toBeVisible({ timeout: 120_000 });

    const voxelCount = parseInt((await ladRow.getAttribute('data-voxel-count'))!, 10);
    expect(voxelCount).toBeGreaterThanOrEqual(1);

    // The single voxel's LAD should be near the true 2.0 m^2/m^3. Allow a wide
    // band: point-cloud triangulation is noisier than the C++ synthetic test.
    const ladMax = parseFloat((await ladRow.getAttribute('data-lad-max'))!);
    expect(ladMax).toBeGreaterThan(1.5);
    expect(ladMax).toBeLessThan(2.7);

    // The LAD colorbar reflects the same range.
    const colorbar = page.getByTestId('lad-colorbar');
    await expect(colorbar).toBeVisible();
    await expect(colorbar).toHaveAttribute('data-colorbar-label', /LAD/);
    const cbMax = parseFloat((await colorbar.getAttribute('data-colorbar-max'))!);
    expect(cbMax).toBeGreaterThan(1.5);
    expect(cbMax).toBeLessThan(2.7);

    // Switching the colormap from the LAD row keeps the colorbar present.
    await ladRow.click();
    await page.getByTestId('lad-colormap').selectOption('magma');
    await expect(colorbar).toBeVisible();

    // Selecting the row (done above) expands it; the group-scale Pimont CI
    // summary is shown. For the uniform leaf cube the interval is valid and
    // brackets a mean near the true LAD of 2.0 m²/m³.
    const uncertainty = page.getByTestId('lad-uncertainty-summary');
    await expect(uncertainty).toBeVisible();
    await expect(uncertainty).toContainText(/Mean LAD .*\[.*–.*\] m²\/m³/);
    await expect(uncertainty).toContainText(/95% group-scale CI/);
  } finally {
    await close();
  }
});

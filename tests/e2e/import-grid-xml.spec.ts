import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { stubOpenDialog } from './helpers/stubOpenDialog';
import { completeImportWizard } from './helpers/importWizard';

// Importing a Helios XML with a top-level <grid> block auto-creates a matching
// voxel-grid mesh ("Grid 1"). The fixture has one resolvable scan plus a grid
// at center (0.25, -0.5, 0.75), size (1.5, 2, 2.5), Nx/Ny/Nz = 2/3/4, rotated
// 30° about z. We drive the real "Import from XML" flow and assert the grid
// mesh lands with that transform and subdivisions — usable directly for LAD.
test('imports a Helios <grid> block as a voxel-grid mesh', async () => {
  const { app, page, close } = await launchApp();

  try {
    const fixture = join(repoRoot, 'tests', 'e2e', 'fixtures', 'sphere-scan', 'sphere-with-grid.xml');
    await stubOpenDialog(app, fixture);

    const scansPanel = page.getByTestId('scans-panel');
    await expect(scansPanel).toBeVisible();

    // Drive the add-scan → import-from-XML flow.
    await page.getByTestId('tool-add-scan').click();
    const popup = page.getByTestId('scan-parameters-popup');
    await expect(popup).toBeVisible();
    await page.getByTestId('scan-import-xml').click();
    await expect(popup).not.toBeVisible({ timeout: 15_000 });

    // One scan goes through the wizard; the grid needs none.
    await completeImportWizard(page);
    await expect(page.getByTestId('scan-import-error')).toHaveCount(0);

    // The scan landed.
    const scanRows = scansPanel.locator('[data-testid="scan-row"]');
    await expect(scanRows).toHaveCount(1, { timeout: 40_000 });

    // The grid landed as a voxel-grid mesh named "Grid 1".
    const meshRows = page.getByTestId('mesh-row');
    await expect(meshRows).toHaveCount(1);
    const grid = meshRows.first();
    await expect(grid).toHaveAttribute('data-mesh-name', 'Grid 1');

    // center → position, size → scale, rotation (deg about z) → mesh z-rotation.
    await expect(grid).toHaveAttribute('data-mesh-position', '0.25,-0.50,0.75');
    await expect(grid).toHaveAttribute('data-mesh-scale', '1.50,2.00,2.50');
    await expect(grid).toHaveAttribute('data-mesh-rotation', '0.0,0.0,30.0');

    // Select the grid and open the resize panel to read its subdivisions.
    await grid.click();
    await expect(grid).toHaveAttribute('data-selected', 'true');
    await page.getByTestId('tool-mesh-transform').click();

    await expect(page.getByTestId('voxel-grid-x')).toHaveValue('2');
    await expect(page.getByTestId('voxel-grid-y')).toHaveValue('3');
    await expect(page.getByTestId('voxel-grid-z')).toHaveValue('4');
  } finally {
    await close();
  }
});

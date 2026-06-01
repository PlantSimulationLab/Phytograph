import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { stubOpenDialog } from './helpers/stubOpenDialog';
import { completeImportWizard } from './helpers/importWizard';

// Reproduces the PyHelios C++ lidar self-test ("LiDAR Single Voxel Sphere
// Test") through the Phytograph UI against the live backend. The C++ test loads
// plugins/lidar/xml/sphere.xml (four discrete-return scans of a unit sphere
// from four origins, each a 100x200 angular grid), triangulates with
// lmax=0.5 / max_aspect_ratio=5, and expects ~383 triangles.
//
// Here we import the same four scans via the Add Scan → Import from XML flow
// (which auto-attaches each scan's referenced .xyz and its per-scan origin +
// Ntheta/Nphi from <size>), then run Helios triangulation with no explicit
// grid. The backend auto-fits a single-cell grid tightly enclosing all hit
// points, which reproduces the C++ reference exactly: 383 triangles. We assert
// a tight band around that to prove the per-scan parameters genuinely drive a
// faithful triangulation, while tolerating tiny library/platform variance.
test('Helios triangulates the multi-scan sphere fixture via the UI', async () => {
  const { app, page, close } = await launchApp();

  try {
    const xmlFixture = join(repoRoot, 'tests', 'e2e', 'fixtures', 'sphere-scan', 'sphere.xml');
    await stubOpenDialog(app, xmlFixture);

    // Import the four scans from XML. Each <scan> references a sibling .xyz,
    // so the importer attaches both params and data automatically.
    await page.getByTestId('tool-add-scan').click();
    const popup = page.getByTestId('scan-parameters-popup');
    await expect(popup).toBeVisible();
    await page.getByTestId('scan-import-xml').click();
    await expect(popup).not.toBeVisible({ timeout: 20_000 });

    // The four resolved scans run through the import wizard (one stepper);
    // complete it with auto-detected columns.
    await completeImportWizard(page);

    const scansPanel = page.getByTestId('scans-panel');
    const rows = scansPanel.locator('[data-testid="scan-row"]');
    await expect(rows).toHaveCount(4, { timeout: 20_000 });
    // Every row must carry both data and params for Helios to accept it.
    for (let i = 0; i < 4; i++) {
      await expect(rows.nth(i)).toHaveAttribute('data-has-data', 'true');
      await expect(rows.nth(i)).toHaveAttribute('data-has-params', 'true');
    }

    // Select all four scans (Helios requires >= 2 selected scans with params).
    await rows.nth(0).click();
    for (let i = 1; i < 4; i++) {
      await rows.nth(i).click({ modifiers: ['ControlOrMeta'] });
    }
    for (let i = 0; i < 4; i++) {
      await expect(rows.nth(i)).toHaveAttribute('data-selected', 'true');
    }

    // Open the Helios triangulation popup.
    await page.getByTestId('tool-triangulate-helios').click();
    const heliosPopup = page.getByTestId('helios-triangulation-popup');
    await expect(heliosPopup).toBeVisible();

    // No voxel box exists, so the grid selector defaults to the auto (all
    // points) option and shows the all-points warning.
    await expect(page.getByTestId('helios-grid-allpoints-warning')).toBeVisible();

    // Mirror the C++ self-test parameters: lmax=0.5, max_aspect_ratio=5.
    await page.getByTestId('helios-input-lmax').fill('0.5');
    await page.getByTestId('helios-input-aspect').fill('5');

    await page.getByTestId('helios-triangulate-button').click();

    // The mesh row appears once the live backend returns. Sphere fixture is
    // small (a few hundred points/scan) so this is quick.
    const meshRow = page.getByTestId('mesh-row').first();
    await expect(meshRow).toBeVisible({ timeout: 60_000 });

    const trianglesStr = await meshRow.getAttribute('data-triangle-count');
    expect(trianglesStr).not.toBeNull();
    const triangles = parseInt(trianglesStr!, 10);
    // C++ reference is 383 primitives; our auto-grid run reproduces it exactly
    // (383). Allow a small band for cross-platform Delaunay/float variance
    // while still excluding a degenerate (near-empty or runaway) result.
    expect(triangles).toBeGreaterThan(340);
    expect(triangles).toBeLessThan(430);

    await expect(meshRow.getByTestId('mesh-row-count')).toContainText('triangles');

    // --- Pseudocolor the triangulated mesh ---------------------------------
    // The "Color by" control lives inline on the mesh's own row: select the
    // mesh, then expand its row via the chevron. Color by each geometric scalar
    // and confirm the matching colorbar appears with a sane range.
    await meshRow.click();
    await expect(meshRow).toHaveAttribute('data-selected', 'true');
    await meshRow.getByTestId('mesh-color-expand').click();

    const colorMode = page.getByTestId('mesh-color-mode');
    await expect(colorMode).toBeVisible();

    // Inclination: a sphere spans horizontal (0deg) to vertical (90deg) faces.
    await colorMode.selectOption('inclination');
    const meshColorbar = page.getByTestId('mesh-colorbar');
    await expect(meshColorbar).toBeVisible();
    await expect(meshColorbar).toHaveAttribute('data-colorbar-label', /Inclination/);
    {
      const lo = parseFloat((await meshColorbar.getAttribute('data-colorbar-min'))!);
      const hi = parseFloat((await meshColorbar.getAttribute('data-colorbar-max'))!);
      // Inclination is folded to [0,90]; a sphere should cover a wide span.
      expect(lo).toBeGreaterThanOrEqual(0);
      expect(hi).toBeLessThanOrEqual(90.001);
      expect(hi - lo).toBeGreaterThan(20);
    }

    // The colorbar must stay visible even when the mesh is not selected — the
    // legend follows the active color mode, not the selection. Deselect by
    // clicking the row again, then confirm the colorbar persists.
    await meshRow.click();
    await expect(meshRow).toHaveAttribute('data-selected', 'false');
    await expect(meshColorbar).toBeVisible();
    // Re-select for the remaining mode switches (the inline control needs the
    // row expanded, which it still is).
    await meshRow.click();
    await expect(meshRow).toHaveAttribute('data-selected', 'true');

    // Azimuth: faces of a sphere point in all compass directions → [0,360).
    await colorMode.selectOption('azimuth');
    await expect(meshColorbar).toHaveAttribute('data-colorbar-label', /Azimuth/);
    {
      const lo = parseFloat((await meshColorbar.getAttribute('data-colorbar-min'))!);
      const hi = parseFloat((await meshColorbar.getAttribute('data-colorbar-max'))!);
      expect(lo).toBeGreaterThanOrEqual(0);
      expect(hi).toBeLessThanOrEqual(360.001);
      expect(hi - lo).toBeGreaterThan(90);
    }

    // Area: all triangle areas are positive and finite.
    await colorMode.selectOption('area');
    await expect(meshColorbar).toHaveAttribute('data-colorbar-label', /area/i);
    {
      const lo = parseFloat((await meshColorbar.getAttribute('data-colorbar-min'))!);
      const hi = parseFloat((await meshColorbar.getAttribute('data-colorbar-max'))!);
      expect(lo).toBeGreaterThanOrEqual(0);
      expect(hi).toBeGreaterThan(0);
      expect(hi).toBeGreaterThanOrEqual(lo);
    }

    // Source scan: this mesh came from four scans, so the option is offered and
    // a per-scan legend appears (no gradient colorbar). Each of the four scans
    // contributed triangles, so the legend lists four entries.
    await colorMode.selectOption('scan');
    const scanLegend = page.getByTestId('mesh-scan-legend');
    await expect(scanLegend).toBeVisible();
    await expect(scanLegend).toHaveAttribute('data-scan-count', '4');
    // The gradient colorbar is not shown for the categorical scan mode.
    await expect(meshColorbar).toHaveCount(0);

    // Back to solid: neither the colorbar nor the legend is shown.
    await colorMode.selectOption('solid');
    await expect(meshColorbar).toHaveCount(0);
    await expect(scanLegend).toHaveCount(0);
  } finally {
    await close();
  }
});
